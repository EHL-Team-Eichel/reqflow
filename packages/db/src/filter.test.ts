import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import {
  type Actor,
  emptyPipelineData,
  type FilterReport,
  type FilterReview,
  type PipelineData,
  WorkflowRun,
} from "@reqflow/core";
import {
  createDatabase,
  FilterOverrideConflictError,
  FilterOverrideRepository,
  SqliteAuditLogger,
  SqliteRunRepository,
} from "./index";

describe("FilterOverrideRepository (@reqflow/db)", () => {
  let db: DatabaseSync;
  let tempDir: string | undefined;

  const sampleActor: Actor = {
    type: "human",
    userId: "pm_user_1",
    name: "Alex PM",
    role: "Product Manager",
  };

  const sampleOriginalInput: PipelineData = {
    ...emptyPipelineData(),
    records: [
      {
        id: "rec_1",
        sourceId: "src_1",
        text: "Excessive wind noise at highway speeds",
        fields: {},
      },
      {
        id: "rec_2",
        sourceId: "src_1",
        text: "Too expensive compared to competitors",
        fields: {},
      },
      {
        id: "rec_3",
        sourceId: "src_1",
        text: "Cup holders are too small",
        fields: {},
      },
    ],
  };

  const sampleReport: FilterReport = {
    schemaVersion: 1,
    runId: "run_sample_1",
    blockId: "blk_filter",
    createdAt: new Date().toISOString(),
    primaryLayer: "records",
    configurationHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    configuration: {
      criterion: "Customer facing",
      include: "",
      exclude: "",
      examples: "",
      fields: [],
      model: "fast",
      minConfidence: 0.7,
      keepUnsure: false,
    },
    originalInput: sampleOriginalInput,
    decisions: [
      {
        itemId: "rec_1",
        itemHash: "1111111111111111111111111111111111111111111111111111111111111111",
        modelDecision: "keep",
        outcome: "keep",
        confidence: 0.95,
        reason: "Valid customer cabin noise issue",
        quotes: [{ recordId: "rec_1", excerpt: "Excessive wind noise" }],
        model: "mock-model",
        forwarded: true,
        retainedAsContext: false,
      },
      {
        itemId: "rec_2",
        itemHash: "2222222222222222222222222222222222222222222222222222222222222222",
        modelDecision: "exclude",
        outcome: "exclude",
        confidence: 0.9,
        reason: "Pricing topic out of scope",
        quotes: [{ recordId: "rec_2", excerpt: "Too expensive" }],
        model: "mock-model",
        forwarded: false,
        retainedAsContext: false,
      },
      {
        itemId: "rec_3",
        itemHash: "3333333333333333333333333333333333333333333333333333333333333333",
        modelDecision: "review",
        outcome: "review",
        confidence: 0.5,
        reason: "Unclear ergonomics impact",
        quotes: [{ recordId: "rec_3", excerpt: "Cup holders" }],
        model: "mock-model",
        forwarded: false,
        retainedAsContext: false,
      },
    ],
    warnings: [],
  };

  async function seedRun(
    database: DatabaseSync,
    overrides?: {
      status?: "completed" | "waiting_for_review" | "failed" | "cancelled" | "running";
      workflowId?: string;
      blockKind?: string;
      report?: FilterReport;
    },
  ) {
    const runRepo = new SqliteRunRepository(database);
    const wfId = overrides?.workflowId ?? "wf_sample_1";
    const status = overrides?.status ?? "completed";
    const report = overrides?.report ?? sampleReport;
    const blockKind = overrides?.blockKind ?? "ai_filter";

    const run: WorkflowRun = {
      id: report.runId,
      workflowId: wfId,
      workflowVersion: 1,
      graph: {
        blocks: [
          {
            id: report.blockId,
            kind: blockKind as any,
            label: "Filter",
            position: { x: 0, y: 0 },
            params: {},
          },
        ],
        edges: [],
      },
      scope: {
        vehicleLine: "1 Series",
        vehicleCode: "F70",
        market: "EU",
        horizonYears: 4,
      },
      status,
      startedBy: { type: "system", component: "test" },
      startedAt: new Date().toISOString(),
      finishedAt: status === "completed" ? new Date().toISOString() : undefined,
      blockRuns: [
        {
          blockId: report.blockId,
          status: "succeeded",
          counts: { records: 1 },
          logs: [],
          filterReport: report,
        },
      ],
    };

    await runRepo.create(run);
    return run;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      db.close();
    } catch {}
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
      tempDir = undefined;
    }
  });

  it("fresh DB / reopen preserves overrides and versions", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "reqflow-filter-test-"));
    const dbPath = join(tempDir, "test.db");
    const fileDb = createDatabase(dbPath);

    await seedRun(fileDb);

    const repo1 = new FilterOverrideRepository(fileDb);
    const initialState = await repo1.get("wf_sample_1", "blk_filter");
    expect(initialState.version).toBe(0);
    expect(initialState.overrides).toEqual([]);

    const review: FilterReview = {
      expectedVersion: 0,
      itemIds: ["rec_2"],
      rationale: "Restore pricing for comparative context",
    };

    const restoredState = await repo1.restore(
      "wf_sample_1",
      "blk_filter",
      sampleReport,
      review,
      sampleActor,
    );
    expect(restoredState.version).toBe(1);
    expect(restoredState.overrides.length).toBe(1);
    expect(restoredState.overrides[0]!.itemId).toBe("rec_2");
    expect(restoredState.overrides[0]!.version).toBe(1);
    expect(restoredState.overrides[0]!.actor).toEqual(sampleActor);

    fileDb.close();

    // Reopen DB
    const reopenedDb = createDatabase(dbPath);
    const repo2 = new FilterOverrideRepository(reopenedDb);
    const loadedState = await repo2.get("wf_sample_1", "blk_filter");
    expect(loadedState.version).toBe(1);
    expect(loadedState.overrides.length).toBe(1);
    expect(loadedState.overrides[0]!.itemId).toBe("rec_2");
    expect(loadedState.overrides[0]!.itemHash).toBe(sampleReport.decisions[1]!.itemHash);
    expect(loadedState.overrides[0]!.configurationHash).toBe(sampleReport.configurationHash);
    reopenedDb.close();
  });

  it("rejects stale CAS with FilterOverrideConflictError and rolls back", async () => {
    await seedRun(db);
    const repo = new FilterOverrideRepository(db);

    const review1: FilterReview = {
      expectedVersion: 0,
      itemIds: ["rec_2"],
      rationale: "Restoring item 2",
    };
    await repo.restore("wf_sample_1", "blk_filter", sampleReport, review1, sampleActor);

    // Stale review with expectedVersion: 0 (now 1)
    const staleReview: FilterReview = {
      expectedVersion: 0,
      itemIds: ["rec_3"],
      rationale: "Restoring item 3 with stale version",
    };

    await expect(
      repo.restore("wf_sample_1", "blk_filter", sampleReport, staleReview, sampleActor),
    ).rejects.toThrow(FilterOverrideConflictError);

    const state = await repo.get("wf_sample_1", "blk_filter");
    expect(state.version).toBe(1);
    expect(state.overrides.map((o) => o.itemId)).toEqual(["rec_2"]);
  });

  it("rejects non-human actor", async () => {
    await seedRun(db);
    const repo = new FilterOverrideRepository(db);

    const aiActor: Actor = {
      type: "ai",
      component: "ai_filter",
      model: "fast",
    };

    const review: FilterReview = {
      expectedVersion: 0,
      itemIds: ["rec_2"],
      rationale: "Automated restore attempt",
    };

    await expect(
      repo.restore("wf_sample_1", "blk_filter", sampleReport, review, aiActor),
    ).rejects.toThrow("A human must restore an item");
  });

  it("rejects invalid item IDs and kept items", async () => {
    await seedRun(db);
    const repo = new FilterOverrideRepository(db);

    // 1. Item not in report
    const nonExistentReview: FilterReview = {
      expectedVersion: 0,
      itemIds: ["rec_missing"],
      rationale: "Restoring missing item",
    };
    await expect(
      repo.restore("wf_sample_1", "blk_filter", sampleReport, nonExistentReview, sampleActor),
    ).rejects.toThrow("not found in filter report");

    // 2. Item already kept
    const keptReview: FilterReview = {
      expectedVersion: 0,
      itemIds: ["rec_1"],
      rationale: "Restoring item that was already kept",
    };
    await expect(
      repo.restore("wf_sample_1", "blk_filter", sampleReport, keptReview, sampleActor),
    ).rejects.toThrow("was kept and cannot be restored");
  });

  it("rejects runs in running, failed, or cancelled states", async () => {
    const repo = new FilterOverrideRepository(db);

    for (const status of ["running", "failed", "cancelled"] as const) {
      const report = { ...sampleReport, runId: `run_${status}` };
      await seedRun(db, { status, report });

      const review: FilterReview = {
        expectedVersion: 0,
        itemIds: ["rec_2"],
        rationale: "Restoring on invalid state",
      };

      await expect(
        repo.restore("wf_sample_1", "blk_filter", report, review, sampleActor),
      ).rejects.toThrow("Source run must be completed or waiting_for_review");
    }
  });

  it("handles superseded history with monotonically increasing item versions", async () => {
    await seedRun(db);
    const repo = new FilterOverrideRepository(db);

    // Restore item 2
    const review1: FilterReview = {
      expectedVersion: 0,
      itemIds: ["rec_2"],
      rationale: "First restore of item 2",
    };
    await repo.restore("wf_sample_1", "blk_filter", sampleReport, review1, sampleActor);

    // Restore item 3
    const review2: FilterReview = {
      expectedVersion: 1,
      itemIds: ["rec_3"],
      rationale: "First restore of item 3",
    };
    await repo.restore("wf_sample_1", "blk_filter", sampleReport, review2, sampleActor);

    // Re-restore item 2 with new rationale (supersedes previous override)
    const review3: FilterReview = {
      expectedVersion: 2,
      itemIds: ["rec_2"],
      rationale: "Second restore of item 2 with updated rationale",
    };
    const state3 = await repo.restore(
      "wf_sample_1",
      "blk_filter",
      sampleReport,
      review3,
      sampleActor,
    );

    // Total rows = 3, state version = 3
    expect(state3.version).toBe(3);
    // Deduped overrides count = 2 (items 2 and 3)
    expect(state3.overrides.length).toBe(2);

    const item2Override = state3.overrides.find((o) => o.itemId === "rec_2");
    expect(item2Override).toBeDefined();
    expect(item2Override!.version).toBe(3);
    expect(item2Override!.rationale).toBe("Second restore of item 2 with updated rationale");

    const item3Override = state3.overrides.find((o) => o.itemId === "rec_3");
    expect(item3Override).toBeDefined();
    expect(item3Override!.version).toBe(2);
  });

  it("records filter.restored audit event atomically", async () => {
    await seedRun(db);
    const repo = new FilterOverrideRepository(db);
    const auditRepo = new SqliteAuditLogger(db);

    const review: FilterReview = {
      expectedVersion: 0,
      itemIds: ["rec_2", "rec_3"],
      rationale: "Restoring both items",
    };

    await repo.restore("wf_sample_1", "blk_filter", sampleReport, review, sampleActor);

    const audits = await auditRepo.list({ entityType: "filter", action: "filter.restored" });
    expect(audits.length).toBe(1);
    expect(audits[0]!.actor).toEqual(sampleActor);
    expect(audits[0]!.entityId).toBe("blk_filter");
    expect(audits[0]!.rationale).toBe("Restoring both items");
    expect(audits[0]!.changes).toEqual([
      { path: "filter.blk_filter.items.rec_2", before: "exclude", after: "keep" },
      { path: "filter.blk_filter.items.rec_3", before: "review", after: "keep" },
    ]);
  });

  it("historical report with unknown extension fields survives SQLite roundtrip", async () => {
    const runRepo = new SqliteRunRepository(db);
    const extendedInput = {
      ...sampleOriginalInput,
      records: sampleOriginalInput.records.map((record) => ({
        ...record,
        providerMetadata: { synthetic: true },
      })),
      _customProvenance: {
        ingestionCluster: "eu-west-1",
        checksum: "abcdef123456",
      },
    };

    const extendedReport: FilterReport = {
      ...sampleReport,
      runId: "run_extended_1",
      originalInput: extendedInput as any,
    };

    const run: WorkflowRun = {
      id: "run_extended_1",
      workflowId: "wf_extended",
      workflowVersion: 1,
      graph: {
        blocks: [
          {
            id: "blk_filter",
            kind: "ai_filter",
            label: "Filter",
            position: { x: 0, y: 0 },
            params: {},
          },
        ],
        edges: [],
      },
      scope: { vehicleLine: "1 Series", vehicleCode: "F70", market: "EU", horizonYears: 4 },
      status: "completed",
      startedBy: { type: "system", component: "test" },
      startedAt: new Date().toISOString(),
      blockRuns: [
        {
          blockId: "blk_filter",
          status: "succeeded",
          counts: { records: 3 },
          logs: [],
          filterReport: extendedReport,
        },
      ],
    };

    await runRepo.create(run);
    const retrieved = await runRepo.get("run_extended_1");
    const retrievedReport = retrieved.blockRuns[0]!.filterReport!;

    expect(retrievedReport).toBeDefined();
    expect((retrievedReport.originalInput as any)._customProvenance).toEqual({
      ingestionCluster: "eu-west-1",
      checksum: "abcdef123456",
    });
    expect(retrievedReport.originalInput.records).toEqual(extendedInput.records);
    await runRepo.update(retrieved);
    expect((await runRepo.get(retrieved.id)).blockRuns[0]!.filterReport).toEqual(extendedReport);
  });

  it("rolls back every override when audit insertion fails", async () => {
    const run = await seedRun(db);
    const runRepo = new SqliteRunRepository(db);
    const outputs = { out: { ...emptyPipelineData(), records: [sampleOriginalInput.records[0]!] } };
    await runRepo.saveBlockOutput(run.id, "blk_filter", outputs);
    db.exec(`CREATE TRIGGER reject_filter_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'filter.restored' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;`);
    const repo = new FilterOverrideRepository(db);
    await expect(
      repo.restore(
        "wf_sample_1",
        "blk_filter",
        sampleReport,
        { expectedVersion: 0, itemIds: ["rec_2", "rec_3"], rationale: "Restore both" },
        sampleActor,
      ),
    ).rejects.toThrow("synthetic audit failure");
    expect(await repo.get("wf_sample_1", "blk_filter")).toEqual({ version: 0, overrides: [] });
    expect(await new SqliteAuditLogger(db).list({ action: "filter.restored" })).toEqual([]);
    expect(await runRepo.get(run.id)).toEqual(WorkflowRun.parse(run));
    expect(await runRepo.getBlockOutput(run.id, "blk_filter")).toEqual(outputs);
    db.exec("DROP TRIGGER reject_filter_audit");
    expect(
      (
        await repo.restore(
          "wf_sample_1",
          "blk_filter",
          sampleReport,
          { expectedVersion: 0, itemIds: ["rec_2"], rationale: "Retry" },
          sampleActor,
        )
      ).version,
    ).toBe(1);
  });

  it("validates workflow/block/report identity, rationale and duplicate IDs without writes", async () => {
    await seedRun(db);
    const repo = new FilterOverrideRepository(db);
    const review = { expectedVersion: 0, itemIds: ["rec_2"], rationale: "Restore" };
    await expect(
      repo.restore("wf_wrong", "blk_filter", sampleReport, review, sampleActor),
    ).rejects.toThrow();
    await expect(
      repo.restore("wf_sample_1", "wrong_block", sampleReport, review, sampleActor),
    ).rejects.toThrow();
    await expect(
      repo.restore(
        "wf_sample_1",
        "blk_filter",
        { ...sampleReport, configurationHash: "b".repeat(64) },
        review,
        sampleActor,
      ),
    ).rejects.toThrow("authoritative");
    await expect(
      repo.restore(
        "wf_sample_1",
        "blk_filter",
        sampleReport,
        { ...review, rationale: " " },
        sampleActor,
      ),
    ).rejects.toThrow();
    await expect(
      repo.restore(
        "wf_sample_1",
        "blk_filter",
        sampleReport,
        { ...review, itemIds: ["rec_2", "rec_2"] },
        sampleActor,
      ),
    ).rejects.toThrow();
    expect(await repo.get("wf_sample_1", "blk_filter")).toEqual({ version: 0, overrides: [] });
  });

  it("accepts held review on paused runs but not review already forwarded by keepUnsure", async () => {
    const report = structuredClone(sampleReport);
    report.decisions[2]!.forwarded = true;
    await seedRun(db, { status: "waiting_for_review", report });
    const repo = new FilterOverrideRepository(db);
    await expect(
      repo.restore(
        "wf_sample_1",
        "blk_filter",
        report,
        { expectedVersion: 0, itemIds: ["rec_3"], rationale: "Restore" },
        sampleActor,
      ),
    ).rejects.toThrow("not held for review");
    expect(
      (
        await repo.restore(
          "wf_sample_1",
          "blk_filter",
          report,
          { expectedVersion: 0, itemIds: ["rec_2"], rationale: "Restore excluded" },
          sampleActor,
        )
      ).version,
    ).toBe(1);
  });

  it("keeps separate fingerprints and full history count", async () => {
    await seedRun(db);
    const repo = new FilterOverrideRepository(db);
    await repo.restore(
      "wf_sample_1",
      "blk_filter",
      sampleReport,
      { expectedVersion: 0, itemIds: ["rec_2"], rationale: "Original" },
      sampleActor,
    );
    const report = { ...sampleReport, runId: "run_changed", configurationHash: "b".repeat(64) };
    await seedRun(db, { report });
    const state = await repo.restore(
      "wf_sample_1",
      "blk_filter",
      report,
      { expectedVersion: 1, itemIds: ["rec_2"], rationale: "New configuration" },
      sampleActor,
    );
    expect(state.version).toBe(2);
    expect(state.overrides).toHaveLength(2);
    expect(state.overrides.map((override) => override.configurationHash)).toEqual([
      sampleReport.configurationHash,
      report.configurationHash,
    ]);
  });

  it("additively migrates an existing database and preserves newer schema versions", async () => {
    db.exec("DROP TABLE filter_overrides; PRAGMA user_version = 0");
    await seedRun(db);
    const { initSchema } = await import("./db");
    initSchema(db);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(
      (await new SqliteRunRepository(db).get(sampleReport.runId)).blockRuns[0]!.filterReport,
    ).toEqual(sampleReport);
    db.exec("PRAGMA user_version = 2");
    initSchema(db);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    expect(await new FilterOverrideRepository(db).get("wf_sample_1", "blk_filter")).toEqual({
      version: 0,
      overrides: [],
    });
  });

  it("checks source run state inside the locked transaction", async () => {
    await seedRun(db);
    const originalExec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      originalExec(sql);
      if (sql === "BEGIN IMMEDIATE") {
        db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(sampleReport.runId);
      }
    });
    const repo = new FilterOverrideRepository(db);
    await expect(
      repo.restore(
        "wf_sample_1",
        "blk_filter",
        sampleReport,
        { expectedVersion: 0, itemIds: ["rec_2"], rationale: "Restore" },
        sampleActor,
      ),
    ).rejects.toThrow("Source run must be completed or waiting_for_review");
    expect(await repo.get("wf_sample_1", "blk_filter")).toEqual({ version: 0, overrides: [] });
  });
});
