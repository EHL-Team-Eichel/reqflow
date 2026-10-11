import {
  CollectedItem,
  defaultBlockParams,
  DEFAULT_SETTINGS,
  emptyPipelineData,
  ResearchDataset,
  ResearchRequest,
  type BlockParams,
} from "@reqflow/core";
import { BlockRegistry, type BlockContext } from "@reqflow/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { researchImplementations } from "./index";
import { normalizeItem } from "./raw";
import { createResearchCollector } from "./runtime";
import type { ProviderAdapter } from "./provider";
import { summarizeResearchDataset } from "./summarizer";
import type { ResearchTableRow } from "./tabular";

const at = "2026-10-10T12:00:00.000Z";
function dataset(): ResearchDataset {
  const item = CollectedItem.parse({
    provider: "local_documents",
    sourceId: "file_synthetic",
    sourceUrl: "reqflow-file:///file_synthetic",
    sourceTitle: "Synthetic original",
    recordId: "file_synthetic:text",
    recordType: "passage",
    text: "Synthetic original — unchanged.\n舒适\n",
    locator: "UTF-8 document",
    metadata: { originalArtifact: { fileId: "file_synthetic" }, nested: { extra: false } },
  });
  const { source, record } = normalizeItem(item, "bmw_sales", "run_synthetic", at);
  return ResearchDataset.parse({
    schemaVersion: 1,
    runId: "run_synthetic",
    retrievedAt: at,
    sources: [source],
    records: [record],
    results: [
      {
        agentId: "bmw_sales",
        status: "success",
        recordIds: [record.id],
        requests: 0,
        limitations: [],
      },
    ],
    synthetic: true,
  });
}
function setup() {
  const raw = dataset();
  const collect = vi.fn(
    async (
      _request: ResearchRequest,
      _context: Parameters<NonNullable<BlockContext["research"]>["collect"]>[1],
    ) => raw,
  );
  const context: BlockContext = {
    runId: "run_synthetic",
    blockId: "research",
    scope: { ...DEFAULT_SETTINGS.defaultScope, market: "US", horizonYears: 3 },
    settings: structuredClone(DEFAULT_SETTINGS),
    signal: new AbortController().signal,
    resumed: false,
    research: { collect },
    web: null,
    log: vi.fn(),
    progress: vi.fn(),
    llm: { generateObject: vi.fn(), generateText: vi.fn() },
    agents: { writer: vi.fn(), judge: vi.fn() },
    audit: { record: vi.fn() },
    files: { get: vi.fn() },
    car: { add: vi.fn() },
  };
  const implementation = new BlockRegistry(researchImplementations).get("research");
  const run = (overrides: BlockParams = {}) =>
    implementation.run({}, { ...defaultBlockParams("research"), ...overrides }, context);
  return { raw, collect, context, run };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Research block", () => {
  it("uses the core default params and the run scope to form a validated retrieval request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    const { run, collect, context } = setup();
    context.settings.research.allowedDomains = ["sources.example.org"];
    context.settings.research.blockedDomains = ["blocked.example.org"];

    await run();

    const request = ResearchRequest.parse(collect.mock.calls[0]![0]);
    expect(request.scope).toMatchObject({
      brand: "BMW",
      model: context.scope.vehicleLine,
      derivative: context.scope.derivative,
      markets: ["US"],
      horizonYears: 3,
      questions: [],
      allowedDomains: ["sources.example.org"],
      blockedDomains: ["blocked.example.org"],
      publishedFrom: "2024-10-10",
      documentIds: [],
    });
    expect(request.agents).toEqual(defaultBlockParams("research").agents);
    expect(request.limits).toMatchObject({
      maxResults: 10,
      maxRequests: 100,
      maxDocumentPages: 20,
      timeoutMs: 120000,
      concurrency: 3,
    });
    expect(collect.mock.calls[0]![1]).toEqual({
      runId: context.runId,
      signal: context.signal,
      log: context.log,
      progress: context.progress,
      planQueries: false,
    });
  });

  it("honors explicit agent, market, question and resource-limit selections", async () => {
    const { run, collect } = setup();

    await run({
      agents: ["bmw_sales", "bmw_strategy"],
      market: "CN",
      question: "What is published verbatim?",
      maxResults: 7,
      maxRequests: 4,
      maxDocumentPages: 2,
      timeoutMs: 1000,
      concurrency: 1,
    });

    expect(collect.mock.calls[0]![0]).toMatchObject({
      agents: ["bmw_sales", "bmw_strategy"],
      scope: { markets: ["CN"], questions: ["What is published verbatim?"] },
      limits: {
        maxResults: 7,
        maxRequests: 4,
        maxDocumentPages: 2,
        timeoutMs: 1000,
        concurrency: 1,
      },
    });
  });

  it("rejects an empty agent selection without defaulting to all paid providers", async () => {
    const { run, collect } = setup();

    await expect(run({ agents: [] })).rejects.toThrow(/no.*agents.*selected/i);

    expect(collect).not.toHaveBeenCalled();
  });

  it("forwards query-planning opt-in through collector context, not strict ResearchRequest", async () => {
    const { run, collect } = setup();
    await run({ queryPlanning: true });
    expect(collect.mock.calls[0]![1]).toMatchObject({ planQueries: true });
    expect(collect.mock.calls[0]![0]).not.toHaveProperty("queryPlanning");
    expect(collect.mock.calls[0]![0]).not.toHaveProperty("planQueries");
    expect(() => ResearchRequest.parse(collect.mock.calls[0]![0])).not.toThrow();
  });

  it("keeps global domain restrictions authoritative when advanced JSON tries to clear or widen them", async () => {
    const { run, collect, context } = setup();
    context.settings.research.allowedDomains = [" https://*.EXAMPLE.org./ "];
    context.settings.research.blockedDomains = ["blocked.example.org"];
    await run({
      scopeJson: JSON.stringify({
        allowedDomains: ["news.example.org", "other.org"],
        blockedDomains: ["scoped.example.org"],
      }),
    });
    expect(collect.mock.calls[0]![0].scope).toMatchObject({
      allowedDomains: ["news.example.org"],
      blockedDomains: ["blocked.example.org", "scoped.example.org"],
    });
    await run({ scopeJson: JSON.stringify({ allowedDomains: [], blockedDomains: [] }) });
    expect(collect.mock.calls[1]![0].scope).toMatchObject({
      allowedDomains: ["example.org"],
      blockedDomains: ["blocked.example.org"],
    });
  });

  it("rejects disjoint global and advanced allowlists before collection", async () => {
    const { run, collect, context } = setup();
    context.settings.research.allowedDomains = ["bmwgroup.com"];
    await expect(
      run({ scopeJson: JSON.stringify({ allowedDomains: ["other.org"] }) }),
    ).rejects.toThrow(/intersection/i);
    expect(collect).not.toHaveBeenCalled();
  });

  it("passes an imported file reference as a document ID without reading a renderer path", async () => {
    const { run, collect, context } = setup();

    await run({
      document: { fileId: "file_synthetic", name: "Synthetic original.txt" },
      agents: ["bmw_sales"],
    });

    expect(collect.mock.calls[0]![0].scope.documentIds).toEqual(["file_synthetic"]);
    expect(context.files.get).not.toHaveBeenCalled();
  });

  it("lets advanced JSON override default scope including the selected document IDs", async () => {
    const { run, collect } = setup();
    const advanced = {
      currentGeneration: "SYN-CURRENT",
      previousGeneration: "SYN-PREVIOUS",
      markets: ["EU", "US"],
      languages: ["de"],
      publishedFrom: "2025-01-01",
      publishedTo: "2026-10-10",
      documentIds: ["file_advanced"],
      competitors: [{ brand: "Synthetic", model: "Alternative" }],
    };

    await run({
      document: { fileId: "file_other", name: "Synthetic other.txt" },
      scopeJson: JSON.stringify(advanced),
    });

    expect(collect.mock.calls[0]![0].scope).toMatchObject(advanced);
  });

  it("retains raw original metadata in the stream without analysis or fabricated reliability", async () => {
    const { run, raw, context } = setup();

    const result = await run();

    const expectedRecords = await summarizeResearchDataset(raw, {
      llm: context.llm,
      scope: context.scope,
      signal: context.signal,
      concurrency: 3,
    });

    expect(result).toEqual({
      status: "ok",
      outputs: {
        out: { ...emptyPipelineData(), sources: raw.sources, records: expectedRecords },
      },
    });

    const [row] = expectedRecords;
    expect(row).toBeDefined();
    expect(row!.text).toContain("Synthetic original — unchanged.");
    expect(row!.fields).toMatchObject({
      Source: "local_documents",
    });
    expect(String(row!.fields!["Customer Feedback"] ?? "")).toContain(
      "Synthetic original — unchanged.",
    );

    // Verify original metadata and provenance are retained
    expect(row!.metadata.nested).toEqual({ extra: false });
    expect(row!.metadata.originalArtifact).toEqual({ fileId: "file_synthetic" });
    expect(row!.originalRecordId).toBe(raw.records[0]!.originalRecordId);
    expect(row!.originalSourceId).toBe(raw.records[0]!.originalSourceId);
    expect(row!.originalUrl).toBe(raw.records[0]!.originalUrl);
    expect(row!.provider).toBe(raw.records[0]!.provider);
    expect(row!.locator).toBe(raw.records[0]!.locator);
    expect(row!.sourceId).toBe(raw.records[0]!.sourceId);

    expect(raw.sources[0]?.reliability).toBeUndefined();
    expect(context.llm.generateText).not.toHaveBeenCalled();
    expect(context.car.add).not.toHaveBeenCalled();
  });

  it.each(["{", "[]", "null", '"synthetic text"', "17"])(
    "rejects invalid advanced JSON %j before collecting anything",
    async (scopeJson) => {
      const { run, collect } = setup();

      await expect(run({ scopeJson })).rejects.toThrow(/advanced research scope/i);

      expect(collect).not.toHaveBeenCalled();
    },
  );

  it.each([
    { scopeJson: JSON.stringify({ publishedFrom: "2026-10-10", publishedTo: "2025-01-01" }) },
    { scopeJson: JSON.stringify({ documentIds: ["../../synthetic.txt"] }) },
    { scopeJson: JSON.stringify({ path: "/tmp/synthetic.txt" }) },
    { document: { fileId: "/tmp/synthetic.txt", name: "Synthetic.txt" } },
    { maxResults: 0 },
    { maxRequests: 0 },
  ])("rejects invalid scope or limits %j before collection", async (params) => {
    const { run, collect } = setup();

    await expect(run(params)).rejects.toThrow();

    expect(collect).not.toHaveBeenCalled();
  });

  it("fails clearly when the main-process collector is unavailable", async () => {
    const { run, context } = setup();
    delete context.research;

    await expect(run()).rejects.toThrow("Research runtime is not configured in the main process.");
  });

  it("propagates collector failure rather than replacing it with invented output", async () => {
    const { run, collect } = setup();
    collect.mockRejectedValueOnce(new Error("Synthetic collection failure"));

    await expect(run()).rejects.toThrow("Synthetic collection failure");
  });

  it.each(["blocked", "missing_credentials", "error", "partial", "cancelled"] as const)(
    "fails an empty %s collection with detailed per-agent limitations",
    async (status) => {
      const { run, collect, raw } = setup();
      collect.mockResolvedValueOnce({
        ...raw,
        sources: [],
        records: [],
        results: [
          {
            agentId: "bmw_sales",
            status,
            recordIds: [],
            requests: 0,
            limitations: ["Synthetic explicit limitation."],
          },
        ],
      });
      await expect(run()).rejects.toThrow(
        new RegExp(`bmw_sales.*${status}.*Synthetic explicit limitation`, "s"),
      );
    },
  );

  it("completes a legitimate empty collection and retains partially collected originals", async () => {
    const { run, collect, raw, context } = setup();
    collect.mockResolvedValueOnce({
      ...raw,
      sources: [],
      records: [],
      results: [
        { agentId: "bmw_sales", status: "empty", recordIds: [], requests: 0, limitations: [] },
      ],
    });
    expect(await run()).toEqual({ status: "ok", outputs: { out: emptyPipelineData() } });
    collect.mockResolvedValueOnce({
      ...raw,
      results: raw.results.map((result) => ({
        ...result,
        status: "partial" as const,
        limitations: ["Synthetic later provider failed."],
      })),
    });
    const expected = await summarizeResearchDataset(raw, {
      llm: context.llm,
      scope: context.scope,
      signal: context.signal,
      concurrency: 3,
    });
    expect(await run()).toMatchObject({
      status: "ok",
      outputs: { out: { records: expected } },
    });
  });

  it.each(["blocked", "missing_credentials", "error"] as const)(
    "persists an empty %s dataset before the block fails",
    async (status) => {
      const { run, context } = setup();
      context.settings.research.provider = status === "blocked" ? "off" : "firecrawl";
      context.settings.research.apis.firecrawl.enabled = true;
      const save = vi.fn(async (_dataset: ResearchDataset) => {});
      const adapter: ProviderAdapter = {
        id: "firecrawl",
        collect: vi.fn(async () => {
          throw new Error("Synthetic provider failure");
        }),
        test: vi.fn(),
      };
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        throw new Error("Unexpected network call");
      });
      context.research = createResearchCollector({
        settings: context.settings,
        credentials: status === "error" ? { firecrawl_api_key: "synthetic-key" } : {},
        adapters: new Map([["firecrawl", adapter]]),
        save,
        fetchImpl,
      });
      await expect(run({ agents: ["owner_forums"] })).rejects.toThrow(
        new RegExp(`owner_forums.*${status}`),
      );
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0]![0]).toMatchObject({
        records: [],
        sources: [],
        results: [{ agentId: "owner_forums", status, requests: 0, recordIds: [] }],
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});
