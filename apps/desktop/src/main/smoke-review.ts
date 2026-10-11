import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  connect,
  createBlock,
  defaultBlockParams,
  removeBlocks,
  setBlockParams,
  Settings,
  type AuditEvent,
  type Requirement,
  type WorkflowGraph,
  type WorkflowRun,
  type WorkflowTemplate,
} from "@reqflow/core";
import type { IpcResult } from "@reqflow/core/ipc";
import type { LocalFileStore } from "@reqflow/db";

/** One raw IPC call through the preload bridge; errors come back as values, not exceptions. */
export type SmokeCall = (
  namespace: string,
  method: string,
  ...args: unknown[]
) => Promise<IpcResult<unknown>>;

interface ReviewSmoke {
  call: SmokeCall;
  check: (ok: boolean, message: string) => void;
  outDir: string;
  samplesDir: string;
  files: LocalFileStore;
  delay: (ms: number) => Promise<unknown>;
}

const RATIONALE = "Synthetic smoke rationale";

/**
 * What the Car tab's review UI relies on, through the real preload, IPC and SQLite: edits, decisions
 * with an override, refused transitions, a challenge, the four-eyes rule, the audit trail, exports,
 * saved workflows, rescoring on new weights and a HIL gate that needs two reviewers. Runs on the
 * synthetic requirements the smoke made before; restores the settings it changes.
 */
export async function runReviewSmoke({
  call,
  check,
  outDir,
  samplesDir,
  files,
  delay,
}: ReviewSmoke) {
  const ok = async <T>(namespace: string, method: string, ...args: unknown[]): Promise<T> => {
    const result = await call(namespace, method, ...args);
    if (!result.ok)
      throw new Error(`${namespace}.${method}: ${result.error.code}: ${result.error.message}`);
    return result.value as T;
  };
  const refused = async (
    code: string,
    what: string,
    namespace: string,
    method: string,
    ...args: unknown[]
  ) => {
    const result = await call(namespace, method, ...args);
    check(!result.ok && result.error.code === code, `review: ${what} should fail with ${code}`);
  };
  const trail = (entityId: string) =>
    ok<AuditEvent[]>("audit", "list", { entityType: "requirement", entityId });
  const original = Settings.parse(await ok("settings", "get"));
  const saveSettings = (patch: (s: Settings) => Settings) =>
    ok<Settings>("settings", "get").then((s) =>
      ok<Settings>("settings", "save", patch(Settings.parse(s))),
    );

  try {
    const requirements = await ok<Requirement[]>("requirements", "list");
    check(requirements.length >= 2, "review: needs two synthetic requirements");
    const [a, b] = requirements;
    if (!a || !b) return;

    // Edit with a rationale; an edit that changes nothing is refused.
    const edited = await ok<Requirement>("requirements", "edit", a.id, {
      title: `${a.title.slice(0, 100)} (reviewed)`,
      rationale: RATIONALE,
    });
    check(edited.version === a.version + 1, "review: edit should bump the version");
    await refused("invalid_input", "a no-op edit", "requirements", "edit", a.id, {
      title: edited.title,
      rationale: RATIONALE,
    });

    // Approve with a priority override; a decided requirement must be reopened first.
    const approved = await ok<Requirement>("requirements", "decide", a.id, {
      decision: "approve",
      rationale: RATIONALE,
      priority: edited.priority === "must" ? "should" : "must",
    });
    check(approved.status === "approved", "review: approve should approve");
    check(
      approved.priorityRationale?.startsWith("PM override:") === true,
      "review: an override should explain itself in the priority rationale",
    );
    await refused(
      "invalid_state",
      "rejecting an approved requirement",
      "requirements",
      "decide",
      a.id,
      {
        decision: "reject",
        rationale: RATIONALE,
      },
    );
    await refused("invalid_input", "an override without approval", "requirements", "decide", a.id, {
      decision: "reopen",
      rationale: RATIONALE,
      priority: "must",
    });
    const reopened = await ok<Requirement>("requirements", "decide", a.id, {
      decision: "reopen",
      rationale: RATIONALE,
    });
    check(reopened.status === "in_review", "review: reopen should return it to review");
    const aTrail = (await trail(a.id)).map((e) => e.action);
    check(
      ["requirement.edited", "requirement.prioritized", "requirement.status_changed"].every((x) =>
        aTrail.includes(x as AuditEvent["action"]),
      ),
      `review: audit trail misses steps (${aTrail.join(", ")})`,
    );

    // Challenge: recorded by the human, answered by the (offline) AI; challenged until decided.
    const challenged = await ok<Requirement>("requirements", "decide", b.id, {
      decision: "challenge",
      rationale: RATIONALE,
    });
    check(challenged.status === "challenged", "review: a challenge should stay challenged");
    const bTrail = (await trail(b.id)).map((e) => e.action);
    check(
      bTrail.includes("requirement.challenged") &&
        bTrail.includes("requirement.challenge_answered"),
      "review: a challenge should audit the question and the answer",
    );

    // Four-eyes: the first approval keeps it in review, the same reviewer can't add the second,
    // a different reviewer (a new name in Settings) can.
    await saveSettings((s) => ({
      ...s,
      review: { reviewer: { ...s.review.reviewer, name: "Synthetic Reviewer One" } },
      collaboration: { ...s.collaboration, requireSecondApproval: true },
    }));
    const first = await ok<Requirement>("requirements", "decide", b.id, {
      decision: "approve",
      rationale: RATIONALE,
    });
    check(first.status === "in_review", "four-eyes: the first approval must not approve");
    await refused(
      "invalid_state",
      "a second approval by the same reviewer",
      "requirements",
      "decide",
      b.id,
      {
        decision: "approve",
        rationale: RATIONALE,
      },
    );
    await saveSettings((s) => ({
      ...s,
      review: { reviewer: { ...s.review.reviewer, name: "Synthetic Reviewer Two" } },
    }));
    const second = await ok<Requirement>("requirements", "decide", b.id, {
      decision: "approve",
      rationale: RATIONALE,
    });
    check(second.status === "approved", "four-eyes: a second reviewer should approve");

    // The audit list filters by actor and keeps the newest events under a limit.
    const all = await ok<AuditEvent[]>("audit", "list", {});
    const newest = await ok<AuditEvent[]>("audit", "list", { limit: 3 });
    check(
      JSON.stringify(newest.map((e) => e.id)) === JSON.stringify(all.slice(-3).map((e) => e.id)),
      "audit: a limit should keep the newest events, oldest first",
    );
    const ai = await ok<AuditEvent[]>("audit", "list", { actorType: "ai" });
    check(ai.length > 0 && ai.every((e) => e.actor.type === "ai"), "audit: actor filter");

    // Exports: every format names findings, excerpts and sources (the dialog is substituted).
    for (const format of ["csv", "md", "json"] as const) {
      const done = await ok<{ path: string } | null>("exports", "requirements", { format });
      check(!!done, `export: ${format} returned no file`);
      if (!done) continue;
      const content = readFileSync(done.path, "utf8");
      check(
        content.includes(a.id) && content.includes(b.id),
        `export: ${format} misses requirements`,
      );
      if (format === "csv")
        check(/Findings/.test(content) && /Evidence excerpts/.test(content), "export: CSV columns");
      if (format === "json") {
        const parsed = JSON.parse(content) as {
          count: number;
          requirements: { findings: unknown[] }[];
        };
        check(parsed.count === requirements.length, "export: JSON count");
        check(
          parsed.requirements.every((r) => r.findings.length > 0),
          "export: JSON findings",
        );
      }
    }
    const exportsAudited = await ok<AuditEvent[]>("audit", "list", { action: "export.created" });
    check(exportsAudited.length >= 3, "export: every export is audited");

    // Rescoring: new weights give scored requirements a new version and a system audit event.
    const scored = requirements.filter((r) => r.score).length;
    await saveSettings((s) => ({
      ...s,
      scoring: {
        ...s.scoring,
        weights: { ...s.scoring.weights, ease: s.scoring.weights.ease + 4 },
      },
    }));
    const rescored = await ok<AuditEvent[]>("audit", "list", { action: "requirement.scored" });
    check(
      scored === 0 || rescored.some((e) => e.actor.type === "system"),
      "settings: new weights should rescore the requirements",
    );
    const afterRescore = await ok<Requirement[]>("requirements", "list");
    check(
      afterRescore.find((r) => r.id === b.id)?.status === "approved",
      "settings: rescoring must not change a decision",
    );

    // Saved workflows: list, load, update and remove round-trip.
    const flows = await ok<{ id: string; name: string; version: number }[]>("workflows", "list");
    const carFlow = flows.find((f) => f.name === "Synthetic feedback to car (smoke)");
    check(!!carFlow, "workflows: the saved car flow is listed");
    if (carFlow) {
      const loaded = await ok<WorkflowGraph & { id: string; version: number; name: string }>(
        "workflows",
        "get",
        carFlow.id,
      );
      check(loaded.blocks.length === 2 && loaded.edges.length === 1, "workflows: loaded graph");
      const copy = await ok<{ id: string; version: number }>("workflows", "save", {
        name: "Synthetic copy (smoke)",
        scope: original.defaultScope,
        blocks: loaded.blocks,
        edges: loaded.edges,
      });
      const renamed = await ok<{ version: number }>("workflows", "save", {
        id: copy.id,
        name: "Synthetic copy renamed (smoke)",
        scope: original.defaultScope,
        blocks: loaded.blocks,
        edges: loaded.edges,
      });
      check(renamed.version === copy.version + 1, "workflows: saving again bumps the version");
      await ok("workflows", "remove", copy.id);
      await refused("not_found", "loading a removed workflow", "workflows", "get", copy.id);
    }

    const o = { ok, refused, check, outDir, files, delay, saveSettings };
    await hilNeedsTwoReviewers(o);
    await bmwTemplate({ ...o, samplesDir });
  } finally {
    await ok("settings", "save", {
      ...Settings.parse(await ok("settings", "get")),
      ...pick(original),
    });
  }
}

/** Only what this smoke changes: reviewer, four-eyes and weights go back to how they were. */
function pick(s: Settings) {
  return { review: s.review, collaboration: s.collaboration, scoring: s.scoring };
}

interface Scenario {
  ok: <T>(namespace: string, method: string, ...args: unknown[]) => Promise<T>;
  refused: (
    code: string,
    what: string,
    namespace: string,
    method: string,
    ...args: unknown[]
  ) => Promise<void>;
  check: (ok: boolean, message: string) => void;
  outDir: string;
  files: LocalFileStore;
  delay: (ms: number) => Promise<unknown>;
  saveSettings: (patch: (s: Settings) => Settings) => Promise<Settings>;
}

async function waitForRun(o: Scenario, runId: string, until: (run: WorkflowRun) => boolean) {
  let run = await o.ok<WorkflowRun>("runs", "get", runId);
  for (const deadline = Date.now() + 30_000; !until(run) && Date.now() < deadline;) {
    await o.delay(100);
    run = await o.ok<WorkflowRun>("runs", "get", runId);
  }
  return run;
}

/** Raw → HIL (2 approvals) → Add to Car: one reviewer's resume keeps it paused, a second resumes it. */
async function hilNeedsTwoReviewers(o: Scenario) {
  const { ok, refused, check } = o;
  const csv = join(o.outDir, "hil-two-reviewers.csv");
  writeFileSync(csv, "id,comment\nH1,The rear seats are uncomfortable on long journeys\n");
  const info = await o.files.importFile(csv);
  let graph: WorkflowGraph = {
    blocks: [
      createBlock("raw", { id: "smoke-gate-raw", position: { x: 0, y: 0 } }),
      createBlock("hil", { id: "smoke-gate", position: { x: 250, y: 0 } }),
      createBlock("add_to_car", { id: "smoke-gate-car", position: { x: 500, y: 0 } }),
    ],
    edges: [],
  };
  graph = setBlockParams(graph, "smoke-gate-raw", {
    ...defaultBlockParams("raw"),
    dataset: "customer_feedback",
    file: { fileId: info.id, name: info.name },
  }).graph;
  graph = setBlockParams(graph, "smoke-gate", { ...defaultBlockParams("hil"), approvals: 2 }).graph;
  graph = connect(graph, {
    source: "smoke-gate-raw",
    sourcePort: "out",
    target: "smoke-gate",
    targetPort: "in",
  });
  graph = connect(graph, {
    source: "smoke-gate",
    sourcePort: "out",
    target: "smoke-gate-car",
    targetPort: "in-0",
  });
  const settings = await ok<Settings>("settings", "get");
  const flow = await ok<{ id: string }>("workflows", "save", {
    ...graph,
    name: "Synthetic two-reviewer gate (smoke)",
    scope: settings.defaultScope,
  });
  const waitFor = (runId: string, until: (s: string) => boolean) =>
    waitForRun(o, runId, (run) => until(run.status));
  const started = await ok<WorkflowRun>("runs", "start", flow.id);
  const paused = await waitFor(started.id, (s) => s === "waiting_for_review");
  check(paused.status === "waiting_for_review", `gate: run should pause, got ${paused.status}`);
  await o.saveSettings((s) => ({
    ...s,
    review: { reviewer: { ...s.review.reviewer, name: "Synthetic Gate Reviewer One" } },
  }));
  const once = await ok<WorkflowRun>("runs", "resume", started.id);
  check(once.status === "waiting_for_review", "gate: one approval of two must not resume");
  await refused(
    "invalid_state",
    "the same reviewer approving a gate twice",
    "runs",
    "resume",
    started.id,
  );
  await o.saveSettings((s) => ({
    ...s,
    review: { reviewer: { ...s.review.reviewer, name: "Synthetic Gate Reviewer Two" } },
  }));
  await ok("runs", "resume", started.id);
  const done = await waitFor(
    started.id,
    (s) => !["running", "queued", "waiting_for_review"].includes(s),
  );
  check(
    done.status === "completed",
    `gate: two approvals should complete the run, got ${done.status}`,
  );
  const approvals = await ok<AuditEvent[]>("audit", "list", {
    runId: started.id,
    action: "run.review_approved",
  });
  check(
    approvals.length === 2 &&
      new Set(approvals.map((e) => e.actor.type === "human" && e.actor.userId)).size === 2,
    "gate: two different reviewers should be on record",
  );
}

/**
 * The demo template end to end on the synthetic samples with the offline mock (web research needs
 * the network and is left out): every Raw input reads, the run completes after the PM gates, and
 * the car gets proposed requirements with explainable scores.
 */
async function bmwTemplate(o: Scenario & { samplesDir: string }) {
  const { ok, check } = o;
  const [template] = await ok<WorkflowTemplate[]>("templates", "list");
  if (!template) return check(false, "template: none listed");
  const file = async (name: string) => {
    const info = await o.files.importFile(join(o.samplesDir, name));
    return { fileId: info.id, name: info.name };
  };
  let graph = removeBlocks(template.graph, ["web"]);
  const inputs: Record<string, Record<string, unknown>> = {
    feedback: { file: await file("customer_feedback.csv") },
    study: { file: await file("customer_study_report.xlsx"), sheet: "CN_EU_2025" },
    equipment: { file: await file("equipment_take_rates.csv") },
    sales: { file: await file("sales_volumes.csv") },
  };
  for (const [id, patch] of Object.entries(inputs)) {
    const block = graph.blocks.find((b) => b.id === id);
    if (!block) return check(false, `template: no "${id}" block`);
    graph = setBlockParams(graph, id, { ...block.params, ...patch }).graph;
  }
  const settings = await ok<Settings>("settings", "get");
  const flow = await ok<{ id: string }>("workflows", "save", {
    ...graph,
    name: `${template.name} (smoke)`,
    scope: settings.defaultScope,
  });
  const started = await ok<WorkflowRun>("runs", "start", flow.id);
  const settled = (r: WorkflowRun) => !["running", "queued"].includes(r.status);
  const pausedAt = (r: WorkflowRun) =>
    r.blockRuns
      .filter((b) => b.status === "waiting_for_review")
      .map((b) => b.blockId)
      .join();
  let run = await waitForRun(o, started.id, settled);
  // Each resume is the PM approving the paused gate(s); wait until the run has moved on.
  for (let i = 0; run.status === "waiting_for_review" && i < 5; i++) {
    const gate = pausedAt(run);
    await ok("runs", "resume", started.id);
    run = await waitForRun(o, started.id, (r) => settled(r) && pausedAt(r) !== gate);
  }
  check(run.status === "completed", `template: the run ended ${run.status}`);
  const failed = run.blockRuns.filter((b) => !b.blockId.includes("--") && b.status !== "succeeded");
  check(
    !failed.length,
    `template: blocks did not succeed: ${failed.map((b) => b.blockId).join(", ")}`,
  );
  const made = await ok<Requirement[]>("requirements", "list", { runId: started.id });
  check(made.length > 0, "template: the car got no requirements");
  check(
    made.every(
      (r) =>
        r.status === "proposed" &&
        r.targets.length > 0 &&
        r.score?.method === "ws8-weighted@1" &&
        r.score.factors.customer_impact.by === "deterministic",
    ),
    "template: requirements must be proposed, measurable and scored by ws8-weighted@1",
  );
}
