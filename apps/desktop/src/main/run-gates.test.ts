import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allBlockImplementations } from "@reqflow/blocks";
import {
  connect,
  createBlock,
  DEFAULT_SETTINGS,
  emptyPipelineData,
  setBlockParams,
  type Requirement,
  type WorkflowGraph,
  type WorkflowRun,
} from "@reqflow/core";
import {
  fixtureFindings,
  fixtureRecords,
  fixtureRequirements,
  fixtureSources,
} from "@reqflow/core/fixtures";
import { createDatabase, createFileStore } from "@reqflow/db";
import { BlockRegistry, defineBlock } from "@reqflow/engine";
import { createHandlers } from "./handlers";
import { dispatch } from "./dispatch";
import { SecretsStore } from "./secrets";

// Synthetic data only: fixture sources/findings and two made-up reviewers.
const reviewerA = { userId: "pm-synthetic-a", name: "Synthetic PM A", role: "Product Manager" };
const reviewerB = { userId: "pm-synthetic-b", name: "Synthetic PM B", role: "Domain Expert" };

let dir: string;
/** What the fake Add to Car block hands to the Car page in the current test. */
let publish: Requirement[] = [];

const registry = new BlockRegistry([
  ...allBlockImplementations.filter((b) => b.kind !== "raw" && b.kind !== "add_to_car"),
  defineBlock({
    kind: "raw",
    async run() {
      return {
        status: "ok",
        outputs: { out: { ...emptyPipelineData(), sources: fixtureSources.slice(0, 1) } },
      };
    },
  }),
  defineBlock({
    kind: "add_to_car",
    async run(_inputs, _params, ctx) {
      await ctx.car.add(publish, {
        sources: fixtureSources,
        records: fixtureRecords,
        findings: fixtureFindings,
      });
      return { status: "ok", outputs: {} };
    },
  }),
]);

function setup() {
  const pushed: WorkflowRun[] = [];
  const handlers = createHandlers({
    dataDir: dir,
    dbPath: join(dir, "test.db"),
    files: createFileStore(join(dir, "uploads")),
    registry,
    pushRunUpdate: (run) => pushed.push(run),
    pickFile: vi.fn().mockResolvedValue(null),
    secretsStore: new SecretsStore(dir, {
      environment: {},
      secureStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`synthetic:${value}`),
        decryptString: (value) => value.toString().slice("synthetic:".length),
      },
    }),
    appInfo: () => ({ version: "synthetic", platform: "darwin", dataDir: dir, isPackaged: false }),
  });
  return { handlers, pushed };
}
type Handlers = ReturnType<typeof setup>["handlers"];

async function configure(handlers: Handlers, reviewer: typeof reviewerA) {
  const settings = await handlers.settings.get();
  await handlers.settings.save({ ...settings, review: { reviewer } });
}

async function start(handlers: Handlers, graph: WorkflowGraph, until: WorkflowRun["status"][]) {
  const wf = await handlers.workflows.save({
    ...graph,
    name: "Synthetic gate flow",
    scope: DEFAULT_SETTINGS.defaultScope,
  });
  const initial = await handlers.runs.start(wf.id);
  let run = await handlers.runs.get(initial.id);
  const deadline = Date.now() + 10_000;
  while (!until.includes(run.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    run = await handlers.runs.get(initial.id);
  }
  expect(until).toContain(run.status);
  return run;
}

const at = (x: number) => ({ x, y: 0 });

/** Raw → HIL gate needing `approvals` reviewers. */
function gateFlow(approvals: number): WorkflowGraph {
  const gate = createBlock("hil", { id: "gate", position: at(300), label: "Synthetic gate" });
  let graph: WorkflowGraph = {
    blocks: [createBlock("raw", { id: "raw", position: at(0) }), gate],
    edges: [],
  };
  graph = setBlockParams(graph, "gate", { ...gate.params, approvals }).graph;
  return connect(graph, { source: "raw", sourcePort: "out", target: "gate", targetPort: "in" });
}

/** Raw → Custom block whose inner workplace holds the HIL gate. */
function nestedGateFlow(approvals: number): WorkflowGraph {
  const outer = createBlock("custom", { id: "outer", position: at(300) });
  const review = createBlock("hil", { id: "review", position: at(100), label: "Inner gate" });
  review.params = { ...review.params, approvals };
  outer.inner = connect(
    connect(
      { ...outer.inner!, blocks: [...outer.inner!.blocks, review] },
      { source: "outer--in", sourcePort: "out", target: "review", targetPort: "in" },
    ),
    { source: "review", sourcePort: "out", target: "outer--out", targetPort: "in" },
  );
  return connect(
    { blocks: [createBlock("raw", { id: "raw", position: at(0) }), outer], edges: [] },
    { source: "raw", sourcePort: "out", target: "outer", targetPort: "in" },
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reqflow-synthetic-gates-"));
  publish = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runs.resume: HIL gates and their approvals", () => {
  it("a one-approval gate records the approval and resumes", async () => {
    const { handlers } = setup();
    await configure(handlers, reviewerA);
    const paused = await start(handlers, gateFlow(1), ["waiting_for_review"]);

    expect((await handlers.runs.resume(paused.id)).status).toBe("completed");
    const trail = await handlers.audit.list({ runId: paused.id });
    const approvals = trail.filter((e) => e.action === "run.review_approved");
    expect(approvals).toEqual([
      expect.objectContaining({
        actor: { type: "human", ...reviewerA },
        entityType: "run",
        entityId: paused.id,
        runId: paused.id,
        blockId: "gate",
        rationale: 'Approved "Synthetic gate" (1 of 1).',
        changes: [{ path: "approvals", before: 0, after: 1 }],
      }),
    ]);
    const actions = trail.map((e) => e.action);
    expect(actions.indexOf("run.review_approved")).toBeLessThan(actions.indexOf("run.resumed"));
  });

  it("a two-approval gate waits for a second, different reviewer", async () => {
    const { handlers, pushed } = setup();
    await configure(handlers, reviewerA);
    const paused = await start(handlers, gateFlow(2), ["waiting_for_review"]);

    const pushesBefore = pushed.length;
    const first = await handlers.runs.resume(paused.id);
    expect(first.status).toBe("waiting_for_review");
    expect(pushed.slice(pushesBefore)).toEqual([
      expect.objectContaining({ id: paused.id, status: "waiting_for_review" }),
    ]);
    expect((await handlers.runs.get(paused.id)).status).toBe("waiting_for_review");

    const again = await dispatch(handlers, "runs", "resume", [paused.id]);
    expect(again).toMatchObject({
      ok: false,
      error: {
        code: "invalid_state",
        message:
          "Synthetic PM A already approved this gate; it needs 2 approvals from different reviewers.",
      },
    });

    await configure(handlers, reviewerB);
    expect((await handlers.runs.resume(paused.id)).status).toBe("completed");
    const approvals = await handlers.audit.list({
      runId: paused.id,
      action: "run.review_approved",
    });
    expect(
      approvals.map((e) => [e.actor.type === "human" && e.actor.userId, e.blockId, e.rationale]),
    ).toEqual([
      [reviewerA.userId, "gate", 'Approved "Synthetic gate" (1 of 2).'],
      [reviewerB.userId, "gate", 'Approved "Synthetic gate" (2 of 2).'],
    ]);
    expect(approvals[1]!.changes).toEqual([{ path: "approvals", before: 1, after: 2 }]);
    expect(await dispatch(handlers, "runs", "resume", [paused.id])).toMatchObject({
      ok: false,
      error: { code: "invalid_state" },
    });
  });

  it("finds a gate inside an inner workplace, not its waiting container", async () => {
    const { handlers } = setup();
    await configure(handlers, reviewerA);
    const paused = await start(handlers, nestedGateFlow(2), ["waiting_for_review"]);
    const waiting = paused.blockRuns.filter((b) => b.status === "waiting_for_review");
    expect(waiting.map((b) => b.blockId).sort()).toEqual(["outer", "review"]);

    expect((await handlers.runs.resume(paused.id)).status).toBe("waiting_for_review");
    await configure(handlers, reviewerB);
    expect((await handlers.runs.resume(paused.id)).status).toBe("completed");
    const approvals = await handlers.audit.list({
      runId: paused.id,
      action: "run.review_approved",
    });
    expect(approvals.map((e) => [e.blockId, e.rationale])).toEqual([
      ["review", 'Approved "Inner gate" (1 of 2).'],
      ["review", 'Approved "Inner gate" (2 of 2).'],
    ]);
  });
});

describe("car.add: AI may only propose", () => {
  const carFlow = (): WorkflowGraph =>
    connect(
      {
        blocks: [
          createBlock("raw", { id: "raw", position: at(0) }),
          createBlock("add_to_car", { id: "car", position: at(300) }),
        ],
        edges: [],
      },
      { source: "raw", sourcePort: "out", target: "car", targetPort: "in-0" },
    );
  const proposal = (seq: number, extra: Partial<Requirement> = {}): Requirement => ({
    ...fixtureRequirements[0]!,
    id: `REQ-F70-EU-${960 + seq}`,
    version: 1,
    status: "proposed",
    runId: undefined,
    ...extra,
  });

  it("fails the block and saves nothing when a requirement claims more than a proposal", async () => {
    const { handlers } = setup();
    publish = [
      proposal(1),
      proposal(2, { status: "approved" }),
      proposal(3, { version: 2 }),
      proposal(4, { createdBy: { type: "human", userId: "pm-x", name: "Synthetic PM X" } }),
    ];
    const run = await start(handlers, carFlow(), ["failed", "completed"]);
    expect(run.status).toBe("failed");
    const error = run.blockRuns.find((b) => b.blockId === "car")!.error!;
    expect(error).toContain("Add to Car may only propose new requirements, so nothing was saved");
    expect(error).toContain(
      'REQ-F70-EU-962: a block may only propose requirements, not set them to "approved"',
    );
    expect(error).toContain("REQ-F70-EU-963: a block may only add new requirements (version 1)");
    expect(error).toContain("REQ-F70-EU-964: a block can't name a human as its author");
    expect(error).not.toContain("REQ-F70-EU-961");

    expect(await handlers.requirements.list()).toEqual([]);
    const db = createDatabase(join(dir, "test.db"));
    try {
      for (const table of ["findings", "sources", "records"])
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("saves a valid proposal with its evidence", async () => {
    const { handlers } = setup();
    publish = [proposal(1)];
    const run = await start(handlers, carFlow(), ["failed", "completed"]);
    expect(run.status).toBe("completed");
    expect(await handlers.requirements.list()).toEqual([
      expect.objectContaining({ id: "REQ-F70-EU-961", status: "proposed", version: 1 }),
    ]);
    const detail = await handlers.requirements.get("REQ-F70-EU-961");
    expect(detail.findings.map((f) => f.id)).toEqual(publish[0]!.findingIds);
  });
});
