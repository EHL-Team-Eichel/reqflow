import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlockRegistry } from "@reqflow/blocks";
import {
  connect,
  createBlock,
  emptyPipelineData,
  setBlockParams,
  type FilterReport,
  type FilterReview,
  type LlmClient,
  type PipelineData,
  type WorkflowRun,
} from "@reqflow/core";
import {
  createDatabase,
  createFileStore,
  FilterOverrideRepository,
  SqliteAuditLogger,
  SqliteRunRepository,
} from "@reqflow/db";
import { createHandlers } from "./handlers";
import { SecretsStore, type SecureStorage } from "./secrets";
import { ReqflowError } from "./dispatch";
import { WorkflowExecutor } from "@reqflow/engine";

const secureStorage: SecureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`synthetic-cipher:${value}`),
  decryptString: (value) => {
    const text = value.toString();
    return text.replace("synthetic-cipher:", "");
  },
};
const syntheticSecrets = (dir: string) => new SecretsStore(dir, { secureStorage, environment: {} });

const SYNTHETIC_CSV = [
  "id,comment",
  "F1,Wind noise at highway speeds is too loud",
  "F2,The subscription pricing for heated seats is unacceptable",
].join("\n");

describe("AI Filter Main IPC Handlers & Integration (@reqflow/desktop)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "reqflow-filter-handlers-test-"));
    dbPath = join(tempDir, "test.db");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  const setup = (customLlm?: LlmClient) => {
    const pushedRuns: WorkflowRun[] = [];
    const secretsStore = syntheticSecrets(tempDir);
    const files = createFileStore(join(tempDir, "uploads"));
    const registry = createBlockRegistry();

    const handlers = createHandlers({
      dataDir: tempDir,
      dbPath,
      files,
      secretsStore,
      registry,
      pushRunUpdate: (r) => pushedRuns.push(r),
      pickFile: vi.fn().mockResolvedValue(null),
      saveDialog: vi.fn(),
      appInfo: () => ({
        version: "0.1.0",
        platform: "darwin",
        dataDir: tempDir,
        isPackaged: false,
      }),
      llm: customLlm,
    });

    const db = createDatabase(dbPath);
    return { handlers, pushedRuns, secretsStore, files, db };
  };

  const seedCompletedFilterRun = async (
    database: DatabaseSync,
    opts?: { status?: "completed" | "waiting_for_review" | "failed" | "cancelled" | "running" },
  ) => {
    const runRepo = new SqliteRunRepository(database);
    const status = opts?.status ?? "completed";

    const originalInput: PipelineData = {
      ...emptyPipelineData(),
      records: [
        {
          id: "rec_1",
          sourceId: "src_1",
          text: "Wind noise in cabin",
          fields: {},
        },
        {
          id: "rec_2",
          sourceId: "src_1",
          text: "Pricing concern",
          fields: {},
        },
      ],
    };

    const filterReport: FilterReport = {
      schemaVersion: 1,
      runId: "run_flt_1",
      blockId: "blk_filter",
      createdAt: new Date().toISOString(),
      primaryLayer: "records",
      configurationHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      configuration: {
        criterion: "Vehicle attributes",
        include: "",
        exclude: "",
        examples: "",
        fields: [],
        model: "fast",
        minConfidence: 0.7,
        keepUnsure: false,
      },
      originalInput,
      decisions: [
        {
          itemId: "rec_1",
          itemHash: "1111111111111111111111111111111111111111111111111111111111111111",
          modelDecision: "keep",
          outcome: "keep",
          confidence: 0.9,
          reason: "Relevant wind noise",
          quotes: [{ recordId: "rec_1", excerpt: "Wind noise" }],
          model: "fast",
          forwarded: true,
          retainedAsContext: false,
        },
        {
          itemId: "rec_2",
          itemHash: "2222222222222222222222222222222222222222222222222222222222222222",
          modelDecision: "exclude",
          outcome: "exclude",
          confidence: 0.85,
          reason: "Pricing excluded",
          quotes: [{ recordId: "rec_2", excerpt: "Pricing concern" }],
          model: "fast",
          forwarded: false,
          retainedAsContext: false,
        },
      ],
      warnings: [],
    };

    const run: WorkflowRun = {
      id: "run_flt_1",
      workflowId: "wf_flt_1",
      workflowVersion: 1,
      graph: {
        blocks: [
          {
            id: "blk_filter",
            kind: "ai_filter",
            label: "AI Filter",
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
          blockId: "blk_filter",
          status: "succeeded",
          counts: { records: 1 },
          logs: [],
          filterReport,
        },
      ],
    };

    await runRepo.create(run);
    await runRepo.saveBlockOutput("run_flt_1", "blk_filter", {
      out: {
        ...emptyPipelineData(),
        records: [originalInput.records[0]!],
      },
    });

    return { run, filterReport };
  };

  it("validates handler arguments and review schema", async () => {
    const { handlers, db } = setup();
    await seedCompletedFilterRun(db);

    // 1. Invalid runId format
    await expect(handlers.runs.filterReviewState("invalid_id", "blk_filter")).rejects.toThrow(
      ReqflowError,
    );

    // 2. Empty blockId
    await expect(handlers.runs.filterReviewState("run_flt_1", "")).rejects.toThrow(ReqflowError);

    // 3. Duplicate itemIds in review
    const duplicateReview: FilterReview = {
      expectedVersion: 0,
      itemIds: ["rec_2", "rec_2"],
      rationale: "Restore",
    };
    await expect(
      handlers.runs.reviewFilter("run_flt_1", "blk_filter", duplicateReview),
    ).rejects.toThrow(ReqflowError);

    // 4. Empty rationale in review
    const emptyRationaleReview = {
      expectedVersion: 0,
      itemIds: ["rec_2"],
      rationale: "   ",
    };
    await expect(
      handlers.runs.reviewFilter("run_flt_1", "blk_filter", emptyRationaleReview as any),
    ).rejects.toThrow(ReqflowError);
  });

  it("guards against active executor / DB run status: only completed or waiting_for_review permitted", async () => {
    const { handlers, db } = setup();

    for (const status of ["failed", "cancelled", "running"] as const) {
      const runRepo = new SqliteRunRepository(db);
      const runId = `run_${status}_1`;
      const run: WorkflowRun = {
        id: runId,
        workflowId: "wf_1",
        workflowVersion: 1,
        graph: {
          blocks: [
            { id: "b1", kind: "ai_filter", label: "Filter", position: { x: 0, y: 0 }, params: {} },
          ],
          edges: [],
        },
        scope: { vehicleLine: "1 Series", vehicleCode: "F70", market: "EU", horizonYears: 4 },
        status,
        startedBy: { type: "system", component: "test" },
        startedAt: new Date().toISOString(),
        blockRuns: [{ blockId: "b1", status: "pending", counts: {}, logs: [] }],
      };
      await runRepo.create(run);

      const review: FilterReview = {
        expectedVersion: 0,
        itemIds: ["rec_2"],
        rationale: "Restore attempt",
      };

      await expect(handlers.runs.reviewFilter(runId, "b1", review)).rejects.toThrow(
        /Cannot restore filter items on run/,
      );
    }
  });

  it("persisted fallback reads state when run is not in executor active memory", async () => {
    const { handlers, db } = setup();
    await seedCompletedFilterRun(db);

    // Run was seeded directly in DB, executor does not have it in its session map
    const state = await handlers.runs.filterReviewState("run_flt_1", "blk_filter");
    expect(state.version).toBe(0);
    expect(state.overrides).toEqual([]);
  });

  it("rejects state reads for non-filter, missing or mismatched reports", async () => {
    const { handlers, db } = setup();
    const { run } = await seedCompletedFilterRun(db);
    const runRepo = new SqliteRunRepository(db);
    for (const fault of ["missing", "wrongRun", "wrongBlock", "wrongKind"] as const) {
      const altered = structuredClone(run);
      if (fault === "missing") delete altered.blockRuns[0]!.filterReport;
      if (fault === "wrongRun") altered.blockRuns[0]!.filterReport!.runId = "run_other";
      if (fault === "wrongBlock") altered.blockRuns[0]!.filterReport!.blockId = "other";
      if (fault === "wrongKind") {
        db.prepare("UPDATE runs SET graph = ? WHERE id = ?").run(
          JSON.stringify({ ...run.graph, blocks: [{ ...run.graph.blocks[0], kind: "raw" }] }),
          run.id,
        );
      } else {
        db.prepare("UPDATE runs SET graph = ? WHERE id = ?").run(JSON.stringify(run.graph), run.id);
      }
      await runRepo.update(altered);
      await expect(handlers.runs.filterReviewState(run.id, "blk_filter")).rejects.toMatchObject({
        code: "invalid_state",
      });
    }
  });

  it("maps invalid items and stale CAS without mutations or automatic updates", async () => {
    const { handlers, pushedRuns, db } = setup();
    await seedCompletedFilterRun(db);
    const review = { expectedVersion: 0, itemIds: ["rec_2"], rationale: "Restore" };
    for (const itemId of ["rec_1", "rec_missing"]) {
      await expect(
        handlers.runs.reviewFilter("run_flt_1", "blk_filter", { ...review, itemIds: [itemId] }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    await handlers.runs.reviewFilter("run_flt_1", "blk_filter", review);
    await expect(
      handlers.runs.reviewFilter("run_flt_1", "blk_filter", review),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await handlers.runs.filterReviewState("run_flt_1", "blk_filter")).version).toBe(1);
    expect(pushedRuns).toEqual([]);
  });

  it("rejects active executor operations even while persisted status remains paused", async () => {
    const { handlers, db } = setup();
    await seedCompletedFilterRun(db, { status: "waiting_for_review" });
    vi.spyOn(WorkflowExecutor.prototype, "isRunActive").mockReturnValue(true);
    await expect(
      handlers.runs.reviewFilter("run_flt_1", "blk_filter", {
        expectedVersion: 0,
        itemIds: ["rec_2"],
        rationale: "Restore",
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(await new FilterOverrideRepository(db).get("wf_flt_1", "blk_filter")).toEqual({
      version: 0,
      overrides: [],
    });
  });

  it("reads human identity from current main Settings, never renderer, and does not mutate historical outputs", async () => {
    const { handlers, db } = setup();
    const { filterReport } = await seedCompletedFilterRun(db);

    // Update settings reviewer to a specific human PM
    const currentSettings = await handlers.settings.get();
    const customReviewer = {
      userId: "pm_johannes_99",
      name: "Johannes PM",
      role: "Lead PM",
    };
    await handlers.settings.save({
      ...currentSettings,
      review: {
        ...currentSettings.review,
        reviewer: customReviewer,
      },
    });

    const review: FilterReview = {
      expectedVersion: 0,
      itemIds: ["rec_2"],
      rationale: "PM decision: keep pricing comment for feature cost evaluation",
    };

    const nextState = await handlers.runs.reviewFilter("run_flt_1", "blk_filter", review);
    expect(nextState.version).toBe(1);
    expect(nextState.overrides.length).toBe(1);
    expect(nextState.overrides[0]!.actor).toEqual({
      type: "human",
      userId: customReviewer.userId,
      name: customReviewer.name,
      role: customReviewer.role,
    });

    // Check audit trail recorded this exact human actor
    const auditLogger = new SqliteAuditLogger(db);
    const audits = await auditLogger.list({ entityType: "filter", action: "filter.restored" });
    expect(audits.length).toBe(1);
    expect(audits[0]!.actor).toEqual({
      type: "human",
      userId: customReviewer.userId,
      name: customReviewer.name,
      role: customReviewer.role,
    });

    // Verify historical run and block output were NOT mutated
    const runRepo = new SqliteRunRepository(db);
    const unchangedRun = await runRepo.get("run_flt_1");
    expect(unchangedRun.status).toBe("completed");
    expect(unchangedRun.blockRuns[0]!.counts.records).toBe(1);
    const unchangedOutput = await runRepo.getBlockOutput("run_flt_1", "blk_filter");
    expect(unchangedOutput!.out!.records.length).toBe(1);
    expect(unchangedOutput!.out!.records[0]!.id).toBe("rec_1");
    expect(unchangedRun.blockRuns[0]!.filterReport).toEqual(filterReport);
  });

  it("stable-input integration: Raw -> offline filter -> persistence -> restoration -> explicit rerun -> configuration invalidation", async () => {
    // 1. Setup offline stub LLM that classifies F1 as keep, F2 as exclude
    const stubLlm: LlmClient = {
      generateObject: async (req) => {
        const payload = JSON.parse(req.prompt);
        const decisions = payload.items.map((entry: any) => {
          const text = entry.item.text || "";
          const firstWord = text.split(" ")[0] || "quote";
          const isF1 = entry.id === "F1" || text.includes("Wind noise");
          return {
            id: entry.id,
            decision: isF1 ? "keep" : "exclude",
            confidence: 0.9,
            reason: isF1 ? "Cabin noise relevant" : "Subscription topic out of scope",
            quotes: [{ recordId: entry.id, excerpt: firstWord }],
          };
        });
        return {
          object: req.schema.parse({
            contract: "reqflow.ai-filter.selection@1",
            decisions,
          }),
          model: "stub-llm-v1",
        };
      },
      generateText: async () => ({ text: "ok", model: "stub-llm-v1" }),
    };

    const { handlers, files } = setup(stubLlm);

    // 2. Import synthetic CSV file into dataDir
    const csvPath = join(tempDir, "feedback.csv");
    writeFileSync(csvPath, SYNTHETIC_CSV, "utf-8");
    const file = await files.importFile(csvPath);

    // 3. Create workflow: Raw -> AI Filter
    const raw = createBlock("raw", { id: "raw", position: { x: 0, y: 0 } });
    const filter = createBlock("ai_filter", { id: "filter", position: { x: 300, y: 0 } });

    let graph = setBlockParams({ blocks: [raw, filter], edges: [] }, "raw", {
      ...raw.params,
      dataset: "customer_feedback",
      file: { fileId: file.id, name: file.name },
    }).graph;

    graph = setBlockParams(graph, "filter", {
      ...filter.params,
      criterion: "Customer-facing vehicle comfort and cabin quality",
      keepUnsure: false,
    }).graph;

    graph = connect(graph, {
      source: "raw",
      sourcePort: "out",
      target: "filter",
      targetPort: "in",
    });

    const workflow = await handlers.workflows.save({
      ...graph,
      name: "Raw to Filter",
      scope: {
        vehicleLine: "1 Series",
        vehicleCode: "F70",
        market: "EU",
        horizonYears: 4,
      },
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T12:00:00.000Z"));

    try {
      // 4. First run
      const initialRun = await handlers.runs.start(workflow.id);
      let run = await handlers.runs.get(initialRun.id);
      for (let i = 0; i < 200 && ["queued", "running"].includes(run.status); i++) {
        await new Promise((r) => setTimeout(r, 50));
        run = await handlers.runs.get(initialRun.id);
      }

      expect(run.status).toBe("completed");
      expect(run.error).toBeUndefined();

      // Verify first run output: only 1 record kept (Wind noise)
      const run1Output = await handlers.runs.blockOutput(run.id, "filter");
      expect(run1Output.out!.records.length).toBe(1);
      expect(run1Output.out!.records[0]!.text).toContain("Wind noise");

      const run1FilterRun = run.blockRuns.find((b) => b.blockId === "filter")!;
      expect(run1FilterRun.filterReport).toBeDefined();
      expect(run1FilterRun.filterReport!.decisions.length).toBe(2);

      // 5. PM restores excluded item
      const excludedDecision = run1FilterRun.filterReport!.decisions.find(
        (d) => d.outcome === "exclude",
      )!;
      const review: FilterReview = {
        expectedVersion: 0,
        itemIds: [excludedDecision.itemId],
        rationale: "Restore subscription pricing comment for package strategy",
      };
      const stateAfterRestore = await handlers.runs.reviewFilter(run.id, "filter", review);
      expect(stateAfterRestore.version).toBe(1);
      expect(stateAfterRestore.overrides.length).toBe(1);

      // 6. Old output is unchanged
      const run1OutputAgain = await handlers.runs.blockOutput(run.id, "filter");
      expect(run1OutputAgain.out!.records.length).toBe(1);
      expect(run1OutputAgain.out!.records[0]!.text).toContain("Wind noise");

      // 7. Explicit rerun: starts second run of the same workflow
      const secondRunInitial = await handlers.runs.start(workflow.id);
      let secondRun = await handlers.runs.get(secondRunInitial.id);
      for (let i = 0; i < 200 && ["queued", "running"].includes(secondRun.status); i++) {
        await new Promise((r) => setTimeout(r, 50));
        secondRun = await handlers.runs.get(secondRunInitial.id);
      }

      expect(secondRun.status).toBe("completed");
      // With override applied, both records are forwarded!
      const run2Output = await handlers.runs.blockOutput(secondRun.id, "filter");
      expect(run2Output.out!.records.length).toBe(2);

      // Raw changes retrieval time on a later run, but unchanged evidence still matches the restore.
      vi.setSystemTime(new Date("2026-10-11T12:01:00.000Z"));
      const laterRunInitial = await handlers.runs.start(workflow.id);
      let laterRun = await handlers.runs.get(laterRunInitial.id);
      for (let i = 0; i < 200 && ["queued", "running"].includes(laterRun.status); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        laterRun = await handlers.runs.get(laterRunInitial.id);
      }
      expect(laterRun.status).toBe("completed");
      expect(
        laterRun.blockRuns.find((state) => state.blockId === "filter")!.filterReport!
          .configurationHash,
      ).toBe(run1FilterRun.filterReport!.configurationHash);
      expect((await handlers.runs.blockOutput(laterRun.id, "filter")).out!.records).toHaveLength(2);
      vi.setSystemTime(new Date("2026-10-11T12:00:00.000Z"));

      // 8. Changed filter configuration invalidates override
      const updatedGraph = setBlockParams(graph, "filter", {
        ...filter.params,
        criterion: "Changed criterion: Strictly powertrain performance only",
        keepUnsure: false,
      }).graph;

      const updatedWorkflow = await handlers.workflows.save({
        ...updatedGraph,
        id: workflow.id,
        name: "Raw to Filter Updated",
        scope: workflow.scope,
      });

      const thirdRunInitial = await handlers.runs.start(updatedWorkflow.id);
      let thirdRun = await handlers.runs.get(thirdRunInitial.id);
      for (let i = 0; i < 200 && ["queued", "running"].includes(thirdRun.status); i++) {
        await new Promise((r) => setTimeout(r, 50));
        thirdRun = await handlers.runs.get(thirdRunInitial.id);
      }

      expect(thirdRun.status).toBe("completed");
      // Since configuration changed, configurationHash changed, override is invalidated: only F1 is kept
      const run3Output = await handlers.runs.blockOutput(thirdRun.id, "filter");
      expect(run3Output.out!.records.length).toBe(1);
      expect(run3Output.out!.records[0]!.text).toContain("Wind noise");
    } finally {
      vi.useRealTimers();
    }
  });
});
