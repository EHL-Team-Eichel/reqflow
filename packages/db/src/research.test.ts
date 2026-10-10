import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, ResearchDataset, WorkflowRun } from "@reqflow/core";
import { createDatabase } from "./db";
import { SqliteRunRepository } from "./runs";
import { ResearchDatasetRepository } from "./research";
const dbs: ReturnType<typeof createDatabase>[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
async function setup() {
  const db = createDatabase();
  dbs.push(db);
  const run = WorkflowRun.parse({
    id: "run_synthetic",
    workflowId: "wf_synthetic",
    workflowVersion: 1,
    graph: { blocks: [], edges: [] },
    scope: DEFAULT_SETTINGS.defaultScope,
    status: "queued",
    startedBy: { type: "system", component: "synthetic" },
    startedAt: "2026-10-10T00:00:00.000Z",
    blockRuns: [],
  });
  await new SqliteRunRepository(db).create(run);
  const dataset = ResearchDataset.parse({
    schemaVersion: 1,
    runId: run.id,
    sources: [],
    records: [],
    results: [],
    synthetic: true,
    retrievedAt: run.startedAt,
  });
  return { db, run, dataset, repo: new ResearchDatasetRepository(db) };
}
describe("SQLite research datasets and run snapshots", () => {
  it("keeps block/aggregate writes atomic; persists settings snapshot once", async () => {
    const { repo, dataset, run } = await setup();
    repo.save(run.id, "research", dataset, dataset);
    expect(repo.get(run.id)).toEqual(dataset);
    expect(repo.blocks(run.id).get("research")).toEqual(dataset);
    repo.saveSettings(run.id, DEFAULT_SETTINGS);
    repo.saveSettings(run.id, {
      ...DEFAULT_SETTINGS,
      app: { ...DEFAULT_SETTINGS.app, theme: "dark" },
    });
    expect(repo.settings(run.id)?.app.theme).toBe("system");
    expect(() =>
      repo.save(run.id, "research", dataset, { ...dataset, runId: "run_other" }),
    ).toThrow();
    expect(repo.get(run.id)).toEqual(dataset);
  });
  it("rejects missing run, unsafe keys and oversized data without destroying preserved originals", async () => {
    const { repo, dataset, run } = await setup();
    repo.save(run.id, "research", dataset, dataset);
    expect(() =>
      repo.save(
        "run_missing",
        "research",
        { ...dataset, runId: "run_missing" },
        { ...dataset, runId: "run_missing" },
      ),
    ).toThrow();
    expect(() => repo.get("run_../../outside")).toThrow();
    const huge = {
      ...dataset,
      sources: [
        {
          id: "src_synthetic",
          kind: "other_web" as const,
          origin: "web" as const,
          title: "s".repeat(17 * 1024 * 1024),
          retrievedAt: run.startedAt,
          metadata: { synthetic: "s".repeat(17 * 1024 * 1024) },
        },
      ],
    };
    expect(() => repo.save(run.id, "research", huge, huge)).toThrow();
    expect(repo.get(run.id)).toEqual(dataset);
  });
  it("rolls back a block write if the aggregate SQL write fails", async () => {
    const { db, repo, dataset, run } = await setup();
    repo.save(run.id, "research", dataset, dataset);
    db.exec(`CREATE TRIGGER synthetic_aggregate_failure BEFORE INSERT ON research_datasets
      WHEN NEW.block_id = '' BEGIN SELECT RAISE(ABORT, 'synthetic persistence fault'); END;`);
    const next = { ...dataset, retrievedAt: "2026-10-11T00:00:00.000Z" };
    expect(() => repo.save(run.id, "research", next, next)).toThrow(/synthetic persistence fault/);
    expect(repo.blocks(run.id).get("research")).toEqual(dataset);
    expect(repo.get(run.id)).toEqual(dataset);
    db.exec("DROP TRIGGER synthetic_aggregate_failure");
    repo.save(run.id, "research", next, next);
    expect(repo.get(run.id)).toEqual(next);
  });
});
