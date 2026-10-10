import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  createBlock,
  emptyPipelineData,
  ResearchDataset,
  Workflow,
  WorkflowRun,
} from "@reqflow/core";
import { createDatabase, createFileStore, SqliteRunRepository } from "@reqflow/db";
import { ResearchDatasetRepository } from "../../../../../packages/db/src/research";
import { migrateLegacyResearch } from "./migration";

const at = "2026-10-10T00:00:00.000Z";
let dir: string;
let db: ReturnType<typeof createDatabase>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reqflow-synthetic-migration-"));
  db = createDatabase(join(dir, "reqflow.db"));
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});
function legacy() {
  const workflow = Workflow.parse({
    id: "wf_legacy",
    name: "Synthetic legacy",
    version: 1,
    createdAt: at,
    updatedAt: at,
    scope: DEFAULT_SETTINGS.defaultScope,
    blocks: [createBlock("raw", { id: "raw", position: { x: 0, y: 0 } })],
    edges: [],
  });
  const run = WorkflowRun.parse({
    id: "run_legacy",
    workflowId: workflow.id,
    workflowVersion: 1,
    scope: workflow.scope,
    graph: { blocks: workflow.blocks, edges: [] },
    status: "completed",
    startedAt: at,
    finishedAt: at,
    startedBy: { type: "system", component: "synthetic" },
    blockRuns: [],
  });
  const source = {
    id: "src_synthetic",
    kind: "other_web" as const,
    origin: "web" as const,
    title: "Synthetic original",
    retrievedAt: at,
  };
  const record = {
    id: "rec_synthetic",
    sourceId: source.id,
    text: "Synthetic verbatim original",
    fields: {},
    recordType: "passage" as const,
    provider: "firecrawl" as const,
    originalSourceId: "synthetic-source",
    originalRecordId: "synthetic-record",
    originalUrl: "https://example.test/original",
    collectingAgents: ["owner_forums"],
    runIds: [run.id],
    retrievedAt: at,
    datePrecision: "unknown" as const,
    contentHash: "synthetic-hash",
    metadata: { originalArtifact: { locator: "synthetic:1" } },
    limitations: [],
  };
  const dataset = ResearchDataset.parse({
    schemaVersion: 1,
    runId: run.id,
    retrievedAt: at,
    synthetic: true,
    sources: [source],
    records: [record],
    results: [],
  });
  const outputs = {
    raw: { out: { ...emptyPipelineData(), sources: [source], records: [record] } },
  };
  const originals = {
    "app-state.json": { settings: DEFAULT_SETTINGS, workflows: [workflow], runs: [run] },
    [`${run.id}.outputs.json`]: outputs,
    [`${run.id}.research.json`]: dataset,
  };
  return { workflow, run, dataset, outputs, originals };
}
async function writeOriginals(originals: Record<string, unknown>) {
  for (const [name, value] of Object.entries(originals))
    await writeFile(join(dir, name), JSON.stringify(value));
}
describe("additive legacy Research migration rollback and conflicts", () => {
  it("rolls back all artifacts of a failed run import and retries without losing original provenance", async () => {
    const { run, dataset, outputs, originals } = legacy();
    await writeOriginals(originals);
    const datasets = new ResearchDatasetRepository(db);
    const files = createFileStore(join(dir, "uploads"));
    db.exec(`CREATE TRIGGER synthetic_migration_fault BEFORE INSERT ON research_datasets
      WHEN NEW.block_id = '' BEGIN SELECT RAISE(ABORT, 'synthetic SQL fault'); END;`);
    await expect(migrateLegacyResearch(dir, db, files, datasets)).rejects.toMatchObject({
      code: "storage_error",
    });
    for (const table of ["runs", "run_settings", "block_outputs", "research_datasets"])
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    await expect(readFile(join(dir, "research-sqlite-migration-v1.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    db.exec("DROP TRIGGER synthetic_migration_fault");
    await migrateLegacyResearch(dir, db, files, datasets);
    expect(await new SqliteRunRepository(db).get(run.id)).toEqual(run);
    expect(await new SqliteRunRepository(db).getBlockOutput(run.id, "raw")).toEqual(outputs.raw);
    expect(datasets.get(run.id)).toEqual(dataset);
    expect(datasets.settings(run.id)).toEqual(DEFAULT_SETTINGS);
    for (const [name, value] of Object.entries(originals))
      expect(await readFile(join(dir, name), "utf8")).toBe(JSON.stringify(value));
  });
  it("validates path ids before copying files or writing any destination state", async () => {
    const { originals, workflow } = legacy();
    originals["app-state.json"].workflows = [{ ...workflow, id: "../../synthetic-outside" }];
    const text = "synthetic-original";
    await mkdir(join(dir, "uploads"));
    await writeFile(join(dir, "uploads", "file_synthetic.csv"), text);
    await writeOriginals({
      ...originals,
      "files.json": [
        {
          id: "file_synthetic",
          name: "legacy.csv",
          mimeType: "text/csv",
          extension: ".csv",
          sizeBytes: Buffer.byteLength(text),
          importedAt: at,
        },
      ],
    });
    const files = createFileStore(join(dir, "uploads"));
    await expect(
      migrateLegacyResearch(dir, db, files, new ResearchDatasetRepository(db)),
    ).rejects.toMatchObject({ code: "storage_error" });
    await expect(files.info("file_synthetic")).rejects.toThrow(/isn't in the store/);
    await expect(readFile(join(dir, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(dir, "uploads", "file_synthetic.csv"), "utf8")).toBe(text);
  });
  it("keeps authoritative current settings/workflows/runs/outputs and leaves all legacy originals intact", async () => {
    const { run, workflow, originals } = legacy();
    const currentSettings = {
      ...DEFAULT_SETTINGS,
      app: { ...DEFAULT_SETTINGS.app, theme: "light" as const },
    };
    const currentWorkflow = { ...workflow, version: 9, name: "Synthetic current workflow" };
    const currentRun = { ...run, status: "failed" as const, error: "Synthetic current failure" };
    const currentOutputs = { out: emptyPipelineData() };
    await mkdir(join(dir, "workflows"));
    await writeFile(join(dir, "settings.json"), JSON.stringify(currentSettings));
    await writeFile(join(dir, "workflows", `${workflow.id}.json`), JSON.stringify(currentWorkflow));
    const runs = new SqliteRunRepository(db);
    await runs.create(currentRun);
    await runs.saveBlockOutput(run.id, "raw", currentOutputs);
    const datasets = new ResearchDatasetRepository(db);
    datasets.saveSettings(run.id, currentSettings);
    await writeOriginals(originals);
    await migrateLegacyResearch(dir, db, createFileStore(join(dir, "uploads")), datasets);
    expect(await runs.get(run.id)).toEqual(currentRun);
    expect(await runs.getBlockOutput(run.id, "raw")).toEqual(currentOutputs);
    expect(datasets.settings(run.id)).toEqual(currentSettings);
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8"))).toEqual(currentSettings);
    expect(
      JSON.parse(await readFile(join(dir, "workflows", `${workflow.id}.json`), "utf8")),
    ).toEqual(currentWorkflow);
    for (const [name, value] of Object.entries(originals))
      expect(await readFile(join(dir, name), "utf8")).toBe(JSON.stringify(value));
  });
});
