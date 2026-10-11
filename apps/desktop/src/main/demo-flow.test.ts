import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connect,
  createBlock,
  DEFAULT_SETTINGS,
  removeBlocks,
  setBlockParams,
  type WorkflowGraph,
  type WorkflowRun,
} from "@reqflow/core";
import { createFileStore, type LocalFileStore } from "@reqflow/db";
import { createHandlers } from "./handlers";
import { SecretsStore } from "./secrets";

// Synthetic samples only (data/samples), the offline mock AI everywhere, no network.
const SAMPLES = fileURLToPath(new URL("../../../../data/samples", import.meta.url));
const DONE: WorkflowRun["status"][] = ["completed", "failed", "cancelled"];

let dir: string;

function setup() {
  const files = createFileStore(join(dir, "uploads"));
  const handlers = createHandlers({
    dataDir: dir,
    dbPath: join(dir, "reqflow.db"),
    files,
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
  return { handlers, files };
}
type Handlers = ReturnType<typeof setup>["handlers"];

async function sample(files: LocalFileStore, name: string) {
  const info = await files.importFile(join(SAMPLES, name));
  return { fileId: info.id, name: info.name };
}

function raw(graph: WorkflowGraph, id: string, patch: Record<string, unknown>) {
  const block = graph.blocks.find((b) => b.id === id)!;
  return setBlockParams(graph, id, { ...block.params, ...patch }).graph;
}

async function waitFor(handlers: Handlers, runId: string, until: WorkflowRun["status"][]) {
  let run = await handlers.runs.get(runId);
  for (const deadline = Date.now() + 60_000; !until.includes(run.status);) {
    if (Date.now() > deadline) throw new Error(`Run stuck in ${run.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    run = await handlers.runs.get(runId);
  }
  return run;
}

/** Resumes every HIL pause (one reviewer approves each gate) until the run ends. */
async function runToEnd(handlers: Handlers, runId: string) {
  let run = await waitFor(handlers, runId, [...DONE, "waiting_for_review"]);
  let pauses = 0;
  while (run.status === "waiting_for_review") {
    pauses++;
    await handlers.runs.resume(runId);
    run = await waitFor(handlers, runId, [...DONE, "waiting_for_review"]);
  }
  return { run, pauses };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reqflow-synthetic-demo-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the BMW demo flow, offline", () => {
  /** The default template on the samples (web research needs the network and is left out). */
  async function runTemplate() {
    const { handlers, files } = setup();
    const [template] = await handlers.templates.list();
    let graph = removeBlocks(template!.graph, ["web"]);
    graph = raw(graph, "feedback", { file: await sample(files, "customer_feedback.csv") });
    graph = raw(graph, "study", {
      file: await sample(files, "customer_study_report.xlsx"),
      sheet: "CN_EU_2025",
    });
    graph = raw(graph, "equipment", { file: await sample(files, "equipment_take_rates.csv") });
    graph = raw(graph, "sales", { file: await sample(files, "sales_volumes.csv") });
    const flow = await handlers.workflows.save({
      ...graph,
      name: template!.name,
      scope: DEFAULT_SETTINGS.defaultScope,
    });
    const started = await handlers.runs.start(flow.id);
    return { handlers, ...(await runToEnd(handlers, started.id)) };
  }

  it("runs the default template from the samples to proposed, scored requirements", async () => {
    const { handlers, run, pauses } = await runTemplate();
    // Untouched inner workplaces (filter, splitter) use the built-in logic: their boundaries skip.
    const failed = run.blockRuns.filter(
      (b) => !b.blockId.includes("--") && b.status !== "succeeded",
    );
    expect(failed.map((b) => `${b.blockId}: ${b.status} ${b.error ?? ""}`)).toEqual([]);
    expect(run.status).toBe("completed");

    const requirements = await handlers.requirements.list({ runId: run.id });
    expect(requirements.length).toBeGreaterThan(0);
    for (const r of requirements) {
      expect(r.id).toMatch(/^REQ-F70-EU-\d{3}$/);
      expect(r.status).toBe("proposed");
      expect(r.createdBy.type).toBe("ai");
      expect(r.targets.length).toBeGreaterThan(0);
      expect(r.score?.method).toBe("ws8-weighted@1");
      expect(r.score?.factors.customer_impact.by).toBe("deterministic");
      expect(r.priorityRationale).toMatch(/Score \d+(\.\d)?\/100/);
    }
    const approvals = await handlers.audit.list({ runId: run.id, action: "run.review_approved" });
    expect(approvals.length).toBeGreaterThanOrEqual(pauses); // every pause needed a human approval
  }, 120_000);

  // KNOWN GAP: the AI Filter classifies only the most advanced layer it receives. Equipment and
  // study findings make that "findings", so the 35 feedback comments (records without findings)
  // are dropped without a log line, nothing reaches the must/should gates and the PM never
  // reviews. Remove `.fails` once the filter or the template keeps the feedback.
  it.fails(
    "passes the customer feedback on to the PM gates",
    async () => {
      const { handlers, run, pauses } = await runTemplate();
      const feedback = (await handlers.runs.blockOutput(run.id, "feedback")).out!;
      const filtered = (await handlers.runs.blockOutput(run.id, "scope")).out!;
      const kept = filtered.records.filter((r) => r.sourceId === feedback.sources[0]!.id);
      expect(kept.length).toBeGreaterThan(0);
      expect(pauses).toBeGreaterThan(0);
    },
    120_000,
  );

  it("keeps a saved flow and a paused run across a restart, and finishes it afterwards", async () => {
    const first = setup();
    let graph: WorkflowGraph = {
      blocks: [
        createBlock("raw", { id: "feedback", position: { x: 0, y: 0 } }),
        createBlock("hil", { id: "review", position: { x: 300, y: 0 } }),
        createBlock("add_to_car", { id: "car", position: { x: 600, y: 0 } }),
      ],
      edges: [],
    };
    graph = raw(graph, "feedback", { file: await sample(first.files, "customer_feedback.csv") });
    graph = connect(graph, {
      source: "feedback",
      sourcePort: "out",
      target: "review",
      targetPort: "in",
    });
    graph = connect(graph, {
      source: "review",
      sourcePort: "out",
      target: "car",
      targetPort: "in-0",
    });
    const flow = await first.handlers.workflows.save({
      ...graph,
      name: "Synthetic restart flow",
      scope: DEFAULT_SETTINGS.defaultScope,
    });
    const started = await first.handlers.runs.start(flow.id);
    const paused = await waitFor(first.handlers, started.id, [...DONE, "waiting_for_review"]);
    expect(paused.status).toBe("waiting_for_review");

    // A second stack on the same folder stands in for the app after a restart.
    const second = setup();
    const flows = await second.handlers.workflows.list();
    expect(flows.map((f) => f.id)).toContain(flow.id);
    expect((await second.handlers.workflows.get(flow.id)).blocks).toHaveLength(3);
    const waiting = (await second.handlers.runs.list()).find((r) => r.id === started.id);
    expect(waiting?.status).toBe("waiting_for_review");

    const { run } = await runToEnd(second.handlers, started.id);
    expect(run.status).toBe("completed");
    expect((await second.handlers.requirements.list({ runId: run.id })).length).toBeGreaterThan(0);
  }, 120_000);
});
