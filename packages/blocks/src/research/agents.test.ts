import { describe, expect, it } from "vitest";
import {
  RESEARCH_AGENT_IDS,
  ResearchAgentDefinition,
  ResearchScope,
  type ResearchAgentId,
} from "@reqflow/core";
import { RESEARCH_AGENTS, buildQueries } from "./agents";

const fullScope = ResearchScope.parse({
  brand: "BMW",
  model: "5 Series",
  currentGeneration: "G60",
  previousGeneration: "G30",
  derivative: "Sedan",
  propulsion: "BEV",
  modelYear: "2026",
  markets: ["EU", "China"],
  languages: ["en", "de"],
  publishedFrom: "2024-01-01",
  publishedTo: "2026-10-10",
  horizonYears: 5,
  questions: ["How is cabin space described?", "What equipment is available?"],
  keywords: ["rear seat", "charging"],
  competitors: [{ brand: "Mercedes-Benz", model: "E-Class", generation: "W214" }],
  allowedDomains: ["example.org"],
  blockedDomains: ["blocked.example.org"],
  urls: ["https://example.org/source"],
  documentIds: ["file_synthetic"],
  eurostatDatasets: [{ id: "demo_pjan", filters: { geo: "DE" } }],
});

describe("raw research expert definitions", () => {
  it("covers the exact 13 shared IDs once, with valid raw-only definitions", () => {
    expect(RESEARCH_AGENTS.map(({ id }) => id)).toEqual([...RESEARCH_AGENT_IDS]);
    expect(new Set(RESEARCH_AGENTS.map(({ id }) => id)).size).toBe(13);
    for (const definition of RESEARCH_AGENTS) {
      expect(ResearchAgentDefinition.parse(definition)).toEqual(definition);
      expect(Object.keys(definition).sort()).toEqual(["description", "id", "label", "providers"]);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.description).toMatch(/raw|original/i);
      expect(definition.providers).not.toContain("tavily");
      expect(definition.description).not.toMatch(
        /classif|sentiment|evidence level|prioriti|recommend/i,
      );
    }
  });

  it("declares the required adapters without paid fallback", () => {
    expect(Object.fromEntries(RESEARCH_AGENTS.map(({ id, providers }) => [id, providers]))).toEqual(
      {
        reddit: ["reddit"],
        youtube: ["youtube"],
        instagram: ["apify"],
        tiktok: ["apify"],
        x: ["x"],
        owner_forums: ["firecrawl"],
        editorial_reviews: ["firecrawl"],
        competitor_models: ["firecrawl"],
        market_studies: ["firecrawl", "openalex"],
        regional_context: ["eurostat", "firecrawl"],
        technology: ["firecrawl", "openalex"],
        bmw_sales: ["firecrawl", "local_documents"],
        bmw_strategy: ["firecrawl", "local_documents"],
      },
    );
  });
});

describe("buildQueries", () => {
  it.each(RESEARCH_AGENT_IDS)("builds bounded deterministic neutral %s queries", (id) => {
    const scope = ResearchScope.parse({});
    const before = structuredClone(scope);
    const queries = buildQueries(id, scope);
    expect(buildQueries(id, scope)).toEqual(queries);
    expect(scope).toEqual(before);
    expect(queries.length).toBeGreaterThanOrEqual(1);
    expect(queries.length).toBeLessThanOrEqual(3);
    expect(new Set(queries).size).toBe(queries.length);
    for (const query of queries) {
      expect(query.length).toBeLessThanOrEqual(500);
      expect(query).toContain("BMW 5 Series");
      expect(query).toContain("market context EU");
      expect(query).not.toMatch(
        /complaints|advantages|negative|positive|sentiment|evidence|infer|dissatisfied/i,
      );
      expect(query).not.toMatch(/["“”`\n\r]/);
      expect(query).not.toMatch(/\blang(?:uage)?[:=]|\ben\b|\bde\b/);
    }
  });

  it.each(RESEARCH_AGENT_IDS)("preserves full vehicle, market and date context for %s", (id) => {
    const before = structuredClone(fullScope);
    const queries = buildQueries(id, fullScope);
    expect(fullScope).toEqual(before);
    expect(queries).toHaveLength(3);
    for (const query of queries) {
      for (const token of [
        "BMW 5 Series",
        "G60",
        "G30",
        "Sedan",
        "BEV",
        "2026",
        "EU",
        "China",
        "2024-01-01",
        "2026-10-10",
      ])
        expect(query).toContain(token);
      expect(query.length).toBeLessThanOrEqual(500);
      expect(query).not.toContain("example.org");
      expect(query).not.toContain("file_synthetic");
      expect(query).not.toContain("demo_pjan");
      expect(query).not.toMatch(/\ben\b|\bde\b|customers from|Chinese owners|European owners/);
    }
    expect(queries.join(" ")).toContain("How is cabin space described?");
    expect(queries.join(" ")).toContain("rear seat charging");
  });

  it("uses only configured competitor identities, not invented competing models", () => {
    const query = buildQueries("competitor_models", fullScope).join(" ");
    expect(query).toContain("Mercedes-Benz E-Class W214");
    expect(query).not.toMatch(/Audi|Tesla|competitive advantage/i);
    expect(buildQueries("competitor_models", ResearchScope.parse({})).join(" ")).not.toContain(
      "Mercedes-Benz",
    );
    expect(buildQueries("owner_forums", fullScope).join(" ")).not.toContain("Mercedes-Benz");
  });

  it.each(["bmw_sales", "bmw_strategy"] as const)(
    "uses official BMW search domains for %s",
    (id) => {
      const query = buildQueries(id, fullScope)[0];
      expect(query).toContain("site:bmwgroup.com");
      expect(query).toContain("site:press.bmwgroup.com");
    },
  );

  it.each(["market_studies", "technology"] as const)(
    "includes explicit planning horizon for %s",
    (id) => {
      expect(buildQueries(id, fullScope)[0]).toContain("5 year outlook");
    },
  );

  it("reserves a neutral query even with complaint-only user questions", () => {
    const queries = buildQueries(
      "reddit",
      ResearchScope.parse({
        questions: ["charging complaints"],
        keywords: ["negative experiences"],
      }),
    );
    expect(queries[0]).not.toMatch(/complaints|negative/);
    expect(queries.slice(1).join(" ")).toContain("charging complaints");
  });

  it("normalizes query whitespace/quotes and caps large user lists without truncating vehicle identity", () => {
    const scope = ResearchScope.parse({
      questions: Array.from({ length: 20 }, (_, i) => `\"question ${i}\" ${"space ".repeat(150)}`),
      keywords: Array.from({ length: 20 }, (_, i) => `keyword${i}`),
    });
    const queries = buildQueries("editorial_reviews", scope);
    expect(queries).toHaveLength(3);
    for (const query of queries) {
      expect(query.length).toBeLessThanOrEqual(500);
      expect(query).toMatch(/^BMW 5 Series/);
      expect(query).not.toMatch(/["“”`\n\r]|\s{2}/);
    }
  });

  it("rejects invalid ID/date windows and an identity too long for bounded queries", () => {
    expect(() => buildQueries("unknown" as ResearchAgentId, fullScope)).toThrow();
    expect(() => buildQueries("reddit", { ...fullScope, publishedFrom: "2027-01-01" })).toThrow();
    expect(() => buildQueries("reddit", { ...fullScope, model: "x".repeat(501) })).toThrow(
      /500|too long|length/i,
    );
  });
});
