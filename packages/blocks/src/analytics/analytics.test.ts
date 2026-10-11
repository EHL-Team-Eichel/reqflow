import {
  blockPorts,
  defaultBlockParams,
  emptyPipelineData,
  parseBlockParams,
  type PipelineData,
} from "@reqflow/core";
import { fixturePipelineData } from "@reqflow/core/fixtures";
import type { BlockContext } from "@reqflow/engine";
import { describe, expect, it } from "vitest";
import { analyticsBlock } from "./analytics";

function ctx() {
  const logs: string[] = [];
  return {
    logs,
    ctx: { resumed: false, log: (m: string) => logs.push(m) } as unknown as BlockContext,
  };
}
const a: PipelineData = {
  ...emptyPipelineData(),
  sources: fixturePipelineData.sources.slice(0, 1),
  records: fixturePipelineData.records.slice(0, 2),
};
const b: PipelineData = {
  ...emptyPipelineData(),
  sources: fixturePipelineData.sources.slice(1, 2),
  records: fixturePipelineData.records.slice(2, 3),
};

describe("Analytics block", () => {
  it("has one input by default and one more port per named input", () => {
    const params = defaultBlockParams("analytics");
    expect(blockPorts({ kind: "analytics", params }).inputs).toEqual([
      { id: "in-0", label: "Input 1" },
    ]);
    const two = { ...params, inputs: ["F70 EU", "G60 EU"] };
    expect(blockPorts({ kind: "analytics", params: two })).toEqual({
      inputs: [
        { id: "in-0", label: "F70 EU" },
        { id: "in-1", label: "G60 EU" },
      ],
      outputs: [{ id: "out", label: "All inputs" }],
    });
  });

  it("validates its params strictly", () => {
    const params = defaultBlockParams("analytics");
    expect(() => parseBlockParams("analytics", { ...params, inputs: [] })).toThrow();
    expect(() => parseBlockParams("analytics", { ...params, timeGranularity: "hour" })).toThrow();
    expect(() => parseBlockParams("analytics", { ...params, extra: 1 })).toThrow();
  });

  it("passes every input on, merged, and logs what each one carried", async () => {
    const { ctx: c, logs } = ctx();
    const params = { ...defaultBlockParams("analytics"), inputs: ["A", "B", "C"] };
    const result = await analyticsBlock.run({ "in-0": a, "in-1": b }, params, c);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.outputs.out!.records.map((r) => r.id)).toEqual([
      ...a.records.map((r) => r.id),
      ...b.records.map((r) => r.id),
    ]);
    expect(result.outputs.out!.sources).toHaveLength(2);
    expect(logs).toEqual([
      "A: 1 source, 2 records.",
      "B: 1 source, 1 record.",
      "C: nothing arrived.",
      "Passing on 2 sources, 3 records from 3 inputs. Open the block to see the analytics.",
    ]);
  });

  it("says so when nothing arrived", async () => {
    const { ctx: c, logs } = ctx();
    const result = await analyticsBlock.run({}, defaultBlockParams("analytics"), c);
    expect(result).toEqual({ status: "ok", outputs: { out: emptyPipelineData() } });
    expect(logs.at(-1)).toMatch(/Nothing arrived/);
  });
});
