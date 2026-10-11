import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineBlock, type BlockImplementation } from "@reqflow/engine";
import { emptyPipelineData, parseBlockParams, type ResearchAgentId } from "@reqflow/core";
import { buildOpenCodeAgentPrompt } from "./prompts";
import { runOpenCode, type OpenCodeRunner } from "./cli";
import { ingestOpenCodeDirectory } from "./ingest";

export interface ResearchOpenCodeParams {
  agents?: string[];
  question?: string;
  market?: string;
  maxResults?: number;
  timeoutMs?: number;
  concurrency?: number;
  model?: string;
  workingDir?: string;
  runner?: OpenCodeRunner;
  skipSkillInstall?: boolean;
}

/**
 * Resolves the OpenCode model string from block params or application settings.
 */
export function resolveOpenCodeModel(
  paramModel: unknown,
  settingsLlm: { provider: string; model: string } | undefined,
): string | undefined {
  if (typeof paramModel === "string" && paramModel.trim()) {
    return paramModel.trim();
  }
  if (!settingsLlm?.model) return undefined;
  const model = settingsLlm.model.trim();
  if (model.includes("/")) return model;
  if (settingsLlm.provider && settingsLlm.provider !== "mock") {
    return `${settingsLlm.provider}/${model}`;
  }
  return model;
}

// Owner: OpenCode Research block — autonomous multi-agent research producing structured Excel files.
export const researchOpencodeImplementations: BlockImplementation<"research_opencode">[] = [
  defineBlock({
    kind: "research_opencode",
    async run(_inputs, rawParams, ctx) {
      const p = (rawParams ?? {}) as unknown as ResearchOpenCodeParams;
      const agents =
        Array.isArray(p.agents) && p.agents.length > 0
          ? p.agents
          : ["editorial_reviews", "competitor_models", "technology"];

      const market = p.market === "global" || !p.market ? ctx.scope.market : p.market;

      const scope = {
        ...ctx.scope,
        market,
      };

      const maxResults = typeof p.maxResults === "number" ? p.maxResults : 10;
      const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 300_000;
      const concurrency =
        typeof p.concurrency === "number" && p.concurrency > 0 ? p.concurrency : 2;
      const model = resolveOpenCodeModel(p.model, ctx.settings?.llm);

      const workingDir =
        typeof p.workingDir === "string" && p.workingDir.trim()
          ? p.workingDir.trim()
          : await mkdtemp(path.join(tmpdir(), "reqflow-opencode-"));

      ctx.log(
        `Starting OpenCode Research across ${agents.length} agent(s) in working directory: ${workingDir}`,
      );

      // Process agents with configured concurrency
      const queue = [...agents];
      let completedCount = 0;

      const runAgent = async (agentId: string) => {
        ctx.signal.throwIfAborted();
        const prompt = buildOpenCodeAgentPrompt({
          agentId,
          scope,
          question: p.question,
          maxResults,
          outputFileName: `research_${agentId}.xlsx`,
        });

        ctx.log(`[Agent: ${agentId}] Launching OpenCode research...`);
        const result = await runOpenCode({
          workingDir,
          model,
          prompt,
          timeoutMs,
          signal: ctx.signal,
          log: (msg) => ctx.log(`[${agentId}] ${msg}`),
          runner: p.runner,
          skipSkillInstall: p.skipSkillInstall,
        });

        if (result.exitCode !== 0) {
          ctx.log(
            `[Agent: ${agentId}] Note: OpenCode process exited with code ${result.exitCode}. Checking for generated output...`,
          );
        } else {
          ctx.log(`[Agent: ${agentId}] OpenCode execution completed successfully.`);
        }

        completedCount++;
        ctx.progress(completedCount / agents.length, `Completed agent ${agentId}`);
      };

      // Worker pool for concurrency
      const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length > 0) {
          const nextAgent = queue.shift();
          if (nextAgent) {
            await runAgent(nextAgent);
          }
        }
      });

      await Promise.all(workers);

      ctx.log(`Ingesting generated Excel workbooks from ${workingDir}...`);
      const { sources, records } = await ingestOpenCodeDirectory(workingDir, agents);

      if (records.length === 0) {
        throw new Error(
          `OpenCode research completed but produced no valid .xlsx feedback records in ${workingDir}. ` +
            `Ensure the agent generated 'research_<agentId>.xlsx' with required columns.`,
        );
      }

      ctx.log(
        `Successfully ingested ${records.length} feedback records across ${sources.length} sources from OpenCode research.`,
      );

      return {
        status: "ok",
        outputs: {
          out: {
            ...emptyPipelineData(),
            sources,
            records,
          },
        },
      };
    },
  }),
];

export * from "./prompts";
export * from "./cli";
export * from "./ingest";
