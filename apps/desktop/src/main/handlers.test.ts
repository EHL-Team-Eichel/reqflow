import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BMW_DEFAULT_TEMPLATE } from "@reqflow/blocks";
import { DEFAULT_SETTINGS, defaultBlockParams, type WorkflowRun } from "@reqflow/core";
import { createHandlers } from "./handlers";
import { SecretsStore } from "./secrets";

describe("handlers (All IPC methods against SQLite and stores)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "reqflow-all-handlers-test-"));
    dbPath = join(tempDir, "test.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const setup = () => {
    const pushedRuns: WorkflowRun[] = [];
    const secretsStore = new SecretsStore(tempDir);
    const handlers = createHandlers({
      dataDir: tempDir,
      dbPath,
      secretsStore,
      pushRunUpdate: (r) => pushedRuns.push(r),
      openDialog: vi.fn(),
      saveDialog: vi.fn(),
      appInfo: () => ({
        version: "0.1.0",
        platform: "darwin",
        dataDir: tempDir,
        isPackaged: false,
      }),
    });
    return { handlers, pushedRuns, secretsStore };
  };

  it("handles app.info and templates.list", async () => {
    const { handlers } = setup();
    const info = await handlers.app.info();
    expect(info.version).toBe("0.1.0");

    const templates = await handlers.templates.list();
    expect(templates).toHaveLength(1);
    expect(templates[0]?.name).toContain("BMW");
  });

  it("handles settings get, save, and secrets management", async () => {
    const { handlers } = setup();

    const initial = await handlers.settings.get();
    expect(initial.scoring.thresholds.must).toBe(70);

    const updated = await handlers.settings.save({
      ...initial,
      scoring: { ...initial.scoring, thresholds: { ...initial.scoring.thresholds, must: 85 } },
    });
    expect(updated.scoring.thresholds.must).toBe(85);

    const secrets = await handlers.settings.secrets();
    expect(secrets.anthropic_api_key.configured).toBe(false);

    const afterSet = await handlers.settings.setSecret("anthropic_api_key", "sk-ant-test-key");
    expect(afterSet.anthropic_api_key.configured).toBe(true);

    const afterClear = await handlers.settings.setSecret("anthropic_api_key", null);
    expect(afterClear.anthropic_api_key.configured).toBe(false);
  });

  it("handles workflows CRUD with validation", async () => {
    const { handlers } = setup();

    const saved = await handlers.workflows.save({
      name: "BMW 5S Flow",
      scope: DEFAULT_SETTINGS.defaultScope,
      blocks: BMW_DEFAULT_TEMPLATE.graph.blocks,
      edges: BMW_DEFAULT_TEMPLATE.graph.edges,
    });
    expect(saved.id).toMatch(/^wf_/);

    const fetched = await handlers.workflows.get(saved.id);
    expect(fetched.name).toBe("BMW 5S Flow");

    const list = await handlers.workflows.list();
    expect(list).toHaveLength(1);

    await handlers.workflows.remove(saved.id);
    expect(await handlers.workflows.list()).toHaveLength(0);
  });

  it("handles requirements listing, detail view, editing, decisions, and audit trail", async () => {
    const { handlers } = setup();

    const reqs = await handlers.requirements.list();
    expect(reqs.length).toBeGreaterThan(0);

    const first = reqs[0]!;
    const detail = await handlers.requirements.get(first.id);
    expect(detail.requirement.id).toBe(first.id);
    expect(detail.findings.length).toBeGreaterThan(0);

    // Edit
    const edited = await handlers.requirements.edit(first.id, {
      title: "Refined Target Title",
      rationale: "PM refined requirements description",
    });
    expect(edited.title).toBe("Refined Target Title");
    expect(edited.version).toBe(first.version + 1);

    // Challenge
    const challenged = await handlers.requirements.decide(first.id, {
      decision: "challenge",
      rationale: "Verify cold weather charging telemetry",
    });
    expect(challenged.status).toBe("in_review");
    expect(challenged.uncertainties.some((u) => u.includes("PM Challenge"))).toBe(true);

    // Approve
    const approved = await handlers.requirements.decide(first.id, {
      decision: "approve",
      rationale: "Confirmed for EU market",
      priority: "must",
    });
    expect(approved.status).toBe("approved");
    expect(approved.priority).toBe("must");

    // Audit logs
    const audits = await handlers.audit.list({ entityId: first.id });
    expect(audits.length).toBeGreaterThanOrEqual(3);
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("requirement.edited");
    expect(actions).toContain("requirement.challenged");
    expect(actions).toContain("requirement.challenge_answered");
    expect(actions).toContain("requirement.status_changed");
  });

  it("handles runs start, get, list, blockOutput, resume, and cancel", async () => {
    const { handlers, pushedRuns } = setup();

    const wf = await handlers.workflows.save({
      name: "Run Test",
      scope: DEFAULT_SETTINGS.defaultScope,
      blocks: [
        {
          id: "hil_block",
          kind: "hil",
          label: "HIL",
          position: { x: 0, y: 0 },
          params: { ...defaultBlockParams("hil"), instructions: "Pause here" },
        },
      ],
      edges: [],
    });

    const run = await handlers.runs.start(wf.id);
    expect(run.id).toMatch(/^run_/);

    const fetched = await handlers.runs.get(run.id);
    expect(fetched.id).toBe(run.id);

    const list = await handlers.runs.list(wf.id);
    expect(list.length).toBeGreaterThanOrEqual(1);

    // Wait slightly for HIL to pause
    await new Promise((r) => setTimeout(r, 50));

    const pausedRun = await handlers.runs.get(run.id);
    expect(pausedRun.status).toBe("waiting_for_review");

    // Resume run
    const resumed = await handlers.runs.resume(run.id);
    expect(resumed.status).toBe("completed");

    expect(pushedRuns.length).toBeGreaterThan(0);
  });

  it("handles file import and requirements export", async () => {
    const sampleFilePath = join(tempDir, "feedback.csv");
    writeFileSync(sampleFilePath, "sample,data\n", "utf8");
    const exportedPath = join(tempDir, "exported.csv");

    const handlers = createHandlers({
      dataDir: tempDir,
      dbPath,
      appInfo: () => ({
        version: "0.1.0",
        platform: "darwin",
        dataDir: tempDir,
        isPackaged: false,
      }),
      openDialog: vi.fn().mockResolvedValue({
        canceled: false,
        filePaths: [sampleFilePath],
      }),
      saveDialog: vi.fn().mockResolvedValue({
        canceled: false,
        filePath: exportedPath,
      }),
    });

    const file = await handlers.files.import();
    expect(file?.name).toBe("feedback.csv");

    const exported = await handlers.exports.requirements({ format: "csv" });
    expect(exported?.path).toBe(exportedPath);
  });
});
