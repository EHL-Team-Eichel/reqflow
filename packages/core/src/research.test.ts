import { describe, expect, it } from "vitest";
import {
  APIFY_ACTORS,
  CollectedItem,
  DEFAULT_RESEARCH_APIS,
  RESEARCH_AGENT_IDS,
  RESEARCH_PROVIDER_IDS,
  RawRecordType,
  ResearchApiSettings,
  ResearchLimits,
  ResearchProviderConfig,
  ResearchRequest,
  ResearchScope,
} from "./research";
import { DEFAULT_SETTINGS, Settings } from "./settings";
import { Source } from "./source";

describe("research scope runtime contract", () => {
  it("supplies documented defaults without adding publication or vehicle-generation facts", () => {
    const parsed = ResearchScope.parse({});

    expect(parsed).toEqual({
      brand: "BMW",
      model: "5 Series",
      markets: ["EU"],
      languages: ["en", "de"],
      horizonYears: 5,
      questions: [],
      keywords: [],
      competitors: [],
      allowedDomains: [],
      blockedDomains: [],
      urls: [],
      documentIds: [],
      eurostatDatasets: [],
    });
    for (const field of [
      "publishedFrom",
      "publishedTo",
      "currentGeneration",
      "previousGeneration",
      "sentiment",
    ])
      expect(parsed).not.toHaveProperty(field);
  });

  it("preserves explicit scope and trims only contractually trimmed text", () => {
    const scope = {
      brand: "  Synthetic Brand ",
      model: " Synthetic Model  ",
      currentGeneration: "synthetic-current",
      previousGeneration: "synthetic-previous",
      derivative: "Synthetic wagon",
      propulsion: "Synthetic electric",
      modelYear: "2027",
      markets: ["Synthetic market"],
      languages: ["zh-Hans"],
      questions: ["  Which original documents describe the controls?  "],
      keywords: [" controls "],
      competitors: [{ brand: "Synthetic Competitor", model: "Synthetic Car", generation: "v2" }],
      documentIds: ["file_synthetic-1"],
      eurostatDatasets: [{ id: "synthetic_dataset", filters: { geo: "DE" } }],
    };

    const parsed = ResearchScope.parse(scope);

    expect(parsed).toMatchObject({
      ...scope,
      brand: "Synthetic Brand",
      model: "Synthetic Model",
      questions: ["Which original documents describe the controls?"],
      keywords: ["controls"],
    });
  });

  it.each([
    { publishedFrom: "2024-02-29", publishedTo: "2026-10-10" },
    { publishedFrom: "2026-10-10", publishedTo: "2026-10-10" },
    { publishedFrom: "2026-10-10" },
    { publishedTo: "2026-10-10" },
  ])("accepts ordered, equal and one-sided date windows: %j", (dates) => {
    expect(ResearchScope.parse(dates)).toMatchObject(dates);
  });

  it("rejects a reversed publication window", () => {
    const result = ResearchScope.safeParse({
      publishedFrom: "2026-10-11",
      publishedTo: "2026-10-10",
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/start.*precede.*end/i);
  });

  it.each(["2025-02-29", "2026-13-01", "2026-10-32", "10/10/2026", "2026-10-10T00:00:00Z", ""])(
    "rejects invalid or non-date-only publication bound %j",
    (publishedFrom) => {
      expect(ResearchScope.safeParse({ publishedFrom }).success).toBe(false);
    },
  );

  it.each([
    { unknownOption: true },
    { sentiment: "negative" },
    { competitors: [{ brand: "Synthetic", model: "Synthetic", inferredAdvantage: true }] },
    { eurostatDatasets: [{ id: "synthetic", query: "unrecognized" }] },
  ])("rejects unknown scope fields, including nested runtime input: %j", (input) => {
    expect(ResearchScope.safeParse(input).success).toBe(false);
  });

  it.each([
    { brand: " " },
    { model: "" },
    { questions: [" "] },
    { keywords: [""] },
    { markets: [""] },
    { languages: [""] },
    { horizonYears: 0 },
    { horizonYears: 11 },
    { horizonYears: 2.5 },
    { documentIds: ["/private/path.txt"] },
    { documentIds: ["file_../secret"] },
    { urls: ["not a URL"] },
    { eurostatDatasets: [{ id: "../dataset" }] },
    { eurostatDatasets: [{ id: "synthetic", filters: { geo: 1 } }] },
  ])("rejects invalid scoped values: %j", (input) => {
    expect(ResearchScope.safeParse(input).success).toBe(false);
  });
});

describe("research limits", () => {
  it("uses all bounded defaults and leaves the optional credit budget absent", () => {
    expect(ResearchLimits.parse({})).toEqual({
      maxResults: 50,
      maxRequests: 100,
      maxDocumentPages: 20,
      timeoutMs: 120_000,
      concurrency: 3,
      retries: 2,
      cacheMaxAgeMs: 0,
      maxApifyChargeUsd: 1,
    });
  });

  const bounds = [
    ["maxResults", 1, 1000],
    ["maxRequests", 1, 1000],
    ["maxDocumentPages", 1, 500],
    ["timeoutMs", 1000, 900_000],
    ["concurrency", 1, 8],
    ["retries", 0, 3],
    ["cacheMaxAgeMs", 0, 86_400_000],
  ] as const;

  it.each(bounds)("accepts inclusive %s bounds", (field, minimum, maximum) => {
    expect(ResearchLimits.parse({ [field]: minimum })[field]).toBe(minimum);
    expect(ResearchLimits.parse({ [field]: maximum })[field]).toBe(maximum);
  });

  it.each(bounds)(
    "rejects out-of-range, fractional and nonnumeric %s",
    (field, minimum, maximum) => {
      for (const value of [
        minimum - 1,
        maximum + 1,
        minimum + 0.5,
        NaN,
        Infinity,
        String(minimum),
        null,
      ])
        expect(ResearchLimits.safeParse({ [field]: value }).success, `${field}=${value}`).toBe(
          false,
        );
    },
  );

  it("accepts positive integer credits and a fractional bounded Apify dollar cap", () => {
    expect(ResearchLimits.parse({ maxProviderCredits: 1, maxApifyChargeUsd: 0.01 })).toMatchObject({
      maxProviderCredits: 1,
      maxApifyChargeUsd: 0.01,
    });
    expect(ResearchLimits.parse({ maxApifyChargeUsd: 100 }).maxApifyChargeUsd).toBe(100);
  });

  it.each([0, -1, 1.5, NaN, Infinity, "2", null])(
    "rejects invalid credit cap %j",
    (maxProviderCredits) => {
      expect(ResearchLimits.safeParse({ maxProviderCredits }).success).toBe(false);
    },
  );

  it.each([0, -1, 100.01, NaN, Infinity, "1", null])(
    "rejects invalid Apify cap %j",
    (maxApifyChargeUsd) => {
      expect(ResearchLimits.safeParse({ maxApifyChargeUsd }).success).toBe(false);
    },
  );

  it("rejects unrecognized limits rather than silently accepting an unenforced budget", () => {
    expect(ResearchLimits.safeParse({ maxSpend: 10 }).success).toBe(false);
  });
});

describe("research request runtime contract", () => {
  it("allows every declared expert and supplies limits for older requests", () => {
    const parsed = ResearchRequest.parse({ agents: [...RESEARCH_AGENT_IDS], scope: {} });

    expect(parsed.agents).toEqual([...RESEARCH_AGENT_IDS]);
    expect(parsed.limits).toEqual(ResearchLimits.parse({}));
  });

  it.each([
    { agents: [], scope: {} },
    { agents: Array(14).fill("reddit"), scope: {} },
    { agents: ["invented_expert"], scope: {} },
    { agents: ["reddit"], scope: {}, runRequirementDerivation: true },
    { agents: ["reddit"], scope: { unexpected: true } },
    { agents: ["reddit"], scope: {}, limits: { concurrency: 9 } },
  ])("rejects invalid or unrecognized runtime requests: %j", (input) => {
    expect(ResearchRequest.safeParse(input).success).toBe(false);
  });
});

describe("research settings migration and provider approval", () => {
  const expectedConfig = {
    enabled: false,
    approval: "not_granted",
    xSearchMode: "recent",
    allowedActors: [],
    redditUserAgent: "ReqFlow/0.1 (approved research client)",
  };

  it("defaults every provider explicitly, enabling only unmetered local/Eurostat sources", () => {
    const parsed = ResearchApiSettings.parse({});

    expect(Object.keys(parsed).sort()).toEqual([...RESEARCH_PROVIDER_IDS].sort());
    for (const id of RESEARCH_PROVIDER_IDS)
      expect(parsed[id]).toEqual({
        ...expectedConfig,
        enabled: id === "eurostat" || id === "local_documents",
      });
  });

  it("migrates old settings without changing unrelated settings or enabling paid research", () => {
    const old = structuredClone(DEFAULT_SETTINGS);
    const { apis: _apis, ...oldResearch } = old.research;
    const legacy = {
      ...old,
      research: { ...oldResearch, provider: "tavily", maxResultsPerQuery: 7 },
    };
    const before = structuredClone(legacy);

    const parsed = Settings.parse(legacy);

    expect(parsed).toEqual({
      ...legacy,
      research: { ...legacy.research, apis: DEFAULT_RESEARCH_APIS },
    });
    expect(parsed.research.apis.tavily).toMatchObject({ enabled: false, approval: "not_granted" });
    expect(legacy).toEqual(before);
  });

  it("fills missing providers and config fields in partially migrated settings", () => {
    const parsed = Settings.parse({
      ...DEFAULT_SETTINGS,
      research: {
        ...DEFAULT_SETTINGS.research,
        apis: { youtube: { enabled: true, approval: "granted" } },
      },
    });

    expect(parsed.research.apis.youtube).toEqual({
      ...expectedConfig,
      enabled: true,
      approval: "granted",
    });
    for (const id of RESEARCH_PROVIDER_IDS.filter((id) => id !== "youtube"))
      expect(parsed.research.apis[id]).toEqual(DEFAULT_RESEARCH_APIS[id]);
  });

  it("requires explicit approval independently of enabling a provider", () => {
    expect(ResearchProviderConfig.parse({ enabled: true }).approval).toBe("not_granted");
  });

  it("restricts Apify actors and X archive mode to the declared capabilities", () => {
    expect(
      ResearchProviderConfig.parse({
        allowedActors: [...APIFY_ACTORS],
        xSearchMode: "full_archive",
      }),
    ).toMatchObject({
      allowedActors: [...APIFY_ACTORS],
      xSearchMode: "full_archive",
    });
    expect(
      ResearchProviderConfig.safeParse({ allowedActors: ["unknown/paid-actor"] }).success,
    ).toBe(false);
    expect(ResearchProviderConfig.safeParse({ xSearchMode: "unrestricted" }).success).toBe(false);
  });

  it.each([
    { apiKey: "synthetic-not-a-real-key" },
    { approval: true },
    { enabled: "true" },
    { redditUserAgent: "short" },
    { redditUserAgent: "x".repeat(201) },
  ])("rejects credential/config fields outside the public settings contract: %j", (input) => {
    expect(ResearchProviderConfig.safeParse(input).success).toBe(false);
  });

  it("rejects unknown providers in settings rather than silently dropping them", () => {
    expect(
      ResearchApiSettings.safeParse({ invented_paid_provider: { enabled: true } }).success,
    ).toBe(false);
  });
});

describe("raw-only source contracts", () => {
  const raw = {
    provider: "local_documents",
    sourceId: "file_synthetic",
    sourceUrl: "reqflow-file:///file_synthetic",
    sourceTitle: "Synthetic original",
    recordId: "synthetic-row",
    recordType: "feedback",
    text: "Synthetic customer verbatim.\nOriginal second line.",
  };

  it("defaults only collection metadata, not inferred sentiment, dates or attributions", () => {
    expect(CollectedItem.parse(raw)).toEqual({
      ...raw,
      sourceKind: "other_web",
      datePrecision: "unknown",
      metadata: {},
      limitations: [],
    });
  });

  it.each(["sentiment", "findings", "requirements", "reliability", "evidenceLevel", "priority"])(
    "rejects a model-owned %s field at collection time",
    (field) => {
      expect(CollectedItem.safeParse({ ...raw, [field]: "synthetic-inference" }).success).toBe(
        false,
      );
    },
  );

  it("retains source-supplied classifications and table flags only as original metadata", () => {
    const metadata = {
      classifications: [
        { column: "Sentiment", value: "mixed", origin: "source_explicit", locator: "sheet!D2" },
      ],
      rawStatus: { "0": "ep" },
    };

    expect(CollectedItem.parse({ ...raw, metadata }).metadata).toEqual(metadata);
  });

  it("does not accept downstream evidence or requirement types as raw records", () => {
    for (const value of ["finding", "requirement", "sentiment", "recommendation"])
      expect(RawRecordType.safeParse(value).success).toBe(false);
  });

  it("allows an unassessed Source without choosing a reliability level", () => {
    const source = Source.parse({
      id: "src_synthetic",
      kind: "other_web",
      origin: "web",
      title: "Synthetic original",
      retrievedAt: "2026-10-10T12:00:00.000Z",
    });

    expect(source).not.toHaveProperty("reliability");
  });
});
