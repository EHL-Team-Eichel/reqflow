import { defaultBlockParams, emptyPipelineData, type PipelineData } from "@reqflow/core";
import { fixturePipelineData } from "@reqflow/core/fixtures";
import type { BlockContext } from "@reqflow/engine";
import { describe, expect, it } from "vitest";
import { describeData, hilBlock } from "./hil";

function ctx(resumed: boolean) {
  const logs: string[] = [];
  return { logs, ctx: { resumed, log: (m: string) => logs.push(m) } as unknown as BlockContext };
}
const params = defaultBlockParams("hil");
const data: PipelineData = {
  ...emptyPipelineData(),
  sources: fixturePipelineData.sources.slice(0, 2),
  records: fixturePipelineData.records.slice(0, 1),
};

describe("HIL block", () => {
  it("pauses the first time, naming the reviewer and what waits", async () => {
    const { ctx: c, logs } = ctx(false);
    const result = await hilBlock.run({ in: data }, params, c);
    expect(result).toEqual({
      status: "paused",
      message: "Waiting for the product manager to review 2 sources, 1 record.",
    });
    expect(logs).toHaveLength(1);
  });

  it("mentions extra approvals", async () => {
    const result = await hilBlock.run(
      { in: data },
      { ...params, approvals: 2, reviewer: "expert" },
      ctx(false).ctx,
    );
    expect(result).toMatchObject({
      message: expect.stringMatching(/domain expert.*\(2 approvals needed\)/),
    });
  });

  it("passes the data on unchanged once resumed", async () => {
    const result = await hilBlock.run({ in: data }, params, ctx(true).ctx);
    expect(result).toEqual({ status: "ok", outputs: { out: data } });
  });

  it("doesn't stop the flow when nothing arrived", async () => {
    const { ctx: c, logs } = ctx(false);
    expect(await hilBlock.run({}, params, c)).toEqual({
      status: "ok",
      outputs: { out: emptyPipelineData() },
    });
    expect(logs[0]).toMatch(/Nothing arrived/);
  });

  it("rejects invalid params instead of guessing", async () => {
    await expect(
      hilBlock.run({ in: data }, { ...params, approvals: 0 }, ctx(false).ctx),
    ).rejects.toThrow();
  });

  it("describes data compactly", () => {
    expect(describeData({ sources: 1, records: 0, findings: 3, themes: 0, requirements: 1 })).toBe(
      "1 source, 3 findings, 1 requirement",
    );
  });
});
