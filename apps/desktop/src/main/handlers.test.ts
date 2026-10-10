import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type WorkflowRun } from "@reqflow/core";
import { createHandlers } from "./handlers";
import { SecretsStore } from "./secrets";

describe("IPC Handlers (apps/desktop/src/main/handlers)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "reqflow-handlers-test-"));
    dbPath = join(tempDir, "test.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const setupHandlers = () => {
    const pushedRuns: WorkflowRun[] = [];
    const secretsStore = new SecretsStore(tempDir);
    const handlers = createHandlers({
      dbPath,
      dataDir: tempDir,
      appInfo: () => ({
        version: "0.1.0",
        platform: "darwin",
        dataDir: tempDir,
        isPackaged: false,
      }),
      secretsStore,
      pushRunUpdate: (run) => pushedRuns.push(run),
      openDialog: vi.fn(),
      saveDialog: vi.fn(),
    });
    return { handlers, pushedRuns, secretsStore };
  };

  it("serves app.info, nodes.catalog, and templates.list", async () => {
    const { handlers } = setupHandlers();

    const info = await handlers.app.info();
    expect(info.version).toBe("0.1.0");
    expect(info.platform).toBe("darwin");

    const catalog = await handlers.nodes.catalog();
    expect(catalog.length).toBeGreaterThan(0);
    const nodeTypes = catalog.map((c) => c.type);
    expect(nodeTypes).toContain("review.pm_gate");
    expect(nodeTypes).toContain("output.publish");
    expect(nodeTypes).toContain("output.export");

    const templates = await handlers.templates.list();
    expect(templates).toHaveLength(1);
    expect(templates[0]?.name).toContain("BMW");
  });

  it("handles workflows CRUD", async () => {
    const { handlers } = setupHandlers();

    const listBefore = await handlers.workflows.list();
    expect(listBefore.length).toBeGreaterThanOrEqual(1); // seeded default fixture

    const created = await handlers.workflows.save({
      name: "New Flow",
      scope: DEFAULT_SETTINGS.defaultScope,
      nodes: [
        {
          id: "n1",
          type: "review.pm_gate",
          position: { x: 0, y: 0 },
          config: {},
        },
      ],
      edges: [],
    });
    expect(created.id).toMatch(/^wf_/);
    expect(created.version).toBe(1);

    const fetched = await handlers.workflows.get(created.id);
    expect(fetched.name).toBe("New Flow");

    await handlers.workflows.remove(created.id);
    await expect(handlers.workflows.get(created.id)).rejects.toThrow();
  });

  it("handles requirements listing, detail retrieval, editing and decision flows", async () => {
    const { handlers } = setupHandlers();

    // List seeded requirements
    const reqs = await handlers.requirements.list();
    expect(reqs.length).toBeGreaterThan(0);

    const first = reqs[0]!;
    const detail = await handlers.requirements.get(first.id);
    expect(detail.requirement.id).toBe(first.id);
    expect(detail.findings.length).toBeGreaterThan(0);
    expect(detail.sources.length).toBeGreaterThan(0);

    // Edit requirement
    const edited = await handlers.requirements.edit(first.id, {
      title: "Updated Requirement Title",
      rationale: "PM refined the scope for clarity",
    });
    expect(edited.title).toBe("Updated Requirement Title");
    expect(edited.version).toBe(first.version + 1);

    // Decide: challenge
    const challenged = await handlers.requirements.decide(first.id, {
      decision: "challenge",
      rationale: "Is the battery supplier ready for 800V timeline?",
    });
    expect(challenged.status).toBe("in_review");
    expect(challenged.uncertainties.some((u) => u.includes("PM Challenge"))).toBe(true);

    // Decide: approve with priority override
    const approved = await handlers.requirements.decide(first.id, {
      decision: "approve",
      rationale: "Confirmed strategic fit for European market",
      priority: "must",
    });
    expect(approved.status).toBe("approved");
    expect(approved.priority).toBe("must");

    // Check audit trail for these changes
    const auditLogs = await handlers.audit.list({ entityId: first.id });
    expect(auditLogs.length).toBeGreaterThanOrEqual(3);
    const actions = auditLogs.map((a) => a.action);
    expect(actions).toContain("requirement.edited");
    expect(actions).toContain("requirement.challenged");
    expect(actions).toContain("requirement.challenge_answered");
    expect(actions).toContain("requirement.status_changed");
  });

  it("handles settings retrieval, saving, and secret storage", async () => {
    const { handlers, secretsStore } = setupHandlers();

    const current = await handlers.settings.get();
    expect(current.scoring.thresholds.must).toBe(70);

    const updated = await handlers.settings.save({
      ...current,
      scoring: {
        ...current.scoring,
        thresholds: { ...current.scoring.thresholds, must: 75 },
      },
    });
    expect(updated.scoring.thresholds.must).toBe(75);

    // Test secret management
    const initialSecrets = await handlers.settings.secrets();
    expect(initialSecrets.anthropic_api_key.configured).toBe(false);

    const afterSet = await handlers.settings.setSecret("anthropic_api_key", "sk-ant-test-key");
    expect(afterSet.anthropic_api_key.configured).toBe(true);
    expect(afterSet.anthropic_api_key.source).toBe("keychain");

    const retrievedKey = await secretsStore.getSecret("anthropic_api_key");
    expect(retrievedKey).toBe("sk-ant-test-key");

    const afterClear = await handlers.settings.setSecret("anthropic_api_key", null);
    expect(afterClear.anthropic_api_key.configured).toBe(false);
  });

  it("handles file import and export dialogs", async () => {
    const sampleFilePath = join(tempDir, "feedback_test.csv");
    writeFileSync(sampleFilePath, "id,comment\n1,Great handling\n", "utf8");

    const exportedPath = join(tempDir, "export_test.csv");

    const { handlers } = (() => {
      const secretsStore = new SecretsStore(tempDir);
      const handlers = createHandlers({
        dbPath,
        dataDir: tempDir,
        appInfo: () => ({
          version: "0.1.0",
          platform: "darwin",
          dataDir: tempDir,
          isPackaged: false,
        }),
        secretsStore,
        openDialog: vi.fn().mockResolvedValue({
          canceled: false,
          filePaths: [sampleFilePath],
        }),
        saveDialog: vi.fn().mockResolvedValue({
          canceled: false,
          filePath: exportedPath,
        }),
      });
      return { handlers };
    })();

    const imported = await handlers.files.import();
    expect(imported).not.toBeNull();
    expect(imported?.name).toBe("feedback_test.csv");
    expect(imported?.mimeType).toBe("text/csv");

    const exportRes = await handlers.exports.requirements({
      format: "csv",
    });
    expect(exportRes?.path).toBe(exportedPath);
  });
});
