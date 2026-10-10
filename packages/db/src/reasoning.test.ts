import { DEFAULT_SETTINGS, type ReasoningTrace } from "@reqflow/core";
import { fixtureRequirements } from "@reqflow/core/fixtures";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "./db";
import { SqliteReasoningRepository } from "./reasoning";
import { SqliteRequirementRepository } from "./requirements";

/** A small synthetic trace; `requirementIds` become its "Why this requirement?" entries. */
function makeTrace(
  id: string,
  runId: string,
  createdAt: string,
  requirementIds: string[] = [],
  blockId = "car",
): ReasoningTrace {
  return {
    id,
    runId,
    blockId,
    createdAt,
    scope: DEFAULT_SETTINGS.defaultScope,
    inputs: [
      { port: "in-0", label: "1. Priority", kind: "priority", rank: 1, counts: { records: 4 } },
    ],
    steps: [
      {
        id: "step-1",
        role: "analyst",
        title: "Analysts read 1. Priority",
        summary: "Picked out two synthetic signals.",
        notes: [],
        stats: [{ label: "signals", value: 2 }],
        model: "offline",
        calls: 0,
        durationMs: 5,
        status: "done",
      },
    ],
    requirements: requirementIds.map((requirementId) => ({
      requirementId,
      title: `Synthetic ${requirementId}`,
      theme: "Synthetic theme",
      ranks: [1],
      evidence: [{ sourceId: "src_synth", excerpt: "synthetic excerpt", supports: true }],
      thoughts: [{ role: "architect", text: "Synthetic thought." }],
      verdict: "accepted",
      issues: [],
      confidence: {
        value: 0.8,
        level: "high",
        signals: [{ key: "support", label: "Support", value: 0.8, weight: 1, by: "deterministic" }],
        method: "agent-confidence@1",
      },
      contextUsed: [],
    })),
    heldBack: [],
    totals: { calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 5 },
    offline: true,
  };
}

function insertRun(db: DatabaseSync, id: string, workflowId: string) {
  db.prepare(
    `INSERT INTO runs (id, workflow_id, workflow_version, status, scope, graph, started_by,
       started_at, block_runs) VALUES (?, ?, 1, 'completed', '{}', '{}', '{}', ?, '[]')`,
  ).run(id, workflowId, "2026-01-01T00:00:00.000Z");
}

describe("SqliteReasoningRepository", () => {
  let db: DatabaseSync;
  let repo: SqliteReasoningRepository;

  beforeEach(() => {
    db = createDatabase(":memory:");
    repo = new SqliteReasoningRepository(db);
  });

  it("returns null when nothing is stored", async () => {
    expect(await repo.forRun("run_1", "car")).toBeNull();
    expect(await repo.latest("wf_1", "car")).toBeNull();
    expect(await repo.forRequirement("REQ-F70-EU-001")).toBeNull();
  });

  it("saves a trace and reads it back for its run and block", async () => {
    const trace = makeTrace("rsn_1", "run_1", "2026-01-01T10:00:00.000Z", ["REQ-F70-EU-001"]);
    await repo.save(trace);
    expect(await repo.forRun("run_1", "car")).toEqual(trace);
    expect(await repo.forRun("run_1", "other")).toBeNull();
    expect(await repo.forRun("run_2", "car")).toBeNull();
  });

  it("returns the newest trace when a block has several in one run", async () => {
    await repo.save(makeTrace("rsn_new", "run_1", "2026-01-01T12:00:00.000Z"));
    await repo.save(makeTrace("rsn_old", "run_1", "2026-01-01T10:00:00.000Z"));
    expect((await repo.forRun("run_1", "car"))?.id).toBe("rsn_new");
  });

  it("latest() looks across the runs of one workflow and ignores other workflows", async () => {
    insertRun(db, "run_a", "wf_1");
    insertRun(db, "run_b", "wf_1");
    insertRun(db, "run_c", "wf_2");
    await repo.save(makeTrace("rsn_a", "run_a", "2026-01-01T10:00:00.000Z"));
    await repo.save(makeTrace("rsn_b", "run_b", "2026-01-02T10:00:00.000Z"));
    await repo.save(makeTrace("rsn_c", "run_c", "2026-01-03T10:00:00.000Z"));
    expect((await repo.latest("wf_1", "car"))?.id).toBe("rsn_b");
    expect((await repo.latest("wf_2", "car"))?.id).toBe("rsn_c");
    expect(await repo.latest("wf_1", "other")).toBeNull();
    expect(await repo.latest("wf_3", "car")).toBeNull();
  });

  it("forRequirement() returns the newest trace that explains the requirement", async () => {
    await repo.save(makeTrace("rsn_1", "run_1", "2026-01-01T10:00:00.000Z", ["REQ-F70-EU-001"]));
    await repo.save(
      makeTrace("rsn_2", "run_2", "2026-01-02T10:00:00.000Z", ["REQ-F70-EU-001", "REQ-F70-EU-002"]),
    );
    expect((await repo.forRequirement("REQ-F70-EU-001"))?.id).toBe("rsn_2");
    expect((await repo.forRequirement("REQ-F70-EU-002"))?.id).toBe("rsn_2");
    expect(await repo.forRequirement("REQ-F70-EU-003")).toBeNull();
  });

  it("re-saving a trace replaces its requirement mapping", async () => {
    await repo.save(makeTrace("rsn_1", "run_1", "2026-01-01T10:00:00.000Z", ["REQ-F70-EU-001"]));
    await repo.save(makeTrace("rsn_1", "run_1", "2026-01-01T10:00:00.000Z", ["REQ-F70-EU-002"]));
    expect(await repo.forRequirement("REQ-F70-EU-001")).toBeNull();
    expect((await repo.forRequirement("REQ-F70-EU-002"))?.id).toBe("rsn_1");
    const count = db.prepare("SELECT COUNT(*) AS n FROM reasoning_traces").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("rejects an invalid trace and stores nothing", async () => {
    const bad = { ...makeTrace("rsn_1", "run_1", "2026-01-01T10:00:00.000Z"), runId: "nope" };
    await expect(repo.save(bad)).rejects.toThrow();
    await expect(
      repo.save({ ...makeTrace("bad_id", "run_1", "2026-01-01T10:00:00.000Z") }),
    ).rejects.toThrow();
    expect(await repo.forRun("run_1", "car")).toBeNull();
  });

  it("throws a clear error for a corrupt stored row", async () => {
    db.prepare(
      `INSERT INTO reasoning_traces (id, run_id, block_id, created_at, json)
       VALUES ('rsn_x', 'run_1', 'car', '2026-01-01T10:00:00.000Z', '{"id":"rsn_x"}')`,
    ).run();
    await expect(repo.forRun("run_1", "car")).rejects.toThrow(/rsn_x is corrupt/);
  });

  it("keeps traces when the requirements are reset", async () => {
    const reqRepo = new SqliteRequirementRepository(db);
    const req = fixtureRequirements[0]!;
    await reqRepo.saveVersion(req);
    await repo.save(makeTrace("rsn_1", "run_1", "2026-01-01T10:00:00.000Z", [req.id]));
    expect(await reqRepo.removeAll()).toHaveLength(1);
    expect((await repo.forRun("run_1", "car"))?.id).toBe("rsn_1");
    expect((await repo.forRequirement(req.id))?.id).toBe("rsn_1");
  });
});
