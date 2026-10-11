import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import {
  createBlock,
  defaultBlockParams,
  DEFAULT_SETTINGS,
  emptyPipelineData,
  ResearchDataset,
  ResearchProviderConfig,
  type BlockParams,
  type ProductScope,
  type WorkflowBlock,
  type WorkflowRun,
} from "@reqflow/core";
import { summarizeResearchDataset } from "@reqflow/blocks";
import type { ReqflowHandlers, StoredFileInfo } from "@reqflow/core/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../dispatch";
import { createResearchRuntime, type RuntimeDeps } from "./legacy-runtime";
import type { SecureStorage } from "./secrets";

// Any accidental Electron dependency should fail collection, not silently run a desktop process.
vi.mock("electron", () => {
  throw new Error("Research tests must remain Electron-free");
});

const seams = vi.hoisted(() => ({
  documentReads: [] as ReturnType<typeof vi.fn>[],
  unrelatedBlockRun: vi.fn(async () => {
    throw new Error("Unrelated block reached a Research-only test");
  }),
}));
vi.mock("@reqflow/blocks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@reqflow/blocks")>();
  return {
    ...actual,
    // Main still constructs the real registry and executes the real Research implementation.
    allBlockImplementations: actual.allBlockImplementations.map((implementation) =>
      implementation.kind === "research"
        ? implementation
        : { kind: implementation.kind, run: seams.unrelatedBlockRun },
    ),
    createLocalDocumentReader: (
      options: Parameters<typeof actual.createLocalDocumentReader>[0],
    ) => {
      const reader = actual.createLocalDocumentReader(options);
      const read = vi.fn(reader.read);
      seams.documentReads.push(read);
      return { ...reader, read };
    },
  };
});

// Deliberately recognizable reversible fake cipher; this does NOT test OS keyring encryption.
const cipherPrefix = "synthetic-cipher:v1:";
const syntheticKey = "synthetic-private-firecrawl-credential";
const syntheticText =
  "Synthetic publication: deliveries are 7.\nSynthetic strategy statement remains verbatim.\n舒适 — unchanged.\n";

async function expectedLocalTextRows(
  dataset: ResearchDataset,
  scope: ProductScope = DEFAULT_SETTINGS.defaultScope,
) {
  return summarizeResearchDataset(dataset, { scope, signal: new AbortController().signal });
}
function secureStorage(): SecureStorage {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "synthetic-keyring",
    encryptString: (value) =>
      Buffer.concat([
        Buffer.from(cipherPrefix),
        Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0xa5)),
      ]),
    decryptString: (value) => {
      if (!value.subarray(0, cipherPrefix.length).equals(Buffer.from(cipherPrefix)))
        throw new Error("Synthetic corrupt cipher");
      return Buffer.from(
        [...value.subarray(cipherPrefix.length)].map((byte) => byte ^ 0xa5),
      ).toString("utf8");
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const emptySearch = () => Response.json({ success: true, data: { web: [] } });
const config = (overrides: Partial<ResearchProviderConfig> = {}) =>
  ResearchProviderConfig.parse({ enabled: true, ...overrides });
function researchBlock(id: string, overrides: BlockParams = {}): WorkflowBlock {
  return {
    ...createBlock("research", { id, position: { x: 0, y: 0 } }),
    params: { ...defaultBlockParams("research"), ...overrides },
  };
}

type Runtime = Awaited<ReturnType<typeof createResearchRuntime>>;
const directories: string[] = [];
const runtimes: Runtime[] = [];
let workspace: string;
async function setup(overrides: Partial<RuntimeDeps> = {}) {
  const dir = join(workspace, `state-${runtimes.length}`);
  const chooseImport = vi.fn<RuntimeDeps["chooseImport"]>(async () => null);
  const chooseExport = vi.fn<RuntimeDeps["chooseExport"]>(async () => null);
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    throw new Error("Unexpected real-network attempt in synthetic Research test");
  });
  const updates: WorkflowRun[] = [];
  const publish = vi.fn((run: WorkflowRun) => {
    updates.push(structuredClone(run));
  });
  const deps: RuntimeDeps = {
    dir,
    chooseImport,
    chooseExport,
    fetchImpl,
    publish,
    secureStorage: secureStorage(),
    ...overrides,
  };
  const runtime = await createResearchRuntime(deps);
  runtimes.push(runtime);
  // Isolated compatibility proof. Production composes Research into SQLite handlers instead.
  const api = runtime.handlers as ReqflowHandlers;
  return {
    dir: deps.dir,
    deps,
    runtime,
    api,
    chooseImport,
    chooseExport,
    fetchImpl,
    publish,
    updates,
  };
}
type Harness = Awaited<ReturnType<typeof setup>>;
async function enableFirecrawlCollection(h: Harness) {
  await h.api.settings.setSecret("firecrawl_api_key", syntheticKey);
  await h.api.research.configure("firecrawl", config());
  const settings = await h.api.settings.get();
  settings.research.provider = "firecrawl";
  await h.api.settings.save(settings);
}
async function saveWorkflow(h: Harness, blocks: WorkflowBlock[]) {
  return h.api.workflows.save({
    name: "Synthetic Research-only workflow",
    scope: structuredClone(DEFAULT_SETTINGS.defaultScope),
    blocks,
    edges: [],
  });
}
async function terminal(h: Harness, runId: string) {
  await vi.waitFor(
    async () => {
      const run = await h.api.runs.get(runId);
      expect(["completed", "failed", "cancelled"]).toContain(run.status);
    },
    { timeout: 3000, interval: 5 },
  );
  // Flush pending persistence/audit after observing terminal status through the public getter.
  await h.runtime.shutdown();
  return h.api.runs.get(runId);
}
async function importText(h: Harness): Promise<StoredFileInfo> {
  const path = join(workspace, "Synthetic original.txt");
  await writeFile(path, syntheticText);
  h.chooseImport.mockResolvedValueOnce(path);
  const imported = await h.api.files.import();
  if (!imported) throw new Error("Synthetic fixture import unexpectedly cancelled");
  return imported;
}
async function localRun(h: Harness, mode: "file-param" | "advanced-json" = "file-param") {
  const file = await importText(h);
  const selection =
    mode === "file-param"
      ? { document: { fileId: file.id, name: file.name } }
      : { scopeJson: JSON.stringify({ documentIds: [file.id] }) };
  const workflow = await saveWorkflow(h, [
    researchBlock("research", { agents: ["bmw_sales", "bmw_strategy"], ...selection }),
  ]);
  const started = await h.api.runs.start(workflow.id);
  const run = await terminal(h, started.id);
  const dataset = await h.api.research.dataset(run.id);
  return { file, workflow, run, dataset };
}
function spreadsheetRows(sheet: ExcelJS.Worksheet) {
  const headers = Array.from({ length: sheet.columnCount }, (_, i) =>
    String(sheet.getRow(1).getCell(i + 1).value),
  );
  return Array.from({ length: sheet.rowCount - 1 }, (_, i) =>
    Object.fromEntries(
      headers.map((header, column) => [header, sheet.getRow(i + 2).getCell(column + 1).value]),
    ),
  );
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "reqflow-runtime-test-"));
  directories.push(workspace);
  seams.documentReads.length = 0;
  seams.unrelatedBlockRun.mockClear();
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("main Research settings and credential API", () => {
  it("starts untested without connecting or returning credential values", async () => {
    const h = await setup();

    const statuses = await h.api.research.providers();

    expect(statuses.find((provider) => provider.id === "firecrawl")).toMatchObject({
      credentialsConfigured: { firecrawl_api_key: false },
      connection: { state: "not_configured", capabilities: [] },
    });
    expect(statuses.find((provider) => provider.id === "openalex")?.connection.state).toBe(
      "untested",
    );
    expect(statuses.every((provider) => provider.connection.testedAt === undefined)).toBe(true);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("returns credential status only and keeps credential values out of state, audit and provider reports", async () => {
    const h = await setup();

    const result = await h.api.settings.setSecret("firecrawl_api_key", syntheticKey);
    const returned = [
      result,
      await h.api.settings.get(),
      await h.api.settings.secrets(),
      await h.api.research.providers(),
      await h.api.audit.list(),
    ];
    const state = await readFile(join(h.dir, "app-state.json"), "utf8");
    const audit = await readFile(join(h.dir, "audit.json"), "utf8");
    const encrypted = await readFile(join(h.dir, "secrets.enc.json"), "utf8");
    const bytes = Buffer.from(JSON.parse(encrypted).firecrawl_api_key, "base64");

    expect(result.firecrawl_api_key).toEqual({ configured: true, source: "keychain" });
    expect(JSON.stringify(returned)).not.toContain(syntheticKey);
    expect(state).not.toContain(syntheticKey);
    expect(state).not.toContain("firecrawl_api_key");
    expect(audit).not.toContain(syntheticKey);
    expect(encrypted).not.toContain(syntheticKey);
    expect(bytes.subarray(0, cipherPrefix.length).toString()).toBe(cipherPrefix);
    expect(bytes.includes(Buffer.from(syntheticKey))).toBe(false);
    expect(await dispatch(h.api, "settings", "getSecret", ["firecrawl_api_key"])).toMatchObject({
      ok: false,
      error: { code: "unknown_method" },
    });
  });

  it.each(["unavailable", "linux-basic-text"] as const)(
    "rejects credential writes with %s storage through the API",
    async (scenario) => {
      const storage = secureStorage();
      if (scenario === "unavailable") storage.isEncryptionAvailable = () => false;
      else storage.getSelectedStorageBackend = () => "basic_text";
      const h = await setup({
        secureStorage: storage,
        platform: scenario === "unavailable" ? "darwin" : "linux",
      });

      const response = await dispatch(h.api, "settings", "setSecret", [
        "firecrawl_api_key",
        syntheticKey,
      ]);

      expect(response).toMatchObject({ ok: false, error: { code: "secure_storage_unavailable" } });
      expect(JSON.stringify(response)).not.toContain(syntheticKey);
      expect((await h.api.settings.secrets()).firecrawl_api_key.configured).toBe(false);
      expect(await h.api.audit.list()).toEqual([]);
      expect(await readdir(h.dir)).not.toContain("secrets.enc.json");
    },
  );

  it("does not delete a configured credential on blank input, but does delete it on null", async () => {
    const h = await setup();
    await h.api.settings.setSecret("firecrawl_api_key", syntheticKey);

    await expect(h.api.settings.setSecret("firecrawl_api_key", "  ")).rejects.toThrow();
    expect((await h.api.settings.secrets()).firecrawl_api_key.configured).toBe(true);
    const removed = await h.api.settings.setSecret("firecrawl_api_key", null);

    expect(removed.firecrawl_api_key).toEqual({ configured: false, source: null });
    expect(JSON.parse(await readFile(join(h.dir, "secrets.enc.json"), "utf8"))).not.toHaveProperty(
      "firecrawl_api_key",
    );
  });

  it("reloads encrypted credential status and provider configuration without exposing a value or retaining a stale test", async () => {
    const h = await setup();
    await h.api.settings.setSecret("firecrawl_api_key", syntheticKey);
    await h.api.research.configure("firecrawl", config());
    h.fetchImpl.mockImplementation(async () => emptySearch());
    await h.api.research.test("firecrawl");
    await h.runtime.shutdown();

    const restarted = await setup({ dir: h.dir });
    const status = (await restarted.api.research.providers()).find(
      (provider) => provider.id === "firecrawl",
    )!;

    expect((await restarted.api.settings.secrets()).firecrawl_api_key).toEqual({
      configured: true,
      source: "keychain",
    });
    expect(status).toMatchObject({
      config: config(),
      credentialsConfigured: { firecrawl_api_key: true },
      connection: { state: "untested" },
    });
    expect(status.connection.testedAt).toBeUndefined();
    expect(
      JSON.stringify([
        status,
        await restarted.api.settings.get(),
        await restarted.api.audit.list(),
      ]),
    ).not.toContain(syntheticKey);
    expect(restarted.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["grant", "revoke"] as const)(
    "does not let a stale general-settings autosave override an explicit provider %s",
    async (operation) => {
      const h = await setup();
      if (operation === "revoke")
        await h.api.research.configure(
          "apify",
          config({ approval: "granted", allowedActors: ["apify/instagram-scraper"] }),
        );
      const stale = await h.api.settings.get();
      const wanted =
        operation === "grant"
          ? config({ approval: "granted", allowedActors: ["apify/instagram-scraper"] })
          : config({ enabled: false, approval: "not_granted", allowedActors: [] });
      await h.api.research.configure("apify", wanted);
      stale.app.theme = "dark";

      const saved = await h.api.settings.save(stale);

      expect(saved.app.theme).toBe("dark");
      expect(saved.research.apis.apify).toEqual(wanted);
      expect((await h.api.settings.get()).research.apis.apify).toEqual(wanted);
      expect(
        JSON.parse(await readFile(join(h.dir, "app-state.json"), "utf8")).settings.research.apis
          .apify,
      ).toEqual(wanted);
    },
  );

  it("does not allow mutation of returned settings to change persisted provider access", async () => {
    const h = await setup();
    const settings = await h.api.settings.get();

    settings.research.apis.firecrawl.enabled = true;
    settings.app.theme = "dark";

    expect(await h.api.settings.get()).toEqual(DEFAULT_SETTINGS);
  });

  it.each(["secret", "config"] as const)(
    "invalidates a real adapter test report when %s changes",
    async (changed) => {
      const h = await setup();
      await h.api.settings.setSecret("firecrawl_api_key", syntheticKey);
      await h.api.research.configure("firecrawl", config());
      h.fetchImpl.mockImplementation(async () => emptySearch());
      const tested = await h.api.research.test("firecrawl");
      expect(tested.connection.state).toBe("success");
      expect(h.fetchImpl).toHaveBeenCalledTimes(1);
      if (changed === "secret")
        await h.api.settings.setSecret("firecrawl_api_key", "synthetic-replacement-key");
      else await h.api.research.configure("firecrawl", config({ enabled: false }));

      const status = (await h.api.research.providers()).find(
        (provider) => provider.id === "firecrawl",
      )!;

      expect(status.connection).toMatchObject({ state: "untested", capabilities: [] });
      expect(status.connection.testedAt).toBeUndefined();
      expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["secret", "config"] as const)(
    "does not restore a stale in-flight success after %s changes",
    async (changed) => {
      const h = await setup();
      await h.api.settings.setSecret("firecrawl_api_key", syntheticKey);
      await h.api.research.configure("firecrawl", config());
      const entered = deferred<void>();
      const response = deferred<Response>();
      h.fetchImpl.mockImplementation(async () => {
        entered.resolve();
        return response.promise;
      });
      const testing = h.api.research.test("firecrawl");
      await entered.promise;
      if (changed === "secret")
        await h.api.settings.setSecret("firecrawl_api_key", "synthetic-replacement-key");
      else await h.api.research.configure("firecrawl", config({ enabled: false }));

      response.resolve(emptySearch());
      const status = await testing;

      expect(status.connection.state).toBe("untested");
      expect(status.connection.testedAt).toBeUndefined();
      expect(
        (await h.api.research.providers()).find((provider) => provider.id === "firecrawl")
          ?.connection.state,
      ).toBe("untested");
    },
  );

  it("coalesces simultaneous connection tests without claiming success before a response", async () => {
    const h = await setup();
    await h.api.settings.setSecret("firecrawl_api_key", syntheticKey);
    await h.api.research.configure("firecrawl", config());
    const entered = deferred<void>();
    const response = deferred<Response>();
    h.fetchImpl.mockImplementation(async () => {
      entered.resolve();
      return response.promise;
    });
    const first = h.api.research.test("firecrawl");
    const second = h.api.research.test("firecrawl");
    await entered.promise;
    expect(
      (await h.api.research.providers()).find((provider) => provider.id === "firecrawl")?.connection
        .state,
    ).toBe("untested");

    response.resolve(emptySearch());
    const results = await Promise.all([first, second]);

    expect(results[0]).toEqual(results[1]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not connection-test a provider with missing credentials", async () => {
    const h = await setup();

    const tested = await h.api.research.test("firecrawl");

    expect(tested.connection.state).toBe("not_configured");
    expect(tested.connection.testedAt).toBeUndefined();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("local raw Research workflow and exports", () => {
  it.each(["file-param", "advanced-json"] as const)(
    "imports TXT and collects undated local originals via %s with the default publication window",
    async (mode) => {
      const h = await setup();

      const { file, run, dataset } = await localRun(h, mode);
      const output = await h.api.runs.blockOutput(run.id, "research");

      expect(run.status).toBe("completed");
      expect(await readFile(join(h.dir, "uploads", `${file.id}.txt`), "utf8")).toBe(syntheticText);
      expect(file).toMatchObject({
        name: "Synthetic original.txt",
        mimeType: "text/plain",
        sizeBytes: Buffer.byteLength(syntheticText),
      });
      expect(dataset.records).toHaveLength(1);
      expect(dataset.records[0]).toMatchObject({
        text: syntheticText,
        originalSourceId: file.id,
        originalRecordId: `${file.id}:text`,
        originalUrl: `reqflow-file:///${file.id}`,
        collectingAgents: ["bmw_sales", "bmw_strategy"],
        runIds: [run.id],
        datePrecision: "unknown",
        metadata: { originalArtifact: { fileId: file.id } },
        locator: "UTF-8 document",
      });
      expect(dataset.results.map((result) => result.agentId)).toEqual([
        "bmw_sales",
        "bmw_strategy",
      ]);
      expect(dataset.results.map((result) => result.status)).toEqual(["partial", "partial"]);
      for (const result of dataset.results) {
        expect(result.limitations).toEqual(
          expect.arrayContaining([expect.stringMatching(/web research is off/i)]),
        );
      }
      expect(dataset.sources[0]?.reliability).toBeUndefined();
      expect(dataset.sources[0]?.publishedAt).toBeUndefined();
      expect(output.out).toEqual({
        ...emptyPipelineData(),
        sources: dataset.sources,
        records: await expectedLocalTextRows(dataset),
      });
      expect(
        ResearchDataset.parse(
          JSON.parse(await readFile(join(h.dir, `${run.id}.research.json`), "utf8")),
        ),
      ).toEqual(dataset);
      expect(
        h.updates.some((update) => update.id === run.id && update.status === "completed"),
      ).toBe(true);
      expect(h.fetchImpl).not.toHaveBeenCalled();
      expect(seams.unrelatedBlockRun).not.toHaveBeenCalled();
    },
  );

  it("shares the parent document-reader cache across agents and blocks but starts a fresh cache per run", async () => {
    const h = await setup();
    const file = await importText(h);
    const params = {
      agents: ["bmw_sales", "bmw_strategy"],
      document: { fileId: file.id, name: file.name },
    };
    const workflow = await saveWorkflow(h, [
      researchBlock("first", params),
      researchBlock("second", params),
    ]);

    const first = await h.api.runs.start(workflow.id);
    await terminal(h, first.id);
    expect(seams.documentReads[0]).toHaveBeenCalledTimes(1);
    const second = await h.api.runs.start(workflow.id);
    await terminal(h, second.id);

    expect(seams.documentReads[0]).toHaveBeenCalledTimes(2);
    expect((await h.api.research.dataset(second.id)).records[0]?.runIds).toEqual([second.id]);
  });

  it("writes JSON and actual XLSX files with the same raw record and source identities", async () => {
    const h = await setup();
    const { run, dataset } = await localRun(h);
    const jsonPath = join(workspace, "Synthetic export.json");
    const xlsxPath = join(workspace, "Synthetic export.xlsx");
    h.chooseExport.mockResolvedValueOnce(jsonPath).mockResolvedValueOnce(xlsxPath);

    const jsonResult = await h.api.exports.research({ runId: run.id, format: "json" });
    const xlsxResult = await h.api.exports.research({ runId: run.id, format: "xlsx" });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(xlsxPath);
    const records = spreadsheetRows(workbook.getWorksheet("Research Records")!);
    const sources = spreadsheetRows(workbook.getWorksheet("Sources")!);

    expect(jsonResult).toEqual({ path: jsonPath });
    expect(xlsxResult).toEqual({ path: xlsxPath });
    expect(ResearchDataset.parse(JSON.parse(await readFile(jsonPath, "utf8")))).toEqual(dataset);
    expect(
      records.map((record) => [
        record.ID,
        record["Source ID"],
        record["Original Record ID"],
        record["Original Text"],
      ]),
    ).toEqual(
      dataset.records.map((record) => [
        record.id,
        record.sourceId,
        record.originalRecordId,
        record.text,
      ]),
    );
    expect(sources.map((source) => source["Source ID"])).toEqual(
      dataset.sources.map((source) => source.id),
    );
    expect(JSON.parse(String(records[0]?.Metadata))).toEqual(dataset.records[0]?.metadata);
    expect(await h.api.audit.list({ action: "export.created" })).toHaveLength(2);
    expect(h.chooseExport.mock.calls).toEqual([
      ["json", run.id],
      ["xlsx", run.id],
    ]);
  });

  it("treats a cancelled import dialog as null without creating uploads or file metadata", async () => {
    const h = await setup();

    expect(await h.api.files.import()).toBeNull();

    expect(h.chooseImport).toHaveBeenCalledTimes(1);
    expect(await readdir(h.dir)).toEqual(["app-state.json"]);
  });

  it("treats a cancelled export dialog as null without an export audit event or dataset changes", async () => {
    const h = await setup();
    const { run, dataset } = await localRun(h);

    const result = await h.api.exports.research({ runId: run.id, format: "json" });

    expect(result).toBeNull();
    expect(await h.api.audit.list({ action: "export.created" })).toEqual([]);
    expect(await h.api.research.dataset(run.id)).toEqual(dataset);
  });

  it("ignores a renderer-supplied import path and obtains the selection only from the trusted dialog", async () => {
    const h = await setup();

    const response = await dispatch(h.api, "files", "import", [
      { path: join(workspace, "Synthetic never-selected.txt") },
    ]);

    expect(response).toEqual({ ok: true, value: null });
    expect(h.chooseImport).toHaveBeenCalledWith();
    expect(await readdir(h.dir)).toEqual(["app-state.json"]);
  });

  it("rejects an export destination supplied by the renderer before opening a dialog", async () => {
    const h = await setup();
    const { run } = await localRun(h);

    const response = await dispatch(h.api, "exports", "research", [
      { runId: run.id, format: "json", path: join(workspace, "Synthetic forbidden.json") },
    ]);

    expect(response).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(h.chooseExport).not.toHaveBeenCalled();
    expect(await readdir(workspace)).not.toContain("Synthetic forbidden.json");
  });

  it("fails a workflow containing a filesystem path instead of an imported document ID without reading or networking", async () => {
    const h = await setup();
    const workflow = await saveWorkflow(h, [
      researchBlock("research", {
        agents: ["bmw_sales"],
        scopeJson: JSON.stringify({ documentIds: [join(workspace, "Synthetic outside.txt")] }),
      }),
    ]);

    const started = await h.api.runs.start(workflow.id);
    const run = await terminal(h, started.id);

    expect(run.status).toBe("failed");
    expect(seams.documentReads[0]).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await expect(h.api.research.dataset(run.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("restores run history and full original provenance outputs after a clean restart", async () => {
    const h = await setup();
    const { workflow, run, dataset } = await localRun(h);

    const restarted = await setup({ dir: h.dir });

    expect(await restarted.api.runs.list(workflow.id)).toEqual([run]);
    expect(await restarted.api.runs.get(run.id)).toEqual(run);
    expect(await restarted.api.research.dataset(run.id)).toEqual(dataset);
    expect((await restarted.api.runs.blockOutput(run.id, "research")).out?.records).toEqual(
      await expectedLocalTextRows(dataset),
    );
    expect(restarted.fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves structured original table metadata and ResearchRecord extensions through main output persistence", async () => {
    const h = await setup();
    const path = join(workspace, "Synthetic structured original.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Synthetic metrics");
    sheet.addRow(["Metric", "Count (vehicles)", "Supplied flag"]);
    sheet.addRow(["Synthetic deliveries", 7, false]);
    sheet.getCell("B2").note = "Synthetic source-supplied footnote";
    await workbook.xlsx.writeFile(path);
    const originalWorkbook = new ExcelJS.Workbook();
    await originalWorkbook.xlsx.readFile(path);
    const originalNote = originalWorkbook.getWorksheet("Synthetic metrics")!.getCell("B2").note;
    h.chooseImport.mockResolvedValueOnce(path);
    const file = await h.api.files.import();
    if (!file) throw new Error("Synthetic XLSX import unexpectedly cancelled");
    const workflow = await saveWorkflow(h, [
      researchBlock("research", {
        agents: ["bmw_sales", "bmw_strategy"],
        document: { fileId: file.id, name: file.name },
      }),
    ]);

    const started = await h.api.runs.start(workflow.id);
    await terminal(h, started.id);
    const dataset = await h.api.research.dataset(started.id);
    const restarted = await setup({ dir: h.dir });
    const output = await restarted.api.runs.blockOutput(started.id, "research");

    expect(dataset.records).toHaveLength(1);
    expect(dataset.records[0]).toMatchObject({
      recordType: "table",
      originalSourceId: file.id,
      originalRecordId: `${file.id}:sheet:1`,
      table: {
        headers: ["Metric", "Count (vehicles)", "Supplied flag"],
        rows: [["Synthetic deliveries", 7, false]],
        units: ["vehicles"],
        footnotes: ["Synthetic source-supplied footnote"],
      },
      metadata: {
        originalArtifact: { fileId: file.id },
        sheet: "Synthetic metrics",
        sourceRows: [2],
        cellArtifacts: [expect.objectContaining({ address: "B2", note: originalNote })],
      },
      collectingAgents: ["bmw_sales", "bmw_strategy"],
    });
    expect(output.out?.records).toHaveLength(1);
    expect(output.out?.records?.[0]).toMatchObject({
      collectedRecordId: dataset.records[0]!.id,
      id: `${dataset.records[0]!.id}_row1`,
      sourceId: dataset.records[0]!.sourceId,
      text: "Metric: Synthetic deliveries; Count (vehicles): 7; Supplied flag: false",
      fields: { Metric: "Synthetic deliveries", "Count (vehicles)": 7, "Supplied flag": false },
      originalSourceId: file.id,
      originalRecordId: `${file.id}:sheet:1`,
      metadata: dataset.records[0]!.metadata,
      table: dataset.records[0]!.table,
      collectingAgents: ["bmw_sales", "bmw_strategy"],
    });
    expect(await restarted.api.research.dataset(started.id)).toEqual(dataset);
    expect(
      JSON.parse(await readFile(join(h.dir, `${started.id}.outputs.json`), "utf8")).research.out
        .records,
    ).toEqual(output.out?.records);
    expect(restarted.fetchImpl).not.toHaveBeenCalled();
  });

  it("marks interrupted history failed on restart but retains exportable datasets and original output metadata", async () => {
    const h = await setup();
    const { run, dataset } = await localRun(h);
    const path = join(h.dir, "app-state.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    saved.runs[0].status = "running";
    delete saved.runs[0].finishedAt;
    await writeFile(path, JSON.stringify(saved));

    const restarted = await setup({ dir: h.dir });
    const restored = await restarted.api.runs.get(run.id);

    expect(restored).toMatchObject({
      status: "failed",
      finishedAt: expect.any(String),
      error: expect.stringMatching(/stopped.*preserved research results/i),
    });
    expect(await restarted.api.research.dataset(run.id)).toEqual(dataset);
    expect((await restarted.api.runs.blockOutput(run.id, "research")).out?.records).toEqual(
      await expectedLocalTextRows(dataset),
    );
    expect(await restarted.api.runs.list()).toEqual([restored]);
    expect(restarted.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("active runs and bounded cancellation", () => {
  async function pendingWorkflow(h: Harness) {
    await enableFirecrawlCollection(h);
    const entered = deferred<void>();
    h.fetchImpl.mockImplementation(async () => {
      entered.resolve();
      return new Promise<Response>(() => {});
    });
    const workflow = await saveWorkflow(h, [
      researchBlock("research", { agents: ["owner_forums"] }),
    ]);
    return { workflow, entered };
  }

  it("rejects a second start while a workflow is already actively fetching", async () => {
    const h = await setup();
    const { workflow, entered } = await pendingWorkflow(h);
    const started = await h.api.runs.start(workflow.id);
    await entered.promise;

    await expect(h.api.runs.start(workflow.id)).rejects.toMatchObject({ code: "run_busy" });

    expect((await h.api.runs.list(workflow.id)).map((run) => run.id)).toEqual([started.id]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("atomically admits only one of two simultaneous starts for the same workflow", async () => {
    const h = await setup();
    const { workflow } = await pendingWorkflow(h);

    const starts = await Promise.allSettled([
      h.api.runs.start(workflow.id),
      h.api.runs.start(workflow.id),
    ]);

    expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(starts.filter((result) => result.status === "rejected")).toEqual([
      { status: "rejected", reason: expect.objectContaining({ code: "run_busy" }) },
    ]);
    expect(await h.api.runs.list(workflow.id)).toHaveLength(1);
  });

  it.each(["cancel", "deadline"] as const)(
    "preserves the earlier block output and saved dataset when %s interrupts a later fetch",
    async (reason) => {
      const h = await setup();
      const file = await importText(h);
      await enableFirecrawlCollection(h);
      const entered = deferred<void>();
      h.fetchImpl.mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { query?: string };
        if (body.query?.includes("owner forum discussions")) {
          entered.resolve();
          return new Promise<Response>(() => {});
        }
        return emptySearch();
      });
      const deadline = new AbortController();
      if (reason === "deadline") {
        const originalTimeout = AbortSignal.timeout;
        vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
          ms === 1000 ? deadline.signal : originalTimeout(ms),
        );
      }
      const workflow = await saveWorkflow(h, [
        researchBlock("earlier", {
          agents: ["bmw_sales"],
          document: { fileId: file.id, name: file.name },
        }),
        researchBlock("later", { agents: ["owner_forums"], timeoutMs: 1000 }),
      ]);
      const started = await h.api.runs.start(workflow.id);
      await entered.promise;
      const before = await h.api.research.dataset(started.id);
      const earlierOutput = await h.api.runs.blockOutput(started.id, "earlier");

      if (reason === "deadline")
        deadline.abort(new DOMException("Synthetic deadline", "TimeoutError"));
      else await h.api.runs.cancel(started.id);
      const run = await terminal(h, started.id);
      const retained = await h.api.research.dataset(run.id);

      if (reason === "cancel") expect(run.status).toBe("cancelled");
      expect(retained.records).toEqual(before.records);
      expect(retained.records[0]?.text).toBe(syntheticText);
      expect(retained.results.find((result) => result.agentId === "owner_forums")?.status).toBe(
        "cancelled",
      );
      expect(await h.api.runs.blockOutput(run.id, "earlier")).toEqual(earlierOutput);
      expect(
        ResearchDataset.parse(
          JSON.parse(await readFile(join(h.dir, `${run.id}.research.json`), "utf8")),
        ),
      ).toEqual(retained);
      expect(earlierOutput.out?.findings).toEqual([]);
      expect(earlierOutput.out?.requirements).toEqual([]);
      expect(
        JSON.stringify([run, retained.results, h.updates, await h.api.audit.list()]),
      ).not.toContain(syntheticKey);
    },
  );
});
