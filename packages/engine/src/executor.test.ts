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
import { defineBlock } from "./block";
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
        expect(inputs.in).toBe(envelope);
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
      expect(run.blockRuns.map((b) => b.blockId)).toEqual(["raw", "split"]);
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
    expect((await executor.getBlockOutput(run.id, "split"))!["out-1"]).toBe(envelope);
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
      onUpdate: (r) => updates.push(r),
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
          params: defaultBlockParams("ai_splitter"),
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

    expect(run.status).toBe("running");
    const cancelled = await executor.cancel(run.id);
    expect(cancelled.status).toBe("cancelled");
  });
});
