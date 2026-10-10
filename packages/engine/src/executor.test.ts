import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  connect,
  createBlock,
  defaultBlockParams,
  emptyPipelineData,
  setBlockParams,
  type AuditLogger,
  type FileStore,
  type LlmClient,
  type Workflow,
  type WorkflowRun,
} from "@reqflow/core";
import { defineBlock, type BlockImplementation } from "./block";
import { fixtureRecords, fixtureSources } from "@reqflow/core/fixtures";
import { WorkflowExecutor } from "./executor";
import { BlockRegistry } from "./registry";

const mockServices = () => {
  const audit: AuditLogger = {
    record: vi.fn(async (input) => ({
      id: "aud_test",
      at: new Date().toISOString(),
      ...input,
      changes: input.changes ?? [],
    })),
  };
  const llm: LlmClient = {
    generateObject: vi.fn(),
    generateText: vi.fn(),
  };
  const files: FileStore = { get: vi.fn() };
  const car = { add: vi.fn() };
  return { audit, llm, files, web: null, car };
};

describe("WorkflowExecutor (@reqflow/engine)", () => {
  const splitterWorkflow = (count: number): Workflow => {
    const raw = createBlock("raw", { id: "raw", position: { x: 0, y: 0 } });
    const split = createBlock("ai_splitter", { id: "split", position: { x: 300, y: 0 } });
    const graph = setBlockParams({ blocks: [raw, split], edges: [] }, "split", {
      ...split.params,
      splitBy: "category",
      branches: Array.from({ length: count }, (_, i) => `Branch ${i}`),
    }).graph;
    return {
      ...connect(graph, { source: "raw", sourcePort: "out", target: "split", targetPort: "in" }),
      id: "wf_split",
      version: 1,
      name: "Splitter integration",
      scope: DEFAULT_SETTINGS.defaultScope,
      createdAt: "2026-10-10T00:00:00Z",
      updatedAt: "2026-10-10T00:00:00Z",
    };
  };
  const actor = { type: "human" as const, userId: "pm", name: "PM" };

  it.each([2, 10])(
    "executes built-in splitter routing with %i unwired output boundaries",
    async (count) => {
      const envelope = emptyPipelineData();
      const splitRun = vi.fn(async (inputs) => {
        // Kernel isolation preserves values, not mutable envelope identity.
        expect(inputs.in).toStrictEqual(envelope);
        expect(inputs.in).not.toBe(envelope);
        return {
          status: "ok" as const,
          outputs: Object.fromEntries(
            Array.from({ length: count }, (_, i) => [
              `out-${i}`,
              i === count - 1 ? envelope : emptyPipelineData(),
            ]),
          ),
        };
      });
      const executor = new WorkflowExecutor({
        registry: new BlockRegistry([
          defineBlock({
            kind: "raw",
            async run() {
              return { status: "ok", outputs: { out: envelope } };
            },
          }),
          defineBlock({ kind: "ai_splitter", run: splitRun }),
        ]),
        services: mockServices(),
      });
      const run = await executor.execute(splitterWorkflow(count), actor, DEFAULT_SETTINGS);
      expect(run.status).toBe("completed");
      expect(splitRun).toHaveBeenCalledOnce();
      expect(Object.keys((await executor.getBlockOutput(run.id, "split"))!)).toHaveLength(count);
      expect(run.blockRuns.filter((b) => b.status !== "skipped").map((b) => b.blockId)).toEqual([
        "raw",
        "split",
      ]);
      // The common kernel also accounts for each unused boundary explicitly.
      expect(run.blockRuns.filter((b) => b.status === "skipped")).toHaveLength(count + 1);
      expect(run.blockRuns).toHaveLength(count + 3);
    },
  );

  it("executes authored splitter workplace routing and preserves it across a legacy upgrade", async () => {
    const workflow = splitterWorkflow(2);
    const split = workflow.blocks.find((b) => b.id === "split")!;
    split.inner = connect(split.inner!, {
      source: "split--in",
      sourcePort: "out",
      target: "split--out-1",
      targetPort: "in",
    });
    const envelope = emptyPipelineData();
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry([
        defineBlock({
          kind: "raw",
          async run() {
            return { status: "ok", outputs: { out: envelope } };
          },
        }),
      ]),
      services: mockServices(),
    });
    const run = await executor.execute(workflow, actor, DEFAULT_SETTINGS);
    expect(run.status).toBe("completed");
    const routed = (await executor.getBlockOutput(run.id, "split"))!["out-1"];
    expect(routed).toStrictEqual(envelope);
    expect(routed).not.toBe(envelope);
    expect(run.graph.blocks.find((b) => b.id === "split")!.inner).toEqual(split.inner);
    expect(run.blockRuns).toHaveLength(5);
    expect(run.blockRuns.every((b) => b.status === "succeeded")).toBe(true);
  });

  it("runs legacy splitters and fails clearly when their default implementation is missing", async () => {
    const workflow = splitterWorkflow(2);
    delete workflow.blocks.find((b) => b.id === "split")!.inner;
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry([
        defineBlock({
          kind: "raw",
          async run() {
            return { status: "ok", outputs: { out: emptyPipelineData() } };
          },
        }),
      ]),
      services: mockServices(),
    });
    expect(() => executor.validateBeforeRun(workflow)).toThrow(/no implementation.*ai_splitter/);
    expect(workflow.blocks.find((b) => b.id === "split")!.inner).toBeUndefined();
  });

  it("executes a workplace in topological order and streams updates", async () => {
    const registry = new BlockRegistry([
      defineBlock({
        kind: "raw",
        async run(_inputs, _params, ctx) {
          ctx.log("reading raw data");
          ctx.progress(0.5);
          return {
            status: "ok",
            outputs: {
              out: {
                ...emptyPipelineData(),
                sources: [
                  {
                    id: "src_1",
                    kind: "customer_feedback",
                    origin: "bmw_internal",
                    title: "Test Feed",
                    uri: "file_1",
                    retrievedAt: new Date().toISOString(),
                    reliability: "high",
                  },
                ],
              },
            },
          };
        },
      }),
      defineBlock({
        kind: "add_to_car",
        async run(inputs) {
          expect(inputs["in-0"]?.sources).toHaveLength(1);
          return { status: "ok", outputs: {} };
        },
      }),
    ]);

    const updates: WorkflowRun[] = [];
    const executor = new WorkflowExecutor({
      registry,
      services: mockServices(),
      onUpdate: (r) => {
        updates.push(r);
      },
    });

    const workflow: Workflow = {
      id: "wf_test",
      version: 1,
      name: "Topological",
      scope: DEFAULT_SETTINGS.defaultScope,
      blocks: [
        {
          id: "b_raw",
          kind: "raw",
          label: "Raw",
          position: { x: 0, y: 0 },
          params: defaultBlockParams("raw"),
        },
        {
          id: "b_car",
          kind: "add_to_car",
          label: "Car",
          position: { x: 200, y: 0 },
          params: defaultBlockParams("add_to_car"),
        },
      ],
      edges: [
        { id: "e1", source: "b_raw", sourcePort: "out", target: "b_car", targetPort: "in-0" },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const run = await executor.execute(
      workflow,
      { type: "human", userId: "u1", name: "Alice" },
      DEFAULT_SETTINGS,
    );

    expect(run.status).toBe("completed");
    expect(run.blockRuns.find((b) => b.blockId === "b_raw")?.status).toBe("succeeded");
    expect(run.blockRuns.find((b) => b.blockId === "b_car")?.status).toBe("succeeded");
    expect(updates.length).toBeGreaterThan(2);
  });

  it("handles multi-port merge on an input port", async () => {
    let callCount = 0;
    const registry = new BlockRegistry([
      defineBlock({
        kind: "raw",
        async run() {
          callCount++;
          return {
            status: "ok",
            outputs: {
              out: {
                ...emptyPipelineData(),
                sources: [
                  {
                    id: `src_${callCount}`,
                    kind: "customer_feedback",
                    origin: "bmw_internal",
                    title: `S${callCount}`,
                    uri: "file_1",
                    retrievedAt: new Date().toISOString(),
                    reliability: "high",
                  },
                ],
              },
            },
          };
        },
      }),
      defineBlock({
        kind: "add_to_car",
        async run(inputs) {
          expect(inputs["in-0"]?.sources).toHaveLength(2);
          return { status: "ok", outputs: {} };
        },
      }),
    ]);

    const executor = new WorkflowExecutor({
      registry,
      services: mockServices(),
    });

    const workflow: Workflow = {
      id: "wf_merge",
      version: 1,
      name: "Merge",
      scope: DEFAULT_SETTINGS.defaultScope,
      blocks: [
        {
          id: "r1",
          kind: "raw",
          label: "Raw 1",
          position: { x: 0, y: 0 },
          params: defaultBlockParams("raw"),
        },
        {
          id: "r2",
          kind: "raw",
          label: "Raw 2",
          position: { x: 0, y: 100 },
          params: defaultBlockParams("raw"),
        },
        {
          id: "c1",
          kind: "add_to_car",
          label: "Car",
          position: { x: 200, y: 50 },
          params: defaultBlockParams("add_to_car"),
        },
      ],
      edges: [
        { id: "e1", source: "r1", sourcePort: "out", target: "c1", targetPort: "in-0" },
        { id: "e2", source: "r2", sourcePort: "out", target: "c1", targetPort: "in-0" },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const run = await executor.execute(
      workflow,
      { type: "human", userId: "u1", name: "Alice" },
      DEFAULT_SETTINGS,
    );
    expect(run.status).toBe("completed");
  });

  it("handles splitter fan-out to multiple outputs", async () => {
    const registry = new BlockRegistry([
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
                    id: "src_1",
                    kind: "customer_feedback",
                    origin: "bmw_internal",
                    title: "S1",
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
      defineBlock({
        kind: "ai_splitter",
        async run(inputs) {
          return {
            status: "ok",
            outputs: {
              "out-0": inputs.in ?? emptyPipelineData(),
              "out-1": emptyPipelineData(),
            },
          };
        },
      }),
      defineBlock({
        kind: "add_to_car",
        async run() {
          return { status: "ok", outputs: {} };
        },
      }),
    ]);

    const executor = new WorkflowExecutor({
      registry,
      services: mockServices(),
    });

    const workflow: Workflow = {
      id: "wf_split",
      version: 1,
      name: "Splitter",
      scope: DEFAULT_SETTINGS.defaultScope,
      blocks: [
        {
          id: "raw",
          kind: "raw",
          label: "Raw",
          position: { x: 0, y: 0 },
          params: defaultBlockParams("raw"),
        },
        {
          id: "spl",
          kind: "ai_splitter",
          label: "Split",
          position: { x: 100, y: 0 },
          // Match the two outputs supplied by this synthetic implementation. The kernel validates ports.
          params: { ...defaultBlockParams("ai_splitter"), branches: ["Must have", "Should have"] },
        },
        {
          id: "car0",
          kind: "add_to_car",
          label: "Car0",
          position: { x: 200, y: 0 },
          params: defaultBlockParams("add_to_car"),
        },
        {
          id: "car1",
          kind: "add_to_car",
          label: "Car1",
          position: { x: 200, y: 100 },
          params: defaultBlockParams("add_to_car"),
        },
      ],
      edges: [
        { id: "e1", source: "raw", sourcePort: "out", target: "spl", targetPort: "in" },
        { id: "e2", source: "spl", sourcePort: "out-0", target: "car0", targetPort: "in-0" },
        { id: "e3", source: "spl", sourcePort: "out-1", target: "car1", targetPort: "in-0" },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const run = await executor.execute(
      workflow,
      { type: "human", userId: "u1", name: "Alice" },
      DEFAULT_SETTINGS,
    );
    expect(run.status).toBe("completed");
    expect(run.blockRuns.find((b) => b.blockId === "car0")?.status).toBe("succeeded");
    expect(run.blockRuns.find((b) => b.blockId === "car1")?.status).toBe("succeeded");
  });

  it("handles inner workplaces via boundary blocks", async () => {
    const registry = new BlockRegistry([
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
                    id: "src_sub",
                    kind: "customer_feedback",
                    origin: "bmw_internal",
                    title: "Sub",
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
      defineBlock({
        kind: "add_to_car",
        async run() {
          return { status: "ok", outputs: {} };
        },
      }),
    ]);

    const executor = new WorkflowExecutor({
      registry,
      services: mockServices(),
    });

    const workflow: Workflow = {
      id: "wf_custom",
      version: 1,
      name: "Custom Inner",
      scope: DEFAULT_SETTINGS.defaultScope,
      blocks: [
        {
          id: "custom_parent",
          kind: "custom",
          label: "Custom",
          position: { x: 0, y: 0 },
          params: defaultBlockParams("custom"),
          inner: {
            blocks: [
              {
                id: "b_in",
                kind: "block_input",
                label: "In",
                position: { x: 0, y: 0 },
                params: { port: "in" },
              },
              {
                id: "sub_raw",
                kind: "raw",
                label: "Inner Raw",
                position: { x: 100, y: 0 },
                params: defaultBlockParams("raw"),
              },
              {
                id: "b_out",
                kind: "block_output",
                label: "Out",
                position: { x: 200, y: 0 },
                params: { port: "out" },
              },
            ],
            edges: [
              {
                id: "ie1",
                source: "sub_raw",
                sourcePort: "out",
                target: "b_out",
                targetPort: "in",
              },
            ],
          },
        },
        {
          id: "car_out",
          kind: "add_to_car",
          label: "Car",
          position: { x: 200, y: 0 },
          params: defaultBlockParams("add_to_car"),
        },
      ],
      edges: [
        {
          id: "e1",
          source: "custom_parent",
          sourcePort: "out",
          target: "car_out",
          targetPort: "in-0",
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const run = await executor.execute(
      workflow,
      { type: "human", userId: "u1", name: "Alice" },
      DEFAULT_SETTINGS,
    );

    expect(run.status).toBe("completed");
    expect(run.blockRuns.find((b) => b.blockId === "sub_raw")?.status).toBe("succeeded");
    expect(run.blockRuns.find((b) => b.blockId === "custom_parent")?.status).toBe("succeeded");
  });

  it("handles block failure and marks downstream blocks skipped", async () => {
    const registry = new BlockRegistry([
      defineBlock({
        kind: "raw",
        async run() {
          throw new Error("Dataset read error");
        },
      }),
      defineBlock({
        kind: "add_to_car",
        async run() {
          return { status: "ok", outputs: {} };
        },
      }),
    ]);

    const executor = new WorkflowExecutor({
      registry,
      services: mockServices(),
    });

    const workflow: Workflow = {
      id: "wf_fail",
      version: 1,
      name: "Fail",
      scope: DEFAULT_SETTINGS.defaultScope,
      blocks: [
        {
          id: "r_fail",
          kind: "raw",
          label: "Raw",
          position: { x: 0, y: 0 },
          params: defaultBlockParams("raw"),
        },
        {
          id: "c_skip",
          kind: "add_to_car",
          label: "Car",
          position: { x: 100, y: 0 },
          params: defaultBlockParams("add_to_car"),
        },
      ],
      edges: [
        { id: "e1", source: "r_fail", sourcePort: "out", target: "c_skip", targetPort: "in-0" },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const run = await executor.execute(
      workflow,
      { type: "human", userId: "u1", name: "Alice" },
      DEFAULT_SETTINGS,
    );

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Dataset read error");
    expect(run.blockRuns.find((b) => b.blockId === "r_fail")?.status).toBe("failed");
    expect(run.blockRuns.find((b) => b.blockId === "c_skip")?.status).toBe("skipped");
  });

  it("handles pause at HIL block and resumes successfully", async () => {
    let hilRuns = 0;
    const registry = new BlockRegistry([
      defineBlock({
        kind: "raw",
        async run() {
          return { status: "ok", outputs: { out: emptyPipelineData() } };
        },
      }),
      defineBlock({
        kind: "hil",
        async run(inputs, _params, ctx) {
          hilRuns++;
          if (!ctx.resumed) {
            return { status: "paused", message: "Review required" };
          }
          return { status: "ok", outputs: { out: inputs.in ?? emptyPipelineData() } };
        },
      }),
      defineBlock({
        kind: "add_to_car",
        async run() {
          return { status: "ok", outputs: {} };
        },
      }),
    ]);

    const executor = new WorkflowExecutor({
      registry,
      services: mockServices(),
    });

    const workflow: Workflow = {
      id: "wf_hil",
      version: 1,
      name: "HIL Flow",
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
          id: "h1",
          kind: "hil",
          label: "HIL",
          position: { x: 100, y: 0 },
          params: defaultBlockParams("hil"),
        },
        {
          id: "c1",
          kind: "add_to_car",
          label: "Car",
          position: { x: 200, y: 0 },
          params: defaultBlockParams("add_to_car"),
        },
      ],
      edges: [
        { id: "e1", source: "r1", sourcePort: "out", target: "h1", targetPort: "in" },
        { id: "e2", source: "h1", sourcePort: "out", target: "c1", targetPort: "in-0" },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const initialRun = await executor.execute(
      workflow,
      { type: "human", userId: "u1", name: "Alice" },
      DEFAULT_SETTINGS,
    );

    expect(initialRun.status).toBe("waiting_for_review");
    expect(initialRun.blockRuns.find((b) => b.blockId === "h1")?.status).toBe("waiting_for_review");
    expect(initialRun.blockRuns.find((b) => b.blockId === "c1")?.status).toBe("pending");
    expect(hilRuns).toBe(1);

    const resumedRun = await executor.resume(initialRun.id);
    expect(resumedRun.status).toBe("completed");
    expect(resumedRun.blockRuns.find((b) => b.blockId === "h1")?.status).toBe("succeeded");
    expect(resumedRun.blockRuns.find((b) => b.blockId === "c1")?.status).toBe("succeeded");
    expect(hilRuns).toBe(2);
  });

  it("keeps a cancelled splitter run cancelled when the AI call rejects on abort", async () => {
    const services = mockServices();
    let latest: WorkflowRun | undefined;
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry([
        defineBlock({
          kind: "raw",
          async run() {
            return { status: "ok", outputs: { out: emptyPipelineData() } };
          },
        }),
        defineBlock({
          kind: "ai_splitter",
          async run(_inputs, _params, ctx) {
            await new Promise<never>((_resolve, reject) => {
              ctx.signal.addEventListener("abort", () => reject(new Error("Aborted")), {
                once: true,
              });
            });
            throw new Error("Unreachable");
          },
        }),
      ]),
      services,
      onUpdate: (update) => {
        latest = update;
      },
    });
    const run = await executor.start(
      splitterWorkflow(2),
      { type: "human", userId: "u1", name: "Alice" },
      DEFAULT_SETTINGS,
    );
    await vi.waitFor(() => {
      expect(latest?.blockRuns.find((block) => block.blockId === "split")?.status).toBe("running");
    });
    await executor.cancel(run.id);
    await vi.waitFor(() => {
      expect(latest?.blockRuns.find((block) => block.blockId === "split")?.status).toBe("skipped");
    });
    expect(latest?.status).toBe("cancelled");
    expect(latest?.error).toBeUndefined();
    expect(services.audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "run.failed" }),
    );
  });

  it("handles cancellation via cancel()", async () => {
    const registry = new BlockRegistry([
      defineBlock({
        kind: "raw",
        async run(_inputs, _params, ctx) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 500);
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            });
          });
          return { status: "ok", outputs: { out: emptyPipelineData() } };
        },
      }),
    ]);

    const executor = new WorkflowExecutor({
      registry,
      services: mockServices(),
    });

    const workflow: Workflow = {
      id: "wf_cancel",
      version: 1,
      name: "Cancel",
      scope: DEFAULT_SETTINGS.defaultScope,
      blocks: [
        {
          id: "r1",
          kind: "raw",
          label: "Raw",
          position: { x: 0, y: 0 },
          params: defaultBlockParams("raw"),
        },
      ],
      edges: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const run = await executor.start(
      workflow,
      { type: "human", userId: "u1", name: "Alice" },
      DEFAULT_SETTINGS,
    );

    // start returns the durable admission snapshot, before background execution.
    expect(run.status).toBe("queued");
    const cancelled = await executor.cancel(run.id);
    expect(cancelled.status).toBe("cancelled");
  });
});

// The wrapper owns admission and persistence; every execution path uses the same kernel.
describe("WorkflowExecutor persistence and admission", () => {
  const actor = { type: "system" as const, component: "test" };
  const workflow = (...blocks: ReturnType<typeof createBlock>[]): Workflow => ({
    id: "wf_persistence",
    name: "Synthetic persistence",
    version: 1,
    blocks,
    edges: [],
    scope: DEFAULT_SETTINGS.defaultScope,
    createdAt: "2026-10-10T00:00:00Z",
    updatedAt: "2026-10-10T00:00:00Z",
  });
  const block = (kind: Parameters<typeof createBlock>[0], id: string = kind) =>
    createBlock(kind, { id, position: { x: 0, y: 0 } });
  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };
  const raw = (
    run: BlockImplementation["run"] = vi.fn(async () => ({
      status: "ok" as const,
      outputs: { out: emptyPipelineData() },
    })),
  ) => defineBlock({ kind: "raw", run });

  it("awaits the queued snapshot before any block starts and returns without awaiting audit or execution", async () => {
    const save = gate();
    const audit = gate();
    const runBlock = vi.fn(async () => ({
      status: "ok" as const,
      outputs: { out: emptyPipelineData() },
    }));
    const services = mockServices();
    services.audit.record = vi.fn(async (input) => {
      await audit.promise;
      return { ...input, id: "aud_test", at: new Date().toISOString(), changes: [] };
    });
    const updates: WorkflowRun[] = [];
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry([raw(runBlock)]),
      services,
      onUpdate: async (update) => {
        updates.push(update);
        if (update.status === "queued") await save.promise;
      },
    });
    let returned = false;
    const starting = executor.start(workflow(block("raw")), actor, DEFAULT_SETTINGS).then((run) => {
      returned = true;
      return run;
    });
    await Promise.resolve();
    expect(updates[0]?.status).toBe("queued");
    expect(returned).toBe(false);
    expect(runBlock).not.toHaveBeenCalled();
    expect(services.audit.record).not.toHaveBeenCalled();
    save.release();
    const initial = await starting;
    expect(initial.status).toBe("queued");
    expect(initial.blockRuns[0]?.status).toBe("pending");
    expect(runBlock).not.toHaveBeenCalled();
    audit.release();
    await vi.waitFor(() => expect(updates.at(-1)?.status).toBe("completed"));
    expect(initial.status).toBe("queued");
  });

  it("saves outputs before awaited updates and never exposes an unsaved successful output", async () => {
    const save = gate();
    const events: string[] = [];
    const stored: Record<string, Record<string, import("@reqflow/core").PipelineData>> = {};
    let latest: WorkflowRun | undefined;
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry([raw()]),
      services: mockServices(),
      outputStore: {
        async saveBlockOutput(_runId, blockId, outputs) {
          events.push("saving");
          await save.promise;
          stored[blockId] = outputs;
          events.push("saved");
        },
        async getBlockOutput(_runId, blockId) {
          return stored[blockId] ?? null;
        },
      },
      onUpdate: async (update) => {
        latest = update;
        if (update.blockRuns[0]?.status === "succeeded") {
          expect(stored.raw).toEqual({ out: emptyPipelineData() });
          events.push("pushed");
        }
      },
    });
    const initial = await executor.start(workflow(block("raw")), actor, DEFAULT_SETTINGS);
    await vi.waitFor(() => expect(events).toContain("saving"));
    expect(latest?.blockRuns[0]?.status).toBe("running");
    expect(await executor.getBlockOutput(initial.id, "raw")).toBeNull();
    save.release();
    await vi.waitFor(() => expect(latest?.status).toBe("completed"));
    expect(events.slice(0, 3)).toEqual(["saving", "saved", "pushed"]);
    expect(await executor.getBlockOutput(initial.id, "raw")).toEqual(stored.raw);
  });

  it("reserves workflow admission synchronously while the initial save is still pending", async () => {
    const save = gate();
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry([raw()]),
      services: mockServices(),
      onUpdate: async (run) => {
        if (run.status === "queued") await save.promise;
      },
    });
    const first = executor.start(workflow(block("raw")), actor, DEFAULT_SETTINGS);
    await expect(executor.start(workflow(block("raw")), actor, DEFAULT_SETTINGS)).rejects.toThrow(
      /active|already/i,
    );
    await expect(executor.execute(workflow(block("raw")), actor, DEFAULT_SETTINGS)).rejects.toThrow(
      /active|already/i,
    );
    save.release();
    await first;
  });

  it("locks resume before awaiting persistence and never replays successful upstream blocks", async () => {
    const resuming = gate();
    let blockResume = false;
    const source = raw();
    const review = defineBlock({
      kind: "hil",
      async run(inputs, _params, ctx) {
        return ctx.resumed
          ? { status: "ok", outputs: { out: inputs.in! } }
          : { status: "paused", message: "Review" };
      },
    });
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry([source, review]),
      services: mockServices(),
      onUpdate: async (run) => {
        if (blockResume && run.status === "running") await resuming.promise;
      },
    });
    const graph = {
      ...workflow(),
      ...connect(workflow(block("raw"), block("hil")), {
        source: "raw",
        sourcePort: "out",
        target: "hil",
        targetPort: "in",
      }),
    };
    const paused = await executor.execute(graph, actor, DEFAULT_SETTINGS);
    expect(paused.status).toBe("waiting_for_review");
    blockResume = true;
    const first = executor.resume(paused.id);
    await expect(executor.resume(paused.id)).rejects.toThrow(/active|already|running/i);
    resuming.release();
    expect((await first).status).toBe("completed");
    expect(source.run).toHaveBeenCalledOnce();
  });

  it("restores a persisted nested review with original provenance and settings", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.defaultScope.market = "US";
    const evidence = {
      ...emptyPipelineData(),
      sources: [fixtureSources[0]!],
      records: [
        {
          ...fixtureRecords[0]!,
          metadata: { originalText: "Synthetic original" },
          collectingAgents: ["editorial_reviews"],
        },
      ],
    };
    const source = raw(vi.fn(async () => ({ status: "ok" as const, outputs: { out: evidence } })));
    const visits: boolean[] = [];
    const review = defineBlock({
      kind: "hil",
      async run(inputs, _params, ctx) {
        visits.push(ctx.resumed);
        expect(ctx.settings.defaultScope.market).toBe("US");
        return ctx.resumed
          ? { status: "ok", outputs: { out: inputs.in! } }
          : { status: "paused", message: "Review" };
      },
    });
    const outer = block("custom", "outer");
    outer.inner = connect(
      connect(
        { ...outer.inner!, blocks: [...outer.inner!.blocks, block("hil", "review")] },
        {
          source: "outer--in",
          sourcePort: "out",
          target: "review",
          targetPort: "in",
        },
      ),
      { source: "review", sourcePort: "out", target: "outer--out", targetPort: "in" },
    );
    const graph = {
      ...workflow(),
      ...connect(workflow(block("raw"), outer), {
        source: "raw",
        sourcePort: "out",
        target: "outer",
        targetPort: "in",
      }),
    };
    const registry = new BlockRegistry([source, review]);
    const first = new WorkflowExecutor({ registry, services: mockServices() });
    const paused = await first.execute(graph, actor, settings);
    const outputs = Object.fromEntries(
      await Promise.all(
        paused.blockRuns
          .filter((state) => state.status === "succeeded")
          .map(async (state) => [
            state.blockId,
            (await first.getBlockOutput(paused.id, state.blockId))!,
          ]),
      ),
    );
    const restored = new WorkflowExecutor({ registry, services: mockServices() });
    await restored.restore(paused, settings, outputs);
    settings.defaultScope.market = "CN";
    outputs.raw!.out!.records[0]!.text = "Corrupted caller-owned output";
    expect((await restored.resume(paused.id)).status).toBe("completed");
    expect((await restored.getBlockOutput(paused.id, "outer"))!.out).toStrictEqual(evidence);
    expect(visits).toEqual([false, true]);
    expect(source.run).toHaveBeenCalledOnce();
    await expect(restored.resume(paused.id)).rejects.toThrow(/completed/);
  });

  it("rejects malformed restore outputs before admitting the run", async () => {
    const source = raw();
    const review = defineBlock({
      kind: "hil",
      async run() {
        return { status: "paused", message: "Review" };
      },
    });
    const graph = {
      ...workflow(),
      ...connect(workflow(block("raw"), block("hil")), {
        source: "raw",
        sourcePort: "out",
        target: "hil",
        targetPort: "in",
      }),
    };
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry([source, review]),
      services: mockServices(),
    });
    const paused = await executor.execute(graph, actor, DEFAULT_SETTINGS);
    const restored = new WorkflowExecutor({
      registry: new BlockRegistry([source, review]),
      services: mockServices(),
    });
    expect(() => restored.restore(paused, DEFAULT_SETTINGS, {})).toThrow(/stored outputs/i);
    expect(() =>
      restored.restore(paused, DEFAULT_SETTINGS, { raw: { wrong: emptyPipelineData() } }),
    ).toThrow(/ports/i);
  });

  it("wires research per run and block and passes the full CarService without replacing evidence or nextSeq", async () => {
    const collector = { collect: vi.fn() };
    const services = {
      ...mockServices(),
      research: vi.fn(() => collector),
      car: { add: vi.fn(), nextSeq: vi.fn(async () => 23) },
    };
    const graph = workflow(block("research"));
    const research = defineBlock({
      kind: "research",
      async run(_inputs, _params, ctx) {
        expect(ctx.research).toBe(collector);
        expect(ctx.car).toBe(services.car);
        expect(await ctx.car.nextSeq!(ctx.scope)).toBe(23);
        await ctx.car.add([], { findings: [] });
        expect(ctx.scope.vehicleLine).toBe("1 Series");
        expect(ctx.scope.vehicleCode).toBe("F70");
        return { status: "ok", outputs: { out: emptyPipelineData() } };
      },
    });
    const executor = new WorkflowExecutor({ registry: new BlockRegistry([research]), services });
    const run = await executor.execute(graph, actor, DEFAULT_SETTINGS);
    expect(run.status).toBe("completed");
    expect(services.research).toHaveBeenCalledWith(run.id, "research", DEFAULT_SETTINGS);
    expect(services.car.add).toHaveBeenCalledWith([], { findings: [] });
  });

  it("surfaces awaited save failures and observes background failures without executing downstream work", async () => {
    const sink = vi.fn(async () => ({ status: "ok" as const, outputs: {} }));
    const updates: WorkflowRun[] = [];
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry([raw(), defineBlock({ kind: "add_to_car", run: sink })]),
      services: mockServices(),
      outputStore: {
        async saveBlockOutput() {
          throw new Error("Synthetic output save failure");
        },
        async getBlockOutput() {
          return null;
        },
      },
      onUpdate: async (run) => {
        updates.push(run);
      },
    });
    const graph = {
      ...workflow(),
      ...connect(workflow(block("raw"), block("add_to_car")), {
        source: "raw",
        sourcePort: "out",
        target: "add_to_car",
        targetPort: "in-0",
      }),
    };
    const initial = await executor.start(graph, actor, DEFAULT_SETTINGS);
    await vi.waitFor(() => expect(updates.at(-1)?.status).toBe("failed"));
    expect(updates.at(-1)?.error).toContain("Synthetic output save failure");
    expect(sink).not.toHaveBeenCalled();
    expect(await executor.getBlockOutput(initial.id, "raw")).toBeNull();
  });

  it("cancels while the queued save is pending without starting blocks or publishing later running states", async () => {
    const save = gate();
    const source = raw();
    const updates: WorkflowRun[] = [];
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry([source]),
      services: mockServices(),
      onUpdate: async (run) => {
        updates.push(run);
        if (run.status === "queued") await save.promise;
      },
    });
    const starting = executor.start(workflow(block("raw")), actor, DEFAULT_SETTINGS);
    await vi.waitFor(() => expect(updates[0]?.status).toBe("queued"));
    const cancelling = executor.cancel(updates[0]!.id);
    save.release();
    await starting;
    expect((await cancelling).status).toBe("cancelled");
    expect(source.run).not.toHaveBeenCalled();
    expect(updates.some((run) => run.status === "running")).toBe(false);
  });

  it.each(["succeeded", "completed", "waiting_for_review"])(
    "cancellation wins during awaited %s persistence",
    async (status) => {
      const save = gate();
      const reached = gate();
      const updates: WorkflowRun[] = [];
      const review = defineBlock({
        kind: "hil",
        async run() {
          return { status: "paused", message: "Review" };
        },
      });
      const executor = new WorkflowExecutor({
        registry: new BlockRegistry([raw(), review]),
        services: mockServices(),
        onUpdate: async (run) => {
          updates.push(run);
          if (
            (status === "succeeded" &&
              run.blockRuns[0]?.status === "succeeded" &&
              run.status === "running") ||
            run.status === status
          ) {
            reached.release();
            await save.promise;
          }
        },
      });
      const graph =
        status === "waiting_for_review"
          ? {
              ...workflow(),
              ...connect(workflow(block("raw"), block("hil")), {
                source: "raw",
                sourcePort: "out",
                target: "hil",
                targetPort: "in",
              }),
            }
          : workflow(block("raw"));
      const initial = await executor.start(graph, actor, DEFAULT_SETTINGS);
      await reached.promise;
      const cancelling = executor.cancel(initial.id);
      save.release();
      expect((await cancelling).status).toBe("cancelled");
      await vi.waitFor(() => expect(updates.at(-1)?.status).toBe("cancelled"));
      expect(await executor.getBlockOutput(initial.id, "raw")).toEqual({
        out: emptyPipelineData(),
      });
      expect(
        updates
          .at(-1)
          ?.blockRuns.some(
            (state) => state.status === "running" || state.status === "waiting_for_review",
          ),
      ).toBe(false);
    },
  );

  it("cancels an empty workflow before the queued save completes", async () => {
    const save = gate();
    const updates: WorkflowRun[] = [];
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry(),
      services: mockServices(),
      onUpdate: async (run) => {
        updates.push(run);
        if (run.status === "queued") await save.promise;
      },
    });
    const starting = executor.start(workflow(), actor, DEFAULT_SETTINGS);
    await vi.waitFor(() => expect(updates[0]?.status).toBe("queued"));
    await vi.waitFor(() => expect(updates[0]?.status).toBe("queued"));
    const cancelling = executor.cancel(updates[0]!.id);
    save.release();
    await starting;
    expect((await cancelling).status).toBe("cancelled");
    expect(updates.at(-1)?.status).toBe("cancelled");
  });

  it("surfaces queued persistence errors, releases admission, and never invokes blocks", async () => {
    const source = raw();
    const save = vi.fn<(run: WorkflowRun) => Promise<void>>(async () => {
      throw new Error("Synthetic queued write failure");
    });
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry([source]),
      services: mockServices(),
      onUpdate: save,
    });
    await expect(executor.start(workflow(block("raw")), actor, DEFAULT_SETTINGS)).rejects.toThrow(
      "Synthetic queued write failure",
    );
    expect(source.run).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed", error: "Synthetic queued write failure" }),
      ),
    );
    save.mockImplementation(async () => {});
    await vi.waitFor(async () =>
      expect((await executor.execute(workflow(block("raw")), actor, DEFAULT_SETTINGS)).status).toBe(
        "completed",
      ),
    );
  });

  it("preserves successful independent branches across a failed branch and persisted HIL review", async () => {
    const failing = raw(
      vi.fn(async () => {
        throw new Error("Synthetic branch failure");
      }),
    );
    const research = defineBlock({
      kind: "research",
      async run() {
        return { status: "ok", outputs: { out: emptyPipelineData() } };
      },
    });
    const review = defineBlock({
      kind: "hil",
      async run(inputs, _params, ctx) {
        return ctx.resumed
          ? { status: "ok", outputs: { out: inputs.in! } }
          : { status: "paused", message: "Review" };
      },
    });
    const graph = {
      ...workflow(),
      ...connect(workflow(block("raw"), block("research"), block("hil")), {
        source: "research",
        sourcePort: "out",
        target: "hil",
        targetPort: "in",
      }),
    };
    const registry = new BlockRegistry([failing, research, review]);
    const executor = new WorkflowExecutor({ registry, services: mockServices() });
    const paused = await executor.execute(graph, actor, DEFAULT_SETTINGS);
    expect(paused.status).toBe("waiting_for_review");
    expect(paused.error).toContain("Synthetic branch failure");
    const outputs = { research: (await executor.getBlockOutput(paused.id, "research"))! };
    const restored = new WorkflowExecutor({ registry, services: mockServices() });
    restored.restore(paused, DEFAULT_SETTINGS, outputs);
    const finished = await restored.resume(paused.id);
    expect(finished.status).toBe("failed");
    expect(finished.blockRuns.find((state) => state.blockId === "hil")?.status).toBe("succeeded");
    expect(await restored.getBlockOutput(paused.id, "research")).toEqual(outputs.research);
    expect(failing.run).toHaveBeenCalledOnce();
  });

  it("cancellation also wins while the final lifecycle audit is being persisted", async () => {
    const auditing = gate();
    const reached = gate();
    const services = mockServices();
    services.audit.record = vi.fn(async (input) => {
      if (input.action === "run.completed") {
        reached.release();
        await auditing.promise;
      }
      return { ...input, id: "aud_test", at: new Date().toISOString(), changes: [] };
    });
    const updates: WorkflowRun[] = [];
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry([raw()]),
      services,
      onUpdate: (run) => {
        updates.push(run);
      },
    });
    const initial = await executor.start(workflow(block("raw")), actor, DEFAULT_SETTINGS);
    await reached.promise;
    const cancelling = executor.cancel(initial.id);
    auditing.release();
    expect((await cancelling).status).toBe("cancelled");
    expect(updates.at(-1)?.status).toBe("cancelled");
    expect(services.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "run.cancelled" }),
    );
  });

  it("awaits an in-flight output save on cancellation and retains only durable partial results", async () => {
    const saving = gate();
    const reached = gate();
    const downstream = vi.fn(async () => ({ status: "ok" as const, outputs: {} }));
    const updates: WorkflowRun[] = [];
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry([raw(), defineBlock({ kind: "add_to_car", run: downstream })]),
      services: mockServices(),
      outputStore: {
        async saveBlockOutput() {
          reached.release();
          await saving.promise;
        },
        async getBlockOutput() {
          return null;
        },
      },
      onUpdate: (run) => {
        updates.push(run);
      },
    });
    const graph = {
      ...workflow(),
      ...connect(workflow(block("raw"), block("add_to_car")), {
        source: "raw",
        sourcePort: "out",
        target: "add_to_car",
        targetPort: "in-0",
      }),
    };
    const initial = await executor.start(graph, actor, DEFAULT_SETTINGS);
    await reached.promise;
    let returned = false;
    const cancelling = executor.cancel(initial.id).then((run) => {
      returned = true;
      return run;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(await executor.getBlockOutput(initial.id, "raw")).toBeNull();
    saving.release();
    expect((await cancelling).status).toBe("cancelled");
    expect(await executor.getBlockOutput(initial.id, "raw")).toEqual({ out: emptyPipelineData() });
    expect(downstream).not.toHaveBeenCalled();
    expect(updates.at(-1)?.blockRuns.find((state) => state.blockId === "add_to_car")?.status).toBe(
      "skipped",
    );
  });

  it("supports cancellation invoked synchronously by a queued subscriber without overwriting its operation", async () => {
    const source = raw();
    let cancelling: Promise<WorkflowRun> | undefined;
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry([source]),
      services: mockServices(),
      onUpdate: (run) => {
        if (run.status === "queued") cancelling = executor.cancel(run.id);
      },
    });
    await executor.start(workflow(block("raw")), actor, DEFAULT_SETTINGS);
    expect((await cancelling)!.status).toBe("cancelled");
    expect(source.run).not.toHaveBeenCalled();
  });

  it("rejects snapshot persistence failures from execute instead of treating them as block errors", async () => {
    const updates: WorkflowRun[] = [];
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry([raw()]),
      services: mockServices(),
      onUpdate: async (run) => {
        updates.push(run);
        if (run.status === "running") throw new Error("Synthetic snapshot save failure");
      },
    });
    await expect(executor.execute(workflow(block("raw")), actor, DEFAULT_SETTINGS)).rejects.toThrow(
      "Synthetic snapshot save failure",
    );
    expect(updates.at(-1)?.status).toBe("failed");
    expect(updates.at(-1)?.error).toBe("Synthetic snapshot save failure");
  });

  it("cancels a parked nested review through the kernel without replaying blocks or recording a resume", async () => {
    const services = mockServices();
    const source = raw();
    const review = defineBlock({
      kind: "hil",
      run: vi.fn(async () => ({ status: "paused" as const, message: "Review" })),
    });
    const outer = block("custom", "outer");
    outer.inner = connect(
      connect(
        { ...outer.inner!, blocks: [...outer.inner!.blocks, block("hil", "review")] },
        {
          source: "outer--in",
          sourcePort: "out",
          target: "review",
          targetPort: "in",
        },
      ),
      { source: "review", sourcePort: "out", target: "outer--out", targetPort: "in" },
    );
    const graph = {
      ...workflow(),
      ...connect(workflow(block("raw"), outer), {
        source: "raw",
        sourcePort: "out",
        target: "outer",
        targetPort: "in",
      }),
    };
    const executor = new WorkflowExecutor({
      registry: new BlockRegistry([source, review]),
      services,
    });
    const paused = await executor.execute(graph, actor, DEFAULT_SETTINGS);
    const cancelled = await executor.cancel(paused.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.blockRuns.find((state) => state.blockId === "raw")?.status).toBe("succeeded");
    expect(
      cancelled.blockRuns
        .filter((state) => ["outer", "review", "outer--out"].includes(state.blockId))
        .every((state) => state.status === "skipped"),
    ).toBe(true);
    expect(source.run).toHaveBeenCalledOnce();
    expect(review.run).toHaveBeenCalledOnce();
    expect(services.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "run.cancelled" }),
    );
    expect(services.audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "run.resumed" }),
    );
  });
});
