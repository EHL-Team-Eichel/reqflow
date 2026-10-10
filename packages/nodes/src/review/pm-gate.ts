import { z } from "zod";
import { defineNode, type NodeDefinition } from "@reqflow/engine";
import { NODE_TYPES } from "../types";

export const PmGateConfig = z.object({
  message: z.string().default("Review requirements before publishing"),
  requireAllDecided: z.boolean().default(false),
});
export type PmGateConfig = z.infer<typeof PmGateConfig>;

export const pmGateNode: NodeDefinition<typeof PmGateConfig> = defineNode({
  type: NODE_TYPES.pmGate,
  label: "PM review gate",
  description:
    "Pauses the workflow for human review, challenge, and decision-making on derived requirements before publishing.",
  category: "review",
  consumes: ["requirements"],
  produces: ["requirements"],
  configSchema: PmGateConfig,
  async run(input, config, ctx) {
    if (!ctx.resumed) {
      ctx.log(
        `Pausing workflow for PM review: ${input.requirements.length} requirement(s) awaiting review.`,
      );
      return {
        status: "paused",
        message: config.message,
      };
    }

    if (config.requireAllDecided) {
      const pending = input.requirements.filter(
        (r) => r.status === "proposed" || r.status === "in_review",
      );
      if (pending.length > 0) {
        throw new Error(
          `Cannot resume: ${pending.length} requirement(s) still pending PM decision (${pending.map((p) => p.id).join(", ")})`,
        );
      }
    }

    ctx.log(`Workflow resumed by PM. Proceeding with ${input.requirements.length} requirement(s).`);
    return {
      status: "ok",
      data: input,
    };
  },
});
