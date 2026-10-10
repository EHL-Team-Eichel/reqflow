import { ResearchScope, createBlock, setBlockParams, type ResearchAgentId } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import {
  SOCIAL_AGENT_IDS,
  SOCIAL_MEDIA_OPTIONS,
  readScopeJson,
  scopeFormFromJson,
  scopeJsonFromForm,
  selectSocialMedia,
  socialMediaSelection,
  validateResearchAgents,
  validateScopeJson,
} from "./research-configuration";

describe("Research social-media selection", () => {
  it("offers a single selection including custom combinations", () => {
    expect(SOCIAL_MEDIA_OPTIONS.map((option) => option.label)).toEqual([
      "None",
      "Reddit",
      "YouTube",
      "Instagram",
      "TikTok",
      "X",
      "All",
      "Custom",
    ]);
  });

  it.each(SOCIAL_AGENT_IDS)("replaces only social agents with %s", (selection) => {
    const agents: ResearchAgentId[] = [
      "reddit",
      "regional_context",
      "youtube",
      "bmw_sales",
      "technology",
    ];
    const before = [...agents];
    expect(selectSocialMedia(agents, selection)).toEqual([
      "regional_context",
      "bmw_sales",
      "technology",
      selection,
    ]);
    expect(agents).toEqual(before);
  });

  it("keeps every non-social collector when choosing All or None", () => {
    const other: ResearchAgentId[] = [
      "owner_forums",
      "editorial_reviews",
      "competitor_models",
      "market_studies",
      "regional_context",
      "technology",
      "bmw_sales",
      "bmw_strategy",
    ];
    const all = selectSocialMedia(other, "all");
    expect(all).toEqual([...other, ...SOCIAL_AGENT_IDS]);
    expect(socialMediaSelection(all)).toBe("all");
    expect(selectSocialMedia(all, "none")).toEqual(other);
    expect(socialMediaSelection(other)).toBe("none");
  });

  it("reflects chip combinations without persisting a second selector", () => {
    expect(socialMediaSelection(["reddit", "technology"])).toBe("reddit");
    const custom: ResearchAgentId[] = ["youtube", "x", "editorial_reviews"];
    expect(socialMediaSelection(custom)).toBe("custom");
    expect(selectSocialMedia(custom, "custom")).toEqual(custom);
    expect(socialMediaSelection([...SOCIAL_AGENT_IDS].reverse())).toBe("all");
  });

  it("rejects zero agents, including None when only social agents remain", () => {
    expect(() => selectSocialMedia(["reddit"], "none")).toThrow(
      "Select at least one research agent.",
    );
    expect(() => validateResearchAgents([])).toThrow("Select at least one research agent.");
    expect(() => validateResearchAgents(["unknown"])).toThrow();
    expect(() => validateResearchAgents(["reddit", "reddit"])).toThrow();
  });
});

describe("Research scope form and advanced JSON", () => {
  const advanced = {
    brand: "BMW",
    model: "1 Series",
    currentGeneration: "F70",
    previousGeneration: "F40",
    derivative: "Hatchback",
    propulsion: "ICE",
    modelYear: "2026",
    markets: ["EU", "CN"],
    languages: ["de", "中文"],
    publishedFrom: "2024-02-29",
    publishedTo: "2026-10-10",
    keywords: ["rear seat", "舒适性", "größerer Kofferraum"],
    urls: ["https://example.org/überblick?topic=舒适"],
    competitors: [{ brand: "Example", model: "Compact", generation: "第二代" }],
    horizonYears: 7,
    questions: ["Which customer needs are unmet?"],
    allowedDomains: ["example.org"],
    blockedDomains: ["blocked.example"],
    documentIds: ["file_synthetic-1"],
    eurostatDatasets: [{ id: "demo_pjan", filters: { geo: "DE", sex: "T" } }],
  };

  it("round-trips every prior advanced field without schema-default materialization", () => {
    const json = JSON.stringify(advanced);
    expect(readScopeJson(scopeJsonFromForm(json, scopeFormFromJson(json)))).toEqual(advanced);
    expect(scopeJsonFromForm("{}", scopeFormFromJson("{}"))).toBe("{}");
    expect(scopeFormFromJson("{}").model).toBe("");
    expect(scopeFormFromJson("{}").markets).toBe("");
    expect(scopeFormFromJson("{}").languages).toBe("");
  });

  it("merges form changes, preserving documents, datasets, domains, horizon and questions", () => {
    const json = JSON.stringify(advanced);
    const fields = scopeFormFromJson(json);
    fields.model = "  Synthetic successor  ";
    fields.markets = "EU\nUS";
    fields.publishedTo = "2027-01-01";
    const next = readScopeJson(scopeJsonFromForm(json, fields));
    expect(next).toEqual({
      ...advanced,
      model: "Synthetic successor",
      markets: ["EU", "US"],
      publishedTo: "2027-01-01",
    });
    expect(advanced.model).toBe("1 Series");
    expect(ResearchScope.safeParse(next).success).toBe(true);
  });

  it("clears overrides by removing keys, not by persisting invented defaults", () => {
    const json = JSON.stringify(advanced);
    const fields = scopeFormFromJson(json);
    for (const key of [
      "brand",
      "model",
      "derivative",
      "markets",
      "languages",
      "publishedFrom",
      "keywords",
      "urls",
    ] as const)
      fields[key] = "";
    fields.competitors = [];
    const next = readScopeJson(scopeJsonFromForm(json, fields));
    for (const key of [
      "brand",
      "model",
      "derivative",
      "markets",
      "languages",
      "publishedFrom",
      "keywords",
      "urls",
      "competitors",
    ])
      expect(next).not.toHaveProperty(key);
    expect(next.eurostatDatasets).toEqual(advanced.eurostatDatasets);
  });

  it("retains explicitly empty arrays and unchanged strings from advanced scope", () => {
    const raw = {
      model: "  Custom model  ",
      markets: [],
      languages: [],
      urls: [],
      competitors: [],
      keywords: ["one\nphrase"],
    };
    const json = JSON.stringify(raw);
    expect(readScopeJson(scopeJsonFromForm(json, scopeFormFromJson(json)))).toEqual(raw);
  });

  it("accepts Unicode input and preserves URL punctuation and competitor generations", () => {
    const fields = scopeFormFromJson("{}");
    fields.brand = "品牌";
    fields.model = "電動車 🚙";
    fields.derivative = "长轴距";
    fields.languages = "中文\n日本語\nde";
    fields.keywords = "舒适性\ngrößerer Kofferraum\ncharging, range";
    fields.urls = "https://example.org/überblick?q=空间,舒适";
    fields.competitors = [{ brand: "示例", model: "コンパクト", generation: "第二代" }];
    const next = readScopeJson(scopeJsonFromForm("{}", fields));
    expect(next).toEqual({
      brand: "品牌",
      model: "電動車 🚙",
      derivative: "长轴距",
      languages: ["中文", "日本語", "de"],
      keywords: ["舒适性", "größerer Kofferraum", "charging, range"],
      urls: [fields.urls],
      competitors: fields.competitors,
    });
    expect(next).not.toHaveProperty("markets");
  });

  it.each(["{", "", "not JSON", "null", "[]", "42", '"model"'])(
    "rejects invalid scope %s without replacing it",
    (json) => {
      expect(() => validateScopeJson(json)).toThrow(/valid JSON|JSON object/);
      expect(() => scopeFormFromJson(json)).toThrow();
    },
  );

  it("does not silently discard unknown or invalid advanced fields", () => {
    for (const raw of [
      { futureField: { keep: true } },
      { documentIds: ["not-an-import"] },
      { eurostatDatasets: [{ id: "bad-id" }] },
    ]) {
      const json = JSON.stringify(raw);
      expect(() => scopeFormFromJson(json)).toThrow();
      expect(json).toBe(JSON.stringify(raw));
    }
    expect(() => readScopeJson({ model: "not a JSON string" })).toThrow();
  });

  it.each([
    { publishedFrom: "2026-02-30" },
    { publishedTo: "10/10/2026" },
    { publishedFrom: "2026-10-10", publishedTo: "2025-01-01" },
  ])("validates publication dates against ResearchScope: %j", (dates) => {
    const fields = { ...scopeFormFromJson("{}"), ...dates };
    expect(() => scopeJsonFromForm("{}", fields)).toThrow(/date|Publication/);
    expect(() => validateScopeJson(JSON.stringify(dates))).toThrow(/date|Publication/);
  });

  it("rejects invalid source URLs and incomplete competitors before acceptance", () => {
    const fields = scopeFormFromJson("{}");
    fields.urls = "not a URL";
    expect(() => scopeJsonFromForm("{}", fields)).toThrow(/urls/);
    fields.urls = "";
    fields.competitors = [{ brand: "Example", model: "", generation: "" }];
    expect(() => scopeJsonFromForm("{}", fields)).toThrow(/competitors/);
  });

  it("preserves valid advanced JSON text and validates without writing schema defaults", () => {
    const json = '{\n  "model": "自定义",\n  "horizonYears": 8\n}';
    expect(validateScopeJson(json)).toBe(json);
    expect(readScopeJson(undefined)).toEqual({});
  });
});

describe("Research inspector parameter contract", () => {
  it("changes only canonical agents and scopeJson through the existing graph validator", () => {
    const block = createBlock("research", { id: "research-synthetic", position: { x: 0, y: 0 } });
    const params = structuredClone(block.params);
    const scope = scopeFormFromJson(params.scopeJson as string);
    scope.model = "自定义 successor";
    scope.currentGeneration = "Synthetic 2";
    const next = setBlockParams({ blocks: [block], edges: [] }, block.id, {
      ...params,
      agents: selectSocialMedia(params.agents as string[], "all"),
      scopeJson: scopeJsonFromForm(params.scopeJson as string, scope),
    }).graph.blocks[0]!.params;
    for (const key of Object.keys(params).filter(
      (key) => key !== "agents" && key !== "scopeJson",
    )) {
      expect(next[key]).toEqual(params[key]);
    }
    expect(next).not.toHaveProperty("socialMedia");
    expect(readScopeJson(next.scopeJson)).toEqual({
      model: "自定义 successor",
      currentGeneration: "Synthetic 2",
    });
    expect(next.agents).toEqual([
      ...(params.agents as string[]).filter(
        (agent) => !SOCIAL_AGENT_IDS.includes(agent as (typeof SOCIAL_AGENT_IDS)[number]),
      ),
      ...SOCIAL_AGENT_IDS,
    ]);
    expect(block.params).toEqual(params);
  });
});
