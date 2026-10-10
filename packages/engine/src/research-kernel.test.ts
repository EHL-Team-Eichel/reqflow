import { describe, expect, it, vi } from "vitest";
import {
  connect,
  createBlock,
  DEFAULT_SETTINGS,
  emptyPipelineData,
  ResearchDataset,
  ResearchRequest,
  walkBlocks,
  WorkflowRun,
  type PaletteBlockKind,
  type PipelineData,
  type WorkflowBlock,
  type WorkflowGraph,
} from "@reqflow/core";
import { fixtureRecords, fixtureScope, fixtureSources } from "@reqflow/core/fixtures";
import { defineBlock, type BlockContext, type BlockImplementation } from "./block";
import { BlockRegistry } from "./registry";
import { executeWorkflow } from "./research-kernel";

const block = (kind: PaletteBlockKind, id: string = kind): WorkflowBlock =>
  createBlock(kind, { id, position: { x: 0, y: 0 } });
const graph = (...blocks: WorkflowBlock[]): WorkflowGraph => ({ blocks, edges: [] });
const wire = (
  g: WorkflowGraph,
  source: string,
  target: string,
  sourcePort = "out",
  targetPort = "in",
) => connect(g, { source, target, sourcePort, targetPort });
const data = (text = "Synthetic customer feedback"): PipelineData => ({
  ...emptyPipelineData(),
  sources: [fixtureSources[0]!],
  records: [{ ...fixtureRecords[0]!, text }],
});
const run = (g: WorkflowGraph): WorkflowRun => ({
  id: "run_executor",
  workflowId: "wf_executor",
  workflowVersion: 1,
  graph: g,
  scope: fixtureScope,
  status: "queued",
  startedBy: { type: "system", component: "test" },
  startedAt: "2026-10-10T00:00:00.000Z",
  blockRuns: [],
});
function context(signal = new AbortController().signal) {
  return (blockId: string): BlockContext => ({
    blockId,
    runId: "run_executor",
    scope: fixtureScope,
    settings: DEFAULT_SETTINGS,
    signal,
    resumed: false,
    web: null,
    log: vi.fn(),
    progress: vi.fn(),
    car: { add: vi.fn() },
    audit: { record: vi.fn() },
    files: { get: vi.fn() },
    llm: { generateObject: vi.fn(), generateText: vi.fn() },
    agents: { writer: vi.fn(), judge: vi.fn() },
  });
}
const source = defineBlock({
  kind: "raw",
  async run() {
    return { status: "ok", outputs: { out: data() } };
  },
});
const pass = defineBlock({
  kind: "ai_filter",
  async run(inputs) {
    return { status: "ok", outputs: { out: inputs.in! } };
  },
});
const sink = defineBlock({
  kind: "add_to_car",
  async run() {
    return { status: "ok", outputs: {} };
  },
});
const execute = (
  g: WorkflowGraph,
  impls: BlockImplementation[],
  extra: Partial<Parameters<typeof executeWorkflow>[0]> = {},
) =>
  executeWorkflow({
    run: run(g),
    registry: new BlockRegistry(impls),
    context: context(),
    onUpdate: vi.fn(),
    ...extra,
  });
const state = (r: WorkflowRun, id: string) => r.blockRuns.find((b) => b.blockId === id)!;

describe("executeWorkflow", () => {
  it("rejects invalid graphs before contexts or updates", async () => {
    const g = graph(block("raw"));
    g.edges.push({
      id: "bad",
      source: "raw",
      sourcePort: "missing",
      target: "absent",
      targetPort: "in",
    });
    const ctx = vi.fn(context());
    const onUpdate = vi.fn();
    await expect(execute(g, [source], { context: ctx, onUpdate })).rejects.toThrow(
      /Invalid workflow graph/,
    );
    expect(ctx).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("runs DAG order, merges in edge order, deduplicates, and fans out", async () => {
    const a = block("raw", "a"),
      b = block("raw", "b"),
      filter = block("ai_filter", "filter"),
      car = block("add_to_car", "car");
    let g = graph(car, filter, b, a);
    g = wire(
      wire(wire(wire(g, "a", "filter"), "b", "filter"), "filter", "car", "out", "in-0"),
      "filter",
      "car",
      "out",
      "in-1",
    );
    const order: string[] = [];
    const raw = defineBlock({
      kind: "raw",
      async run(_inputs, _params, ctx) {
        order.push(ctx.blockId);
        return { status: "ok", outputs: { out: data(ctx.blockId) } };
      },
    });
    const filterImpl = defineBlock({
      kind: "ai_filter",
      async run(inputs) {
        order.push("filter");
        expect(inputs.in!.records[0]!.text).toBe("b");
        return { status: "ok", outputs: { out: inputs.in! } };
      },
    });
    const carImpl = defineBlock({
      kind: "add_to_car",
      async run(inputs) {
        order.push("car");
        expect(inputs["in-0"]).toEqual(inputs["in-1"]);
        expect(inputs["in-2"]).toEqual(emptyPipelineData());
        return { status: "ok", outputs: {} };
      },
    });
    const result = await execute(g, [raw, filterImpl, carImpl]);
    expect(order.indexOf("filter")).toBeGreaterThan(order.indexOf("a"));
    expect(order.indexOf("filter")).toBeGreaterThan(order.indexOf("b"));
    expect(order.at(-1)).toBe("car");
    expect(result.run.status).toBe("completed");
    expect(state(result.run, "filter").counts.records).toBe(1);
    expect(result.outputs.car).toEqual({});
    expect(WorkflowRun.safeParse(result.run).success).toBe(true);
  });

  it("routes each splitter output to the correct input", async () => {
    const split = block("ai_splitter", "split");
    let g = wire(graph(block("raw"), split, block("add_to_car")), "raw", "split");
    g = wire(
      wire(g, "split", "add_to_car", "out-2", "in-0"),
      "split",
      "add_to_car",
      "out-0",
      "in-2",
    );
    const splitter = defineBlock({
      kind: "ai_splitter",
      async run() {
        return {
          status: "ok",
          outputs: { "out-0": data("first"), "out-1": emptyPipelineData(), "out-2": data("third") },
        };
      },
    });
    const car = defineBlock({
      kind: "add_to_car",
      async run(inputs) {
        expect(inputs["in-0"]!.records[0]!.text).toBe("third");
        expect(inputs["in-2"]!.records[0]!.text).toBe("first");
        return { status: "ok", outputs: {} };
      },
    });
    expect((await execute(g, [source, splitter, car])).run.status).toBe("completed");
  });

  it("keeps independent successful outputs when another branch fails", async () => {
    const g = wire(
      graph(block("raw", "bad"), block("ai_filter", "downstream"), block("research", "good")),
      "bad",
      "downstream",
    );
    const broken = defineBlock({
      kind: "raw",
      async run() {
        throw new Error("Synthetic upstream error");
      },
    });
    const research = defineBlock({
      kind: "research",
      async run() {
        return { status: "ok", outputs: { out: data("good") } };
      },
    });
    const result = await execute(g, [broken, research, pass]);
    expect(result.run.status).toBe("failed");
    expect(state(result.run, "bad").error).toContain("Synthetic upstream error");
    expect(state(result.run, "downstream").status).toBe("skipped");
    expect(result.outputs.good!.out!.records[0]!.text).toBe("good");
    expect(result.outputs.bad).toBeUndefined();
  });

  it("fails an unregistered builtin clearly without discarding another branch", async () => {
    const result = await execute(graph(block("research"), block("raw")), [source]);
    expect(result.run.status).toBe("failed");
    expect(state(result.run, "research").error).toMatch(/research.*no implementation/);
    expect(result.outputs.raw).toBeDefined();
  });

  it.each(["missing", "extra", "invalid"])("rejects %s output ports/envelopes", async (mode) => {
    const impl = defineBlock({
      kind: "raw",
      async run() {
        const outputs =
          mode === "missing"
            ? {}
            : mode === "extra"
              ? { out: data(), other: data() }
              : { out: { records: [] } };
        return { status: "ok", outputs } as Awaited<ReturnType<BlockImplementation["run"]>>;
      },
    });
    const result = await execute(graph(block("raw")), [impl]);
    expect(state(result.run, "raw").status).toBe("failed");
    expect(state(result.run, "raw").error).toMatch(/output/i);
    expect(result.outputs.raw).toBeUndefined();
  });

  it("uses builtin Research when inner workplace contains only untouched boundaries", async () => {
    const dataset = ResearchDataset.parse({
      schemaVersion: 1,
      runId: "run_executor",
      sources: [],
      records: [],
      results: [
        {
          agentId: "editorial_reviews",
          status: "empty",
          recordIds: [],
          limitations: [],
          requests: 1,
        },
      ],
      retrievedAt: "2026-10-10T00:00:00.000Z",
      synthetic: true,
    });
    const collect = vi.fn(async () => dataset);
    const research = defineBlock({
      kind: "research",
      async run(_inputs, _params, ctx) {
        const request = ResearchRequest.parse({
          agents: ["editorial_reviews"],
          scope: { questions: ["Synthetic comfort question"] },
        });
        const collected = await ctx.research!.collect(request, ctx);
        return {
          status: "ok",
          outputs: {
            out: { ...emptyPipelineData(), sources: collected.sources, records: collected.records },
          },
        };
      },
    });
    const base = context();
    const result = await execute(graph(block("research")), [research], {
      context: (id) => ({ ...base(id), research: { collect } }),
    });
    expect(collect).toHaveBeenCalledOnce();
    expect(result.run.status).toBe("completed");
    expect(state(result.run, "research--out").status).toBe("skipped");
  });

  it("overrides Research builtin with a nonempty inner graph and routes its output boundary", async () => {
    const research = block("research");
    research.inner = wire(
      { ...research.inner!, blocks: [...research.inner!.blocks, block("raw", "inside")] },
      "inside",
      "research--out",
    );
    const builtin = vi.fn();
    const result = await execute(graph(research), [
      source,
      defineBlock({ kind: "research", run: builtin }),
    ]);
    expect(builtin).not.toHaveBeenCalled();
    expect(result.outputs.research!.out).toEqual(data());
    expect(state(result.run, "research--out").status).toBe("succeeded");
  });

  it("routes parent input/output across nested custom workplaces without registry entries", async () => {
    const outer = block("custom", "outer"),
      inner = block("custom", "inner");
    inner.inner = wire(inner.inner!, "inner--in", "inner--out");
    outer.inner = wire(
      wire({ ...outer.inner!, blocks: [...outer.inner!.blocks, inner] }, "outer--in", "inner"),
      "inner",
      "outer--out",
    );
    const result = await execute(wire(graph(outer, block("raw")), "raw", "outer"), [source]);
    expect(result.run.status).toBe("completed");
    expect(result.outputs.outer!.out).toEqual(data());
    expect(result.outputs["inner--in"]!.out).toEqual(data());
  });

  it("treats an explicit boundary connection as a subflow override", async () => {
    const filter = block("ai_filter");
    filter.inner = wire(filter.inner!, "ai_filter--in", "ai_filter--out");
    const result = await execute(wire(graph(block("raw"), filter), "raw", "ai_filter"), [source]);
    expect(result.outputs.ai_filter!.out).toEqual(data());
  });

  it("pauses nested HIL, preserves independent work, resumes only paused HIL", async () => {
    const outer = block("custom", "outer"),
      inner = block("custom", "inner");
    inner.inner = wire(
      wire(
        { ...inner.inner!, blocks: [...inner.inner!.blocks, block("hil", "review")] },
        "inner--in",
        "review",
      ),
      "review",
      "inner--out",
    );
    outer.inner = wire(
      wire(
        { ...outer.inner!, blocks: [...outer.inner!.blocks, inner, block("raw", "independent")] },
        "outer--in",
        "inner",
      ),
      "inner",
      "outer--out",
    );
    const raw = vi.fn(source.run);
    const hil = vi.fn<BlockImplementation["run"]>(async (inputs, _params, ctx) =>
      ctx.resumed
        ? { status: "ok", outputs: { out: inputs.in! } }
        : { status: "paused", message: "Human review required" },
    );
    const registry = new BlockRegistry([
      defineBlock({ kind: "raw", run: raw }),
      defineBlock({ kind: "hil", run: hil }),
      sink,
    ]);
    const g = wire(
      wire(graph(block("raw"), outer, block("add_to_car")), "raw", "outer"),
      "outer",
      "add_to_car",
      "out",
      "in-0",
    );
    const paused = await executeWorkflow({
      run: run(g),
      registry,
      context: context(),
      onUpdate: vi.fn(),
    });
    expect(paused.run.status).toBe("waiting_for_review");
    for (const id of ["outer", "inner", "review"])
      expect(state(paused.run, id).status).toBe("waiting_for_review");
    expect(state(paused.run, "independent").status).toBe("succeeded");
    expect(state(paused.run, "add_to_car").status).toBe("pending");
    const resumed = await executeWorkflow({
      ...paused,
      registry,
      context: context(),
      onUpdate: vi.fn(),
    });
    expect(resumed.run.status).toBe("completed");
    expect(raw).toHaveBeenCalledTimes(2);
    expect(hil).toHaveBeenCalledTimes(2);
    expect(hil.mock.calls.map((args) => args[2].resumed)).toEqual([false, true]);
    expect(resumed.outputs.outer!.out).toEqual(data());
  });

  it("does not set resumed on a HIL reached for the first time after another HIL", async () => {
    const g = wire(
      wire(graph(block("raw"), block("hil", "first"), block("hil", "second")), "raw", "first"),
      "first",
      "second",
    );
    const visits: [string, boolean][] = [];
    const hil = defineBlock({
      kind: "hil",
      async run(inputs, _params, ctx) {
        visits.push([ctx.blockId, ctx.resumed]);
        return ctx.resumed
          ? { status: "ok", outputs: { out: inputs.in! } }
          : { status: "paused", message: "Review" };
      },
    });
    const registry = new BlockRegistry([source, hil]);
    const first = await executeWorkflow({
      run: run(g),
      registry,
      context: context(),
      onUpdate: vi.fn(),
    });
    const second = await executeWorkflow({
      ...first,
      registry,
      context: context(),
      onUpdate: vi.fn(),
    });
    expect(second.run.status).toBe("waiting_for_review");
    expect(visits).toEqual([
      ["first", false],
      ["first", true],
      ["second", false],
    ]);
    expect(
      (await executeWorkflow({ ...second, registry, context: context(), onUpdate: vi.fn() })).run
        .status,
    ).toBe("completed");
  });

  it("rejects resume without saved successful outputs", async () => {
    const hil = defineBlock({
      kind: "hil",
      async run() {
        return { status: "paused", message: "Review" };
      },
    });
    const registry = new BlockRegistry([source, hil]);
    const paused = await executeWorkflow({
      run: run(wire(graph(block("raw"), block("hil")), "raw", "hil")),
      registry,
      context: context(),
      onUpdate: vi.fn(),
    });
    await expect(
      executeWorkflow({ run: paused.run, registry, context: context(), onUpdate: vi.fn() }),
    ).rejects.toThrow(/stored outputs/i);
  });

  it("allows only HIL implementations to pause", async () => {
    const bad = defineBlock({
      kind: "raw",
      async run() {
        return { status: "paused", message: "No" };
      },
    });
    expect(state((await execute(graph(block("raw")), [bad])).run, "raw").error).toMatch(/Only HIL/);
  });

  it("cancels before start without invoking blocks", async () => {
    const controller = new AbortController();
    controller.abort();
    const raw = vi.fn(source.run);
    const result = await execute(graph(block("raw")), [defineBlock({ kind: "raw", run: raw })], {
      context: context(controller.signal),
    });
    expect(result.run.status).toBe("cancelled");
    expect(raw).not.toHaveBeenCalled();
    expect(state(result.run, "raw").status).toBe("skipped");
  });

  it("cancels a hanging implementation promptly and retains prior outputs", async () => {
    const controller = new AbortController();
    const hanging = defineBlock({
      kind: "hil",
      async run(_inputs, _params, ctx) {
        ctx.log("Started review");
        controller.abort();
        return new Promise(() => {});
      },
    });
    const result = await execute(
      wire(graph(block("raw"), block("hil")), "raw", "hil"),
      [source, hanging],
      { context: context(controller.signal) },
    );
    expect(result.run.status).toBe("cancelled");
    expect(result.outputs.raw!.out).toEqual(data());
    expect(result.outputs.hil).toBeUndefined();
    expect(
      result.run.blockRuns.every((b) => b.status !== "running" && b.status !== "pending"),
    ).toBe(true);
  });

  it("streams immutable ordered progress/log snapshots and awaits subscribers", async () => {
    const snapshots: WorkflowRun[] = [];
    const raw = defineBlock({
      kind: "raw",
      async run(_inputs, _params, ctx) {
        ctx.progress(0.4, "Collecting");
        ctx.log("Synthetic data only");
        return { status: "ok", outputs: { out: data() } };
      },
    });
    await execute(graph(block("raw")), [raw], {
      onUpdate: async (snapshot) => {
        await Promise.resolve();
        snapshots.push(snapshot);
      },
    });
    expect(snapshots[0]!.status).toBe("running");
    expect(snapshots.at(-1)!.status).toBe("completed");
    const progress = snapshots.find((snapshot) => state(snapshot, "raw").progress === 0.4)!;
    expect(state(progress, "raw").status).toBe("running");
    expect(state(progress, "raw").logs.some((log) => log.message === "Collecting")).toBe(true);
    expect(
      state(snapshots.at(-1)!, "raw").logs.some((log) => log.message === "Synthetic data only"),
    ).toBe(true);
  });

  it("surfaces snapshot persistence errors instead of silently completing", async () => {
    await expect(
      execute(graph(block("raw")), [source], {
        onUpdate: async () => {
          throw new Error("Snapshot write failed");
        },
      }),
    ).rejects.toThrow("Snapshot write failed");
  });

  it("preserves research provenance extensions while validating envelopes", async () => {
    const record = {
      ...data().records[0]!,
      metadata: { originalText: "Synthetic" },
      collectingAgents: ["editorial_reviews"],
    };
    const raw = defineBlock({
      kind: "raw",
      async run() {
        return { status: "ok", outputs: { out: { ...data(), records: [record] } } };
      },
    });
    const result = await execute(graph(block("raw")), [raw]);
    expect(result.outputs.raw!.out!.records[0]).toEqual(record);
  });

  it("isolates inputs so a failing block cannot corrupt successful upstream data", async () => {
    const bad = defineBlock({
      kind: "ai_filter",
      async run(inputs) {
        inputs.in!.records[0]!.text = "Corrupted by failing block";
        throw new Error("Synthetic failure");
      },
    });
    const result = await execute(
      wire(graph(block("raw"), block("ai_filter")), "raw", "ai_filter"),
      [source, bad],
    );
    expect(result.outputs.raw!.out).toEqual(data());
  });

  it("does not publish late logs or outputs from a cancelled implementation", async () => {
    const controller = new AbortController();
    let finish: () => void = () => {};
    const late = defineBlock({
      kind: "raw",
      async run(_inputs, _params, ctx) {
        await new Promise<void>((resolve) => {
          finish = resolve;
          controller.abort();
        });
        ctx.log("Late log");
        ctx.progress(1);
        return { status: "ok", outputs: { out: data() } };
      },
    });
    const onUpdate = vi.fn();
    const result = await execute(graph(block("raw")), [late], {
      context: context(controller.signal),
      onUpdate,
    });
    const count = onUpdate.mock.calls.length;
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(onUpdate).toHaveBeenCalledTimes(count);
    expect(result.outputs.raw).toBeUndefined();
    expect(state(result.run, "raw").logs.some((log) => log.message === "Late log")).toBe(false);
  });

  it("leaves no pending boundary statuses after a failed builtin", async () => {
    const result = await execute(graph(block("research")), []);
    expect([...walkBlocks(result.run.graph)].length).toBe(result.run.blockRuns.length);
    expect(result.run.blockRuns.some((b) => b.status === "pending")).toBe(false);
  });

  it("observes cancellation during the final awaited subscriber and preserves completed outputs", async () => {
    const controller = new AbortController();
    const snapshots: WorkflowRun[] = [];
    const result = await execute(graph(block("raw")), [source], {
      context: context(controller.signal),
      onUpdate: async (snapshot) => {
        snapshots.push(snapshot);
        if (snapshot.status === "completed") {
          await Promise.resolve();
          controller.abort();
        }
      },
    });
    expect(result.run.status).toBe("cancelled");
    expect(result.outputs.raw!.out).toEqual(data());
    expect(snapshots.at(-1)?.status).toBe("cancelled");
  });

  it("uses an explicit run signal to cancel empty workflows", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await execute(graph(), [], { signal: controller.signal });
    expect(result.run.status).toBe("cancelled");
    expect(result.outputs).toEqual({});
  });
});
