import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  connect,
  createBlock,
  emptyPipelineData,
  type AuditLogger,
  type FileStore,
  type FilterOverride,
  type FilterReport,
  type LlmClient,
  type PipelineData,
  type Workflow,
} from "@reqflow/core";
import { defineBlock } from "./block";
import { WorkflowExecutor } from "./executor";
import { BlockRegistry } from "./registry";

const mockServices = (overrides?: {
  filterOverrides?: (workflowId: string, blockId: string) => Promise<FilterOverride[]>;
}) => {
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
  return {
    audit,
    llm,
    files,
    web: null,
    car,
    filterOverrides: overrides?.filterOverrides,
  };
};

describe("Filter Engine & Report Validation (@reqflow/engine)", () => {
  const sampleInputData: PipelineData = {
    ...emptyPipelineData(),
    records: [
      {
        id: "rec_1",
        sourceId: "src_1",
        text: "Battery range feedback",
        fields: {},
      },
      {
        id: "rec_2",
        sourceId: "src_1",
        text: "Seat comfort feedback",
        fields: {},
      },
    ],
  };

  const createFilterWorkflow = (): Workflow => {
    const raw = createBlock("raw", { id: "raw", position: { x: 0, y: 0 } });
    const filter = createBlock("ai_filter", { id: "filter", position: { x: 300, y: 0 } });
    const graph = { blocks: [raw, filter], edges: [] };
    return {
      ...connect(graph, { source: "raw", sourcePort: "out", target: "filter", targetPort: "in" }),
      id: "wf_filter_test",
      version: 1,
      name: "Filter Test",
      scope: {
        vehicleLine: "1 Series",
        vehicleCode: "F70",
        market: "EU",
        horizonYears: 4,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  };

  const makeReport = (
    runId: string,
    blockId: string,
    input: PipelineData,
    decisions: FilterReport["decisions"],
  ): FilterReport => ({
    schemaVersion: 1,
    runId,
    blockId,
    createdAt: new Date().toISOString(),
    primaryLayer: "records",
    configurationHash: "1111111111111111111111111111111111111111111111111111111111111111",
    configuration: {
      criterion: "Relevant",
      include: "",
      exclude: "",
      examples: "",
      fields: [],
      model: "fast",
      minConfidence: 0.7,
      keepUnsure: false,
    },
    originalInput: input,
    decisions,
    warnings: [],
  });

  it("succeeds with valid report and attaches filterReport to blockRun", async () => {
    const registry = new BlockRegistry();
    registry.register(
      defineBlock({
        kind: "raw",
        run: async () => ({ status: "ok", outputs: { out: sampleInputData } }),
      }),
    );

    let observedRunId = "";
    registry.register(
      defineBlock({
        kind: "ai_filter",
        run: async (inputs, _params, ctx) => {
          observedRunId = ctx.runId;
          const report = makeReport(ctx.runId, ctx.blockId, inputs.in!, [
            {
              itemId: "rec_1",
              itemHash: "1111111111111111111111111111111111111111111111111111111111111111",
              modelDecision: "keep",
              outcome: "keep",
              confidence: 0.9,
              reason: "Battery range relevant",
              quotes: [{ recordId: "rec_1", excerpt: "Battery range" }],
              model: "fast",
              forwarded: true,
              retainedAsContext: false,
            },
            {
              itemId: "rec_2",
              itemHash: "2222222222222222222222222222222222222222222222222222222222222222",
              modelDecision: "exclude",
              outcome: "exclude",
              confidence: 0.8,
              reason: "Comfort not prioritized",
              quotes: [{ recordId: "rec_2", excerpt: "Seat comfort" }],
              model: "fast",
              forwarded: false,
              retainedAsContext: false,
            },
          ]);

          const forwardedOutput: PipelineData = {
            ...emptyPipelineData(),
            records: [sampleInputData.records[0]!],
          };
          return {
            status: "ok",
            outputs: { out: forwardedOutput },
            filterReport: report,
          };
        },
      }),
    );

    const executor = new WorkflowExecutor({
      registry,
      services: mockServices(),
    });

    const run = await executor.execute(
      createFilterWorkflow(),
      { type: "human", userId: "u1", name: "User" },
      DEFAULT_SETTINGS,
    );

    expect(run.status).toBe("completed");
    const filterBlockRun = run.blockRuns.find((b) => b.blockId === "filter");
    expect(filterBlockRun).toBeDefined();
    expect(filterBlockRun!.status).toBe("succeeded");
    expect(filterBlockRun!.filterReport).toBeDefined();
    expect(filterBlockRun!.filterReport!.runId).toBe(observedRunId);
    expect(filterBlockRun!.filterReport!.decisions.length).toBe(2);
  });

  it("rejects filterReport on non-ai_filter block kind", async () => {
    const registry = new BlockRegistry();
    registry.register(
      defineBlock({
        kind: "raw",
        run: async (_inputs, _params, ctx) => {
          const report = makeReport(ctx.runId, ctx.blockId, sampleInputData, []);
          return {
            status: "ok",
            outputs: { out: sampleInputData },
            filterReport: report,
          };
        },
      }),
    );
    registry.register(
      defineBlock({
        kind: "ai_filter",
        run: async () => ({ status: "ok", outputs: { out: emptyPipelineData() } }),
      }),
    );

    const executor = new WorkflowExecutor({
      registry,
      services: mockServices(),
    });

    const run = await executor.execute(
      createFilterWorkflow(),
      { type: "human", userId: "u1", name: "User" },
      DEFAULT_SETTINGS,
    );

    expect(run.status).toBe("failed");
    const rawBlockRun = run.blockRuns.find((b) => b.blockId === "raw");
    expect(rawBlockRun!.status).toBe("failed");
    expect(rawBlockRun!.error).toContain("Filter report is only valid for ai_filter blocks");
  });

  it("rejects report with mismatched runId or blockId", async () => {
    const registry = new BlockRegistry();
    registry.register(
      defineBlock({
        kind: "raw",
        run: async () => ({ status: "ok", outputs: { out: sampleInputData } }),
      }),
    );
    registry.register(
      defineBlock({
        kind: "ai_filter",
        run: async (inputs, _params, ctx) => {
          const report = makeReport("run_wrong_id", ctx.blockId, inputs.in!, []);
          return {
            status: "ok",
            outputs: { out: emptyPipelineData() },
            filterReport: report,
          };
        },
      }),
    );

    const executor = new WorkflowExecutor({
      registry,
      services: mockServices(),
    });

    const run = await executor.execute(
      createFilterWorkflow(),
      { type: "human", userId: "u1", name: "User" },
      DEFAULT_SETTINGS,
    );

    expect(run.status).toBe("failed");
    const filterBlockRun = run.blockRuns.find((b) => b.blockId === "filter");
    expect(filterBlockRun!.status).toBe("failed");
    expect(filterBlockRun!.error).toContain("does not match the executing block/run");
  });

  it("rejects report with modified originalInput", async () => {
    const registry = new BlockRegistry();
    registry.register(
      defineBlock({
        kind: "raw",
        run: async () => ({ status: "ok", outputs: { out: sampleInputData } }),
      }),
    );
    registry.register(
      defineBlock({
        kind: "ai_filter",
        run: async (_inputs, _params, ctx) => {
          const alteredInput: PipelineData = {
            ...sampleInputData,
            records: [sampleInputData.records[0]!], // Dropped record 2
          };
          const report = makeReport(ctx.runId, ctx.blockId, alteredInput, [
            {
              itemId: "rec_1",
              itemHash: "1111111111111111111111111111111111111111111111111111111111111111",
              modelDecision: "keep",
              outcome: "keep",
              confidence: 0.9,
              reason: "Reason",
              quotes: [{ recordId: "rec_1", excerpt: "text" }],
              model: "fast",
              forwarded: true,
              retainedAsContext: false,
            },
          ]);
          return {
            status: "ok",
            outputs: { out: alteredInput },
            filterReport: report,
          };
        },
      }),
    );

    const executor = new WorkflowExecutor({
      registry,
      services: mockServices(),
    });

    const run = await executor.execute(
      createFilterWorkflow(),
      { type: "human", userId: "u1", name: "User" },
      DEFAULT_SETTINGS,
    );

    expect(run.status).toBe("failed");
    const filterBlockRun = run.blockRuns.find((b) => b.blockId === "filter");
    expect(filterBlockRun!.status).toBe("failed");
    expect(filterBlockRun!.error).toContain(
      "Filter report originalInput must equal unmodified merged block input",
    );
  });

  it("rejects incomplete or duplicate primary-layer coverage", async () => {
    const registry = new BlockRegistry();
    registry.register(
      defineBlock({
        kind: "raw",
        run: async () => ({ status: "ok", outputs: { out: sampleInputData } }),
      }),
    );
    registry.register(
      defineBlock({
        kind: "ai_filter",
        run: async (inputs, _params, ctx) => {
          // Incomplete coverage: 2 inputs, but only 1 decision
          const report = makeReport(ctx.runId, ctx.blockId, inputs.in!, [
            {
              itemId: "rec_1",
              itemHash: "1111111111111111111111111111111111111111111111111111111111111111",
              modelDecision: "keep",
              outcome: "keep",
              confidence: 0.9,
              reason: "Reason",
              quotes: [{ recordId: "rec_1", excerpt: "text" }],
              model: "fast",
              forwarded: true,
              retainedAsContext: false,
            },
          ]);
          return {
            status: "ok",
            outputs: { out: { ...emptyPipelineData(), records: [sampleInputData.records[0]!] } },
            filterReport: report,
          };
        },
      }),
    );

    const executor = new WorkflowExecutor({
      registry,
      services: mockServices(),
    });

    const run = await executor.execute(
      createFilterWorkflow(),
      { type: "human", userId: "u1", name: "User" },
      DEFAULT_SETTINGS,
    );

    expect(run.status).toBe("failed");
    const filterBlockRun = run.blockRuns.find((b) => b.blockId === "filter");
    expect(filterBlockRun!.status).toBe("failed");
    expect(filterBlockRun!.error).toContain(
      "Filter report decisions do not match the items to classify",
    );
  });

  it("rejects forwarded outputs mismatching decisions", async () => {
    const registry = new BlockRegistry();
    registry.register(
      defineBlock({
        kind: "raw",
        run: async () => ({ status: "ok", outputs: { out: sampleInputData } }),
      }),
    );
    registry.register(
      defineBlock({
        kind: "ai_filter",
        run: async (inputs, _params, ctx) => {
          const report = makeReport(ctx.runId, ctx.blockId, inputs.in!, [
            {
              itemId: "rec_1",
              itemHash: "1111111111111111111111111111111111111111111111111111111111111111",
              modelDecision: "keep",
              outcome: "keep",
              confidence: 0.9,
              reason: "Keep 1",
              quotes: [{ recordId: "rec_1", excerpt: "text" }],
              model: "fast",
              forwarded: true,
              retainedAsContext: false,
            },
            {
              itemId: "rec_2",
              itemHash: "2222222222222222222222222222222222222222222222222222222222222222",
              modelDecision: "exclude",
              outcome: "exclude",
              confidence: 0.9,
              reason: "Exclude 2",
              quotes: [{ recordId: "rec_2", excerpt: "text" }],
              model: "fast",
              forwarded: false,
              retainedAsContext: false,
            },
          ]);
          // Mismatch: output forwarded rec_2 instead of rec_1
          const mismatchedOutput: PipelineData = {
            ...emptyPipelineData(),
            records: [sampleInputData.records[1]!],
          };
          return {
            status: "ok",
            outputs: { out: mismatchedOutput },
            filterReport: report,
          };
        },
      }),
    );

    const executor = new WorkflowExecutor({
      registry,
      services: mockServices(),
    });

    const run = await executor.execute(
      createFilterWorkflow(),
      { type: "human", userId: "u1", name: "User" },
      DEFAULT_SETTINGS,
    );

    expect(run.status).toBe("failed");
    const filterBlockRun = run.blockRuns.find((b) => b.blockId === "filter");
    expect(filterBlockRun!.status).toBe("failed");
    expect(filterBlockRun!.error).toContain(
      'Forwarded decision for item "rec_1" is missing from output',
    );
  });

  it("permits unforwarded context items to remain without error", async () => {
    const inputWithContext: PipelineData = {
      ...sampleInputData,
      sources: [
        {
          id: "src_1",
          title: "Source 1",
          kind: "other_internal",
          origin: "bmw_internal",
          reliability: "high",
          retrievedAt: new Date().toISOString(),
        },
      ],
    };

    const registry = new BlockRegistry();
    registry.register(
      defineBlock({
        kind: "raw",
        run: async () => ({ status: "ok", outputs: { out: inputWithContext } }),
      }),
    );
    registry.register(
      defineBlock({
        kind: "ai_filter",
        run: async (inputs, _params, ctx) => {
          const report = makeReport(ctx.runId, ctx.blockId, inputs.in!, [
            {
              itemId: "rec_1",
              itemHash: "1111111111111111111111111111111111111111111111111111111111111111",
              modelDecision: "keep",
              outcome: "keep",
              confidence: 0.9,
              reason: "Keep 1",
              quotes: [{ recordId: "rec_1", excerpt: "text" }],
              model: "fast",
              forwarded: true,
              retainedAsContext: false,
            },
            {
              itemId: "rec_2",
              itemHash: "2222222222222222222222222222222222222222222222222222222222222222",
              modelDecision: "exclude",
              outcome: "exclude",
              confidence: 0.9,
              reason: "Exclude 2",
              quotes: [{ recordId: "rec_2", excerpt: "text" }],
              model: "fast",
              forwarded: false,
              retainedAsContext: false,
            },
          ]);
          // Sources kept as context, primary layer only forwards rec_1
          const outputWithContext: PipelineData = {
            ...emptyPipelineData(),
            sources: inputWithContext.sources,
            records: [inputWithContext.records[0]!],
          };
          return {
            status: "ok",
            outputs: { out: outputWithContext },
            filterReport: report,
          };
        },
      }),
    );

    const executor = new WorkflowExecutor({
      registry,
      services: mockServices(),
    });

    const run = await executor.execute(
      createFilterWorkflow(),
      { type: "human", userId: "u1", name: "User" },
      DEFAULT_SETTINGS,
    );

    expect(run.status).toBe("completed");
    const filterBlockRun = run.blockRuns.find((b) => b.blockId === "filter");
    expect(filterBlockRun!.status).toBe("succeeded");
  });

  it("permits absent filterReport for fake-block testing", async () => {
    const registry = new BlockRegistry();
    registry.register(
      defineBlock({
        kind: "raw",
        run: async () => ({ status: "ok", outputs: { out: sampleInputData } }),
      }),
    );
    registry.register(
      defineBlock({
        kind: "ai_filter",
        run: async () => ({
          status: "ok",
          outputs: { out: sampleInputData },
        }),
      }),
    );

    const executor = new WorkflowExecutor({
      registry,
      services: mockServices(),
    });

    const run = await executor.execute(
      createFilterWorkflow(),
      { type: "human", userId: "u1", name: "User" },
      DEFAULT_SETTINGS,
    );

    expect(run.status).toBe("completed");
    const filterBlockRun = run.blockRuns.find((b) => b.blockId === "filter");
    expect(filterBlockRun!.status).toBe("succeeded");
    expect(filterBlockRun!.filterReport).toBeUndefined();
  });

  it("provides filterOverrides callback that snapshots service returns and returns [] when absent", async () => {
    const registry = new BlockRegistry();
    registry.register(
      defineBlock({
        kind: "raw",
        run: async () => ({ status: "ok", outputs: { out: sampleInputData } }),
      }),
    );

    let receivedOverrides: FilterOverride[] | undefined;
    registry.register(
      defineBlock({
        kind: "ai_filter",
        run: async (_inputs, _params, ctx) => {
          receivedOverrides = await ctx.filterOverrides?.();
          return {
            status: "ok",
            outputs: { out: emptyPipelineData() },
          };
        },
      }),
    );

    // 1. Absent service returns []
    const executorNoOverrides = new WorkflowExecutor({
      registry,
      services: mockServices(),
    });
    await executorNoOverrides.execute(
      createFilterWorkflow(),
      { type: "human", userId: "u1", name: "User" },
      DEFAULT_SETTINGS,
    );
    expect(receivedOverrides).toEqual([]);

    // 2. Wired service returns structured clone
    const storedOverrides: FilterOverride[] = [
      {
        itemId: "rec_2",
        itemHash: "2222222222222222222222222222222222222222222222222222222222222222",
        configurationHash: "1111111111111111111111111111111111111111111111111111111111111111",
        actor: { type: "human", userId: "u1", name: "User" },
        at: new Date().toISOString(),
        rationale: "Restore",
        version: 1,
      },
    ];

    const executorWithOverrides = new WorkflowExecutor({
      registry,
      services: mockServices({
        filterOverrides: async () => storedOverrides,
      }),
    });
    await executorWithOverrides.execute(
      createFilterWorkflow(),
      { type: "human", userId: "u1", name: "User" },
      DEFAULT_SETTINGS,
    );
    expect(receivedOverrides).toEqual(storedOverrides);
    // Verify snapshot (not the same object reference)
    expect(receivedOverrides).not.toBe(storedOverrides);
  });

  it.each([
    "schema",
    "blockId",
    "duplicate",
    "unknown",
    "extraOutput",
    "rewrittenOutput",
    "mutatedInput",
  ])("rejects malformed report: %s", async (fault) => {
    const registry = new BlockRegistry();
    registry.register(
      defineBlock({
        kind: "raw",
        run: async () => ({ status: "ok", outputs: { out: sampleInputData } }),
      }),
    );
    registry.register(
      defineBlock({
        kind: "ai_filter",
        run: async (inputs, _params, ctx) => {
          const input = inputs.in!;
          const report = makeReport(
            ctx.runId,
            ctx.blockId,
            input,
            input.records.map((record, index) => ({
              itemId: record.id,
              itemHash: String(index + 1).repeat(64),
              modelDecision: "keep",
              outcome: "keep",
              confidence: 0.9,
              reason: "Synthetic selection",
              quotes: [],
              model: "synthetic",
              forwarded: true,
              retainedAsContext: false,
            })),
          );
          const output = structuredClone(input);
          if (fault === "schema") report.decisions[0]!.confidence = 2;
          if (fault === "blockId") report.blockId = "wrong";
          if (fault === "duplicate") report.decisions[1]!.itemId = "rec_1";
          if (fault === "unknown") report.decisions[1]!.itemId = "rec_unknown";
          if (fault === "extraOutput")
            output.records.push({ ...output.records[0]!, id: "rec_unknown" });
          if (fault === "rewrittenOutput") output.records[0]!.text = "Rewritten";
          if (fault === "mutatedInput") input.records[0]!.text = "Mutated in place";
          return { status: "ok", outputs: { out: output }, filterReport: report };
        },
      }),
    );
    const executor = new WorkflowExecutor({ registry, services: mockServices() });
    const run = await executor.execute(
      createFilterWorkflow(),
      { type: "human", userId: "u1", name: "User" },
      DEFAULT_SETTINGS,
    );
    expect(run.status).toBe("failed");
    expect(run.blockRuns.find((state) => state.blockId === "filter")!.filterReport).toBeUndefined();
    expect(await executor.getBlockOutput(run.id, "filter")).toBeNull();
  });

  it("reads overrides once before block execution and isolates repeated callback reads", async () => {
    const registry = new BlockRegistry();
    registry.register(
      defineBlock({
        kind: "raw",
        run: async () => ({ status: "ok", outputs: { out: sampleInputData } }),
      }),
    );
    const stored: FilterOverride[] = [
      {
        itemId: "rec_2",
        itemHash: "2".repeat(64),
        configurationHash: "1".repeat(64),
        actor: { type: "human", userId: "pm", name: "PM" },
        at: new Date().toISOString(),
        rationale: "Original restore",
        version: 1,
      },
    ];
    const service = vi.fn(async () => stored);
    registry.register(
      defineBlock({
        kind: "ai_filter",
        run: async (_inputs, _params, ctx) => {
          expect(service).toHaveBeenCalledExactlyOnceWith("wf_filter_test", "filter");
          stored[0]!.rationale = "Later restore";
          const first = await ctx.filterOverrides!();
          expect(first[0]!.rationale).toBe("Original restore");
          first[0]!.rationale = "Caller mutation";
          expect((await ctx.filterOverrides!())[0]!.rationale).toBe("Original restore");
          return { status: "ok", outputs: { out: emptyPipelineData() } };
        },
      }),
    );
    const run = await new WorkflowExecutor({
      registry,
      services: mockServices({ filterOverrides: service }),
    }).execute(
      createFilterWorkflow(),
      { type: "human", userId: "u1", name: "User" },
      DEFAULT_SETTINGS,
    );
    expect(run.status).toBe("completed");
    expect(service).toHaveBeenCalledTimes(1);
  });

  it("marks a resumed HIL-paused session active before its persisted status changes", async () => {
    const registry = new BlockRegistry();
    registry.register(
      defineBlock({
        kind: "raw",
        run: async () => ({ status: "ok", outputs: { out: sampleInputData } }),
      }),
    );
    registry.register(
      defineBlock({
        kind: "ai_filter",
        run: async (inputs) => ({ status: "ok", outputs: { out: inputs.in! } }),
      }),
    );
    registry.register(
      defineBlock({
        kind: "hil",
        run: async (inputs, _params, ctx) =>
          ctx.resumed
            ? { status: "ok", outputs: { out: inputs.in! } }
            : { status: "paused", message: "Synthetic review" },
      }),
    );
    const workflow = createFilterWorkflow();
    const hil = createBlock("hil", { id: "hil", position: { x: 600, y: 0 } });
    const graph = connect(
      { blocks: [...workflow.blocks, hil], edges: workflow.edges },
      { source: "filter", sourcePort: "out", target: "hil", targetPort: "in" },
    );
    const services = mockServices();
    let release!: () => void;
    const resumeAudit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const record = services.audit.record;
    services.audit.record = async (event) => {
      if (event.action === "run.resumed") await resumeAudit;
      return record(event);
    };
    const executor = new WorkflowExecutor({ registry, services });
    const paused = await executor.execute(
      { ...workflow, ...graph },
      { type: "human", userId: "pm", name: "PM" },
      DEFAULT_SETTINGS,
    );
    expect(paused.status).toBe("waiting_for_review");
    expect(executor.isRunActive(paused.id)).toBe(false);
    const resuming = executor.resume(paused.id);
    expect(executor.isRunActive(paused.id)).toBe(true);
    expect(executor.getRun(paused.id).status).toBe("waiting_for_review");
    release();
    expect((await resuming).status).toBe("completed");
    expect(executor.isRunActive(paused.id)).toBe(false);
  });

  it("preserves nonempty sources-only context without inventing classifications", async () => {
    const input: PipelineData = {
      ...emptyPipelineData(),
      sources: [
        {
          id: "src_synthetic",
          title: "Synthetic source",
          kind: "other_internal",
          origin: "bmw_internal",
          reliability: "high",
          retrievedAt: new Date().toISOString(),
        },
      ],
    };
    const registry = new BlockRegistry();
    registry.register(
      defineBlock({ kind: "raw", run: async () => ({ status: "ok", outputs: { out: input } }) }),
    );
    registry.register(
      defineBlock({
        kind: "ai_filter",
        run: async (inputs, _params, ctx) => ({
          status: "ok",
          outputs: { out: inputs.in! },
          filterReport: {
            ...makeReport(ctx.runId, ctx.blockId, inputs.in!, []),
            primaryLayer: "sources",
          },
        }),
      }),
    );
    const run = await new WorkflowExecutor({ registry, services: mockServices() }).execute(
      createFilterWorkflow(),
      { type: "human", userId: "pm", name: "PM" },
      DEFAULT_SETTINGS,
    );
    expect(run.status).toBe("completed");
    expect(run.blockRuns.find((state) => state.blockId === "filter")!.filterReport).toMatchObject({
      primaryLayer: "sources",
      decisions: [],
      originalInput: input,
    });
  });
});
