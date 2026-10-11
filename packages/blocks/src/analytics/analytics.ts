import {
  analyticsInputs,
  countPipelineData,
  emptyPipelineData,
  mergePipelineData,
  parseBlockParams,
} from "@reqflow/core";
import { defineBlock } from "@reqflow/engine";
import { describeData } from "../hil/hil";

/**
 * Analytics. The charts are computed in the analytics view from what arrives on each input, by
 * rules only (no model call). At run time the block reports what each input carried and passes
 * all inputs on, merged, so it can sit in the middle of a flow as well as at its end.
 */
export const analyticsBlock = defineBlock({
  kind: "analytics",
  async run(inputs, rawParams, ctx) {
    const params = parseBlockParams("analytics", rawParams);
    const ports = analyticsInputs(params);
    const parts = ports.map(({ id, label }) => {
      const data = inputs[id] ?? emptyPipelineData();
      const what = describeData(countPipelineData(data));
      ctx.log(`${label}: ${what || "nothing arrived"}.`);
      return data;
    });
    const merged = mergePipelineData(emptyPipelineData(), ...parts);
    const total = describeData(countPipelineData(merged));
    ctx.log(
      total
        ? `Passing on ${total} from ${ports.length} input${ports.length === 1 ? "" : "s"}. Open the block to see the analytics.`
        : "Nothing arrived, so there is nothing to analyse yet.",
    );
    return { status: "ok", outputs: { out: merged } };
  },
});
