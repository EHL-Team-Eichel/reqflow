import { countPipelineData, emptyPipelineData, parseBlockParams } from "@reqflow/core";
import { defineBlock } from "@reqflow/engine";

/** Mirrors BLOCK_SPECS.hil.params (validated by parseBlockParams before use). */
interface HilParams {
  reviewer: "pm" | "expert" | "anyone";
  instructions: string;
  approvals: number;
  allowEdits: boolean;
}

const REVIEWER: Record<HilParams["reviewer"], string> = {
  pm: "the product manager",
  expert: "a domain expert",
  anyone: "a team member",
};

/** "3 sources, 12 records" — only the parts that are there. */
export function describeData(counts: ReturnType<typeof countPipelineData>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => `${n} ${n === 1 ? key.replace(/s$/, "") : key}`);
  return parts.join(", ");
}

/**
 * Human in the loop. On the first run it pauses the flow until a person has reviewed what arrived
 * (the engine marks the run `waiting_for_review`). When the run is resumed, it passes the data on.
 * This block never counts approvals itself: each `runs.resume` call (Electron main) records one
 * reviewer's `run.review_approved` event for the paused gate and only resumes the run once
 * `approvals` different reviewers have approved it; until then the run stays paused here.
 * Reviewer edits are made through the requirement API and audited there, not inside this block.
 */
export const hilBlock = defineBlock({
  kind: "hil",
  async run(inputs, rawParams, ctx) {
    const params = parseBlockParams("hil", rawParams) as unknown as HilParams;
    const input = inputs.in ?? emptyPipelineData();
    const what = describeData(countPipelineData(input));

    if (!what) {
      ctx.log("Nothing arrived to review, so the flow continues with an empty stream.");
      return { status: "ok", outputs: { out: input } };
    }
    if (!ctx.resumed) {
      const approvals = params.approvals > 1 ? ` (${params.approvals} approvals needed)` : "";
      const message = `Waiting for ${REVIEWER[params.reviewer]} to review ${what}${approvals}.`;
      ctx.log(message);
      return { status: "paused", message };
    }
    ctx.log(`Review finished. Passing on ${what}.`);
    return { status: "ok", outputs: { out: input } };
  },
});
