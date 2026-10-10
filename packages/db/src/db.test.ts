import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { emptyPipelineData } from "@reqflow/core";
import {
  createDatabase,
  formatRequirementsCsv,
  formatRequirementsJson,
  formatRequirementsMarkdown,
  seedDatabaseIfEmpty,
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
    expect(seedDatabaseIfEmpty(db)).toBe(true);
    expect(seedDatabaseIfEmpty(db)).toBe(false);

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
    seedDatabaseIfEmpty(db);
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
    seedDatabaseIfEmpty(db);
    const reqRepo = new SqliteRequirementRepository(db);
    const reqs = await reqRepo.list();

    const json = formatRequirementsJson(reqs);
    expect(json).toContain("REQ-5S-EU-");

    const csv = formatRequirementsCsv(reqs);
    expect(csv).toContain("ID,Title,Category");
    expect(csv).toContain("REQ-5S-EU-");

    const md = formatRequirementsMarkdown(reqs);
    expect(md).toContain("# BMW Vehicle Requirements Specification");
    expect(md).toContain("| ID | Title | Category |");
  });
});
