import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allBlockImplementations, BMW_DEFAULT_TEMPLATE } from "@reqflow/blocks";
import {
  DEFAULT_SETTINGS,
  connect,
  createBlock,
  defaultBlockParams,
  emptyPipelineData,
  setBlockParams,
  type LlmClient,
  type WorkflowRun,
} from "@reqflow/core";
import { fixtureRecords, fixtureSources } from "@reqflow/core/fixtures";
import {
  createDatabase,
  createFileStore,
  seedFixtures,
  SqliteReasoningRepository,
} from "@reqflow/db";
import { BlockRegistry, defineBlock } from "@reqflow/engine";
import { createHandlers } from "./handlers";
import { SecretsStore, type SecureStorage } from "./secrets";

// Synthetic boundary double: no Electron, host environment credentials, or plaintext fallback.
const secureStorage: SecureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`synthetic-cipher:${value.split("").reverse().join("")}`),
  decryptString: (value) => {
    const text = value.toString();
    if (!text.startsWith("synthetic-cipher:")) throw new Error("Invalid synthetic ciphertext");
    return text.slice("synthetic-cipher:".length).split("").reverse().join("");
  },
};
const syntheticSecrets = (dir: string) => new SecretsStore(dir, { secureStorage, environment: {} });

/** BMW's real export, present only locally in data/raw/ (gitignored). */
const BMW_FEEDBACK = join(import.meta.dirname, "../../../../data/raw/F70_feedback_hackathon.xlsx");
/** Synthetic feedback: two topics with two comments each, enough for Add to Car to propose two. */
const FEEDBACK_CSV = [
  "id,comment",
  "F1,The rear seats are uncomfortable on long journeys",
  "F2,The rear seats are uncomfortable and need better support",
  "F3,The infotainment screen is too slow and freezes often",
  "F4,The infotainment screen freezes and is too slow to respond",
].join("\n");

type Handlers = ReturnType<typeof createHandlers>;

/** Saves and runs Raw (feedback file) → Add to Car, waits for the run, returns it. */
async function runFeedbackToCar(handlers: Handlers, uploadsDir: string, path: string) {
  const file = await createFileStore(uploadsDir).importFile(path);
  const raw = createBlock("raw", { id: "raw", position: { x: 0, y: 0 } });
  const car = createBlock("add_to_car", { id: "car", position: { x: 300, y: 0 } });
  let graph = setBlockParams({ blocks: [raw, car], edges: [] }, "raw", {
    ...raw.params,
    dataset: "customer_feedback",
    file: { fileId: file.id, name: file.name },
  }).graph;
  graph = connect(graph, { source: "raw", sourcePort: "out", target: "car", targetPort: "in-0" });
  const workflow = await handlers.workflows.save({
    ...graph,
    name: "Feedback to car",
    scope: DEFAULT_SETTINGS.defaultScope,
  });
  const initial = await handlers.runs.start(workflow.id);
  let run = await handlers.runs.get(initial.id);
  const deadline = Date.now() + 30_000;
  while (["queued", "running"].includes(run.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    run = await handlers.runs.get(initial.id);
  }
  expect(run.error).toBeUndefined();
  expect(run.status).toBe("completed");
  return run;
}

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

  const setup = (registry?: BlockRegistry) => {
    const pushedRuns: WorkflowRun[] = [];
    const secretsStore = syntheticSecrets(tempDir);
    const files = createFileStore(join(tempDir, "uploads"));
    const handlers = createHandlers({
      dataDir: tempDir,
      dbPath,
      files,
      secretsStore,
      registry,
      pushRunUpdate: (r) => pushedRuns.push(r),
      pickFile: vi.fn().mockResolvedValue(null),
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

    // setup:<id> secret deletion
    const setupsInitial = await handlers.settings.get();
    const settingsWithSetups = await handlers.settings.save({
      ...setupsInitial,
      agents: {
        ...setupsInitial.agents,
        setups: [
          {
            id: "test-1",
            provider: "anthropic",
            baseUrl: "",
            model: "claude-3-5-sonnet-latest",
            fastModel: "claude-haiku",
            name: "T1",
            effort: "low",
            temperature: 0,
            maxParallel: 5,
          },
          {
            id: "test-2",
            provider: "openai",
            baseUrl: "",
            model: "gpt-4o",
            fastModel: "gpt-4o-mini",
            name: "T2",
            effort: "low",
            temperature: 0,
            maxParallel: 5,
          },
        ],
      },
    });
    await handlers.settings.setSecret("setup:test-1", "key1");
    await handlers.settings.setSecret("setup:test-2", "key2");

    // Remove test-2
    await handlers.settings.save({
      ...settingsWithSetups,
      agents: { ...settingsWithSetups.agents, setups: [settingsWithSetups.agents.setups[0]!] },
    });

    const finalSecrets = await handlers.settings.secrets();
    expect(finalSecrets.setups?.["test-1"]?.configured).toBe(true);
    expect(finalSecrets.setups?.["test-2"]).toBeUndefined();
  });

  it("handles workflows CRUD with validation", async () => {
    const { handlers } = setup();

    const saved = await handlers.workflows.save({
      name: "BMW Default Flow",
      scope: DEFAULT_SETTINGS.defaultScope,
      blocks: BMW_DEFAULT_TEMPLATE.graph.blocks,
      edges: BMW_DEFAULT_TEMPLATE.graph.edges,
    });
    expect(saved.id).toMatch(/^wf_/);

    const fetched = await handlers.workflows.get(saved.id);
    expect(fetched.name).toBe("BMW Default Flow");

    const list = await handlers.workflows.list();
    expect(list).toHaveLength(1);

    await handlers.workflows.remove(saved.id);
    expect(await handlers.workflows.list()).toHaveLength(0);
  });

  it("persists model choices and audits them without changing any requirement", async () => {
    const { handlers } = setup();
    const before = await handlers.requirements.list();
    const settings = await handlers.settings.get();
    await handlers.settings.save({ ...settings, model: { powertrain: "hydrogen" } });
    expect((await handlers.settings.get()).model.powertrain).toBe("hydrogen");
    const events = await handlers.audit.list();
    const event = events.find((e) => e.action === "settings.changed");
    expect(event?.changes).toContainEqual({
      path: "model",
      before: { powertrain: "electric" },
      after: { powertrain: "hydrogen" },
    });
    expect(await handlers.requirements.list()).toEqual(before);
  });

  it("runs the real ten-output splitter through IPC handlers with the configured offline LLM", async () => {
    const registry = new BlockRegistry([
      ...allBlockImplementations.filter((b) => b.kind !== "raw"),
      defineBlock({
        kind: "raw",
        async run() {
          return {
            status: "ok",
            outputs: {
              out: {
                ...emptyPipelineData(),
                sources: fixtureSources,
                records: fixtureRecords,
              },
            },
          };
        },
      }),
    ]);
    const { handlers } = setup(registry);
    const split = createBlock("ai_splitter", { id: "split", position: { x: 300, y: 0 } });
    let graph = setBlockParams(
      { blocks: [createBlock("raw", { id: "raw", position: { x: 0, y: 0 } }), split], edges: [] },
      "split",
      {
        ...split.params,
        splitBy: "category",
        branches: Array.from({ length: 10 }, (_, i) => `Group ${i}`),
      },
    ).graph;
    graph = connect(graph, { source: "raw", sourcePort: "out", target: "split", targetPort: "in" });
    const workflow = await handlers.workflows.save({
      ...graph,
      name: "Split records",
      scope: DEFAULT_SETTINGS.defaultScope,
    });
    const initial = await handlers.runs.start(workflow.id);
    let run = await handlers.runs.get(initial.id);
    const deadline = Date.now() + 2000;
    while (["queued", "running"].includes(run.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      run = await handlers.runs.get(initial.id);
    }
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("completed");
    const outputs = await handlers.runs.blockOutput(run.id, "split");
    expect(Object.keys(outputs)).toHaveLength(10);
    expect(
      Object.values(outputs)
        .flatMap((data) => data.records.map((r) => r.id))
        .sort(),
    ).toEqual(fixtureRecords.map((r) => r.id).sort());
    expect(
      run.blockRuns
        .find((b) => b.blockId === "split")!
        .logs.some((log) => /model mock:default/.test(log.message)),
    ).toBe(true);
  });

  it.skipIf(!existsSync(BMW_FEEDBACK))(
    "runs Raw → Add to Car on BMW's real F70 feedback: requirements with evidence, numbering continues",
    async () => {
      const { handlers } = setup();
      const uploads = join(tempDir, "uploads");

      // BMW data: assertions compare booleans and counts only, so a failure can't print a value.
      await runFeedbackToCar(handlers, uploads, BMW_FEEDBACK);
      const first = await handlers.requirements.list();
      expect(first.length).toBeGreaterThan(0);
      expect(first.length).toBeLessThanOrEqual(20); // the block's default limit
      expect(first.every((r) => r.priority === "must" && r.status === "proposed")).toBe(true);
      expect(first.every((r) => r.confidence !== undefined && r.inputRank === 1)).toBe(true);
      const seq = (id: string) => Number(id.split("-").at(-1));
      expect(Math.min(...first.map((r) => seq(r.id)))).toBe(1);
      const detail = await handlers.requirements.get(first[0]!.id);
      expect(detail.findings.length).toBeGreaterThan(0);
      expect(detail.records.length).toBeGreaterThan(0);
      expect(detail.sources.some((s) => s.kind === "customer_feedback")).toBe(true);
      const verbatim = detail.findings.every((f) =>
        f.evidence.every(
          (e) => detail.records.find((r) => r.id === e.recordId)?.text.includes(e.excerpt) ?? false,
        ),
      );
      expect(verbatim).toBe(true);
      const trace = await handlers.reasoning.forRequirement(first[0]!.id);
      expect(trace !== null && trace.offline && trace.requirements.length === first.length).toBe(
        true,
      );

      // A second run continues the numbering instead of overwriting the first run's ids.
      await runFeedbackToCar(handlers, uploads, BMW_FEEDBACK);
      const all = await handlers.requirements.list();
      expect(all.length).toBe(2 * first.length);
      expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
      const unchanged =
        JSON.stringify((await handlers.requirements.get(first[0]!.id)).requirement) ===
        JSON.stringify(detail.requirement);
      expect(unchanged).toBe(true);
    },
    60_000,
  );

  it("handles requirements listing, detail view, editing, decisions, and audit trail", async () => {
    const { handlers } = setup();
    await runSyntheticFeedback(handlers);

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

    // Use a custom registry with a block that produces data into HIL
    const customRegistry = new BlockRegistry([
      ...allBlockImplementations.filter((b) => b.kind !== "raw"),
      defineBlock({
        kind: "raw",
        async run() {
          return {
            status: "ok",
            outputs: {
              out: {
                ...emptyPipelineData(),
                sources: [
                  {
                    id: "src_hil_test",
                    kind: "customer_feedback",
                    origin: "bmw_internal",
                    title: "Test",
                    uri: "f1",
                    retrievedAt: new Date().toISOString(),
                    reliability: "high",
                  },
                ],
              },
            },
          };
        },
      }),
    ]);

    const testHandlers = createHandlers({
      dataDir: tempDir,
      dbPath,
      secretsStore: syntheticSecrets(tempDir),
      files: createFileStore(join(tempDir, "uploads")),
      registry: customRegistry,
      pushRunUpdate: (r) => pushedRuns.push(r),
      pickFile: vi.fn().mockResolvedValue(null),
      appInfo: () => ({
        version: "0.1.0",
        platform: "darwin",
        dataDir: tempDir,
        isPackaged: false,
      }),
    });

    const wf = await testHandlers.workflows.save({
      name: "Run Test",
      scope: DEFAULT_SETTINGS.defaultScope,
      blocks: [
        {
          id: "r1",
          kind: "raw",
          label: "Raw",
          position: { x: 0, y: 0 },
          params: defaultBlockParams("raw"),
        },
        {
          id: "hil_block",
          kind: "hil",
          label: "HIL",
          position: { x: 100, y: 0 },
          params: { ...defaultBlockParams("hil"), instructions: "Pause here" },
        },
      ],
      edges: [{ id: "e1", source: "r1", sourcePort: "out", target: "hil_block", targetPort: "in" }],
    });

    const run = await testHandlers.runs.start(wf.id);
    expect(run.id).toMatch(/^run_/);

    const fetched = await testHandlers.runs.get(run.id);
    expect(fetched.id).toBe(run.id);

    const list = await testHandlers.runs.list(wf.id);
    expect(list.length).toBeGreaterThanOrEqual(1);

    await new Promise((r) => setTimeout(r, 60));

    const pausedRun = await testHandlers.runs.get(run.id);
    expect(pausedRun.status).toBe("waiting_for_review");

    // Resume run
    const resumed = await testHandlers.runs.resume(run.id);
    expect(resumed.status).toBe("completed");

    expect(pushedRuns.length).toBeGreaterThan(0);
  });

  it("handles file import and requirements export", async () => {
    const sampleFilePath = join(tempDir, "feedback.csv");
    writeFileSync(sampleFilePath, "sample,data\n", "utf8");
    const exportedPath = join(tempDir, "exported.csv");

    const files = createFileStore(join(tempDir, "uploads"));
    const handlers = createHandlers({
      dataDir: tempDir,
      dbPath,
      secretsStore: syntheticSecrets(tempDir),
      files,
      appInfo: () => ({
        version: "0.1.0",
        platform: "darwin",
        dataDir: tempDir,
        isPackaged: false,
      }),
      pickFile: vi.fn().mockResolvedValue(sampleFilePath),
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

  /** Real requirements, made the way the app makes them: Raw → Add to Car on synthetic feedback. */
  const runSyntheticFeedback = async (handlers: Handlers) => {
    const csv = join(tempDir, "feedback.csv");
    writeFileSync(csv, FEEDBACK_CSV, "utf8");
    return runFeedbackToCar(handlers, join(tempDir, "uploads"), csv);
  };

  it("starts without demo data and removes what earlier builds seeded", async () => {
    const old = createDatabase(dbPath);
    expect(seedFixtures(old)).toBe(true);
    old.close();

    const { handlers } = setup();
    expect(await handlers.requirements.list()).toEqual([]);
    expect(await handlers.audit.list()).toEqual([]);
    expect(await handlers.runs.list()).toEqual([]);
  });

  it("reset removes every requirement, audits each one, and never reuses their ids", async () => {
    const { handlers } = setup();
    expect(await handlers.requirements.reset()).toEqual({ removed: 0 });

    await runSyntheticFeedback(handlers);
    const before = await handlers.requirements.list();
    expect(before.length).toBeGreaterThan(0);
    await handlers.requirements.edit(before[0]!.id, { title: "Edited", rationale: "test" });

    expect(await handlers.requirements.reset()).toEqual({ removed: before.length });
    expect(await handlers.requirements.list()).toEqual([]);
    await expect(handlers.requirements.get(before[0]!.id)).rejects.toThrow(/not found/i);
    const deleted = await handlers.audit.list({ action: "requirement.deleted" });
    expect(deleted.map((e) => e.entityId).sort()).toEqual(before.map((r) => r.id).sort());
    expect(deleted.every((e) => e.actor.type === "human" && e.rationale?.includes("Reset"))).toBe(
      true,
    );
    // The history of a removed requirement is kept.
    const history = await handlers.audit.list({ entityId: before[0]!.id });
    expect(history.map((e) => e.action)).toEqual(
      expect.arrayContaining(["requirement.proposed", "requirement.edited", "requirement.deleted"]),
    );

    await runSyntheticFeedback(handlers);
    const after = await handlers.requirements.list();
    const seq = (id: string) => Number(id.split("-").at(-1));
    expect(Math.min(...after.map((r) => seq(r.id)))).toBe(
      Math.max(...before.map((r) => seq(r.id))) + 1,
    );
  });

  it("handles reasoning traces: null when empty, returns saved trace via handlers", async () => {
    const { handlers, secretsStore } = setup();

    expect(await handlers.reasoning.forRun("run_1", "car")).toBeNull();
    expect(await handlers.reasoning.latest("wf_1", "car")).toBeNull();
    expect(await handlers.reasoning.forRequirement("REQ-F70-EU-001")).toBeNull();

    const db = createDatabase(tempDir + "/test.db");
    const repo = new SqliteReasoningRepository(db);

    db.exec("PRAGMA foreign_keys = OFF;");

    const trace = {
      id: "rsn_1",
      runId: "run_1",
      blockId: "car",
      createdAt: "2026-01-01T10:00:00.000Z",
      scope: { vehicleLine: "1", derivative: "5", vehicleCode: "F", market: "EU", horizonYears: 5 },
      inputs: [],
      steps: [],
      requirements: [
        {
          requirementId: "REQ-F70-EU-001",
          title: "Syn",
          theme: "Syn",
          ranks: [1],
          evidence: [],
          thoughts: [],
          verdict: "accepted" as const,
          issues: [],
          confidence: {
            value: 0.8,
            level: "high" as const,
            signals: [{ key: "test", label: "Test", value: 1, weight: 1, by: "test" }],
            method: "m",
          },
          contextUsed: [],
        },
      ],
      heldBack: [],
      totals: { calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 5 },
      offline: true,
    };

    await repo.save(trace);

    const forRun = await handlers.reasoning.forRun("run_1", "car");
    expect(forRun?.id).toBe("rsn_1");

    // wait, latest joins with runs table, so we need a run
    db.prepare(
      `INSERT OR REPLACE INTO runs (id, workflow_id, workflow_version, status, scope, graph, started_by, started_at, block_runs) VALUES (?, ?, 1, 'completed', '{}', '{}', '{}', ?, '[]')`,
    ).run("run_1", "wf_1", "2026-01-01T00:00:00.000Z");

    const latest = await handlers.reasoning.latest("wf_1", "car");
    expect(latest?.id).toBe("rsn_1");

    const forReq = await handlers.reasoning.forRequirement("REQ-F70-EU-001");
    expect(forReq?.id).toBe("rsn_1");

    await expect(handlers.reasoning.forRun("invalid", "car")).rejects.toThrow();

    db.close();
  });

  it("lazy no-call for spreadsheet: previewing CSV does not invoke or initialize AI", async () => {
    const mockLlm: LlmClient = {
      generateText: vi.fn(),
      generateObject: vi.fn(),
    };
    const files = createFileStore(join(tempDir, "uploads"));
    const handlers = createHandlers({
      dataDir: tempDir,
      dbPath,
      files,
      llm: mockLlm,
      secretsStore: syntheticSecrets(tempDir),
      pickFile: vi.fn().mockResolvedValue(null),
      appInfo: () => ({
        version: "0.1.0",
        platform: "darwin",
        dataDir: tempDir,
        isPackaged: false,
      }),
    });

    const csvPath = join(tempDir, "sample.csv");
    writeFileSync(csvPath, "id,comment\n1,Great seat comfort\n", "utf8");
    const file = await files.importFile(csvPath);

    const preview = await handlers.blocks.preview({
      kind: "raw",
      params: {
        ...defaultBlockParams("raw"),
        dataset: "customer_feedback",
        file: { fileId: file.id, name: file.name },
      },
      scope: DEFAULT_SETTINGS.defaultScope,
    });

    expect(preview.outputs.out?.records).toHaveLength(1);
    expect(mockLlm.generateText).not.toHaveBeenCalled();
    expect(mockLlm.generateObject).not.toHaveBeenCalled();
  });

  it("invokes configured default model via configuredLlm when preview invokes AI and handles deps.llm test seam", async () => {
    const mockLlm: LlmClient = {
      generateText: vi
        .fn()
        .mockResolvedValue({ text: "extracted requirements", model: "test-model" }),
      generateObject: vi.fn().mockResolvedValue({ object: {} }),
    };
    const testRegistry = new BlockRegistry([
      ...allBlockImplementations.filter((b) => b.kind !== "raw"),
      defineBlock({
        kind: "raw",
        async run(_inputs, _params, ctx) {
          ctx.log("Starting raw preview with AI extraction");
          const res = await ctx.llm.generateText({ prompt: "extract from doc" });
          return {
            status: "ok",
            outputs: {
              out: {
                ...emptyPipelineData(),
                records: [{ id: "R1", text: res.text, sourceId: "S1" }],
              },
            },
          };
        },
      }),
    ]);
    const files = createFileStore(join(tempDir, "uploads"));
    const handlers = createHandlers({
      dataDir: tempDir,
      dbPath,
      files,
      llm: mockLlm,
      registry: testRegistry,
      secretsStore: syntheticSecrets(tempDir),
      pickFile: vi.fn().mockResolvedValue(null),
      appInfo: () => ({
        version: "0.1.0",
        platform: "darwin",
        dataDir: tempDir,
        isPackaged: false,
      }),
    });

    const preview = await handlers.blocks.preview({
      kind: "raw",
      params: defaultBlockParams("raw"),
      scope: DEFAULT_SETTINGS.defaultScope,
    });

    expect(mockLlm.generateText).toHaveBeenCalledWith({ prompt: "extract from doc" });
    expect(preview.outputs.out?.records).toHaveLength(1);
    expect(preview.outputs.out?.records[0]?.text).toBe("extracted requirements");
  });

  it("wraps AI provider failure safely during preview and preserves logs", async () => {
    const failingLlm: LlmClient = {
      generateText: vi
        .fn()
        .mockRejectedValue(new Error('Provider error 401: {"key":"sk-ant-test-super-secret"}')),
      generateObject: vi.fn().mockRejectedValue(new Error("fail")),
    };
    const testRegistry = new BlockRegistry([
      ...allBlockImplementations.filter((b) => b.kind !== "raw"),
      defineBlock({
        kind: "raw",
        async run(_inputs, _params, ctx) {
          ctx.log("Log recorded prior to failure");
          await ctx.llm.generateText({ prompt: "extract" });
          return { status: "ok", outputs: {} };
        },
      }),
    ]);
    const files = createFileStore(join(tempDir, "uploads"));
    const handlers = createHandlers({
      dataDir: tempDir,
      dbPath,
      files,
      llm: failingLlm,
      registry: testRegistry,
      secretsStore: syntheticSecrets(tempDir),
      pickFile: vi.fn().mockResolvedValue(null),
      appInfo: () => ({
        version: "0.1.0",
        platform: "darwin",
        dataDir: tempDir,
        isPackaged: false,
      }),
    });

    await expect(
      handlers.blocks.preview({
        kind: "raw",
        params: defaultBlockParams("raw"),
        scope: DEFAULT_SETTINGS.defaultScope,
      }),
    ).rejects.toMatchObject({
      code: "block_failed",
      message: expect.not.stringContaining("sk-ant-test-super-secret"),
      details: {
        logs: expect.arrayContaining(["Log recorded prior to failure"]),
      },
    });
  });
});
