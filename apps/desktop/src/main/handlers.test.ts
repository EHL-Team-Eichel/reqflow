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
  type WorkflowRun,
} from "@reqflow/core";
import { fixtureRecords, fixtureSources } from "@reqflow/core/fixtures";
import { createFileStore } from "@reqflow/db";
import { BlockRegistry, defineBlock } from "@reqflow/engine";
import { createHandlers } from "./handlers";
import { SecretsStore } from "./secrets";

/** BMW's real export, present only locally in data/raw/ (gitignored). */
const BMW_FEEDBACK = join(import.meta.dirname, "../../../../data/raw/F70_feedback_hackathon.xlsx");

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
    const secretsStore = new SecretsStore(tempDir);
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
    while (run.status === "running" && Date.now() < deadline) {
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
      const file = await createFileStore(join(tempDir, "uploads")).importFile(BMW_FEEDBACK);
      const raw = createBlock("raw", { id: "raw", position: { x: 0, y: 0 } });
      const car = createBlock("add_to_car", { id: "car", position: { x: 300, y: 0 } });
      let graph = setBlockParams({ blocks: [raw, car], edges: [] }, "raw", {
        ...raw.params,
        dataset: "customer_feedback",
        file: { fileId: file.id, name: file.name },
      }).graph;
      graph = connect(graph, {
        source: "raw",
        sourcePort: "out",
        target: "car",
        targetPort: "in-0",
      });
      const workflow = await handlers.workflows.save({
        ...graph,
        name: "F70 feedback to car",
        scope: DEFAULT_SETTINGS.defaultScope,
      });
      const runOnce = async () => {
        const initial = await handlers.runs.start(workflow.id);
        let run = await handlers.runs.get(initial.id);
        const deadline = Date.now() + 30_000;
        while (run.status === "running" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          run = await handlers.runs.get(initial.id);
        }
        expect(run.error).toBeUndefined();
        expect(run.status).toBe("completed");
        return run;
      };

      const seeded = await handlers.requirements.list(); // the app seeds demo requirements
      await runOnce();
      const first = (await handlers.requirements.list()).filter(
        (r) => !seeded.some((x) => x.id === r.id),
      );
      expect(first.length).toBeGreaterThan(20);
      expect(first.every((r) => r.priority === "must" && r.status === "proposed")).toBe(true);
      // Numbering continues after the seeded ids instead of overwriting them.
      const seq = (id: string) => Number(id.split("-").at(-1));
      expect(Math.min(...first.map((r) => seq(r.id)))).toBe(
        Math.max(...seeded.map((r) => seq(r.id))) + 1,
      );
      const detail = await handlers.requirements.get(first[0]!.id);
      expect(detail.findings.length).toBeGreaterThan(0);
      expect(detail.records.length).toBeGreaterThan(0);
      expect(detail.sources.map((s) => s.kind)).toContain("customer_feedback");
      for (const f of detail.findings) {
        for (const e of f.evidence) {
          expect(detail.records.find((r) => r.id === e.recordId)?.text).toContain(e.excerpt);
        }
      }

      await runOnce();
      const all = await handlers.requirements.list();
      expect(all.length).toBe(seeded.length + 2 * first.length);
      expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
      expect((await handlers.requirements.get(first[0]!.id)).requirement).toEqual(
        detail.requirement,
      );
    },
    60_000,
  );

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
});
