import { CollectedItem, ConnectionReport, ResearchLimits, ResearchScope } from "@reqflow/core";
import { ProviderError, type ProviderAdapter } from "../provider";

export function createLocalDocumentsAdapter(): ProviderAdapter {
  return {
    id: "local_documents",
    async collect(request, ctx) {
      const scope = ResearchScope.parse(request.scope),
        limits = ResearchLimits.parse(ctx.limits);
      if (!ctx.documents)
        return {
          items: [],
          status: "blocked",
          limitations: ["Main-process local document reader is not configured; no cloud fallback."],
        };
      if (!scope.documentIds.length)
        return { items: [], status: "empty", limitations: ["No imported document IDs selected."] };
      const items: CollectedItem[] = [],
        limitations: string[] = [],
        seen = new Set<string>();
      let failed = false,
        unsupported = false,
        reads = 0;
      for (const fileId of new Set(scope.documentIds)) {
        if (ctx.signal.aborted)
          return {
            items,
            status: "cancelled",
            limitations: [...limitations, "Local document collection cancelled."],
          };
        if (items.length >= limits.maxResults || reads >= limits.maxRequests)
          return {
            items,
            status: "partial",
            limitations: [
              ...limitations,
              "Local document collection truncated by result/read limit.",
            ],
          };
        try {
          reads++;
          const records = await ctx.documents.read(fileId, limits.maxDocumentPages, ctx.signal);
          for (const record of records) {
            const item = CollectedItem.parse(record);
            if (
              item.provider !== "local_documents" ||
              item.sourceId !== fileId ||
              item.sourceUrl !== `reqflow-file:///${fileId}`
            )
              throw new ProviderError("unsupported", "Invalid local source identity");
            if (seen.has(item.recordId)) continue;
            if (items.length >= limits.maxResults)
              return {
                items,
                status: "partial",
                limitations: [...limitations, "Local document records truncated by result limit."],
              };
            seen.add(item.recordId);
            items.push(item);
            for (const limitation of item.limitations)
              if (!limitations.includes(limitation)) limitations.push(limitation);
          }
        } catch (error) {
          if (ctx.signal.aborted || (error instanceof ProviderError && error.code === "cancelled"))
            return {
              items,
              status: "cancelled",
              limitations: [...limitations, "Local document collection cancelled."],
            };
          failed = true;
          unsupported ||= error instanceof ProviderError && error.code === "unsupported";
          limitations.push(
            `${fileId}: ${error instanceof ProviderError && error.code === "unsupported" ? "Local format/runtime unsupported; no cloud fallback." : "Local document read failed."}`,
          );
        }
      }
      return {
        items,
        status: failed
          ? items.length
            ? "partial"
            : unsupported
              ? "blocked"
              : "error"
          : items.length
            ? "success"
            : "empty",
        limitations,
      };
    },
    async test(ctx) {
      if (!ctx.documents)
        return {
          state: "not_configured",
          message: "Main-process local document reader is not configured.",
          capabilities: [],
          limitations: ["No cloud fallback."],
        };
      try {
        return ConnectionReport.parse(await ctx.documents.available());
      } catch {
        return {
          state: "unsupported",
          message: "Local parser availability check failed.",
          capabilities: [],
          limitations: ["No cloud fallback."],
        };
      }
    },
  };
}
