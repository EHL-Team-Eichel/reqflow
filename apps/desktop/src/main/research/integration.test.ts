import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileStore, createDatabase, SqliteRunRepository } from "@reqflow/db";
import { allBlockImplementations } from "@reqflow/blocks";
import { BlockRegistry, defineBlock } from "@reqflow/engine";
import {
  DEFAULT_SETTINGS,
  ResearchProviderConfig,
  WorkflowRun,
  Workflow,
  createBlock,
  connect,
  emptyPipelineData,
  type WorkflowBlock,
} from "@reqflow/core";
import { createHandlers, type HandlerDeps } from "../handlers";
import { SecretsStore, type SecureStorage } from "../secrets";
import { ResearchDatasetRepository } from "../../../../../packages/db/src/research";
import { syntheticSourceReviewLlm } from "./smoke-fixture";

vi.mock("electron", () => {
  throw new Error("Synthetic tests must stay Electron-free");
});
const seams = vi.hoisted(() => ({
  documentReads: [] as ReturnType<typeof vi.fn>[],
  llmOptions: [] as unknown[],
  collectorSettings: [] as unknown[],
  generateObjectCalls: [] as { tier?: string; prompt: string; schema: any }[],
  generateObjectImpl: undefined as
    | ((req: {
        tier?: string;
        prompt: string;
        schema: any;
      }) => Promise<{ model: string; object: unknown }>)
    | undefined,
}));
vi.mock("@reqflow/blocks", async (original) => {
  const actual = await original<typeof import("@reqflow/blocks")>();
  return {
    ...actual,
    createResearchCollector(options: Parameters<typeof actual.createResearchCollector>[0]) {
      seams.collectorSettings.push(structuredClone(options.settings));
      return actual.createResearchCollector(options);
    },
    createLocalDocumentReader(options: Parameters<typeof actual.createLocalDocumentReader>[0]) {
      const reader = actual.createLocalDocumentReader(options);
      const read = vi.fn(reader.read);
      seams.documentReads.push(read);
      return { ...reader, read };
    },
  };
});
vi.mock("@reqflow/llm", async (original) => {
  const actual = await original<typeof import("@reqflow/llm")>();
  return {
    ...actual,
    createLlmClient(...args: Parameters<typeof actual.createLlmClient>) {
      seams.llmOptions.push(args);
      return {
        generateText: async () => ({ text: "Synthetic analysis", model: "synthetic" }),
        generateObject: async (req: any) => {
          seams.generateObjectCalls.push(req);
          if (seams.generateObjectImpl) {
            return seams.generateObjectImpl(req);
          }
          throw new Error("No synthetic object requested");
        },
      };
    },
  };
});
const storage: SecureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`cipher:${text.split("").reverse().join("")}`),
  decryptString: (bytes) => {
    const text = bytes.toString();
    if (!text.startsWith("cipher:")) throw new Error("invalid cipher");
    return text.slice(7).split("").reverse().join("");
  },
};
const at = "2026-10-10T12:00:00.000Z";
let dir: string;
let handlers: ReturnType<typeof createHandlers>;
let deps: HandlerDeps;
let updates: WorkflowRun[];
let fetched: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reqflow-sqlite-research-"));
  updates = [];
  seams.documentReads.length = 0;
  seams.llmOptions.length = 0;
  seams.collectorSettings.length = 0;
  seams.generateObjectCalls.length = 0;
  seams.generateObjectImpl = undefined;
  fetched = vi.fn<typeof fetch>(async () => {
    throw new Error("No live calls allowed");
  });
  deps = {
    appInfo: () => ({ version: "synthetic", platform: "darwin", dataDir: dir, isPackaged: false }),
    files: createFileStore(join(dir, "uploads")),
    pickFile: async () => null,
    secretsStore: new SecretsStore(dir, { secureStorage: storage, environment: {} }),
    researchOptions: { fetchImpl: fetched, sourceReviewLlm: syntheticSourceReviewLlm },
    pushRunUpdate: (run) => {
      updates.push(run);
    },
    saveDialog: async () => ({ canceled: true, filePath: "" }),
  };
  handlers = createHandlers(deps);
  await handlers.app.info();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
const research = (id: string, params: Record<string, unknown> = {}): WorkflowBlock => {
  const block = createBlock("research", { id, position: { x: 0, y: 0 } });
  return {
    ...block,
    params: { ...block.params, agents: ["bmw_sales", "bmw_strategy"], ...params },
  };
};
async function save(blocks: WorkflowBlock[], edges: Workflow["edges"] = []) {
  return handlers.workflows.save({
    name: "Synthetic integrated flow",
    scope: structuredClone(DEFAULT_SETTINGS.defaultScope),
    blocks,
    edges,
  });
}
async function wait(runId: string, status = "completed") {
  await vi.waitFor(async () => expect((await handlers.runs.get(runId)).status).toBe(status), {
    timeout: 3000,
    interval: 5,
  });
  return handlers.runs.get(runId);
}
async function document() {
  const path = join(dir, "synthetic.txt");
  await writeFile(path, "Synthetic deliveries 7.\nSynthetic original strategy.\n");
  return deps.files.importFile(path);
}

describe("one authoritative main/SQLite Research integration", () => {
  it("requires source assessment in production wiring and excludes failed Quality reviews without losing originals", async () => {
    deps.researchOptions!.sourceReviewLlm = undefined;
    handlers = createHandlers(deps);
    const settings = await handlers.settings.get();
    await handlers.settings.save({
      ...settings,
      llm: {
        ...settings.llm,
        provider: "google",
        model: "synthetic-quality-model",
        fastModel: "synthetic-fast-model",
      },
    });
    await handlers.settings.setSecret("google_api_key", "synthetic-review-key");
    const file = await document();
    const workflow = await save([
      research("research", { document: { fileId: file.id, name: file.name } }),
    ]);
    const queued = await handlers.runs.start(workflow.id);
    const run = await wait(queued.id);
    const dataset = await handlers.research.dataset(run.id);
    expect(dataset.records).toHaveLength(1);
    expect(dataset.records[0]!.text).toContain("Synthetic deliveries 7.");
    expect(dataset.records[0]!.fields!.researchAssessments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: "bmw_sales", verdict: "unreviewed" }),
        expect.objectContaining({ agentId: "bmw_strategy", verdict: "unreviewed" }),
      ]),
    );
    expect((await handlers.runs.blockOutput(run.id, "research")).out?.records).toEqual([]);
    expect(dataset.results.every((result) => result.status === "partial")).toBe(true);
    expect(seams.llmOptions).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            provider: "google",
            model: "synthetic-quality-model",
            fastModel: "synthetic-fast-model",
          }),
          expect.objectContaining({ apiKey: "synthetic-review-key" }),
        ],
      ]),
    );
    expect(fetched).not.toHaveBeenCalled();
  });
  it("rejects non-relevant sources using configured Quality model without extra Fast calls: preserves archive while usable block output records are empty", async () => {
    deps.researchOptions!.sourceReviewLlm = undefined;
    handlers = createHandlers(deps);
    const settings = await handlers.settings.get();
    await handlers.settings.save({
      ...settings,
      llm: {
        ...settings.llm,
        provider: "google",
        model: "synthetic-quality-model",
        fastModel: "synthetic-fast-model",
      },
    });
    await handlers.settings.setSecret("google_api_key", "synthetic-review-key");
    seams.generateObjectImpl = async (req) => ({
      model: "synthetic-quality-model",
      object: req.schema.parse({
        verdict: "irrelevant",
        reason: "Synthetic irrelevant source.",
        uncertainty: "Not relevant to assignment.",
        summary: "",
        excerpts: [],
        tableRows: [],
      }),
    });
    const file = await document();
    const workflow = await save([
      research("research", { document: { fileId: file.id, name: file.name } }),
    ]);
    const queued = await handlers.runs.start(workflow.id);
    const run = await wait(queued.id);
    const dataset = await handlers.research.dataset(run.id);

    // Archive preserved with original records, source, and assessments
    expect(dataset.records).toHaveLength(1);
    expect(dataset.sources).toHaveLength(1);
    expect(dataset.records[0]!.fields!.researchAssessments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: "bmw_sales", verdict: "irrelevant" }),
        expect.objectContaining({ agentId: "bmw_strategy", verdict: "irrelevant" }),
      ]),
    );

    // Usable block output records are empty (source rejected)
    const blockOutput = await handlers.runs.blockOutput(run.id, "research");
    expect(blockOutput.out?.records).toEqual([]);
    const referencedSources = (blockOutput.out?.sources ?? []).filter((source) =>
      blockOutput.out?.records?.some((record) => record.sourceId === source.id),
    );
    expect(referencedSources).toEqual([]);

    // Main configured Quality model used for assessment summary and no additional Fast calls
    expect(seams.generateObjectCalls.length).toBeGreaterThan(0);
    expect(seams.generateObjectCalls.every((call) => call.tier === "default")).toBe(true);
    expect(seams.generateObjectCalls.some((call) => call.tier === "fast")).toBe(false);
  });
  it.each(["queued", "running"] as const)(
    "recovers interrupted %s runs without active block states or lost artifacts, exactly once",
    async (status) => {
      const workflow = await save([createBlock("raw", { id: "raw", position: { x: 0, y: 0 } })]);
      const run = WorkflowRun.parse({
        id: "run_interrupted",
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        graph: { blocks: workflow.blocks, edges: workflow.edges },
        scope: workflow.scope,
        startedBy: { type: "system", component: "synthetic" },
        startedAt: at,
        status,
        blockRuns: [
          {
            blockId: "done",
            status: "succeeded",
            counts: { records: 1 },
            logs: [{ at, message: "Synthetic finished" }],
            finishedAt: at,
          },
          { blockId: "raw", status: "running", counts: {}, logs: [] },
          { blockId: "pending", status: "pending", counts: {}, logs: [] },
          {
            blockId: "failed",
            status: "failed",
            counts: {},
            logs: [],
            error: "Synthetic original failure",
            finishedAt: at,
          },
        ],
      });
      const db = createDatabase(join(dir, "reqflow.db"));
      try {
        const runs = new SqliteRunRepository(db);
        await runs.create(run);
        const outputs = { out: emptyPipelineData() };
        await runs.saveBlockOutput(run.id, "done", outputs);
        const datasets = new ResearchDatasetRepository(db);
        datasets.saveSettings(run.id, DEFAULT_SETTINGS);
        const dataset = {
          schemaVersion: 1 as const,
          runId: run.id,
          sources: [],
          records: [],
          results: [],
          retrievedAt: at,
          synthetic: true,
        };
        datasets.save(run.id, "raw", dataset, dataset);
        const restarted = createHandlers(deps);
        const recovered = await restarted.runs.get(run.id);
        expect(recovered.status).toBe("failed");
        expect(recovered.blockRuns.map((block) => block.status)).toEqual([
          "succeeded",
          "failed",
          "skipped",
          "failed",
        ]);
        expect(recovered.blockRuns[0]).toEqual(run.blockRuns[0]);
        expect(recovered.blockRuns[3]).toEqual(run.blockRuns[3]);
        expect(recovered.blockRuns[1]?.error).toBe(recovered.error);
        expect(recovered.blockRuns[2]?.finishedAt).toBe(recovered.finishedAt);
        expect(await restarted.runs.blockOutput(run.id, "done")).toEqual(outputs);
        expect(await restarted.research.dataset(run.id)).toEqual(dataset);
        expect(datasets.settings(run.id)).toEqual(DEFAULT_SETTINGS);
        expect(await restarted.audit.list({ runId: run.id, action: "run.failed" })).toHaveLength(1);
        const again = createHandlers(deps);
        expect(await again.runs.get(run.id)).toEqual(recovered);
        expect(await again.audit.list({ runId: run.id, action: "run.failed" })).toHaveLength(1);
        expect(fetched).not.toHaveBeenCalled();
        expect(updates).toEqual([]);
      } finally {
        db.close();
      }
    },
  );
  it("rolls back recovery if its audit cannot be saved, then retries on the next startup", async () => {
    const workflow = await save([createBlock("raw", { id: "raw", position: { x: 0, y: 0 } })]);
    const run = WorkflowRun.parse({
      id: "run_recovery_fault",
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      graph: { blocks: workflow.blocks, edges: workflow.edges },
      scope: workflow.scope,
      startedBy: { type: "system", component: "synthetic" },
      startedAt: at,
      status: "running",
      blockRuns: [{ blockId: "raw", status: "running", counts: {}, logs: [] }],
    });
    const db = createDatabase(join(dir, "reqflow.db"));
    try {
      const runs = new SqliteRunRepository(db);
      await runs.create(run);
      db.exec(`CREATE TRIGGER synthetic_recovery_fault BEFORE INSERT ON audit_events
        WHEN NEW.action = 'run.failed' BEGIN SELECT RAISE(ABORT, 'synthetic recovery SQL fault'); END;`);
      await expect(createHandlers(deps).app.info()).rejects.toMatchObject({
        code: "storage_error",
      });
      expect(await runs.get(run.id)).toEqual(run);
      db.exec("DROP TRIGGER synthetic_recovery_fault");
      const restarted = createHandlers(deps);
      expect((await restarted.runs.get(run.id)).status).toBe("failed");
      expect(await restarted.audit.list({ runId: run.id, action: "run.failed" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });
  it("rolls back a failed initial snapshot without launching work, publishing queued, or rolling back another run", async () => {
    const ran = vi.fn();
    deps.registry = new BlockRegistry([
      defineBlock({
        kind: "raw",
        async run() {
          ran();
          return { status: "ok", outputs: { out: emptyPipelineData() } };
        },
      }),
    ]);
    handlers = createHandlers(deps);
    const first = await save([createBlock("raw", { id: "raw", position: { x: 0, y: 0 } })]);
    const second = await save([createBlock("raw", { id: "raw", position: { x: 0, y: 0 } })]);
    const original = ResearchDatasetRepository.prototype.saveSettings;
    let failedId: string | undefined;
    const snapshot = vi
      .spyOn(ResearchDatasetRepository.prototype, "saveSettings")
      .mockImplementation(function (this: ResearchDatasetRepository, id, settings) {
        failedId ??= id;
        if (id === failedId) throw new Error("Synthetic snapshot write fault");
        original.call(this, id, settings);
      });
    const results = await Promise.allSettled([
      handlers.runs.start(first.id),
      handlers.runs.start(second.id),
    ]);
    expect(results[0]).toMatchObject({ status: "rejected" });
    expect(results[1]).toMatchObject({ status: "fulfilled" });
    const healthy = results[1];
    if (healthy?.status !== "fulfilled") throw new Error("Expected a healthy concurrent start");
    await wait(healthy.value.id);
    await vi.waitFor(() =>
      expect(snapshot.mock.calls.filter(([id]) => id === failedId).length).toBeGreaterThanOrEqual(
        2,
      ),
    );
    expect(ran).toHaveBeenCalledTimes(1);
    expect(updates.some((run) => run.id === failedId)).toBe(false);
    expect((await handlers.runs.list()).map((run) => run.id)).toEqual([healthy.value.id]);
    snapshot.mockRestore();
    const retry = await handlers.runs.start(first.id);
    await wait(retry.id);
    expect(ran).toHaveBeenCalledTimes(2);
  });
  it("admits only one concurrent start and persists the run/snapshot before every first IPC update", async () => {
    const db = createDatabase(join(dir, "reqflow.db"));
    let observed = 0;
    deps.pushRunUpdate = (run) => {
      if (run.status !== "queued") return;
      expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id)).toEqual({
        status: "queued",
      });
      const row = db.prepare("SELECT json FROM run_settings WHERE run_id = ?").get(run.id) as {
        json: string;
      };
      expect(JSON.parse(row.json)).toEqual(DEFAULT_SETTINGS);
      observed++;
    };
    try {
      const file = await document();
      const workflow = await save([
        research("research", { document: { fileId: file.id, name: file.name } }),
      ]);
      const starts = await Promise.allSettled([
        handlers.runs.start(workflow.id),
        handlers.runs.start(workflow.id),
      ]);
      expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(starts.find((result) => result.status === "rejected")).toMatchObject({
        reason: { code: "run_busy" },
      });
      const started = starts.find((result) => result.status === "fulfilled");
      if (started?.status !== "fulfilled") throw new Error("Expected a queued run");
      await wait(started.value.id);
      expect(observed).toBe(1);
      expect(seams.documentReads[0]).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
  it("persists queued run before collection; shares per-run cache across agents/blocks; exports and reloads raw provenance", async () => {
    const file = await document();
    const blockParams = { document: { fileId: file.id, name: file.name } };
    const workflow = await save([research("first", blockParams), research("second", blockParams)]);
    const queued = await handlers.runs.start(workflow.id);
    expect(queued.status).toBe("queued");
    const run = await wait(queued.id);
    const dataset = await handlers.research.dataset(run.id);
    expect(dataset.records).toHaveLength(1);
    expect(dataset.records[0]).toMatchObject({
      text: "Synthetic deliveries 7.\nSynthetic original strategy.\n",
      collectingAgents: ["bmw_sales", "bmw_strategy"],
      runIds: [run.id],
    });
    expect(seams.documentReads[0]).toHaveBeenCalledTimes(1);
    expect(fetched).not.toHaveBeenCalled();
    expect(updates[0]?.status).toBe("queued");
    const db = createDatabase(join(dir, "reqflow.db"));
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id)).toEqual({
      status: "completed",
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM research_datasets WHERE run_id = ?").get(run.id),
    ).toEqual({ count: 3 });
    db.close();
    deps.saveDialog = async () => ({ canceled: false, filePath: join(dir, "export.json") });
    expect(await handlers.exports.research({ runId: run.id, format: "json" })).toEqual({
      path: join(dir, "export.json"),
    });
    expect(JSON.parse(await readFile(join(dir, "export.json"), "utf8"))).toEqual(dataset);
    const restored = createHandlers(deps);
    expect(await restored.research.dataset(run.id)).toEqual(dataset);
    expect((await restored.runs.blockOutput(run.id, "first")).out?.records[0]).toMatchObject({
      id: dataset.records[0]!.id,
      recordType: "passage",
      text: expect.stringContaining("Synthetic deliveries 7."),
      collectingAgents: ["bmw_sales", "bmw_strategy"],
      metadata: expect.objectContaining({ textOrigin: "ai_summary" }),
      fields: expect.objectContaining({
        Brand: null,
        "Derivate (e-code)": null,
        "Sales Description": null,
        "Customer Feedback": expect.stringContaining("Synthetic source summary:"),
        "Original Evidence": expect.stringContaining("Synthetic deliveries 7."),
      }),
    });
    await expect(readFile(join(dir, "app-state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps dedicated provider flags authoritative against stale Settings autosaves", async () => {
    const stale = await handlers.settings.get();
    await handlers.research.configure(
      "reddit",
      ResearchProviderConfig.parse({ enabled: true, approval: "granted" }),
    );
    stale.app.theme = "dark";
    stale.llm.modelProfiles = { openai: { model: "custom-quality", fastModel: "custom-fast" } };
    const saved = await handlers.settings.save(stale);
    expect(saved.research.apis.reddit).toMatchObject({ enabled: true, approval: "granted" });
    expect(saved.llm.modelProfiles?.openai?.model).toBe("custom-quality");
    await handlers.research.configure(
      "reddit",
      ResearchProviderConfig.parse({ enabled: false, approval: "not_granted" }),
    );
    await handlers.settings.save(saved);
    expect((await handlers.settings.get()).research.apis.reddit).toMatchObject({
      enabled: false,
      approval: "not_granted",
    });
    await handlers.research.test("reddit");
    expect(fetched).not.toHaveBeenCalled();
  });
  it("applies provider and domain gates without calls and persists failed empty collection outcomes", async () => {
    const settings = await handlers.settings.get();
    settings.research.provider = "firecrawl";
    settings.research.allowedDomains = ["bmwgroup.com"];
    await handlers.settings.save(settings);
    await handlers.settings.setSecret("firecrawl_api_key", "synthetic-private-firecrawl");
    await handlers.research.configure(
      "firecrawl",
      ResearchProviderConfig.parse({ enabled: false }),
    );
    const workflow = await save([research("research", { agents: ["owner_forums"] })]);
    const queued = await handlers.runs.start(workflow.id);
    await wait(queued.id, "failed");
    expect((await handlers.research.dataset(queued.id)).results[0]?.status).toBe("blocked");
    expect(fetched).not.toHaveBeenCalled();
    expect(
      JSON.stringify([await handlers.runs.get(queued.id), await handlers.audit.list(), updates]),
    ).not.toContain("synthetic-private-firecrawl");
    await expect(handlers.workflows.get("wf_../../outside")).rejects.toThrow();
  });
  it("persists partial collection and earlier output before cancellation returns", async () => {
    const file = await document();
    await handlers.settings.setSecret("firecrawl_api_key", "synthetic-private-firecrawl");
    await handlers.research.configure("firecrawl", ResearchProviderConfig.parse({ enabled: true }));
    const settings = await handlers.settings.get();
    settings.research.provider = "firecrawl";
    await handlers.settings.save(settings);
    let entered!: () => void;
    const fetching = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fetched.mockImplementation(async (_url, init) => {
      const query = JSON.parse(String(init?.body)).query as string;
      if (query.includes("owner forum discussions")) {
        entered();
        return new Promise<Response>(() => {});
      }
      return Response.json({ success: true, data: { web: [] } });
    });
    const workflow = await save([
      research("earlier", {
        agents: ["bmw_sales"],
        document: { fileId: file.id, name: file.name },
      }),
      research("later", { agents: ["owner_forums"] }),
    ]);
    const queued = await handlers.runs.start(workflow.id);
    await fetching;
    const earlier = await handlers.runs.blockOutput(queued.id, "earlier");
    const db = createDatabase(join(dir, "reqflow.db"));
    let terminalObserved = false;
    deps.pushRunUpdate = (run) => {
      if (run.status !== "cancelled") return;
      expect(
        new ResearchDatasetRepository(db)
          .get(run.id)
          ?.results.find((result) => result.agentId === "owner_forums")?.status,
      ).toBe("cancelled");
      expect(
        db
          .prepare("SELECT outputs FROM block_outputs WHERE run_id = ? AND block_id = ?")
          .get(run.id, "earlier"),
      ).toEqual({ outputs: JSON.stringify(earlier) });
      expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id)).toEqual({
        status: "cancelled",
      });
      terminalObserved = true;
    };
    const cancelled = await handlers.runs.cancel(queued.id);
    db.close();
    expect(cancelled.status).toBe("cancelled");
    expect(terminalObserved).toBe(true);
    const dataset = await handlers.research.dataset(queued.id);
    expect(dataset.records).toHaveLength(1);
    expect(dataset.results.find((r) => r.agentId === "owner_forums")?.status).toBe("cancelled");
    expect(await handlers.runs.blockOutput(queued.id, "earlier")).toEqual(earlier);
  });
  it.each(["disable", "remove-key", "web-off", "allowlist", "blocklist"] as const)(
    "revokes active transport on %s, preserving earlier originals without a following scrape",
    async (change) => {
      const file = await document();
      await handlers.settings.setSecret("firecrawl_api_key", "synthetic-revocation-key");
      await handlers.research.configure(
        "firecrawl",
        ResearchProviderConfig.parse({ enabled: true }),
      );
      const settings = await handlers.settings.get();
      settings.research.provider = "firecrawl";
      await handlers.settings.save(settings);
      let entered!: () => void;
      let release!: (response: Response) => void;
      const fetching = new Promise<void>((resolve) => {
        entered = resolve;
      });
      fetched.mockImplementation(async (url, init) => {
        if (String(url).endsWith("/scrape")) throw new Error("Revoked scrape must never dispatch");
        const query = JSON.parse(String(init?.body)).query as string;
        if (query.includes("owner forum discussions")) {
          entered();
          // Deliberately ignore AbortSignal: the real HTTP wrapper must prevent
          // the late response from starting another request or becoming evidence.
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }
        return Response.json({ success: true, data: { web: [] } });
      });
      const workflow = await save([
        research("earlier", {
          agents: ["bmw_sales"],
          document: { fileId: file.id, name: file.name },
        }),
        research("later", { agents: ["owner_forums"] }),
      ]);
      const queued = await handlers.runs.start(workflow.id);
      await fetching;
      const earlier = await handlers.runs.blockOutput(queued.id, "earlier");
      const preserved = (await handlers.research.dataset(queued.id)).records;
      expect(preserved).toHaveLength(1);
      if (change === "disable") {
        await handlers.research.configure(
          "firecrawl",
          ResearchProviderConfig.parse({ enabled: false }),
        );
      } else if (change === "remove-key") {
        await handlers.settings.setSecret("firecrawl_api_key", null);
      } else {
        const changed = await handlers.settings.get();
        if (change === "web-off") changed.research.provider = "off";
        if (change === "allowlist") changed.research.allowedDomains = ["bmwgroup.com"];
        if (change === "blocklist") changed.research.blockedDomains = ["example.org"];
        await handlers.settings.save(changed);
      }
      // Cancellation settles even though the synthetic transport has not returned.
      await wait(queued.id, "failed");
      release(
        Response.json({
          success: true,
          data: {
            web: [{ url: "https://example.org/revoked", title: "Revoked synthetic source" }],
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetched.mock.calls.filter(([url]) => String(url).endsWith("/scrape"))).toHaveLength(0);
      const dataset = await handlers.research.dataset(queued.id);
      expect(dataset.records).toEqual(preserved);
      expect(dataset.results.find((result) => result.agentId === "owner_forums")?.status).toBe(
        "cancelled",
      );
      expect(await handlers.runs.blockOutput(queued.id, "earlier")).toEqual(earlier);
    },
  );
  it("restores paused HIL with outputs/settings; preserves upstream evidence, decisions/reset and Car numbering", async () => {
    const file = await document();
    const hil = createBlock("hil", { id: "review", position: { x: 200, y: 0 } });
    const car = createBlock("add_to_car", { id: "car", position: { x: 400, y: 0 } });
    // This test proves Research and upstream services share one executor; synthetic feedback
    // remains deterministic and contains enough repeated signals for Add to Car.
    const registry = new BlockRegistry([
      ...allBlockImplementations.filter((b) => b.kind !== "raw"),
      defineBlock({
        kind: "raw",
        async run() {
          const at = new Date().toISOString();
          return {
            status: "ok",
            outputs: {
              out: {
                ...emptyPipelineData(),
                sources: [
                  {
                    id: "src_synthetic",
                    kind: "customer_feedback",
                    origin: "bmw_internal",
                    title: "Synthetic feedback",
                    retrievedAt: at,
                    reliability: "high",
                  },
                ],
                records: [
                  "The rear seats are uncomfortable on long journeys",
                  "The rear seats are uncomfortable and need better support",
                ].map((text, i) => ({
                  id: `rec_synthetic_${i}`,
                  sourceId: "src_synthetic",
                  text,
                  fields: {},
                })),
              },
            },
          };
        },
      }),
    ]);
    deps.registry = registry;
    handlers = createHandlers(deps);
    const raw = createBlock("raw", { id: "raw", position: { x: 0, y: 100 } });
    let graph = connect(
      {
        blocks: [
          research("research", { document: { fileId: file.id, name: file.name } }),
          raw,
          hil,
          car,
        ],
        edges: [],
      },
      { source: "raw", sourcePort: "out", target: "review", targetPort: "in" },
    );
    graph = connect(graph, {
      source: "review",
      sourcePort: "out",
      target: "car",
      targetPort: "in-0",
    });
    const workflow = await save(graph.blocks, graph.edges);
    const queued = await handlers.runs.start(workflow.id);
    await wait(queued.id, "waiting_for_review");
    const dataset = await handlers.research.dataset(queued.id);
    const restarted = createHandlers(deps);
    const resumed = await restarted.runs.resume(queued.id);
    expect(resumed.status).toBe("completed");
    expect(await restarted.research.dataset(queued.id)).toEqual(dataset);
    const requirements = await restarted.requirements.list();
    expect(requirements.length).toBeGreaterThan(0);
    const first = requirements[0]!;
    expect((await restarted.requirements.get(first.id)).records.length).toBeGreaterThan(0);
    const approved = await restarted.requirements.decide(first.id, {
      decision: "approve",
      rationale: "Synthetic PM review",
    });
    expect(approved.status).toBe("approved");
    await restarted.requirements.edit(first.id, {
      title: "Synthetic revised requirement",
      rationale: "Synthetic clarification",
    });
    expect(await restarted.requirements.reset()).toEqual({ removed: requirements.length });
    expect(await restarted.requirements.list()).toEqual([]);
    const history = await restarted.audit.list({ entityId: first.id });
    expect(history.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "requirement.status_changed",
        "requirement.edited",
        "requirement.deleted",
      ]),
    );
    handlers = restarted;
    const next = await handlers.runs.start(workflow.id);
    await wait(next.id, "waiting_for_review");
    await handlers.runs.resume(next.id);
    expect(Number((await handlers.requirements.list())[0]!.id.split("-").at(-1))).toBeGreaterThan(
      Number(first.id.split("-").at(-1)),
    );
    expect(fetched).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "restores frozen Research settings after HIL while enforcing live revocation=%s",
    async (revoked) => {
      await handlers.settings.setSecret("firecrawl_api_key", "synthetic-firecrawl");
      await handlers.research.configure(
        "firecrawl",
        ResearchProviderConfig.parse({ enabled: true }),
      );
      const settings = await handlers.settings.get();
      settings.research.provider = "firecrawl";
      settings.research.maxResultsPerQuery = 3;
      await handlers.settings.save(settings);
      const implementation = allBlockImplementations.find((block) => block.kind === "research")!;
      deps.registry = new BlockRegistry([
        ...allBlockImplementations.filter((block) => !["raw", "ai_filter"].includes(block.kind)),
        defineBlock({
          kind: "raw",
          async run() {
            return {
              status: "ok",
              outputs: {
                out: {
                  ...emptyPipelineData(),
                  sources: [
                    {
                      id: "src_synthetic_review",
                      kind: "customer_feedback",
                      origin: "bmw_internal",
                      title: "Synthetic review source",
                      retrievedAt: at,
                    },
                  ],
                },
              },
            };
          },
        }),
        // A dependent synthetic block exercises the exact engine Research service seam
        // after HIL; Research itself is a source-only block with no input ports.
        defineBlock({
          kind: "ai_filter",
          async run(_inputs, _params, ctx) {
            return implementation.run(
              {},
              research("synthetic", { agents: ["owner_forums"] }).params,
              ctx,
            );
          },
        }),
      ]);
      handlers = createHandlers(deps);
      const blocks = [
        createBlock("raw", { id: "raw", position: { x: 0, y: 0 } }),
        createBlock("hil", { id: "review", position: { x: 200, y: 0 } }),
        createBlock("ai_filter", { id: "collect", position: { x: 400, y: 0 } }),
      ];
      let graph = connect(
        { blocks, edges: [] },
        { source: "raw", sourcePort: "out", target: "review", targetPort: "in" },
      );
      graph = connect(graph, {
        source: "review",
        sourcePort: "out",
        target: "collect",
        targetPort: "in",
      });
      const workflow = await save(graph.blocks, graph.edges);
      const queued = await handlers.runs.start(workflow.id);
      await wait(queued.id, "waiting_for_review");
      expect(fetched).not.toHaveBeenCalled();
      const changed = await handlers.settings.get();
      changed.research.provider = "tavily";
      changed.research.maxResultsPerQuery = 9;
      await handlers.settings.save(changed);
      if (revoked)
        await handlers.research.configure(
          "firecrawl",
          ResearchProviderConfig.parse({ enabled: false }),
        );
      fetched.mockImplementation(async () => Response.json({ success: true, data: { web: [] } }));
      const restarted = createHandlers(deps);
      const resumed = await restarted.runs.resume(queued.id);
      expect(resumed.status).toBe(revoked ? "failed" : "completed");
      if (revoked) {
        expect(fetched).not.toHaveBeenCalled();
        expect((await restarted.research.dataset(queued.id)).results[0]?.status).toBe("blocked");
      } else {
        expect(fetched).toHaveBeenCalled();
        for (const [url, init] of fetched.mock.calls) {
          expect(String(url)).toContain("firecrawl");
          // Adapter limits come from this block's ResearchRequest, not the legacy
          // global maxResultsPerQuery field. Verify the actual frozen service input below.
          expect(JSON.parse(String(init?.body)).limit).toBe(10);
        }
      }
      expect(seams.collectorSettings).toHaveLength(1);
      expect(seams.collectorSettings[0]).toMatchObject({
        research: {
          provider: "firecrawl",
          maxResultsPerQuery: 3,
          apis: { firecrawl: { enabled: !revoked } },
        },
      });
      const db = createDatabase(join(dir, "reqflow.db"));
      expect(new ResearchDatasetRepository(db).settings(queued.id)?.research).toMatchObject({
        provider: "firecrawl",
        maxResultsPerQuery: 3,
      });
      db.close();
    },
  );
  it("migrates synthetic legacy settings/workflows/runs/files/datasets/audit additively and never changes originals", async () => {
    const fileId = "file_legacy_document",
      runId = "run_legacy",
      workflowId = "wf_legacy";
    await mkdir(join(dir, "uploads"), { recursive: true });
    const fileContents = "Synthetic legacy original text";
    await writeFile(join(dir, "uploads", `${fileId}.txt`), fileContents);
    const file = {
      id: fileId,
      name: "Legacy synthetic.txt",
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(fileContents),
      importedAt: at,
      extension: ".txt",
    };
    const block = research("research", { document: { fileId, name: file.name } });
    const workflow = Workflow.parse({
      id: workflowId,
      name: "Legacy synthetic workflow",
      version: 3,
      createdAt: at,
      updatedAt: at,
      scope: DEFAULT_SETTINGS.defaultScope,
      blocks: [block],
      edges: [],
    });
    const run = WorkflowRun.parse({
      id: runId,
      workflowId,
      workflowVersion: 3,
      graph: { blocks: [block], edges: [] },
      scope: workflow.scope,
      startedBy: { type: "system", component: "synthetic" },
      startedAt: at,
      status: "running",
      blockRuns: [],
    });
    const legacySettings = structuredClone(DEFAULT_SETTINGS);
    legacySettings.app.theme = "dark";
    const source = {
      id: "src_legacy",
      kind: "other_web",
      origin: "bmw_internal",
      title: "Synthetic legacy",
      retrievedAt: at,
    };
    const record = {
      id: "rec_legacy",
      sourceId: "src_legacy",
      text: fileContents,
      recordType: "passage",
      provider: "local_documents",
      originalSourceId: fileId,
      originalRecordId: `${fileId}:text`,
      originalUrl: `reqflow-file:///${fileId}`,
      collectingAgents: ["bmw_sales"],
      runIds: [runId],
      retrievedAt: at,
      datePrecision: "unknown",
      contentHash: "synthetic",
      limitations: [],
      metadata: { originalArtifact: { fileId } },
    };
    const dataset = {
      schemaVersion: 1,
      runId,
      sources: [source],
      records: [record],
      results: [],
      retrievedAt: at,
      synthetic: true,
    };
    const outputs = {
      research: { out: { ...emptyPipelineData(), sources: [source], records: [record] } },
    };
    const originals = {
      "app-state.json": { settings: legacySettings, workflows: [workflow], runs: [run] },
      "files.json": [file],
      [`${runId}.research.json`]: dataset,
      [`${runId}.outputs.json`]: outputs,
      "audit.json": [
        {
          id: "aud_legacy",
          at,
          actor: { type: "system", component: "synthetic" },
          action: "workflow.saved",
          entityType: "workflow",
          entityId: workflowId,
          changes: [],
        },
      ],
    };
    for (const [name, value] of Object.entries(originals))
      await writeFile(join(dir, name), JSON.stringify(value));
    handlers = createHandlers(deps);
    expect((await handlers.settings.get()).app.theme).toBe("dark");
    expect((await handlers.workflows.get(workflowId)).version).toBe(3);
    expect((await handlers.runs.get(runId)).status).toBe("failed");
    expect(await handlers.runs.blockOutput(runId, "research")).toEqual(outputs.research);
    expect((await handlers.research.dataset(runId)).records[0]?.metadata).toEqual(record.metadata);
    expect(Buffer.from((await deps.files.get(fileId)).bytes).toString()).toBe(fileContents);
    expect((await handlers.audit.list()).map((event) => event.id)).toContain("aud_legacy");
    for (const [name, value] of Object.entries(originals))
      expect(await readFile(join(dir, name), "utf8")).toBe(JSON.stringify(value));
    expect(await readFile(join(dir, "uploads", `${fileId}.txt`), "utf8")).toBe(fileContents);
    await deps.files.remove(fileId);
    expect(await readFile(join(dir, "uploads", `${fileId}.txt`), "utf8")).toBe(fileContents);
    // Migration marker prevents old state from resurrecting later edits/removals.
    await handlers.workflows.remove(workflowId);
    const saved = await handlers.settings.get();
    saved.app.theme = "light";
    await handlers.settings.save(saved);
    const again = createHandlers(deps);
    expect(await again.workflows.list()).toEqual([]);
    expect((await again.settings.get()).app.theme).toBe("light");
    await expect(deps.files.get(fileId)).rejects.toThrow(/isn't in the store/);
  });
  it("rejects unsafe legacy artifacts/marker before importing or following external symlinks", async () => {
    const outside = join(dir, "synthetic-outside.json");
    await writeFile(
      outside,
      JSON.stringify({ settings: DEFAULT_SETTINGS, workflows: [], runs: [] }),
    );
    await symlink(outside, join(dir, "app-state.json"));
    await expect(createHandlers(deps).app.info()).rejects.toMatchObject({ code: "storage_error" });
    await expect(readFile(join(dir, "research-sqlite-migration-v1.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await rm(join(dir, "app-state.json"));
    await writeFile(
      join(dir, "app-state.json"),
      JSON.stringify({ settings: DEFAULT_SETTINGS, workflows: [], runs: [] }),
    );
    await writeFile(join(dir, "research-sqlite-migration-v1.json"), JSON.stringify({ version: 0 }));
    await expect(createHandlers(deps).app.info()).rejects.toMatchObject({ code: "storage_error" });
    expect(JSON.parse(await readFile(outside, "utf8"))).toEqual({
      settings: DEFAULT_SETTINGS,
      workflows: [],
      runs: [],
    });
  });
  it("does not silently overwrite malformed legacy state or malformed current settings", async () => {
    const bad = "synthetic-private-invalid-json";
    await writeFile(join(dir, "app-state.json"), bad);
    await expect(createHandlers(deps).settings.get()).rejects.toMatchObject({
      code: "storage_error",
    });
    expect(await readFile(join(dir, "app-state.json"), "utf8")).toBe(bad);
    await rm(join(dir, "app-state.json"));
    await writeFile(join(dir, "settings.json"), bad);
    await expect(createHandlers(deps).settings.get()).rejects.toMatchObject({
      code: "storage_error",
    });
  });
  it.each(["openai", "google"] as const)(
    "uses shared secret mapping for %s with custom models without live calls",
    async (provider) => {
      await handlers.settings.setSecret(
        provider === "openai" ? "openai_api_key" : "google_api_key",
        `synthetic-${provider}`,
      );
      const settings = await handlers.settings.get();
      settings.llm.provider = provider;
      settings.llm.model = "custom-quality";
      settings.llm.fastModel = "custom-fast";
      await handlers.settings.save(settings);
      deps.registry = new BlockRegistry([
        defineBlock({
          kind: "raw",
          async run(_inputs, _params, context) {
            await context.llm.generateText({ prompt: "Synthetic prompt" });
            return { status: "ok", outputs: { out: emptyPipelineData() } };
          },
        }),
      ]);
      handlers = createHandlers(deps);
      const workflow = await save([createBlock("raw", { id: "raw", position: { x: 0, y: 0 } })]);
      const started = await handlers.runs.start(workflow.id);
      await wait(started.id);
      expect(seams.llmOptions).toContainEqual([
        expect.objectContaining({ provider, model: "custom-quality", fastModel: "custom-fast" }),
        { apiKey: `synthetic-${provider}` },
      ]);
      expect(fetched).not.toHaveBeenCalled();
    },
  );
});
