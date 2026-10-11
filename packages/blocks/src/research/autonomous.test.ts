import { describe, expect, it, vi } from "vitest";
import {
  CollectedItem,
  DEFAULT_SETTINGS,
  ResearchRequest,
  ResearchScope,
  type LlmClient,
} from "@reqflow/core";
import { createResearchCollector } from "./runtime.js";
import type { ProviderAdapter, CollectionRequest } from "./provider.js";
import { buildAutonomousQueries, discoverCompetitors, refineAgentQueries } from "./autonomous.js";

describe("autonomous research discovery and refinement", () => {
  describe("discoverCompetitors", () => {
    it("preserves explicitly configured competitors in scope without calling LLM", async () => {
      const generateObject = vi.fn();
      const mockLlm: LlmClient = { generateObject } as unknown as LlmClient;
      const scope = ResearchScope.parse({
        brand: "BMW",
        model: "1 Series",
        competitors: [{ brand: "Audi", model: "A3", generation: "8Y" }],
      });

      const competitors = await discoverCompetitors(scope, mockLlm);
      expect(competitors).toEqual([{ brand: "Audi", model: "A3", generation: "8Y" }]);
      expect(generateObject).not.toHaveBeenCalled();
    });

    it("autonomously discovers segment competitors using LLM when competitors are empty", async () => {
      const mockLlm: LlmClient = {
        generateObject: vi.fn().mockResolvedValue({
          object: {
            competitors: [
              { brand: "Audi", model: "A3", generation: "8Y" },
              { brand: "Mercedes-Benz", model: "A-Class", generation: "W177" },
              { brand: "Volkswagen", model: "Golf", generation: "8" },
            ],
          },
        }),
      } as unknown as LlmClient;

      const scope = ResearchScope.parse({
        brand: "BMW",
        model: "1 Series",
        derivative: "F70",
        markets: ["EU"],
      });

      const competitors = await discoverCompetitors(scope, mockLlm);
      expect(competitors).toHaveLength(3);
      expect(competitors[0]).toMatchObject({ brand: "Audi", model: "A3" });
      expect(competitors[1]).toMatchObject({ brand: "Mercedes-Benz", model: "A-Class" });
    });

    it("falls back to deterministic automotive segmentation defaults when LLM is unavailable or fails", async () => {
      const scope = ResearchScope.parse({
        brand: "BMW",
        model: "1 Series",
        markets: ["EU"],
      });

      const competitors = await discoverCompetitors(scope);
      expect(competitors.length).toBeGreaterThanOrEqual(2);
      expect(competitors.some((c) => c.brand === "Audi" && c.model === "A3")).toBe(true);
      expect(competitors.some((c) => c.brand === "Mercedes-Benz")).toBe(true);
    });

    it("identifies executive rivals for 5 Series / G60", async () => {
      const scope = ResearchScope.parse({
        brand: "BMW",
        model: "5 Series",
        currentGeneration: "G60",
      });

      const competitors = await discoverCompetitors(scope);
      expect(competitors.some((c) => c.brand === "Mercedes-Benz" && c.model === "E-Class")).toBe(
        true,
      );
      expect(competitors.some((c) => c.brand === "Audi" && c.model === "A6")).toBe(true);
    });
  });

  describe("buildAutonomousQueries", () => {
    it("builds targeted competitor queries directly searching for competing models without rigid BMW-only prefix", () => {
      const scope = ResearchScope.parse({
        brand: "BMW",
        model: "1 Series",
        currentGeneration: "F70",
        markets: ["EU"],
      });

      const queries = buildAutonomousQueries("competitor_models", scope);
      expect(queries.length).toBeGreaterThanOrEqual(2);
      // Queries should directly target competitor cars like Audi A3 or Mercedes A-Class
      const hasCompetitorName = queries.some(
        (q) => q.includes("Audi A3") || q.includes("Mercedes-Benz A-Class") || q.includes("Golf"),
      );
      expect(hasCompetitorName).toBe(true);
    });

    it("builds technology queries focused on automotive systems and trends without forced BMW model prefix on generic tech", () => {
      const scope = ResearchScope.parse({
        brand: "BMW",
        model: "1 Series",
        markets: ["EU"],
        horizonYears: 5,
      });

      const queries = buildAutonomousQueries("technology", scope);
      expect(queries.length).toBeGreaterThanOrEqual(2);
      const hasTechTerms = queries.some(
        (q) =>
          q.includes("infotainment") ||
          q.includes("driver assistance") ||
          q.includes("ADAS") ||
          q.includes("cockpit"),
      );
      expect(hasTechTerms).toBe(true);
    });

    it("builds editorial review queries with automotive publication and usability focus", () => {
      const scope = ResearchScope.parse({
        brand: "BMW",
        model: "1 Series",
        currentGeneration: "F70",
      });

      const queries = buildAutonomousQueries("editorial_reviews", scope);
      expect(queries.some((q) => q.includes("road test") || q.includes("review"))).toBe(true);
    });
  });

  describe("refineAgentQueries", () => {
    it("uses LLM to generate refined queries that avoid previous rejection reasons", async () => {
      const mockLlm: LlmClient = {
        generateObject: vi.fn().mockResolvedValue({
          object: {
            queries: [
              "Audi A3 8Y equipment options list road test",
              "Mercedes-Benz A-Class interior usability comparison",
            ],
            refinementReason: "Shifted search to direct competitor equipment reviews",
          },
        }),
      } as unknown as LlmClient;

      const scope = ResearchScope.parse({
        brand: "BMW",
        model: "1 Series",
      });

      const result = await refineAgentQueries({
        agentId: "competitor_models",
        scope,
        previousQueries: ["BMW 1 Series comparison specifications"],
        rejections: [
          {
            url: "https://example.com/bmw-review",
            reason: "Source is about the BMW 1 Series; does not cover competitor models.",
          },
        ],
        acceptedCount: 0,
        targetCount: 3,
        llm: mockLlm,
      });

      expect(result.queries).toHaveLength(2);
      expect(result.queries[0]).toContain("Audi A3");
      expect(result.refinementReason).toContain("competitor");
    });

    it("falls back to deterministic refinement when LLM is unavailable, avoiding already used queries", async () => {
      const scope = ResearchScope.parse({
        brand: "BMW",
        model: "1 Series",
      });

      const previous = ["Audi A3 standard equipment list options table"];
      const result = await refineAgentQueries({
        agentId: "competitor_models",
        scope,
        previousQueries: previous,
        rejections: [
          {
            url: "https://example.com/macro",
            reason: "Corporate annual report without vehicle technology.",
          },
        ],
        acceptedCount: 0,
        targetCount: 3,
      });

      expect(result.queries.length).toBeGreaterThan(0);
      expect(result.queries.some((q) => previous.includes(q))).toBe(false);
      expect(result.refinementReason).toContain("Refined queries to avoid rejected source topics");
    });
  });

  describe("autonomous collector runtime integration", () => {
    function createSyntheticOriginal(
      suffix: string,
      overrides: Partial<CollectedItem> = {},
    ): CollectedItem {
      return CollectedItem.parse({
        provider: "firecrawl",
        sourceId: `synthetic-source-${suffix}`,
        sourceUrl: `https://sources.example.org/${suffix}`,
        sourceTitle: `Synthetic original ${suffix}`,
        recordId: `synthetic-record-${suffix}`,
        recordType: "passage",
        text: `Synthetic source text ${suffix}`,
        metadata: { originalValue: 7 },
        ...overrides,
      });
    }

    it("autonomously discovers segment competitors when scope has none and refines queries upon rejection", async () => {
      const capturedQueries: string[][] = [];
      let roundCount = 0;

      const mockAdapter: ProviderAdapter = {
        id: "firecrawl",
        collect: vi.fn(async (input: CollectionRequest) => {
          capturedQueries.push([...input.queries]);
          roundCount++;
          if (roundCount === 1) {
            // Round 1: returns a source that will be rejected (e.g. BMW review instead of competitor)
            return {
              items: [
                createSyntheticOriginal("bmw-f70-review", {
                  sourceUrl: "https://sources.example.org/bmw-f70-review",
                  text: "BMW 1 Series review of the standard model and interior.",
                }),
              ],
              status: "success" as const,
              limitations: [],
            };
          }
          // Round 2: returns a relevant competitor source
          return {
            items: [
              createSyntheticOriginal("audi-a3-review", {
                sourceUrl: "https://sources.example.org/audi-a3-review",
                text: "Audi A3 Sportback test and equipment comparison with BMW 1 Series.",
              }),
            ],
            status: "success" as const,
            limitations: [],
          };
        }),
        test: vi.fn(),
      };

      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.research.provider = "firecrawl";
      settings.research.apis.firecrawl = {
        ...settings.research.apis.firecrawl,
        enabled: true,
        approval: "granted",
        allowedActors: [],
      };

      let assessCount = 0;
      const reviewLlm: LlmClient = {
        generateObject: vi.fn(async ({ system }: { system: unknown }) => {
          const sys = Array.isArray(system) ? system.join(" ") : String(system);
          const isDiscovery = sys.includes("segment competitors");
          if (isDiscovery) {
            return {
              object: {
                competitors: [
                  { brand: "Audi", model: "A3", generation: "8Y" },
                  { brand: "Mercedes-Benz", model: "A-Class", generation: "W177" },
                ],
              },
            };
          }
          const isRefinement = sys.includes("query refiner");
          if (isRefinement) {
            return {
              object: {
                queries: ["Audi A3 Sportback test review", "Mercedes A-Klasse Vergleich"],
                refinementReason:
                  "Focused directly on discovered competitors Audi A3 and Mercedes A-Class",
              },
            };
          }
          assessCount++;
          if (assessCount === 1) {
            return {
              object: {
                verdict: "irrelevant",
                reason:
                  "Source discusses BMW 1 Series directly, not the requested competitor models.",
                uncertainty: "",
                excerpts: [],
                tableRows: [],
                summary: "",
              },
              model: "synthetic-review-model",
            };
          }
          const quote = "Audi A3 Sportback test and equipment comparison";
          return {
            object: {
              verdict: "relevant",
              reason: "Relevant competitor comparison for Audi A3.",
              uncertainty: "",
              excerpts: [{ quote, start: 0, end: quote.length }],
              tableRows: [],
              summary: "Audi A3 comparison with BMW 1 Series highlights interior equipment.",
            },
            model: "synthetic-review-model",
          };
        }),
      } as unknown as LlmClient;

      const collector = createResearchCollector({
        settings,
        credentials: { firecrawl_api_key: "synthetic-key" },
        adapters: new Map([["firecrawl", mockAdapter]]),
        reviewLlm: () => reviewLlm,
        save: vi.fn(),
      });

      const controller = new AbortController();
      const logs: string[] = [];
      const dataset = await collector.collect(
        ResearchRequest.parse({
          scope: {
            brand: "BMW",
            model: "1 Series",
            derivative: "F70",
            competitors: [],
          },
          agents: ["competitor_models"],
          limits: {
            maxResults: 1,
            maxRequests: 20,
            timeoutMs: 120000,
          },
        }),
        {
          runId: "run_synthetic_autonomous",
          log: (msg) => logs.push(msg),
          progress: vi.fn(),
          signal: controller.signal,
        },
      );

      // Verify that 2 rounds executed:
      expect(roundCount).toBe(2);
      expect(capturedQueries.length).toBe(2);
      // Verify initial queries used autonomously discovered competitors
      expect(capturedQueries[0]?.some((q) => q.includes("Audi A3") || q.includes("A-Class"))).toBe(
        true,
      );
      // Verify refined queries in round 2
      expect(capturedQueries[1]).toEqual([
        "Audi A3 Sportback test review",
        "Mercedes A-Klasse Vergleich",
      ]);
      // Verify dataset has the accepted record
      expect(dataset.records.length).toBeGreaterThanOrEqual(1);
      const acceptedRecord = dataset.records.find((r) => r.text.includes("Audi A3"));
      expect(acceptedRecord).toBeDefined();
      expect(logs.some((l) => l.includes("Autonomously discovered segment competitors"))).toBe(
        true,
      );
      expect(logs.some((l) => l.includes("round 1 yielded 0/1 relevant sources"))).toBe(true);
    });

    it("does not abort under the default 120000ms timeout while still honoring explicit custom deadlines", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

      const mockAdapter: ProviderAdapter = {
        id: "firecrawl",
        collect: vi.fn(async () => ({
          items: [createSyntheticOriginal("timeout-test")],
          status: "success" as const,
          limitations: [],
        })),
        test: vi.fn(),
      };

      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.research.provider = "firecrawl";
      settings.research.apis.firecrawl = {
        ...settings.research.apis.firecrawl,
        enabled: true,
        approval: "granted",
        allowedActors: [],
      };

      const collector = createResearchCollector({
        settings,
        credentials: { firecrawl_api_key: "synthetic-key" },
        adapters: new Map([["firecrawl", mockAdapter]]),
        save: vi.fn(),
      });

      // 1. Run with default 120000ms: timeoutSpy should NOT be called with 120000
      timeoutSpy.mockClear();
      await collector.collect(
        ResearchRequest.parse({
          scope: { brand: "BMW", model: "1 Series" },
          agents: ["editorial_reviews"],
          limits: { timeoutMs: 120000 },
        }),
        {
          runId: "run_synthetic_default_timeout",
          log: vi.fn(),
          progress: vi.fn(),
          signal: new AbortController().signal,
        },
      );
      expect(timeoutSpy).not.toHaveBeenCalledWith(120000);

      // 2. Run with custom 5000ms deadline: timeoutSpy SHOULD be called with 5000
      timeoutSpy.mockClear();
      await collector.collect(
        ResearchRequest.parse({
          scope: { brand: "BMW", model: "1 Series" },
          agents: ["editorial_reviews"],
          limits: { timeoutMs: 5000 },
        }),
        {
          runId: "run_synthetic_custom_timeout",
          log: vi.fn(),
          progress: vi.fn(),
          signal: new AbortController().signal,
        },
      );
      expect(timeoutSpy).toHaveBeenCalledWith(5000);
      timeoutSpy.mockRestore();
    });
  });
});
