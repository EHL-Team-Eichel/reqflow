import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  emptyPipelineData,
  rescoreBreakdown,
  type Requirement,
  type Settings,
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

// Synthetic data only: fixture requirements re-numbered, scored under the default settings.
const reviewer = { userId: "pm-synthetic-a", name: "Synthetic PM A", role: "Product Manager" };
const SCORED_AT = "2026-10-10T09:00:00.000Z";

let dir: string;
let db: ReturnType<typeof createDatabase>;
let handlers: ReturnType<typeof createHandlers>;
let seeded: Requirement[];

/** Fixture 001–003 (bands should/must/should, evidence C/C/B) and one never scored. */
function syntheticRequirements(): Requirement[] {
  const scored = fixtureRequirements.slice(0, 3).map((r, i) => ({
    ...r,
    id: `REQ-F70-EU-${971 + i}`,
    version: 1,
    status: (["proposed", "approved", "rejected"] as const)[i]!,
    priority: (["must", "could", "should"] as const)[i]!, // from input rank or a human, not the score
    score: rescoreBreakdown(r.score!, DEFAULT_SETTINGS.scoring, r.evidenceLevel, SCORED_AT),
  }));
  const unscored = { ...fixtureRequirements[0]!, id: "REQ-F70-EU-974", score: undefined };
  return [...scored, unscored];
}

const withScoring = (settings: Settings, scoring: Partial<Settings["scoring"]>): Settings => ({
  ...settings,
  scoring: { ...settings.scoring, ...scoring },
});
const scoredEvents = () => handlers.audit.list({ action: "requirement.scored" });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reqflow-synthetic-rescore-"));
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
    appInfo: () => ({ version: "synthetic", platform: "darwin", dataDir: dir, isPackaged: false }),
  });
  await handlers.app.info();
  db = createDatabase(join(dir, "test.db"));
  seeded = syntheticRequirements();
  await new SqliteRequirementRepository(db).savePipelineData({
    ...emptyPipelineData(),
    requirements: seeded,
    sources: fixtureSources,
    records: fixtureRecords,
    findings: fixtureFindings,
  });
  await handlers.settings.save({ ...(await handlers.settings.get()), review: { reviewer } });
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("settings.save rescoring", () => {
  it("rescores every scored requirement when the weights change; priority and status stay", async () => {
    const settings = await handlers.settings.get();
    const weights = { ...settings.scoring.weights, ease: 10 };
    const saved = await handlers.settings.save(withScoring(settings, { weights }));
    expect(saved.scoring.weights.ease).toBe(10);

    const after = await handlers.requirements.list();
    const scored = seeded.filter((r) => r.score);
    for (const before of scored) {
      const now = after.find((r) => r.id === before.id)!;
      const expected = rescoreBreakdown(
        before.score!,
        saved.scoring,
        before.evidenceLevel,
        now.score!.scoredAt,
      );
      expect(now.score).toEqual(expected);
      expect(now.score!.factors.ease.weight).toBe(10);
      expect(now).toMatchObject({
        version: 2,
        priority: before.priority,
        status: before.status,
        priorityRationale: before.priorityRationale,
      });
    }
    // The bands really moved: should → could, must → should; and a flag came with the C level.
    const totals = (rs: Requirement[]) =>
      rs.filter((r) => r.score).map((r) => [r.score!.suggestedPriority, r.score!.flags]);
    expect(totals(seeded)).toEqual([
      ["should", ["high_score_weak_evidence"]],
      ["must", ["high_score_weak_evidence"]],
      ["should", []],
    ]);
    expect(totals(after)).toEqual([
      ["could", []],
      ["should", ["high_score_weak_evidence"]],
      ["should", []],
    ]);
    expect(after.find((r) => r.id === "REQ-F70-EU-974")!.version).toBe(1);

    const events = await scoredEvents();
    expect(events.map((e) => e.entityId)).toEqual(scored.map((r) => r.id));
    for (const event of events) {
      const before = scored.find((r) => r.id === event.entityId)!;
      const now = after.find((r) => r.id === event.entityId)!;
      expect(event).toMatchObject({
        actor: { type: "system", component: "settings.rescore" },
        entityType: "requirement",
        runId: before.runId,
        rationale: `Scoring settings changed by Synthetic PM A: ${before.score!.total} → ${now.score!.total} (${now.score!.suggestedPriority}).`,
        changes: [{ path: "score", before: before.score, after: now.score }],
      });
    }
    expect(
      (await handlers.audit.list({ action: "settings.changed" }))
        .at(-1)!
        .changes.map((c) => c.path),
    ).toEqual(["scoring"]);
  });

  it("rescores only requirements whose score changes", async () => {
    const settings = await handlers.settings.get();
    // Moving "could" from 30 to 25 changes no band, weight or flag of the seeded scores.
    const thresholds = { ...settings.scoring.thresholds, could: 25 };
    await handlers.settings.save(withScoring(settings, { thresholds }));
    expect(await scoredEvents()).toEqual([]);
    expect((await handlers.requirements.list()).map((r) => r.version)).toEqual([1, 1, 1, 1]);

    // Raising "must" to 72 moves only the 70.9 requirement down to should.
    const raised = { ...thresholds, must: 72 };
    await handlers.settings.save(
      withScoring(await handlers.settings.get(), { thresholds: raised }),
    );
    expect((await scoredEvents()).map((e) => e.entityId)).toEqual(["REQ-F70-EU-972"]);
  });

  it("leaves requirements alone when other settings change", async () => {
    const settings = await handlers.settings.get();
    await handlers.settings.save({ ...settings, app: { ...settings.app, theme: "dark" } });
    expect(await scoredEvents()).toEqual([]);
    expect(await handlers.requirements.list()).toEqual(seeded);
  });

  it("keeps the previous settings and every requirement when one rescore can't be saved", async () => {
    const settings = await handlers.settings.get();
    // The second requirement's audit event fails, after the first one was already written.
    db.exec(`CREATE TRIGGER synthetic_rescore_fault BEFORE INSERT ON audit_events
      WHEN NEW.action = 'requirement.scored' AND NEW.entity_id = 'REQ-F70-EU-972'
      BEGIN SELECT RAISE(ABORT, 'synthetic rescore fault'); END;`);
    const changed = withScoring(settings, { weights: { ...settings.scoring.weights, ease: 10 } });
    const result = await dispatch(handlers, "settings", "save", [changed]);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "storage_error",
        message: "Settings were not saved: requirements could not be rescored.",
      },
    });
    expect(await handlers.settings.get()).toEqual(settings);
    expect(await handlers.requirements.list()).toEqual(seeded);
    expect(await scoredEvents()).toEqual([]);
    const settingsEvents = await handlers.audit.list({ action: "settings.changed" });
    expect(settingsEvents.some((e) => e.changes.some((c) => c.path === "scoring"))).toBe(false);
  });

  it("refuses weights that can't score anything, without saving them", async () => {
    const settings = await handlers.settings.get();
    const zero = Object.fromEntries(
      Object.keys(settings.scoring.weights).map((k) => [k, 0]),
    ) as Settings["scoring"]["weights"];
    const result = await dispatch(handlers, "settings", "save", [
      withScoring(settings, { weights: zero }),
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(result.ok || result.error.message).toMatch(/^Settings were not saved: /);
    expect(await handlers.settings.get()).toEqual(settings);
    expect(await handlers.requirements.list()).toEqual(seeded);
  });
});
