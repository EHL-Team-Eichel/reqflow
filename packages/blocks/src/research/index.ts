import { defineBlock, type BlockImplementation } from "@reqflow/engine";
import { emptyPipelineData, FileRef, ResearchRequest, ResearchScope } from "@reqflow/core";
import { mergeResearchDomainPolicy } from "./runtime";

// Owner: WS6 — the Research block emits only original source records, never analysis.
export const researchImplementations: BlockImplementation<"research">[] = [
  defineBlock({
    kind: "research",
    async run(_inputs, params, ctx) {
      if (!ctx.research) throw new Error("Research runtime is not configured in the main process.");
      if (!Array.isArray(params.agents) || !params.agents.length)
        throw new Error("No research agents selected. Select at least one agent before running.");
      if (params.queryPlanning !== undefined && typeof params.queryPlanning !== "boolean")
        throw new Error("Research queryPlanning must be a boolean.");
      let advanced: unknown;
      try {
        advanced = JSON.parse(typeof params.scopeJson === "string" ? params.scopeJson : "{}");
      } catch {
        throw new Error("Advanced research scope must be valid JSON.");
      }
      if (!advanced || typeof advanced !== "object" || Array.isArray(advanced))
        throw new Error("Advanced research scope must be a JSON object.");
      const from = new Date();
      from.setUTCMonth(from.getUTCMonth() - Number(params.maxAgeMonths ?? 24));
      const document = FileRef.nullable().parse(params.document ?? null);
      const scope = ResearchScope.parse({
        brand: "BMW",
        model: ctx.scope.vehicleLine,
        derivative: ctx.scope.derivative,
        markets: [params.market === "global" || !params.market ? ctx.scope.market : params.market],
        horizonYears: ctx.scope.horizonYears,
        questions:
          typeof params.question === "string" && params.question.trim() ? [params.question] : [],
        publishedFrom: from.toISOString().slice(0, 10),
        ...(document ? { documentIds: [document.fileId] } : {}),
        ...advanced,
      });
      const request = ResearchRequest.parse({
        scope: { ...scope, ...mergeResearchDomainPolicy(ctx.settings.research, scope) },
        agents: params.agents,
        limits: {
          maxResults: params.maxResults ?? 10,
          maxRequests: params.maxRequests ?? 100,
          maxDocumentPages: params.maxDocumentPages ?? 20,
          timeoutMs: params.timeoutMs ?? 120000,
          concurrency: params.concurrency ?? 3,
        },
      });
      const collectionContext = {
        runId: ctx.runId,
        signal: ctx.signal,
        log: ctx.log,
        progress: ctx.progress,
        planQueries: params.queryPlanning === true,
      };
      // The collector persists every agent result before returning, including unsuccessful empty runs.
      const dataset = await ctx.research.collect(request, collectionContext);
      if (
        !dataset.records.length &&
        !dataset.results.some((result) => result.status === "empty" || result.status === "success")
      ) {
        const detail = dataset.results
          .map(
            (result) =>
              `${result.agentId} [${result.status}]: ${result.limitations.join("; ") || "No original records collected."}`,
          )
          .join(" | ");
        throw new Error(
          `Research collection failed: ${detail || "Collector returned no agent results."}`,
        );
      }
      return {
        status: "ok",
        outputs: {
          out: { ...emptyPipelineData(), sources: dataset.sources, records: dataset.records },
        },
      };
    },
  }),
];
