import { z } from "zod";
import { defineNode, type NodeDefinition } from "@reqflow/engine";
import { NODE_TYPES } from "../types";
import {
  formatRequirementsCsv,
  formatRequirementsJson,
  formatRequirementsMarkdown,
} from "./formatters";

export const ExportConfig = z.object({
  format: z.enum(["json", "csv", "md"]).default("json"),
});
export type ExportConfig = z.infer<typeof ExportConfig>;

export const exportNode: NodeDefinition<typeof ExportConfig> = defineNode({
  type: NODE_TYPES.export,
  label: "Export requirements",
  description: "Formats requirements for documentation and export (JSON, CSV, or Markdown).",
  category: "output",
  consumes: ["requirements"],
  produces: ["requirements"],
  configSchema: ExportConfig,
  async run(input, config, ctx) {
    let formatted: string;
    switch (config.format) {
      case "csv":
        formatted = formatRequirementsCsv(input.requirements);
        break;
      case "md":
        formatted = formatRequirementsMarkdown(
          input.requirements,
          `BMW ${ctx.scope.vehicleLine} ${ctx.scope.derivative ?? ""} (${ctx.scope.market}) Requirements`,
        );
        break;
      case "json":
      default:
        formatted = formatRequirementsJson(input.requirements);
        break;
    }

    ctx.log(
      `Exported ${input.requirements.length} requirement(s) in ${config.format.toUpperCase()} format (${formatted.length} characters).`,
    );

    await ctx.audit.record({
      actor: { type: "ai", component: NODE_TYPES.export, model: "deterministic" },
      action: "export.created",
      entityType: "export",
      entityId: `exp_${ctx.runId}_${config.format}`,
      runId: ctx.runId,
      nodeId: ctx.nodeId,
      rationale: `Exported ${input.requirements.length} requirements as ${config.format}`,
    });

    return {
      status: "ok",
      data: input,
    };
  },
});
