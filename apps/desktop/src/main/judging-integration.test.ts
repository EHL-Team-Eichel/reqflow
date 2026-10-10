import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allBlockImplementations } from "@reqflow/blocks";
import {
  connect,
  createBlock,
  DEFAULT_SETTINGS,
  emptyPipelineData,
  setBlockParams,
  type WorkflowRun,
  type WorkflowGraph,
} from "@reqflow/core";
import { createFileStore } from "@reqflow/db";
import { BlockRegistry, defineBlock } from "@reqflow/engine";
import { createHandlers } from "./handlers";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("Mastra judging desktop integration (offline synthetic)", () => {
  it("routes proposals through HIL, publishes evidence, and preserves earlier runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reqflow-judge-test-"));
    dirs.push(dir);
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
                sources: [
                  {
                    id: "src_synthetic",
                    kind: "customer_feedback",
                    origin: "bmw_internal",
                    title: "Synthetic F70 feedback",
                    reliability: "high",
                    retrievedAt: "2026-10-10T20:00:00.000Z",
                  },
                ],
                records: Array.from({ length: 8 }, (_, i) => ({
                  id: `rec_synthetic${i}`,
                  sourceId: "src_synthetic",
                  market: "DE",
                  text: `The seats squeak over bumps on every trip, synthetic case ${i}.`,
                })),
              },
            },
          };
        },
      }),
    ]);
    const handlers = createHandlers({
      dataDir: dir,
      registry,
      files: createFileStore(join(dir, "uploads")),
      pickFile: async () => null,
      appInfo: () => ({ version: "test", platform: "darwin", dataDir: dir, isPackaged: false }),
    });
    let graph: WorkflowGraph = {
      blocks: [
        createBlock("raw", { id: "raw", position: { x: 0, y: 0 } }),
        createBlock("ai_judge", { id: "judge", position: { x: 300, y: 0 } }),
        createBlock("hil", { id: "hil", position: { x: 600, y: 0 } }),
        createBlock("add_to_car", { id: "car", position: { x: 900, y: 0 } }),
      ],
      edges: [],
    };
    graph = setBlockParams(graph, "judge", {
      ...graph.blocks[1]!.params,
      query: "seats",
      model: "mock/judge",
      sources: ["Feedback"],
    }).graph;
    for (const [source, sourcePort, target, targetPort] of [
      ["raw", "out", "judge", "in-0"],
      ["judge", "out", "hil", "in"],
      ["hil", "out", "car", "in-0"],
    ])
      graph = connect(graph, {
        source: source!,
        sourcePort: sourcePort!,
        target: target!,
        targetPort: targetPort!,
      });
    const workflow = await handlers.workflows.save({
      ...graph,
      name: "Synthetic judge",
      scope: DEFAULT_SETTINGS.defaultScope,
    });
    const wait = async (id: string) => {
      let run: WorkflowRun = await handlers.runs.get(id);
      const deadline = Date.now() + 3000;
      while (run.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        run = await handlers.runs.get(id);
      }
      return run;
    };
    const initial = await handlers.requirements.list();
    const run = await handlers.runs.start(workflow.id);
    expect((await wait(run.id)).status).toBe("waiting_for_review");
    expect(await handlers.requirements.list({ runId: run.id })).toHaveLength(0);
    expect(
      (await handlers.runs.blockOutput(run.id, "judge")).out!.requirements.length,
    ).toBeGreaterThan(0);
    await handlers.runs.resume(run.id); // explicit human continuation, never an automatic resume
    expect((await wait(run.id)).status).toBe("completed");
    const proposals = await handlers.requirements.list({ runId: run.id });
    expect(proposals.length).toBeGreaterThan(0);
    expect(
      proposals.every(
        (r) => r.status === "proposed" && r.score!.factors.evidence_strength!.value === 0,
      ),
    ).toBe(true);
    const detail = await handlers.requirements.get(proposals[0]!.id);
    expect(detail.findings.length).toBeGreaterThan(0);
    expect(detail.records.length).toBeGreaterThan(0);
    expect(detail.sources.length).toBeGreaterThan(0);
    const second = await handlers.runs.start(workflow.id);
    expect((await wait(second.id)).status).toBe("waiting_for_review");
    await handlers.runs.resume(second.id);
    expect((await wait(second.id)).status).toBe("completed");
    const again = await handlers.requirements.list({ runId: second.id });
    expect(again.every((r) => !proposals.some((old) => old.id === r.id))).toBe(true);
    for (const old of [...initial, ...proposals])
      expect((await handlers.requirements.get(old.id)).requirement).toEqual(old);
  });
});
