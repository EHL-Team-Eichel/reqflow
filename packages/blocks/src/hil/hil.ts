import { emptyPipelineData } from "@reqflow/core";
import { defineBlock, type BlockImplementation } from "@reqflow/engine";

export const hilBlock: BlockImplementation<"hil"> = defineBlock({
  kind: "hil",
  async run(inputs, params, ctx) {
    if (!ctx.resumed) {
      const msg =
        typeof params.instructions === "string" && params.instructions.trim().length > 0
          ? params.instructions
          : "Human review required before proceeding.";
      ctx.log(`Pausing at HIL block for review: ${msg}`);
      return {
        status: "paused",
        message: msg,
      };
    }

    ctx.log("HIL block resumed. Passing items to output.");
    const incoming = inputs.in ?? emptyPipelineData();
    return {
      status: "ok",
      outputs: {
        out: incoming,
      },
    };
  },
});
