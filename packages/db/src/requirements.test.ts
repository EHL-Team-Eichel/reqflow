import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { emptyPipelineData, type Requirement } from "@reqflow/core";
import {
  fixtureFindings,
  fixtureRecords,
  fixtureRequirements,
  fixtureSources,
} from "@reqflow/core/fixtures";
import { createDatabase } from "./db";
import { SqliteRequirementRepository, RequirementConflictError } from "./requirements";

describe("SqliteRequirementRepository version integrity and atomic transactions", () => {
  let db: DatabaseSync;
  let repo: SqliteRequirementRepository;
  const baseReq: Requirement = {
    ...fixtureRequirements[0]!,
    id: "REQ-F70-EU-888",
    version: 1,
    status: "proposed",
  };

  beforeEach(() => {
    db = createDatabase(":memory:");
    repo = new SqliteRequirementRepository(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
  });

  it("inserts initial version 1 and rejects duplicate version 1", async () => {
    const saved = await repo.saveVersion(baseReq);
    expect(saved.version).toBe(1);

    await expect(repo.saveVersion(baseReq)).rejects.toThrow(RequirementConflictError);
    const detail = await repo.get(baseReq.id);
    expect(detail.versions).toHaveLength(1);
  });

  it("requires expectedCurrentVersion to match MAX(version)", async () => {
    await repo.saveVersion(baseReq);

    const v2: Requirement = {
      ...baseReq,
      version: 2,
      title: "Updated Title v2",
    };

    // Stale expected version (e.g. 0 instead of 1)
    await expect(repo.saveVersion(v2, 0)).rejects.toThrow(RequirementConflictError);

    // Wrong expected version (e.g. 2 instead of 1)
    await expect(repo.saveVersion(v2, 2)).rejects.toThrow(RequirementConflictError);

    // Matching expected version (1)
    const savedV2 = await repo.saveVersion(v2, 1);
    expect(savedV2.version).toBe(2);

    // After v2 is committed, an attempt to commit v2 again fails
    await expect(repo.saveVersion(v2, 1)).rejects.toThrow(RequirementConflictError);
  });

  it("prevents resurrecting a deleted requirement", async () => {
    await repo.saveVersion(baseReq);

    // Record a requirement.deleted audit event (as happens during reset)
    db.prepare(
      `
      INSERT INTO audit_events (id, at, action, entity_type, entity_id, actor, changes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "aud_del_1",
      new Date().toISOString(),
      "requirement.deleted",
      "requirement",
      baseReq.id,
      JSON.stringify({ type: "human", userId: "u1", name: "PM" }),
      JSON.stringify([]),
    );

    // Attempting to append a new version to the deleted requirement must fail
    const v2: Requirement = { ...baseReq, version: 2 };
    await expect(repo.saveVersion(v2, 1)).rejects.toThrow(RequirementConflictError);

    // Attempting to recreate version 1 of the deleted requirement must also fail
    await expect(repo.saveVersion(baseReq, null)).rejects.toThrow(RequirementConflictError);
  });

  it("saveVersionWithAudit commits requirement and audit atomically, and rolls back both on audit failure", async () => {
    await repo.saveVersion(baseReq);

    const v2: Requirement = { ...baseReq, version: 2, title: "Title v2" };
    const auditInput = {
      actor: { type: "human" as const, userId: "u1", name: "PM" },
      action: "requirement.edited" as const,
      entityType: "requirement" as const,
      entityId: baseReq.id,
      rationale: "PM edit",
      changes: [{ path: "title", before: baseReq.title, after: "Title v2" }],
    };

    // Trigger that causes audit insert to fail
    db.exec(`
      CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'requirement.edited'
      BEGIN SELECT RAISE(ABORT, 'Simulated audit table failure'); END;
    `);

    expect(() => repo.saveVersionWithAudit(v2, 1, [auditInput])).toThrow();

    // Verify requirement was NOT bumped to v2
    const detail = await repo.get(baseReq.id);
    expect(detail.requirement.version).toBe(1);
    expect(detail.requirement.title).toBe(baseReq.title);
    expect(detail.versions).toHaveLength(1);

    // Drop trigger and retry
    db.exec("DROP TRIGGER fail_audit");
    const saved = repo.saveVersionWithAudit(v2, 1, [auditInput]);
    expect(saved.version).toBe(2);

    const updatedDetail = await repo.get(baseReq.id);
    expect(updatedDetail.requirement.version).toBe(2);
    expect(updatedDetail.versions).toHaveLength(2);

    const auditRows = db.prepare("SELECT * FROM audit_events WHERE entity_id = ?").all(baseReq.id);
    expect(auditRows).toHaveLength(1);
  });

  it("removeAllWithAudit atomically deletes requirements and writes audit, rolling back on failure", async () => {
    await repo.saveVersion(baseReq);
    const deleteAudit = {
      actor: { type: "human" as const, userId: "u1", name: "PM" },
      action: "requirement.deleted" as const,
      entityType: "requirement" as const,
      entityId: baseReq.id,
      rationale: "Reset test",
      changes: [{ path: "status", before: baseReq.status, after: null }],
    };

    // Trigger failing audit insert on delete
    db.exec(`
      CREATE TRIGGER fail_delete_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'requirement.deleted'
      BEGIN SELECT RAISE(ABORT, 'Simulated delete audit failure'); END;
    `);

    expect(() => repo.removeAllWithAudit([baseReq], [deleteAudit])).toThrow();

    // Requirements must NOT be deleted
    expect(await repo.list()).toHaveLength(1);

    db.exec("DROP TRIGGER fail_delete_audit");
    const removed = repo.removeAllWithAudit([baseReq], [deleteAudit]);
    expect(removed).toHaveLength(1);
    expect(await repo.list()).toHaveLength(0);

    const auditRows = db.prepare("SELECT * FROM audit_events WHERE entity_id = ?").all(baseReq.id);
    expect(auditRows).toHaveLength(1);
  });

  it("removeAllWithAudit rejects when an expected requirement version was concurrently changed", async () => {
    await repo.saveVersion(baseReq);
    const v2: Requirement = { ...baseReq, version: 2, title: "Title v2" };
    await repo.saveVersion(v2, 1);

    const deleteAudit = {
      actor: { type: "human" as const, userId: "u1", name: "PM" },
      action: "requirement.deleted" as const,
      entityType: "requirement" as const,
      entityId: baseReq.id,
      rationale: "Reset test",
      changes: [],
    };

    // Passing stale baseReq (version 1) while DB is at version 2 must throw RequirementConflictError
    expect(() => repo.removeAllWithAudit([baseReq], [deleteAudit])).toThrow(
      RequirementConflictError,
    );

    // Requirement must still be in the DB
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.version).toBe(2);
  });

  it("savePipelineData rolls back entire batch when requirement version conflicts", async () => {
    await repo.saveVersion(baseReq);

    // Prepare pipeline data with a conflicting requirement (version 1 of existing requirement)
    const pipelineData = {
      ...emptyPipelineData(),
      sources: fixtureSources.slice(0, 1),
      records: fixtureRecords.slice(0, 1),
      findings: fixtureFindings.slice(0, 1),
      requirements: [baseReq],
    };

    await expect(repo.savePipelineData(pipelineData)).rejects.toThrow(RequirementConflictError);

    // Evidence must NOT be committed due to transaction rollback
    const sources = db.prepare("SELECT * FROM sources").all();
    const records = db.prepare("SELECT * FROM records").all();
    const findings = db.prepare("SELECT * FROM findings").all();
    expect(sources).toHaveLength(0);
    expect(records).toHaveLength(0);
    expect(findings).toHaveLength(0);
  });
});
