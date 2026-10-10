import { z } from "zod";
import { DecisionStatus } from "@reqflow/core";
import { defineNode, type NodeDefinition } from "@reqflow/engine";
import { NODE_TYPES } from "../types";

export const PublishConfig = z.object({
  allowedStatuses: z.array(DecisionStatus).optional(),
});
export type PublishConfig = z.infer<typeof PublishConfig>;

export const publishNode: NodeDefinition<typeof PublishConfig> = defineNode({
  type: NODE_TYPES.publish,
  label: "Publish requirements",
  description:
    "Publishes finalized requirements to the workbench and records publication audit trail events.",
  category: "output",
  consumes: ["requirements"],
  produces: ["requirements"],
  configSchema: PublishConfig,
  async run(input, config, ctx) {
    let requirementsToPublish = input.requirements;
    if (config.allowedStatuses && config.allowedStatuses.length > 0) {
      requirementsToPublish = input.requirements.filter((r) =>
        config.allowedStatuses?.includes(r.status),
      );
    }

    ctx.log(
      `Publishing ${requirementsToPublish.length} requirement(s) for scope ${ctx.scope.vehicleLine} ${ctx.scope.market}.`,
    );

    for (const req of requirementsToPublish) {
      await ctx.audit.record({
        actor: { type: "ai", component: NODE_TYPES.publish, model: "deterministic" },
        action: "requirement.proposed",
        entityType: "requirement",
        entityId: req.id,
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        rationale: `Published via workflow node ${ctx.nodeId}`,
      });
    }

    return {
      status: "ok",
      data: {
        ...input,
        requirements: requirementsToPublish,
      },
    };
  },
});
