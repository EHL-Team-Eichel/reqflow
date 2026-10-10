import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlock, DEFAULT_SETTINGS, setBlockParams, type WorkflowGraph } from "@reqflow/core";
import { createFileStore } from "@reqflow/db";
import { createMastraLlmClient } from "@reqflow/llm";
import { createHandlers } from "./handlers";
import { SecretsStore } from "./secrets";

const SAMPLE_STUDY = join(import.meta.dirname, "../../../../data/samples/customer_study.xlsx");

describe("AI Splitter review through main IPC handlers", () => {
  let dir: string;
  let dbPath: string;
  let handlers: ReturnType<typeof createHandlers>;
  let files: ReturnType<typeof createFileStore>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reqflow-splitter-review-"));
    dbPath = join(dir, "reqflow.db");
    const baseFiles = createFileStore(join(dir, "uploads"));
    // The file store uses .json for metadata too; keep imported Research JSON bytes in this test adapter.
    const jsonBytes = new Map<string, Uint8Array>();
    files = {
      ...baseFiles,
      async importFile(path) {
        const info = await baseFiles.importFile(path);
        if (path.endsWith(".json"))
          jsonBytes.set(
            info.id,
            new Uint8Array(await (await import("node:fs/promises")).readFile(path)),
          );
        return info;
      },
      async get(id) {
        const bytes = jsonBytes.get(id);
        if (bytes) return { id, name: "research.json", mimeType: "application/json", bytes };
        return baseFiles.get(id);
      },
    };
    handlers = createHandlers({
      dataDir: dir,
      dbPath,
      files,
      secretsStore: new SecretsStore(dir),
      llm: createMastraLlmClient({ ...DEFAULT_SETTINGS.llm, provider: "mock" }),
      pickFile: vi.fn().mockResolvedValue(null),
      appInfo: () => ({ version: "test", platform: "darwin", dataDir: dir, isPackaged: false }),
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function waitForRun(runId: string, states = ["running"] as string[]) {
    const deadline = Date.now() + 15_000;
    let run = await handlers.runs.get(runId);
    while (states.includes(run.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      run = await handlers.runs.get(runId);
    }
    return run;
  }

  async function rawInputs() {
    const researchPath = join(dir, "research.json");
    const research = {
      sources: [
        {
          id: "src_research_synthetic",
          kind: "review",
          origin: "web",
          title: "Synthetic review",
          uri: "https://example.invalid/synthetic-review",
          retrievedAt: "2026-01-01T00:00:00.000Z",
          reliability: "medium",
        },
      ],
      records: [
        {
          id: "rec_research_synthetic",
          sourceId: "src_research_synthetic",
          text: "Synthetic driver says the seat support should improve.",
          locator: "page 4, paragraph 2",
          fields: {
            provider: "synthetic",
            originalId: "review-1",
            provenance: { fixture: "research" },
          },
        },
      ],
    };
    writeFileSync(researchPath, JSON.stringify(research));
    const researchFile = await files.importFile(researchPath);
    const studyFile = await files.importFile(SAMPLE_STUDY);

    const sqlitePath = join(dir, "synthetic.sqlite");
    const sqlite = new DatabaseSync(sqlitePath);
    sqlite.exec(
      "CREATE TABLE opinions (comment TEXT, id TEXT); INSERT INTO opinions VALUES ('Synthetic customer needs easier seat adjustment.', 'db-1'), ('Synthetic driver cannot reach the rear controls.', 'db-2')",
    );
    sqlite.close();

    const sourceBlocks = ["research", "database", "study"].map((id, i) =>
      createBlock("raw", { id, position: { x: 0, y: i * 120 } }),
    );
    const splitter = createBlock("ai_splitter", { id: "split", position: { x: 300, y: 0 } });
    const params = sourceBlocks.map((block, i) => {
      if (i === 0)
        return { ...block.params, file: { fileId: researchFile.id, name: researchFile.name } };
      if (i === 1)
        return {
          ...block.params,
          source: "database",
          dbType: "sqlite",
          connection: sqlitePath,
          query: "SELECT comment, id FROM opinions",
        };
      return {
        ...block.params,
        file: { fileId: studyFile.id, name: studyFile.name },
        dataset: "customer_study",
      };
    });
    return { sourceBlocks, splitter, params };
  }

  async function createRun(splitBy: string, withGates = false, editable = true) {
    const { sourceBlocks, splitter, params } = await rawInputs();
    const hilBlocks = withGates
      ? ["out-2"].map((_, i) => {
          const block = createBlock("hil", { id: `hil-${i}`, position: { x: 650, y: i * 120 } });
          return setBlockParams({ blocks: [block], edges: [] }, block.id, {
            ...block.params,
            allowEdits: editable,
          }).graph.blocks[0]!;
        })
      : [];
    const configuredSplitter = setBlockParams({ blocks: [splitter], edges: [] }, splitter.id, {
      ...splitter.params,
      splitBy,
      branches: ["High", "Medium", "Low"],
      instruction: splitBy === "custom" ? "Group synthetic feedback by customer need" : "",
    }).graph.blocks[0]!;
    let graph: WorkflowGraph = {
      blocks: [...sourceBlocks, configuredSplitter, ...hilBlocks],
      edges: [
        ...sourceBlocks.map((b) => ({
          id: `e-${b.id}`,
          source: b.id,
          sourcePort: "out",
          target: "split",
          targetPort: "in",
        })),
        ...hilBlocks.map((b, i) => ({
          id: `e-hil-${i}`,
          source: "split",
          sourcePort: "out-2",
          target: b.id,
          targetPort: "in",
        })),
      ],
    };
    // Apply source-specific Raw parameters after composing the full graph.
    sourceBlocks.forEach((block, i) => {
      graph = setBlockParams(graph, block.id, params[i]!).graph;
    });
    const workflow = await handlers.workflows.save({
      ...graph,
      name: `Synthetic ${splitBy}`,
      scope: DEFAULT_SETTINGS.defaultScope,
    });
    const started = await handlers.runs.start(workflow.id);
    return {
      run: await waitForRun(started.id, ["running"]),
      splitter: configuredSplitter,
      hilBlocks,
    };
  }

  it.each(["customer_priority", "car_parts", "custom"])(
    "merges Research JSON, SQLite and sample study into %s report and persists exact-once outputs",
    async (splitBy) => {
      const { run } = await createRun(splitBy);
      expect(run.error).toBeUndefined();
      expect(run.status).toBe("completed");
      const splitterRun = run.blockRuns.find((b) => b.blockId === "split")!;
      expect(splitterRun.splitterReport).toMatchObject({
        mode: splitBy,
        input: { primaryLayer: "records", customerCount: null },
      });
      const outputs = await handlers.runs.blockOutput(run.id, "split");
      const routed = Object.values(outputs).flatMap((output) => output.records);
      const ids = routed.map((record) => record.id);
      expect(ids).toHaveLength(new Set(ids).size);
      expect(ids).toEqual(expect.arrayContaining(["rec_research_synthetic"]));
      expect(routed.find((record) => record.id === "rec_research_synthetic")).toMatchObject({
        sourceId: "src_research_synthetic",
        locator: "page 4, paragraph 2",
        fields: { provenance: { fixture: "research" } },
      });
      expect(splitterRun.splitterReport!.input.recordCount).toBe(routed.length);

      const restarted = createHandlers({
        dataDir: dir,
        dbPath,
        files,
        secretsStore: new SecretsStore(dir),
        llm: createMastraLlmClient({ ...DEFAULT_SETTINGS.llm, provider: "mock" }),
        pickFile: vi.fn().mockResolvedValue(null),
        appInfo: () => ({ version: "test", platform: "darwin", dataDir: dir, isPackaged: false }),
      });
      const persisted = await restarted.runs.get(run.id);
      expect(persisted.status).toBe("completed");
      expect(persisted.blockRuns.find((b) => b.blockId === "split")?.splitterReport).toEqual(
        splitterRun.splitterReport,
      );
    },
  );

  it("human corrects routes at a paused editable HIL, rejects invalid reviews, and persists corrected ports", async () => {
    const { run, hilBlocks } = await createRun("customer_priority", true);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("waiting_for_review");
    const beforeRequirements = await handlers.requirements.list();
    const splitterRun = run.blockRuns.find((b) => b.blockId === "split")!;
    const report = splitterRun.splitterReport!;
    const assignment = report.assignments.find((item) => item.outputPortId !== "out-2")!;
    const target = "out-2";
    const review = {
      expectedVersion: 0,
      rationale: "Human reviewer identified a better evidence-aligned branch.",
      changes: [{ itemId: assignment.itemId, toPortId: target }],
    };
    const corrected = await handlers.runs.reviewSplitter(run.id, "split", review);
    expect(
      corrected.blockRuns.find((b) => b.blockId === "split")!.splitterReport!.reviews,
    ).toHaveLength(1);
    const audit = await handlers.audit.list({ runId: run.id, action: "run.routing_reviewed" });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: { type: "human" }, rationale: review.rationale });
    await expect(handlers.runs.reviewSplitter(run.id, "split", review)).rejects.toThrow(
      /version changed/i,
    );
    await expect(
      handlers.runs.reviewSplitter(run.id, "split", {
        ...review,
        expectedVersion: 1,
        changes: [{ itemId: "missing", toPortId: target }],
      }),
    ).rejects.toThrow();
    await expect(
      handlers.runs.reviewSplitter(run.id, "split", {
        ...review,
        expectedVersion: 1,
        changes: [{ itemId: assignment.itemId, toPortId: "out-99" }],
      }),
    ).rejects.toThrow();
    await expect(
      handlers.runs.reviewSplitter(run.id, "split", { ...review, expectedVersion: 1, changes: [] }),
    ).rejects.toThrow();
    const reviewedOutputs = await handlers.runs.blockOutput(run.id, "split");
    expect(reviewedOutputs[target]!.records.map((r) => r.id)).toContain(assignment.itemId);
    expect(reviewedOutputs[assignment.outputPortId]!.records.map((r) => r.id)).not.toContain(
      assignment.itemId,
    );

    let current = corrected;
    const deadline = Date.now() + 15_000;
    while (current.status !== "completed" && Date.now() < deadline) {
      const waitingHil = current.blockRuns.find((br) => br.status === "waiting_for_review");
      if (waitingHil) current = await handlers.runs.resume(current.id);
      else current = await waitForRun(current.id, ["running"]);
    }
    expect(current.status).toBe("completed");
    for (const hil of hilBlocks) {
      const output = await handlers.runs.blockOutput(run.id, hil.id);
      expect(output.out).toBeDefined();
      expect(output.out?.records.map((r) => r.id)).toEqual(
        reviewedOutputs["out-2"]!.records.map((r) => r.id),
      );
    }
    await expect(
      handlers.runs.reviewSplitter(run.id, "split", {
        ...review,
        expectedVersion: 1,
        changes: [{ itemId: assignment.itemId, toPortId: assignment.outputPortId }],
      }),
    ).rejects.toThrow(/paused HIL/i);
    expect(await handlers.requirements.list()).toEqual(beforeRequirements);

    const restarted = createHandlers({
      dataDir: dir,
      dbPath,
      files,
      secretsStore: new SecretsStore(dir),
      llm: createMastraLlmClient({ ...DEFAULT_SETTINGS.llm, provider: "mock" }),
      pickFile: vi.fn().mockResolvedValue(null),
      appInfo: () => ({ version: "test", platform: "darwin", dataDir: dir, isPackaged: false }),
    });
    const persisted = await restarted.runs.get(run.id);
    expect(persisted.status).toBe("completed");
    expect(
      persisted.blockRuns.find((b) => b.blockId === "split")!.splitterReport!.reviews,
    ).toHaveLength(1);
    expect(await restarted.runs.blockOutput(run.id, "split")).toEqual(reviewedOutputs);
    expect(
      await restarted.audit.list({ runId: run.id, action: "run.routing_reviewed" }),
    ).toHaveLength(1);
  });

  it("rejects route corrections when the paused HIL does not allow edits", async () => {
    const { run } = await createRun("customer_priority", true, false);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("waiting_for_review");
    const report = run.blockRuns.find((b) => b.blockId === "split")!.splitterReport!;
    const assignment = report.assignments.find((item) => item.outputPortId !== "out-2")!;
    const target = "out-2";
    await expect(
      handlers.runs.reviewSplitter(run.id, "split", {
        expectedVersion: 0,
        rationale: "Attempt correction at a locked gate.",
        changes: [{ itemId: assignment.itemId, toPortId: target }],
      }),
    ).rejects.toThrow(/editable HIL gate/i);
  });

  it("rolls back atomically if persisting a routing correction fails", async () => {
    const { run } = await createRun("customer_priority", true, true);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("waiting_for_review");
    const initialReport = run.blockRuns.find((b) => b.blockId === "split")!.splitterReport!;
    const assignment = initialReport.assignments.find((item) => item.outputPortId !== "out-2")!;
    const initialOutputs = await handlers.runs.blockOutput(run.id, "split");

    const preDb = new DatabaseSync(dbPath);
    const initialAuditCount = Number(
      (
        preDb
          .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE run_id = ?")
          .get(run.id) as { count: number | bigint }
      ).count,
    );
    // Fail the final audit insert after both report and output writes have occurred.
    // This verifies rollback of actual writes, rather than a failure before any modification.
    preDb.exec(`CREATE TRIGGER reject_routing_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'run.routing_reviewed'
      BEGIN SELECT RAISE(ABORT, 'synthetic routing audit failure'); END`);
    preDb.close();

    await expect(
      handlers.runs.reviewSplitter(run.id, "split", {
        expectedVersion: 0,
        rationale: "Correction that aborts at the persistence layer.",
        changes: [{ itemId: assignment.itemId, toPortId: "out-2" }],
      }),
    ).rejects.toThrow(/synthetic routing audit failure/i);

    // Verify atomic rollback in SQLite: no new audit events, outputs unchanged, block_runs unchanged.
    const checkDb = new DatabaseSync(dbPath);
    const auditCount = Number(
      (
        checkDb
          .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE run_id = ?")
          .get(run.id) as { count: number | bigint }
      ).count,
    );
    expect(auditCount).toBe(initialAuditCount);

    const routingReviewedAudits = (
      checkDb
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE run_id = ? AND action = 'run.routing_reviewed'",
        )
        .get(run.id) as { count: number | bigint }
    ).count;
    expect(Number(routingReviewedAudits)).toBe(0);

    const savedOutputs = JSON.parse(
      (
        checkDb
          .prepare("SELECT outputs FROM block_outputs WHERE run_id = ? AND block_id = 'split'")
          .get(run.id) as { outputs: string }
      ).outputs,
    );
    expect(savedOutputs).toEqual(initialOutputs);

    const savedBlockRuns = JSON.parse(
      (
        checkDb.prepare("SELECT block_runs FROM runs WHERE id = ?").get(run.id) as {
          block_runs: string;
        }
      ).block_runs,
    );
    const splitBlockRun = savedBlockRuns.find((br: { blockId: string }) => br.blockId === "split");
    expect(splitBlockRun.splitterReport.reviews).toHaveLength(0);
    checkDb.exec("DROP TRIGGER reject_routing_audit");
    checkDb.close();
    expect(await handlers.runs.blockOutput(run.id, "split")).toEqual(initialOutputs);
    expect(
      (await handlers.runs.get(run.id)).blockRuns.find((br) => br.blockId === "split")!
        .splitterReport!.reviews,
    ).toHaveLength(0);
    const retried = await handlers.runs.reviewSplitter(run.id, "split", {
      expectedVersion: 0,
      rationale: "Retry after persistence failure with the original review version.",
      changes: [{ itemId: assignment.itemId, toPortId: "out-2" }],
    });
    expect(
      retried.blockRuns.find((br) => br.blockId === "split")!.splitterReport!.reviews,
    ).toHaveLength(1);
  });
});
