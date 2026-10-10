import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DEFAULT_SETTINGS,
  emptyPipelineData,
  newId,
  type AuditLogger,
  type FileStore,
  type LlmClient,
  type PipelineData,
  type Workflow,
  type WorkflowRun,
} from "@reqflow/core";
import { defineNode } from "./node";
import { NodeRegistry } from "./registry";
import { WorkflowExecutor } from "./executor";
import { validateWorkflowGraph } from "./validate";

const mockServices = () => {
  const audit: AuditLogger = {
    record: vi.fn(async (input) => ({
      id: newId("aud"),
      at: new Date().toISOString(),
      ...input,
      changes: input.changes ?? [],
    })),
  };
  const llm: LlmClient = {
    generateObject: vi.fn(),
    generateText: vi.fn(),
  };
  const files: FileStore = {
    get: vi.fn(),
  };
  return { audit, llm, files, web: null };
};

describe("WorkflowExecutor and Validation (@reqflow/engine)", () => {
  it("validates valid graphs and catches errors (missing types, bad configs, cycles)", () => {
    const reg = new NodeRegistry([
      defineNode({
        type: "source.test",
        label: "Source",
        description: "Test source",
        category: "source",
        consumes: [],
        produces: ["sources"],
        configSchema: z.object({ count: z.number().int() }),
        async run() {
          return { status: "ok", data: emptyPipelineData() };
        },
      }),
    ]);

    // Valid graph
    const validGraph = {
      nodes: [
        {
          id: "n1",
          type: "source.test",
          position: { x: 0, y: 0 },
          config: { count: 5 },
        },
      ],
      edges: [],
    };
    expect(validateWorkflowGraph(validGraph, reg).valid).toBe(true);

    // Missing node type
    const missingTypeGraph = {
      nodes: [
        {
          id: "n1",
          type: "source.unknown",
          position: { x: 0, y: 0 },
          config: {},
        },
      ],
      edges: [],
    };
    const missingTypeRes = validateWorkflowGraph(missingTypeGraph, reg);
    expect(missingTypeRes.valid).toBe(false);
    expect(missingTypeRes.errors[0]?.message).toContain("Unknown node type");

    // Bad config
    const badConfigGraph = {
      nodes: [
        {
          id: "n1",
          type: "source.test",
          position: { x: 0, y: 0 },
          config: { count: "invalid" },
        },
      ],
      edges: [],
    };
    const badConfigRes = validateWorkflowGraph(badConfigGraph, reg);
    expect(badConfigRes.valid).toBe(false);
    expect(badConfigRes.errors[0]?.message).toContain("Invalid configuration");

    // Cycle detection
    const cycleGraph = {
      nodes: [
        { id: "a", type: "source.test", position: { x: 0, y: 0 }, config: { count: 1 } },
        { id: "b", type: "source.test", position: { x: 0, y: 0 }, config: { count: 2 } },
      ],
      edges: [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "a" },
      ],
    };
    const cycleRes = validateWorkflowGraph(cycleGraph, reg);
    expect(cycleRes.valid).toBe(false);
    expect(cycleRes.errors[0]?.message).toContain("cycle");
  });

  it("executes a topological pipeline successfully and streams updates", async () => {
    const reg = new NodeRegistry([
      defineNode({
        type: "source.a",
        label: "Source A",
        description: "",
        category: "source",
        consumes: [],
        produces: ["sources"],
        configSchema: z.object({}),
        async run(_input, _cfg, ctx) {
          ctx.log("producing source");
          ctx.progress(0.5, "halfway");
          return {
            status: "ok",
            data: {
              ...emptyPipelineData(),
              sources: [
                {
                  id: "src_1",
                  kind: "customer_feedback",
                  origin: "bmw_internal",
                  title: "Source 1",
                  uri: "file_1",
                  retrievedAt: new Date().toISOString(),
                  reliability: "high",
                },
              ],
            },
          };
        },
      }),
      defineNode({
        type: "output.done",
        label: "Output",
        description: "",
        category: "output",
        consumes: ["sources"],
        produces: [],
        configSchema: z.object({}),
        async run(input) {
          expect(input.sources).toHaveLength(1);
          return { status: "ok", data: input };
        },
      }),
    ]);

    const updates: WorkflowRun[] = [];
    const executor = new WorkflowExecutor({
      registry: reg,
      services: mockServices(),
      onUpdate: (run) => updates.push(run),
    });

    const wf: Workflow = {
      id: "wf_test",
      version: 1,
      name: "Test Pipeline",
      scope: {
        vehicleLine: "5 Series",
        derivative: "Sedan",
        vehicleCode: "5S",
        market: "EU",
        horizonYears: 5,
      },
      nodes: [
        { id: "src", type: "source.a", position: { x: 0, y: 0 }, config: {} },
        { id: "out", type: "output.done", position: { x: 100, y: 0 }, config: {} },
      ],
      edges: [{ id: "e1", source: "src", target: "out" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const finalRun = await executor.execute(
      wf,
      { type: "human", userId: "u1", name: "Alice" },
      DEFAULT_SETTINGS,
    );

    expect(finalRun.status).toBe("completed");
    expect(finalRun.nodeRuns[0]?.status).toBe("succeeded");
    expect(finalRun.nodeRuns[0]?.logs.length).toBeGreaterThan(0);
    expect(finalRun.nodeRuns[1]?.status).toBe("succeeded");
    expect(updates.length).toBeGreaterThan(3);
  });

  it("handles multi-input merge properly", async () => {
    const reg = new NodeRegistry([
      defineNode({
        type: "source.source_one",
        label: "Source 1",
        description: "",
        category: "source",
        consumes: [],
        produces: ["sources"],
        configSchema: z.object({}),
        async run() {
          return {
            status: "ok",
            data: {
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
          };
        },
      }),
      defineNode({
        type: "source.source_two",
        label: "Source 2",
        description: "",
        category: "source",
        consumes: [],
        produces: ["sources"],
        configSchema: z.object({}),
        async run() {
          return {
            status: "ok",
            data: {
              ...emptyPipelineData(),
              sources: [
                {
                  id: "src_2",
                  kind: "customer_study",
                  origin: "bmw_internal",
                  title: "S2",
                  uri: "f2",
                  retrievedAt: new Date().toISOString(),
                  reliability: "high",
                },
              ],
            },
          };
        },
      }),
      defineNode({
        type: "merge.check",
        label: "Merge Check",
        description: "",
        category: "analysis",
        consumes: ["sources"],
        produces: ["sources"],
        configSchema: z.object({}),
        async run(input) {
          expect(input.sources).toHaveLength(2);
          const ids = input.sources.map((s) => s.id);
          expect(ids).toContain("src_1");
          expect(ids).toContain("src_2");
          return { status: "ok", data: input };
        },
      }),
    ]);

    const executor = new WorkflowExecutor({
      registry: reg,
      services: mockServices(),
    });

    const wf: Workflow = {
      id: "wf_merge",
      version: 1,
      name: "Merge",
      scope: {
        vehicleLine: "5 Series",
        derivative: "Sedan",
        vehicleCode: "5S",
        market: "EU",
        horizonYears: 5,
      },
      nodes: [
        { id: "s1", type: "source.source_one", position: { x: 0, y: 0 }, config: {} },
        { id: "s2", type: "source.source_two", position: { x: 0, y: 100 }, config: {} },
        { id: "m", type: "merge.check", position: { x: 200, y: 50 }, config: {} },
      ],
      edges: [
        { id: "e1", source: "s1", target: "m" },
        { id: "e2", source: "s2", target: "m" },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const finalRun = await executor.execute(
      wf,
      { type: "human", userId: "u1", name: "Alice" },
      DEFAULT_SETTINGS,
    );
    expect(finalRun.status).toBe("completed");
  });

  it("handles node failure and skips downstream nodes", async () => {
    const reg = new NodeRegistry([
      defineNode({
        type: "node.fail",
        label: "Failing Node",
        description: "",
        category: "analysis",
        consumes: [],
        produces: [],
        configSchema: z.object({}),
        async run() {
          throw new Error("Simulated failure in node");
        },
      }),
      defineNode({
        type: "node.downstream",
        label: "Downstream Node",
        description: "",
        category: "output",
        consumes: [],
        produces: [],
        configSchema: z.object({}),
        async run() {
          return { status: "ok", data: emptyPipelineData() };
        },
      }),
    ]);

    const executor = new WorkflowExecutor({
      registry: reg,
      services: mockServices(),
    });

    const wf: Workflow = {
      id: "wf_fail",
      version: 1,
      name: "Fail Test",
      scope: {
        vehicleLine: "5 Series",
        derivative: "Sedan",
        vehicleCode: "5S",
        market: "EU",
        horizonYears: 5,
      },
      nodes: [
        { id: "f1", type: "node.fail", position: { x: 0, y: 0 }, config: {} },
        { id: "d1", type: "node.downstream", position: { x: 100, y: 0 }, config: {} },
      ],
      edges: [{ id: "e1", source: "f1", target: "d1" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const run = await executor.execute(
      wf,
      { type: "human", userId: "u1", name: "Alice" },
      DEFAULT_SETTINGS,
    );

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Simulated failure in node");
    expect(run.nodeRuns.find((n) => n.nodeId === "f1")?.status).toBe("failed");
    expect(run.nodeRuns.find((n) => n.nodeId === "d1")?.status).toBe("skipped");
  });

  it("handles pause and resume at review nodes", async () => {
    let gateRunCount = 0;
    const reg = new NodeRegistry([
      defineNode({
        type: "review.gate",
        label: "Review Gate",
        description: "",
        category: "review",
        consumes: [],
        produces: [],
        configSchema: z.object({}),
        async run(input, _cfg, ctx) {
          gateRunCount++;
          if (!ctx.resumed) {
            return { status: "paused", message: "Waiting for PM review" };
          }
          return { status: "ok", data: input };
        },
      }),
      defineNode({
        type: "output.final",
        label: "Final",
        description: "",
        category: "output",
        consumes: [],
        produces: [],
        configSchema: z.object({}),
        async run(input) {
          return { status: "ok", data: input };
        },
      }),
    ]);

    const executor = new WorkflowExecutor({
      registry: reg,
      services: mockServices(),
    });

    const wf: Workflow = {
      id: "wf_pause",
      version: 1,
      name: "Pause Test",
      scope: {
        vehicleLine: "5 Series",
        derivative: "Sedan",
        vehicleCode: "5S",
        market: "EU",
        horizonYears: 5,
      },
      nodes: [
        { id: "gate", type: "review.gate", position: { x: 0, y: 0 }, config: {} },
        { id: "final", type: "output.final", position: { x: 100, y: 0 }, config: {} },
      ],
      edges: [{ id: "e1", source: "gate", target: "final" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const initialRun = await executor.execute(
      wf,
      { type: "human", userId: "u1", name: "Alice" },
      DEFAULT_SETTINGS,
    );

    expect(initialRun.status).toBe("waiting_for_review");
    expect(initialRun.nodeRuns.find((n) => n.nodeId === "gate")?.status).toBe("waiting_for_review");
    expect(initialRun.nodeRuns.find((n) => n.nodeId === "final")?.status).toBe("pending");
    expect(gateRunCount).toBe(1);

    // Resume
    const resumedRun = await executor.resume(initialRun.id);
    expect(resumedRun.status).toBe("completed");
    expect(resumedRun.nodeRuns.find((n) => n.nodeId === "gate")?.status).toBe("succeeded");
    expect(resumedRun.nodeRuns.find((n) => n.nodeId === "final")?.status).toBe("succeeded");
    expect(gateRunCount).toBe(2);
  });

  it("handles run cancellation", async () => {
    const reg = new NodeRegistry([
      defineNode({
        type: "node.long",
        label: "Long Node",
        description: "",
        category: "analysis",
        consumes: [],
        produces: [],
        configSchema: z.object({}),
        async run(_input, _cfg, ctx) {
          // Poll ctx.signal
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 500);
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            });
          });
          return { status: "ok", data: emptyPipelineData() };
        },
      }),
    ]);

    const executor = new WorkflowExecutor({
      registry: reg,
      services: mockServices(),
    });

    const wf: Workflow = {
      id: "wf_cancel",
      version: 1,
      name: "Cancel Test",
      scope: {
        vehicleLine: "5 Series",
        derivative: "Sedan",
        vehicleCode: "5S",
        market: "EU",
        horizonYears: 5,
      },
      nodes: [{ id: "l1", type: "node.long", position: { x: 0, y: 0 }, config: {} }],
      edges: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const run = await executor.start(
      wf,
      { type: "human", userId: "u1", name: "Alice" },
      DEFAULT_SETTINGS,
    );

    expect(run.status).toBe("running");
    const cancelled = await executor.cancel(run.id);
    expect(cancelled.status).toBe("cancelled");
  });
});
