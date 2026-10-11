import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_DECISIONS,
  DecisionKind,
  decisionProblem,
  DecisionStatus,
  emptyPipelineData,
  type LlmClient,
  type Requirement,
} from "@reqflow/core";
import {
  fixtureFindings,
  fixtureRecords,
  fixtureRequirements,
  fixtureSources,
} from "@reqflow/core/fixtures";
import { createDatabase, createFileStore, SqliteRequirementRepository } from "@reqflow/db";
import { createHandlers } from "./handlers";
import { dispatch } from "./dispatch";
import { SecretsStore } from "./secrets";

// Synthetic data only: fixture requirements re-numbered, two made-up reviewers.
const reviewerA = { userId: "pm-synthetic-a", name: "Synthetic PM A", role: "Product Manager" };
const reviewerB = { userId: "pm-synthetic-b", name: "Synthetic PM B", role: "Domain Expert" };

let dir: string;
let db: ReturnType<typeof createDatabase>;
let handlers: ReturnType<typeof createHandlers>;
let llmCalls: number;

function synthetic(seq: number, status: DecisionStatus, extra: Partial<Requirement> = {}) {
  return {
    ...fixtureRequirements[0]!,
    id: `REQ-F70-EU-${900 + seq}`,
    version: 1,
    status,
    runId: "run_synthetic_rules",
    ...extra,
  } satisfies Requirement;
}

async function seed(requirements: Requirement[]) {
  await new SqliteRequirementRepository(db).savePipelineData({
    ...emptyPipelineData(),
    requirements,
    sources: fixtureSources,
    records: fixtureRecords,
    findings: fixtureFindings,
  });
}

async function configure(reviewer: typeof reviewerA, requireSecondApproval = false) {
  const settings = await handlers.settings.get();
  await handlers.settings.save({
    ...settings,
    review: { reviewer },
    collaboration: { ...settings.collaboration, requireSecondApproval },
  });
}

const history = (id: string) => handlers.audit.list({ entityType: "requirement", entityId: id });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reqflow-synthetic-decisions-"));
  llmCalls = 0;
  const llm: LlmClient = {
    generateText: async () => {
      llmCalls++;
      return { text: "Synthetic answer", model: "synthetic" };
    },
    generateObject: async () => {
      throw new Error("No synthetic objects requested");
    },
  };
  handlers = createHandlers({
    dataDir: dir,
    dbPath: join(dir, "test.db"),
    files: createFileStore(join(dir, "uploads")),
    pickFile: async () => null,
    secretsStore: new SecretsStore(dir, {
      environment: {},
      secureStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`synthetic:${value}`),
        decryptString: (value) => value.toString().slice("synthetic:".length),
      },
    }),
    llm,
    researchOptions: {
      fetchImpl: async () => {
        throw new Error("No live calls allowed");
      },
    },
    appInfo: () => ({ version: "synthetic", platform: "darwin", dataDir: dir, isPackaged: false }),
  });
  await handlers.app.info();
  db = createDatabase(join(dir, "test.db"));
  await configure(reviewerA);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("requirements.decide: allowed transitions", () => {
  it("refuses every decision the status doesn't allow, before any AI call or write", async () => {
    const reqs = DecisionStatus.options.map((status, i) => synthetic(i, status));
    await seed(reqs);
    let refused = 0;
    for (const req of reqs) {
      for (const kind of DecisionKind.options) {
        if (ALLOWED_DECISIONS[req.status].includes(kind)) continue;
        const result = await dispatch(handlers, "requirements", "decide", [
          req.id,
          { decision: kind, rationale: "Synthetic disallowed decision" },
        ]);
        expect(result).toMatchObject({
          ok: false,
          error: { code: "invalid_state", message: decisionProblem(req.status, kind) },
        });
        refused++;
      }
    }
    // proposed/in_review: reopen; challenged: challenge; deferred: defer; approved/rejected: 4 each.
    expect(refused).toBe(12);
    expect(llmCalls).toBe(0);
    for (const req of reqs)
      expect((await handlers.requirements.get(req.id)).versions).toEqual([req]);
    expect(await handlers.audit.list({ entityType: "requirement" })).toEqual([]);
  });

  it("applies decisions the status allows (reopen, approve from deferred, reject a challenged one)", async () => {
    const approved = synthetic(1, "approved");
    const deferred = synthetic(2, "deferred");
    const challenged = synthetic(3, "challenged");
    await seed([approved, deferred, challenged]);
    const reopen = { decision: "reopen", rationale: "Synthetic: new clinic data" } as const;
    expect(await handlers.requirements.decide(approved.id, reopen)).toMatchObject({
      status: "in_review",
      version: 2,
    });
    const approve = { decision: "approve", rationale: "Synthetic approval" } as const;
    expect(await handlers.requirements.decide(deferred.id, approve)).toMatchObject({
      status: "approved",
    });
    const reject = { decision: "reject", rationale: "Synthetic rejection" } as const;
    expect(await handlers.requirements.decide(challenged.id, reject)).toMatchObject({
      status: "rejected",
    });
    expect((await history(approved.id)).map((e) => e.changes)).toEqual([
      [{ path: "status", before: "approved", after: "in_review" }],
    ]);
  });

  it("refuses a priority override on anything but approve (contract)", async () => {
    const req = synthetic(1, "proposed");
    await seed([req]);
    const result = await dispatch(handlers, "requirements", "decide", [
      req.id,
      { decision: "reject", rationale: "Synthetic rejection", priority: "must" },
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect((await handlers.requirements.get(req.id)).versions).toHaveLength(1);
  });
});

describe("requirements.decide: priority override", () => {
  it("records the override as its own event next to the status change, in one version", async () => {
    const req = synthetic(1, "in_review", {
      priority: "should",
      priorityRationale: "Score suggests should.",
    });
    await seed([req]);
    const approved = await handlers.requirements.decide(req.id, {
      decision: "approve",
      rationale: "Synthetic clinic confirmed it",
      priority: "must",
    });
    expect(approved).toMatchObject({
      status: "approved",
      priority: "must",
      version: 2,
      priorityRationale: "PM override: should → must. Synthetic clinic confirmed it",
    });
    const events = await history(req.id);
    expect(events.map((e) => e.action)).toEqual([
      "requirement.prioritized",
      "requirement.status_changed",
    ]);
    expect(events[0]!.changes).toEqual([
      { path: "priority", before: "should", after: "must" },
      {
        path: "priorityRationale",
        before: "Score suggests should.",
        after: "PM override: should → must. Synthetic clinic confirmed it",
      },
    ]);
    expect(events[1]!.changes).toEqual([
      { path: "status", before: "in_review", after: "approved" },
    ]);
    expect(
      events.every(
        (e) =>
          e.actor.type === "human" &&
          e.actor.userId === reviewerA.userId &&
          e.rationale === "Synthetic clinic confirmed it",
      ),
    ).toBe(true);
    expect((await handlers.requirements.get(req.id)).versions).toHaveLength(2);
  });

  it('says "none" when there was no priority, and writes no override for the same priority', async () => {
    const unprioritized = synthetic(1, "proposed", {
      priority: undefined,
      priorityRationale: undefined,
    });
    const same = synthetic(2, "proposed", { priority: "should", priorityRationale: "Kept." });
    await seed([unprioritized, same]);
    const first = await handlers.requirements.decide(unprioritized.id, {
      decision: "approve",
      rationale: "Synthetic: worth doing",
      priority: "could",
    });
    expect(first.priorityRationale).toBe("PM override: none → could. Synthetic: worth doing");
    expect((await history(unprioritized.id))[0]!.changes[0]).toEqual({
      path: "priority",
      before: null,
      after: "could",
    });

    const second = await handlers.requirements.decide(same.id, {
      decision: "approve",
      rationale: "Synthetic: as scored",
      priority: "should",
    });
    expect(second).toMatchObject({ priority: "should", priorityRationale: "Kept." });
    expect((await history(same.id)).map((e) => e.action)).toEqual(["requirement.status_changed"]);
  });
});

describe("requirements.decide: four-eyes rule", () => {
  const approve = (rationale: string, priority?: "must" | "should") =>
    ({ decision: "approve", rationale, ...(priority ? { priority } : {}) }) as const;

  it("approves with one approval while the setting is off", async () => {
    const req = synthetic(1, "proposed");
    await seed([req]);
    expect(await handlers.requirements.decide(req.id, approve("Synthetic single"))).toMatchObject({
      status: "approved",
    });
  });

  it("needs a second, different reviewer; the same reviewer is refused", async () => {
    const req = synthetic(1, "proposed");
    await seed([req]);
    await configure(reviewerA, true);

    const first = await handlers.requirements.decide(req.id, approve("Synthetic first look"));
    expect(first).toMatchObject({ status: "in_review", version: 2 });
    const [recorded] = await history(req.id);
    expect(recorded).toMatchObject({
      action: "requirement.approval_recorded",
      actor: { type: "human", userId: reviewerA.userId },
      changes: [
        { path: "status", before: "proposed", after: "in_review" },
        { path: "approvals", before: [], after: [reviewerA.userId] },
      ],
    });
    expect(recorded!.rationale).toMatch(/^Synthetic first look .*four-eyes/);

    const again = await dispatch(handlers, "requirements", "decide", [
      req.id,
      approve("Synthetic second look by the same PM"),
    ]);
    expect(again).toMatchObject({
      ok: false,
      error: {
        code: "invalid_state",
        message:
          "Four-eyes rule: Synthetic PM A already approved; a different reviewer must give the second approval (Settings → Collaboration → your name).",
      },
    });

    await configure(reviewerB, true);
    const second = await handlers.requirements.decide(req.id, approve("Synthetic expert check"));
    expect(second).toMatchObject({ status: "approved", version: 3 });
    const events = await history(req.id);
    expect(events.map((e) => e.action)).toEqual([
      "requirement.approval_recorded",
      "requirement.status_changed",
    ]);
    expect(events[1]).toMatchObject({
      actor: { userId: reviewerB.userId },
      changes: [{ path: "status", before: "in_review", after: "approved" }],
    });
    expect(events[1]!.rationale).toContain("Second approval after Synthetic PM A");
  });

  it("keeps an in-review requirement's status on the first approval (only approvals change)", async () => {
    const req = synthetic(1, "in_review");
    await seed([req]);
    await configure(reviewerA, true);
    await handlers.requirements.decide(req.id, approve("Synthetic first"));
    expect((await history(req.id))[0]!.changes).toEqual([
      { path: "approvals", before: [], after: [reviewerA.userId] },
    ]);
  });

  it("starts the count again when the requirement is edited between the approvals", async () => {
    const req = synthetic(1, "proposed");
    await seed([req]);
    await configure(reviewerA, true);
    await handlers.requirements.decide(req.id, approve("Synthetic first"));
    await handlers.requirements.edit(req.id, {
      title: "Synthetic sharper title",
      rationale: "Synthetic wording fix",
    });

    await configure(reviewerB, true);
    const afterEdit = await handlers.requirements.decide(req.id, approve("Synthetic B"));
    expect(afterEdit.status).toBe("in_review"); // a first approval again, now by B

    await configure(reviewerA, true);
    const final = await handlers.requirements.decide(req.id, approve("Synthetic A again"));
    expect(final.status).toBe("approved");
    expect((await history(req.id)).map((e) => e.action)).toEqual([
      "requirement.approval_recorded",
      "requirement.edited",
      "requirement.approval_recorded",
      "requirement.status_changed",
    ]);
  });

  it("records a first-approval override before the approval, so the second reviewer can finish", async () => {
    const req = synthetic(1, "proposed", { priority: "should" });
    await seed([req]);
    await configure(reviewerA, true);
    const first = await handlers.requirements.decide(req.id, approve("Synthetic A", "must"));
    expect(first).toMatchObject({ status: "in_review", priority: "must", version: 2 });
    expect((await history(req.id)).map((e) => e.action)).toEqual([
      "requirement.prioritized",
      "requirement.approval_recorded",
    ]);
    await configure(reviewerB, true);
    const second = await handlers.requirements.decide(req.id, approve("Synthetic B"));
    expect(second).toMatchObject({ status: "approved", priority: "must" });
  });

  it("treats a second reviewer's priority override as a new first approval of changed content", async () => {
    const req = synthetic(1, "proposed", { priority: "should" });
    await seed([req]);
    await configure(reviewerA, true);
    await handlers.requirements.decide(req.id, approve("Synthetic A"));
    await configure(reviewerB, true);
    const changed = await handlers.requirements.decide(req.id, approve("Synthetic B", "must"));
    expect(changed).toMatchObject({ status: "in_review", priority: "must" });
    await configure(reviewerA, true);
    expect(await handlers.requirements.decide(req.id, approve("Synthetic A ok"))).toMatchObject({
      status: "approved",
      priority: "must",
    });
  });
});

describe("requirements.edit", () => {
  it("refuses an edit that changes nothing, without a new version or event", async () => {
    const req = synthetic(1, "proposed");
    await seed([req]);
    const result = await dispatch(handlers, "requirements", "edit", [
      req.id,
      { title: req.title, targets: req.targets, rationale: "Synthetic no-op" },
    ]);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "The edit changes nothing." },
    });
    expect((await handlers.requirements.get(req.id)).versions).toHaveLength(1);
    expect(await history(req.id)).toEqual([]);
  });

  it("refuses links to findings that don't exist, naming them", async () => {
    const req = synthetic(1, "proposed");
    await seed([req]);
    const supporting = await dispatch(handlers, "requirements", "edit", [
      req.id,
      { findingIds: ["fnd_rearspace", "fnd_synthetic_missing"], rationale: "Synthetic link" },
    ]);
    expect(supporting).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(supporting.ok || supporting.error.message).toContain("fnd_synthetic_missing");
    expect(supporting.ok || supporting.error.message).not.toContain("fnd_rearspace");

    const conflicting = await dispatch(handlers, "requirements", "edit", [
      req.id,
      { conflictingFindingIds: ["fnd_synthetic_other"], rationale: "Synthetic conflict" },
    ]);
    expect(conflicting).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(conflicting.ok || conflicting.error.message).toContain("fnd_synthetic_other");
    expect((await handlers.requirements.get(req.id)).versions).toHaveLength(1);
  });

  it("recomputes the sources from the new findings' evidence, in order, in the same event", async () => {
    const req = synthetic(1, "proposed");
    await seed([req]);
    const findingIds = ["fnd_menus", "fnd_ui_trend", "fnd_rearspace"];
    const expected = [
      ...new Set(
        findingIds.flatMap((id) =>
          fixtureFindings.find((f) => f.id === id)!.evidence.map((e) => e.sourceId),
        ),
      ),
    ];
    expect(expected).not.toEqual(req.sourceIds); // the edit must really move the sources
    const edited = await handlers.requirements.edit(req.id, {
      findingIds,
      conflictingFindingIds: ["fnd_grille_praise"],
      rationale: "Synthetic relink",
    });
    expect(edited).toMatchObject({
      findingIds,
      sourceIds: expected,
      conflictingFindingIds: ["fnd_grille_praise"],
    });
    const [event] = await history(req.id);
    expect(event!.changes).toEqual([
      { path: "findingIds", before: req.findingIds, after: findingIds },
      { path: "conflictingFindingIds", before: [], after: ["fnd_grille_praise"] },
      { path: "sourceIds", before: req.sourceIds, after: expected },
    ]);
  });

  it("moves an approved requirement back to review in the same edited event", async () => {
    const req = synthetic(1, "approved");
    await seed([req]);
    const edited = await handlers.requirements.edit(req.id, {
      description: "Synthetic: a sharper description",
      rationale: "Synthetic clarification",
    });
    expect(edited).toMatchObject({ status: "in_review", version: 2 });
    const events = await history(req.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "requirement.edited",
      changes: [
        { path: "description", before: req.description, after: "Synthetic: a sharper description" },
        { path: "status", before: "approved", after: "in_review" },
      ],
    });
    expect(events[0]!.rationale).toMatch(/^Synthetic clarification .*back in review/);
  });

  it("keeps rejected and deferred requirements in their status", async () => {
    const rejected = synthetic(1, "rejected");
    const deferred = synthetic(2, "deferred");
    await seed([rejected, deferred]);
    for (const req of [rejected, deferred]) {
      const edited = await handlers.requirements.edit(req.id, {
        title: "Synthetic title",
        rationale: "Synthetic edit",
      });
      expect(edited.status).toBe(req.status);
      expect((await history(req.id))[0]!.changes.map((c) => c.path)).toEqual(["title"]);
    }
  });

  it("refuses removing every measurable target (contract)", async () => {
    const req = synthetic(1, "proposed");
    await seed([req]);
    const result = await dispatch(handlers, "requirements", "edit", [
      req.id,
      { targets: [], rationale: "Synthetic removal" },
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});
