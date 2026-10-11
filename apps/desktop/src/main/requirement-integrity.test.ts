import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPipelineData, type LlmClient } from "@reqflow/core";
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

let dir: string;
let db: ReturnType<typeof createDatabase>;
let handlers: ReturnType<typeof createHandlers>;
let repo: SqliteRequirementRepository;
const requirement = {
  ...fixtureRequirements[0]!,
  id: "REQ-F70-EU-941",
  runId: "run_synthetic_integrity",
  status: "proposed" as const,
};
let answer: (text: string) => void;
let called: ReturnType<typeof vi.fn<() => void>>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reqflow-synthetic-integrity-"));
  const response = new Promise<{ object: unknown; model: string }>((resolve) => {
    answer = (summary) =>
      resolve({
        object: {
          verdict: "partly_supported",
          summary,
          backsRequirement: [],
          backsChallenge: [],
          missingEvidence: [],
          suggestedChanges: [],
        },
        model: "synthetic",
      });
  });
  called = vi.fn();
  const llm = {
    generateText: async () => {
      throw new Error("Challenges ask for a structured answer");
    },
    generateObject: async () => {
      called();
      return response;
    },
  } as unknown as LlmClient;
  handlers = createHandlers({
    dataDir: dir,
    dbPath: join(dir, "test.db"),
    files: createFileStore(join(dir, "uploads")),
    pickFile: async () => null,
    secretsStore: new SecretsStore(dir, {
      environment: {},
      secureStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`synthetic:${value.split("").reverse().join("")}`),
        decryptString: (value) =>
          value.toString().slice("synthetic:".length).split("").reverse().join(""),
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
  repo = new SqliteRequirementRepository(db);
  await repo.savePipelineData({
    ...emptyPipelineData(),
    requirements: [requirement],
    sources: fixtureSources,
    records: fixtureRecords,
    findings: fixtureFindings,
  });
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("requirement mutation integrity through registered handlers", () => {
  it("rejects an AI challenge result that arrives after a newer human approval", async () => {
    const challenged = dispatch(handlers, "requirements", "decide", [
      requirement.id,
      { decision: "challenge", rationale: "Synthetic challenge" },
    ]);
    await vi.waitFor(() => expect(called).toHaveBeenCalledTimes(1));
    const approved = await handlers.requirements.decide(requirement.id, {
      decision: "approve",
      rationale: "Synthetic human approval",
    });
    answer("Synthetic answer");
    expect(await challenged).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await handlers.requirements.get(requirement.id)).requirement).toEqual(approved);
    expect(approved.status).toBe("approved");
    expect(approved.version).toBe(requirement.version + 1);
  });

  it("rejects an AI challenge result that arrives after requirement deletion (reset)", async () => {
    const challenged = dispatch(handlers, "requirements", "decide", [
      requirement.id,
      { decision: "challenge", rationale: "Synthetic challenge before reset" },
    ]);
    await vi.waitFor(() => expect(called).toHaveBeenCalledTimes(1));

    // PM resets all requirements
    const resetRes = await handlers.requirements.reset();
    expect(resetRes.removed).toBe(1);
    expect(await handlers.requirements.list()).toEqual([]);

    // Delayed LLM response arrives
    answer("Synthetic late answer");
    const challengedResult = await challenged;
    expect(challengedResult).toMatchObject({ ok: false, error: { code: "conflict" } });

    // The requirement must NOT be resurrected
    expect(await handlers.requirements.list()).toEqual([]);
    await expect(handlers.requirements.get(requirement.id)).rejects.toThrow();
  });

  it("rolls back approval when SQLite refuses its audit event", async () => {
    const original = await handlers.requirements.get(requirement.id);
    db.exec(`CREATE TRIGGER synthetic_audit_fault BEFORE INSERT ON audit_events
      WHEN NEW.action = 'requirement.status_changed'
      BEGIN SELECT RAISE(ABORT, 'synthetic audit fault'); END;`);
    const result = await dispatch(handlers, "requirements", "decide", [
      requirement.id,
      { decision: "approve", rationale: "Synthetic approval fault" },
    ]);
    expect(result.ok).toBe(false);
    expect(await handlers.requirements.get(requirement.id)).toEqual(original);
    expect(await handlers.audit.list({ entityId: requirement.id })).toEqual([]);
  });

  it("rolls back edit when SQLite refuses its audit event", async () => {
    const original = await handlers.requirements.get(requirement.id);
    db.exec(`CREATE TRIGGER synthetic_edit_audit_fault BEFORE INSERT ON audit_events
      WHEN NEW.action = 'requirement.edited'
      BEGIN SELECT RAISE(ABORT, 'synthetic edit audit fault'); END;`);
    const result = await dispatch(handlers, "requirements", "edit", [
      requirement.id,
      { title: "Faulty Edit Title", rationale: "Faulty Edit" },
    ]);
    expect(result.ok).toBe(false);
    expect(await handlers.requirements.get(requirement.id)).toEqual(original);
    expect(await handlers.audit.list({ entityId: requirement.id })).toEqual([]);
  });

  it("rolls back challenge when SQLite refuses its challenge_answered audit event", async () => {
    const original = await handlers.requirements.get(requirement.id);
    db.exec(`CREATE TRIGGER synthetic_challenge_answered_fault BEFORE INSERT ON audit_events
      WHEN NEW.action = 'requirement.challenge_answered'
      BEGIN SELECT RAISE(ABORT, 'synthetic challenge answered fault'); END;`);

    const challenged = dispatch(handlers, "requirements", "decide", [
      requirement.id,
      { decision: "challenge", rationale: "Audit fault challenge" },
    ]);
    await vi.waitFor(() => expect(called).toHaveBeenCalledTimes(1));
    answer("Valid text");

    const result = await challenged;
    expect(result.ok).toBe(false);
    expect(await handlers.requirements.get(requirement.id)).toEqual(original);
    expect(await handlers.audit.list({ entityId: requirement.id })).toEqual([]);
  });

  it("rolls back reset when SQLite refuses its deleted audit event", async () => {
    db.exec(`CREATE TRIGGER synthetic_reset_audit_fault BEFORE INSERT ON audit_events
      WHEN NEW.action = 'requirement.deleted'
      BEGIN SELECT RAISE(ABORT, 'synthetic reset audit fault'); END;`);

    const result = await dispatch(handlers, "requirements", "reset", []);
    expect(result.ok).toBe(false);
    // Requirements must NOT be deleted
    expect(await handlers.requirements.list()).toHaveLength(1);
  });

  it("does not let parallel human edits overwrite the same version", async () => {
    const updates = await Promise.all([
      dispatch(handlers, "requirements", "edit", [
        requirement.id,
        { title: "Synthetic title", rationale: "Synthetic title edit" },
      ]),
      dispatch(handlers, "requirements", "edit", [
        requirement.id,
        { description: "Synthetic description", rationale: "Synthetic description edit" },
      ]),
    ]);
    expect(updates.filter((result) => result.ok)).toHaveLength(1);
    expect(updates.find((result) => !result.ok)).toMatchObject({ error: { code: "conflict" } });
    const detail = await handlers.requirements.get(requirement.id);
    expect(detail.versions.map((value) => value.version)).toEqual([1, 2]);
    expect(await handlers.audit.list({ entityId: requirement.id })).toHaveLength(1);
  });

  it("does not let parallel human decisions both succeed on the same version", async () => {
    const decisions = await Promise.all([
      dispatch(handlers, "requirements", "decide", [
        requirement.id,
        { decision: "approve", rationale: "Approve concurrent" },
      ]),
      dispatch(handlers, "requirements", "decide", [
        requirement.id,
        { decision: "reject", rationale: "Reject concurrent" },
      ]),
    ]);
    expect(decisions.filter((result) => result.ok)).toHaveLength(1);
    expect(decisions.find((result) => !result.ok)).toMatchObject({ error: { code: "conflict" } });
    const detail = await handlers.requirements.get(requirement.id);
    expect(detail.versions.map((value) => value.version)).toEqual([1, 2]);
    expect(await handlers.audit.list({ entityId: requirement.id })).toHaveLength(1);
  });

  it("rejects editing or deciding on a deleted requirement", async () => {
    await handlers.requirements.reset();
    expect(await handlers.requirements.list()).toHaveLength(0);

    const editResult = await dispatch(handlers, "requirements", "edit", [
      requirement.id,
      { title: "Zombie edit", rationale: "Should fail" },
    ]);
    expect(editResult).toMatchObject({ ok: false, error: { code: "not_found" } });

    const decideResult = await dispatch(handlers, "requirements", "decide", [
      requirement.id,
      { decision: "approve", rationale: "Should fail" },
    ]);
    expect(decideResult).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("redacts sensitive secrets in audit rationale and change payloads", async () => {
    const secretKey = "sk-secret-confidential-token";
    await handlers.settings.setSecret("anthropic_api_key", secretKey);

    const edited = await handlers.requirements.edit(requirement.id, {
      title: `Secret title with ${secretKey}`,
      rationale: `PM used ${secretKey} in rationale`,
    });
    expect(edited.version).toBe(2);

    const audits = await handlers.audit.list({ entityId: requirement.id });
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.rationale).not.toContain(secretKey);
    expect(audit.rationale).toContain("[REDACTED");
    expect(JSON.stringify(audit.changes)).not.toContain(secretKey);
    expect(JSON.stringify(audit.changes)).toContain("[REDACTED");
  });
});
