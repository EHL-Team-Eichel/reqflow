import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { emptyPipelineData, type Requirement } from "@reqflow/core";
import { fixtureRequirements } from "@reqflow/core/fixtures";
import {
  createDatabase,
  formatRequirementsCsv,
  formatRequirementsJson,
  formatRequirementsMarkdown,
  removeDemoData,
  seedFixtures,
  SqliteAuditLogger,
  SqliteRequirementRepository,
  SqliteRunRepository,
} from "./index";

describe("SQLite persistence (@reqflow/db)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
  });

  it("seeds database and lists requirements and audit events", async () => {
    expect(seedFixtures(db)).toBe(true);
    expect(seedFixtures(db)).toBe(false);

    const reqRepo = new SqliteRequirementRepository(db);
    const auditRepo = new SqliteAuditLogger(db);

    const reqs = await reqRepo.list();
    expect(reqs.length).toBeGreaterThan(0);

    const detail = await reqRepo.get(reqs[0]!.id);
    expect(detail.requirement.id).toBe(reqs[0]!.id);
    expect(detail.findings.length).toBeGreaterThan(0);

    const audits = await auditRepo.list();
    expect(audits.length).toBeGreaterThan(0);
  });

  it("versions requirements and records audit events", async () => {
    seedFixtures(db);
    const reqRepo = new SqliteRequirementRepository(db);
    const auditRepo = new SqliteAuditLogger(db);

    const reqs = await reqRepo.list();
    const first = reqs[0]!;

    const updated = {
      ...first,
      title: "Updated Title",
      version: first.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await reqRepo.saveVersion(updated);

    const detail = await reqRepo.get(first.id);
    expect(detail.requirement.title).toBe("Updated Title");
    expect(detail.versions).toHaveLength(2);

    const newAudit = await auditRepo.record({
      actor: { type: "human", userId: "u1", name: "Alice" },
      action: "requirement.edited",
      entityType: "requirement",
      entityId: first.id,
      rationale: "Edited in test",
    });
    expect(newAudit.id).toMatch(/^aud_/);

    const filtered = await auditRepo.list({ entityId: first.id });
    expect(filtered.some((a) => a.id === newAudit.id)).toBe(true);
  });

  it("stores and retrieves block outputs per run and block", async () => {
    const runRepo = new SqliteRunRepository(db);
    const outputs = {
      out: emptyPipelineData(),
    };

    await runRepo.saveBlockOutput("run_1", "block_1", outputs);
    const fetched = await runRepo.getBlockOutput("run_1", "block_1");
    expect(fetched).toEqual(outputs);
  });

  it("formats requirements to JSON, CSV, and Markdown", async () => {
    seedFixtures(db);
    const reqRepo = new SqliteRequirementRepository(db);
    const reqs = await reqRepo.list();

    const json = formatRequirementsJson(reqs);
    expect(json).toContain("REQ-F70-EU-");

    const csv = formatRequirementsCsv(reqs);
    expect(csv).toContain("ID,Title,Category");
    expect(csv).toContain("REQ-F70-EU-");

    const md = formatRequirementsMarkdown(reqs);
    expect(md).toContain("# BMW Vehicle Requirements Specification");
    expect(md).toContain("| ID | Title | Category |");
  });

  it("removes seeded demo rows and nothing else, and is safe to repeat", async () => {
    seedFixtures(db);
    const reqRepo = new SqliteRequirementRepository(db);
    const audit = new SqliteAuditLogger(db);
    const real: Requirement = {
      ...fixtureRequirements[0]!,
      id: "REQ-F70-EU-042",
      runId: "run_real0001",
    };
    await reqRepo.saveVersion(real);
    await reqRepo.savePipelineData(
      { ...emptyPipelineData(), sources: [{ ...fixtureSourceLike(), id: "src_real" }] },
      "run_real0001",
    );
    const kept = await audit.record({
      actor: { type: "human", userId: "u1", name: "PM" },
      action: "requirement.edited",
      entityType: "requirement",
      entityId: real.id,
      rationale: "real edit",
    });

    const removed = removeDemoData(db);
    expect(removed.requirements).toBe(fixtureRequirements.length);
    expect(removed.auditEvents).toBeGreaterThan(0);
    expect(removed.runs).toBe(1);
    expect((await reqRepo.list()).map((r) => r.id)).toEqual(["REQ-F70-EU-042"]);
    expect((await audit.list()).map((a) => a.id)).toEqual([kept.id]);
    const sources = db.prepare("SELECT id FROM sources").all() as { id: string }[];
    expect(sources.map((s) => s.id)).toEqual(["src_real"]);

    expect(Object.values(removeDemoData(db)).every((n) => n === 0)).toBe(true);
  });

  it("removes all requirements, and deleted ids still count for numbering", async () => {
    const reqRepo = new SqliteRequirementRepository(db);
    const audit = new SqliteAuditLogger(db);
    for (const seq of ["001", "002", "007"]) {
      await reqRepo.saveVersion({ ...fixtureRequirements[0]!, id: `REQ-F70-EU-${seq}` });
    }
    await reqRepo.saveVersion({ ...fixtureRequirements[0]!, id: "REQ-G60-EU-009" });
    expect(await reqRepo.maxSeq("REQ-F70-EU-")).toBe(7);

    const removed = await reqRepo.removeAll();
    expect(removed.map((r) => r.id).sort()).toEqual([
      "REQ-F70-EU-001",
      "REQ-F70-EU-002",
      "REQ-F70-EU-007",
      "REQ-G60-EU-009",
    ]);
    expect(await reqRepo.list()).toEqual([]);
    expect(await reqRepo.maxSeq("REQ-F70-EU-")).toBe(0); // nothing recorded yet

    await audit.record({
      actor: { type: "human", userId: "u1", name: "PM" },
      action: "requirement.deleted",
      entityType: "requirement",
      entityId: "REQ-F70-EU-007",
      rationale: "reset",
    });
    expect(await reqRepo.maxSeq("REQ-F70-EU-")).toBe(7);
    expect(await reqRepo.maxSeq("REQ-G60-EU-")).toBe(0);
    expect(await reqRepo.removeAll()).toEqual([]);
  });
});

function fixtureSourceLike() {
  return {
    id: "src_x",
    kind: "customer_feedback" as const,
    origin: "bmw_internal" as const,
    title: "Real export",
    retrievedAt: "2026-10-10T08:00:00.000Z",
    reliability: "high" as const,
  };
}
