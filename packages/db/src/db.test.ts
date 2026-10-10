import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  createDatabase,
  SqliteAuditLogger,
  SqliteFileStore,
  SqliteRequirementRepository,
  SqliteRunRepository,
  SqliteSettingsRepository,
  SqliteWorkflowRepository,
  seedFixturesIfEmpty,
} from "./index";
import { DEFAULT_SETTINGS, emptyPipelineData, newId, type Requirement } from "@reqflow/core";

describe("SQLite database & repositories (@reqflow/db)", () => {
  let db: DatabaseSync;
  let tempDir: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "reqflow-db-test-"));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("SqliteAuditLogger", () => {
    it("records events and lists them ordered by timestamp", async () => {
      const logger = new SqliteAuditLogger(db);

      const evt1 = await logger.record({
        actor: { type: "system", component: "engine" },
        action: "run.started",
        entityType: "run",
        entityId: "run_123",
      });

      const evt2 = await logger.record({
        actor: { type: "human", userId: "u1", name: "Alice", role: "Product Manager" },
        action: "requirement.status_changed",
        entityType: "requirement",
        entityId: "REQ-5S-EU-001",
        rationale: "Approved after PM review",
        changes: [{ path: "status", before: "in_review", after: "approved" }],
      });

      expect(evt1.id).toMatch(/^aud_/);
      expect(evt2.id).toMatch(/^aud_/);

      const all = await logger.list();
      expect(all).toHaveLength(2);
      expect(all[0]?.id).toBe(evt1.id);
      expect(all[1]?.id).toBe(evt2.id);

      const filtered = await logger.list({ entityType: "requirement" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.entityId).toBe("REQ-5S-EU-001");

      const humanOnly = await logger.list({ actorType: "human" });
      expect(humanOnly).toHaveLength(1);
      expect(humanOnly[0]?.actor.type).toBe("human");
    });
  });

  describe("SqliteFileStore", () => {
    it("stores and retrieves files", async () => {
      const store = new SqliteFileStore(db, tempDir);
      const content = new TextEncoder().encode("Hello BMW Dataset");

      const saved = await store.save("test_feedback.csv", "text/csv", content);
      expect(saved.id).toMatch(/^file_/);
      expect(saved.sizeBytes).toBe(content.byteLength);

      const retrieved = await store.get(saved.id);
      expect(retrieved.name).toBe("test_feedback.csv");
      expect(retrieved.mimeType).toBe("text/csv");
      expect(new TextDecoder().decode(retrieved.bytes)).toBe("Hello BMW Dataset");

      const list = await store.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(saved.id);
    });
  });

  describe("SqliteSettingsRepository", () => {
    it("falls back to default settings and persists updates", async () => {
      const repo = new SqliteSettingsRepository(db);

      const initial = await repo.get();
      expect(initial).toEqual(DEFAULT_SETTINGS);

      const modified = {
        ...initial,
        review: {
          reviewer: { ...initial.review.reviewer, name: "Alexander" },
        },
      };
      await repo.save(modified);

      const loaded = await repo.get();
      expect(loaded.review.reviewer.name).toBe("Alexander");
    });
  });

  describe("SqliteWorkflowRepository", () => {
    it("creates, versions, retrieves, and removes workflows", async () => {
      const repo = new SqliteWorkflowRepository(db);

      const created = await repo.save({
        name: "Test Pipeline",
        scope: {
          vehicleLine: "5 Series",
          derivative: "Sedan",
          vehicleCode: "5S",
          market: "EU",
          horizonYears: 5,
        },
        nodes: [
          {
            id: "n1",
            type: "source.bmw_dataset",
            position: { x: 0, y: 0 },
            config: {},
          },
        ],
        edges: [],
      });

      expect(created.id).toMatch(/^wf_/);
      expect(created.version).toBe(1);

      const fetched = await repo.get(created.id);
      expect(fetched.name).toBe("Test Pipeline");

      const updated = await repo.save({
        id: created.id,
        name: "Updated Pipeline",
        scope: created.scope,
        nodes: created.nodes,
        edges: created.edges,
      });

      expect(updated.version).toBe(2);
      expect(updated.name).toBe("Updated Pipeline");

      const list = await repo.list();
      expect(list).toHaveLength(1);

      await repo.remove(created.id);
      const afterRemove = await repo.list();
      expect(afterRemove).toHaveLength(0);
    });
  });

  describe("SqliteRunRepository", () => {
    it("stores runs and per-node outputs", async () => {
      const repo = new SqliteRunRepository(db);

      const run = {
        id: newId("run"),
        workflowId: "wf_1",
        workflowVersion: 1,
        status: "running" as const,
        scope: {
          vehicleLine: "5 Series",
          derivative: "Sedan",
          vehicleCode: "5S",
          market: "EU",
          horizonYears: 5,
        },
        graph: { nodes: [], edges: [] },
        startedBy: { type: "human" as const, userId: "u1", name: "Alice" },
        startedAt: new Date().toISOString(),
        nodeRuns: [],
      };

      await repo.create(run);

      const fetched = await repo.get(run.id);
      expect(fetched.status).toBe("running");

      const updated = {
        ...fetched,
        status: "completed" as const,
        finishedAt: new Date().toISOString(),
      };
      await repo.update(updated);

      const afterUpdate = await repo.get(run.id);
      expect(afterUpdate.status).toBe("completed");

      const sampleOutput = emptyPipelineData();
      await repo.saveNodeOutput(run.id, "node_extract", sampleOutput);

      const retrievedOutput = await repo.getNodeOutput(run.id, "node_extract");
      expect(retrievedOutput).toEqual(sampleOutput);
    });
  });

  describe("SqliteRequirementRepository & Seeding", () => {
    it("seeds fixtures and supports listing and get detail expansion", async () => {
      const seeded = await seedFixturesIfEmpty(db);
      expect(seeded).toBe(true);

      const seededAgain = await seedFixturesIfEmpty(db);
      expect(seededAgain).toBe(false);

      const reqRepo = new SqliteRequirementRepository(db);
      const list = await reqRepo.list();
      expect(list.length).toBeGreaterThan(0);

      const first = list[0]!;
      const detail = await reqRepo.get(first.id);
      expect(detail.requirement.id).toBe(first.id);
      expect(detail.versions.length).toBeGreaterThanOrEqual(1);
      expect(detail.findings.length).toBeGreaterThan(0);
      expect(detail.sources.length).toBeGreaterThan(0);

      // Test version update
      const newVersion: Requirement = {
        ...first,
        version: first.version + 1,
        title: "Edited title",
        updatedAt: new Date().toISOString(),
      };
      await reqRepo.saveVersion(newVersion);

      const updatedList = await reqRepo.list();
      const updatedItem = updatedList.find((r) => r.id === first.id);
      expect(updatedItem?.title).toBe("Edited title");
      expect(updatedItem?.version).toBe(first.version + 1);

      const detailAfter = await reqRepo.get(first.id);
      expect(detailAfter.versions).toHaveLength(2);
      expect(detailAfter.requirement.title).toBe("Edited title");
    });
  });
});
