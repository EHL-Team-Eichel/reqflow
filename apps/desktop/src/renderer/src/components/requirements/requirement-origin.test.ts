import { describe, expect, it, vi } from "vitest";
import {
  createBlock,
  emptyPipelineData,
  graphAt,
  type AuditEvent,
  type ReqflowApi,
  type Requirement,
  type WorkflowGraph,
  type WorkflowRun,
} from "@reqflow/core";
import { fixtureRequirements, fixtureScope, fixturePipelineData } from "@reqflow/core/fixtures";
import {
  loadOriginStepData,
  loadRequirementOrigin,
  resolveRequirementOrigin,
} from "./requirement-origin";

const block = (kind: Parameters<typeof createBlock>[0], id: string) =>
  createBlock(kind, { id, position: { x: 0, y: 0 } });
const raw = block("raw", "raw_original");
const other = block("raw", "raw_other_rank");
const context = block("raw", "raw_context");
const car = block("add_to_car", "car_original");
car.params = { ...car.params, priorities: 2, contexts: ["sales_volumes"] };
const graph: WorkflowGraph = {
  blocks: [raw, other, context, car, block("add_to_car", "car_unrelated")],
  edges: [
    { id: "edge1", source: raw.id, sourcePort: "out", target: car.id, targetPort: "in-0" },
    { id: "edge2", source: other.id, sourcePort: "out", target: car.id, targetPort: "in-1" },
    { id: "edge3", source: context.id, sourcePort: "out", target: car.id, targetPort: "ctx-0" },
  ],
};
const run: WorkflowRun = {
  id: "run_original",
  workflowId: "wf_original",
  workflowVersion: 3,
  graph,
  scope: fixtureScope,
  status: "completed",
  startedBy: { type: "system", component: "synthetic" },
  startedAt: "2026-10-11T12:00:00.000Z",
  blockRuns: [],
};
const requirement: Requirement = { ...fixtureRequirements[0]!, runId: run.id, inputRank: 1 };
const audit: AuditEvent = {
  id: "aud_original",
  at: run.startedAt,
  actor: requirement.createdBy,
  action: "requirement.proposed",
  entityType: "requirement",
  entityId: requirement.id,
  changes: [],
  runId: run.id,
  blockId: car.id,
};
function api(runValue = run, events = [audit]) {
  return {
    runs: { get: vi.fn(async () => runValue), blockOutput: vi.fn(), list: vi.fn() },
    audit: { list: vi.fn(async () => events) },
  } as unknown as Pick<ReqflowApi, "runs" | "audit">;
}
async function origin() {
  return (await resolveRequirementOrigin(requirement, api()))!;
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("Car option historical workflow provenance", () => {
  it("opens the exact run/version and audited originating block, not another Add to Car", async () => {
    const client = api();
    const saved = await resolveRequirementOrigin(requirement, client);
    expect(client.runs.get).toHaveBeenCalledWith("run_original");
    expect(client.runs.list).not.toHaveBeenCalled();
    expect(client.audit.list).toHaveBeenCalledWith({
      entityType: "requirement",
      entityId: requirement.id,
      action: "requirement.proposed",
      runId: run.id,
    });
    expect(saved?.run.workflowVersion).toBe(3);
    expect(saved?.step.block.id).toBe("car_original");
  });

  it("traces only the option's ranked input plus shared context without mutating the saved workflow", async () => {
    const before = structuredClone(run);
    const saved = await origin();
    expect(saved.lineage.steps.map((step) => step.block.id)).toEqual([car.id, raw.id, context.id]);
    expect(saved.run.graph.edges).toHaveLength(3);
    expect(run).toEqual(before);
  });

  it("keeps all historical inputs for older requirements with no recorded rank", async () => {
    const saved = await resolveRequirementOrigin({ ...requirement, inputRank: undefined }, api());
    expect(saved?.lineage.steps.some((step) => step.block.id === other.id)).toBe(true);
  });

  it("resolves origins inside nested workplaces and traces across their boundaries", async () => {
    const parent = block("custom", "nested");
    const input = parent.inner!.blocks.find((block) => block.kind === "block_input")!;
    parent.inner!.blocks.push(car);
    parent.inner!.edges.push({
      id: "inside",
      source: input.id,
      sourcePort: "out",
      target: car.id,
      targetPort: "in-0",
    });
    const nestedRun = {
      ...run,
      graph: {
        blocks: [raw, parent],
        edges: [
          { id: "outside", source: raw.id, sourcePort: "out", target: parent.id, targetPort: "in" },
        ],
      },
    };
    const saved = await resolveRequirementOrigin(requirement, api(nestedRun));
    expect(saved?.step.path).toEqual(["nested"]);
    expect(saved?.lineage.steps.map((step) => step.block.id)).toContain(raw.id);
    expect(graphAt(saved!.run.graph, saved!.step.path).blocks).toContainEqual(car);
  });

  it("does not guess an origin when there is no run or no creation block", async () => {
    const client = api();
    expect(await resolveRequirementOrigin({ ...requirement, runId: undefined }, client)).toBeNull();
    expect(client.runs.get).not.toHaveBeenCalled();
    expect(
      await resolveRequirementOrigin(requirement, api(run, [{ ...audit, blockId: undefined }])),
    ).toBeNull();
  });

  it("ignores audit entries for other requirements, actions or runs", async () => {
    const events: AuditEvent[] = [
      { ...audit, entityId: "REQ-F70-EU-999" },
      { ...audit, action: "requirement.edited" },
      { ...audit, runId: "run_different" },
    ];
    expect(await resolveRequirementOrigin(requirement, api(run, events))).toBeNull();
  });

  it("rejects ambiguous creation blocks instead of opening the first matching block", async () => {
    await expect(
      resolveRequirementOrigin(
        requirement,
        api(run, [audit, { ...audit, blockId: "car_unrelated" }]),
      ),
    ).rejects.toThrow("More than one");
  });

  it.each([
    ["wrong run", { ...run, id: "run_wrong" }, audit, "does not match"],
    ["missing block", run, { ...audit, blockId: "removed" }, "missing"],
    ["wrong block kind", run, { ...audit, blockId: raw.id }, "missing"],
    ["invalid snapshot", { ...run, graph: undefined } as unknown as WorkflowRun, audit, "invalid"],
    ["invalid audit", run, { ...audit, at: "invalid" }, "invalid"],
  ])("rejects %s", async (_label, value, event, message) => {
    await expect(resolveRequirementOrigin(requirement, api(value, [event]))).rejects.toThrow(
      message,
    );
  });

  it("rejects a rank not present in the historical block", async () => {
    await expect(resolveRequirementOrigin({ ...requirement, inputRank: 9 }, api())).rejects.toThrow(
      "priority input is missing",
    );
  });

  it("reports missing provenance while retaining requirement evidence in the UI state", async () => {
    const publish = vi.fn();
    loadRequirementOrigin({ ...requirement, runId: undefined }, api(), publish);
    await flush();
    expect(publish.mock.lastCall?.[0]).toMatchObject({ status: "unavailable" });
  });

  it("exposes a saved-run read failure, without re-reading a source or substituting samples", async () => {
    const client = api();
    client.runs.get = async () => {
      throw new Error("Saved run is unavailable");
    };
    const publish = vi.fn();
    loadRequirementOrigin(requirement, client, publish);
    await flush();
    expect(publish).toHaveBeenLastCalledWith({
      status: "error",
      message: "Saved run is unavailable",
    });
  });

  it("ignores a stale success after closing or switching options", async () => {
    let resolve!: (value: WorkflowRun) => void;
    const client = api();
    client.runs.get = () =>
      new Promise((done) => {
        resolve = done;
      });
    const publish = vi.fn();
    const cancel = loadRequirementOrigin(requirement, client, publish);
    cancel();
    resolve(run);
    await flush();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("ignores an old failure after a successful retry", async () => {
    let reject!: (reason: Error) => void;
    const client = api();
    client.runs.get = () =>
      new Promise((_done, fail) => {
        reject = fail;
      });
    const publish = vi.fn();
    const cancel = loadRequirementOrigin(requirement, client, publish);
    cancel();
    loadRequirementOrigin(requirement, api(), publish);
    await flush();
    reject(new Error("Old failure"));
    await flush();
    expect(publish.mock.lastCall?.[0].status).toBe("ready");
  });
});

describe("saved data at the originating Add to Car sink", () => {
  it("loads the exact priority port and context, not unrelated priorities or empty sink outputs", async () => {
    const read = vi.fn(async (_run: string, id: string) => ({
      out: id === raw.id ? fixturePipelineData : emptyPipelineData(),
    }));
    const data = await loadOriginStepData(await origin(), requirement, (await origin()).step, read);
    expect(read.mock.calls).toEqual([
      [run.id, raw.id],
      [run.id, context.id],
    ]);
    expect(data.records).toEqual(fixturePipelineData.records);
  });

  it("reads multiple exact ports from one upstream block once and merges by id", async () => {
    const sameSourceRun = structuredClone(run);
    sameSourceRun.graph.edges[2]!.source = raw.id;
    sameSourceRun.graph.edges[2]!.sourcePort = "context";
    const saved = (await resolveRequirementOrigin(requirement, api(sameSourceRun)))!;
    const read = vi.fn(async () => ({
      out: fixturePipelineData,
      context: fixturePipelineData,
      unrelated: emptyPipelineData(),
    }));
    const data = await loadOriginStepData(saved, requirement, saved.step, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(data.records).toHaveLength(fixturePipelineData.records.length);
  });

  it("uses the saved upstream output, including the historical HIL input behavior", async () => {
    const saved = await origin();
    const read = vi.fn(async () => ({ out: fixturePipelineData }));
    const step = saved.lineage.steps.find((step) => step.block.id === raw.id)!;
    expect(await loadOriginStepData(saved, requirement, step, read)).toEqual(fixturePipelineData);
    expect(read).toHaveBeenCalledWith(run.id, raw.id);
  });

  it("fails visibly for missing persisted input ports", async () => {
    const saved = await origin();
    await expect(
      loadOriginStepData(saved, requirement, saved.step, async () => ({})),
    ).rejects.toThrow("Saved input data is missing");
  });

  it("fails visibly for malformed persisted data", async () => {
    const saved = await origin();
    await expect(
      loadOriginStepData(saved, requirement, saved.step, async () => ({ out: {} as never })),
    ).rejects.toThrow("invalid");
  });

  it("does not turn source/output read errors into an empty evidence table", async () => {
    const saved = await origin();
    await expect(
      loadOriginStepData(saved, requirement, saved.step, async () => {
        throw new Error("Output unavailable");
      }),
    ).rejects.toThrow("Output unavailable");
  });
});
