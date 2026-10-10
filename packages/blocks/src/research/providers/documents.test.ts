import {
  CollectedItem,
  ResearchLimits,
  ResearchProviderConfig,
  ResearchScope,
} from "@reqflow/core";
import { describe, expect, it, vi } from "vitest";
import { ProviderError, type ProviderContext } from "../provider";
import { createLocalDocumentsAdapter } from "./documents";

const record = {
  provider: "local_documents",
  sourceId: "file_synthetic",
  sourceUrl: "reqflow-file:///file_synthetic",
  sourceTitle: "Synthetic",
  recordId: "file_synthetic:text",
  recordType: "passage",
  text: "Synthetic document.",
};
function context(): ProviderContext {
  return {
    http: { json: vi.fn(), text: vi.fn(), requests: 0 },
    credentials: {},
    config: ResearchProviderConfig.parse({ enabled: true }),
    limits: ResearchLimits.parse({}),
    signal: new AbortController().signal,
    log: vi.fn(),
    now: () => "2026-10-10T00:00:00.000Z",
    documents: {
      read: vi.fn().mockResolvedValue([record]),
      available: vi.fn().mockResolvedValue({
        state: "success",
        message: "TXT/XLSX available",
        capabilities: ["txt", "xlsx"],
        limitations: ["Docling unavailable"],
      }),
    },
  };
}
const request = (ids = ["file_synthetic"]) => ({
  agentId: "bmw_sales" as const,
  queries: [],
  scope: ResearchScope.parse({ documentIds: ids }),
});

describe("local documents adapter", () => {
  it("uses only injected imported IDs, deduplicates IDs and performs no network requests", async () => {
    const ctx = context();
    const result = await createLocalDocumentsAdapter().collect(
      request(["file_synthetic", "file_synthetic"]),
      ctx,
    );
    expect(result.status).toBe("success");
    expect(result.items).toHaveLength(1);
    expect(ctx.documents?.read).toHaveBeenCalledExactlyOnceWith("file_synthetic", 20, ctx.signal);
    expect(ctx.http.json).not.toHaveBeenCalled();
    expect(ctx.http.text).not.toHaveBeenCalled();
  });
  it("reports missing reader and unsupported documents explicitly and preserves prior records", async () => {
    const missing = context();
    delete missing.documents;
    expect((await createLocalDocumentsAdapter().collect(request(), missing)).status).toBe(
      "blocked",
    );
    const ctx = context();
    vi.mocked(ctx.documents!.read).mockRejectedValueOnce(
      new ProviderError("unsupported", "private/path"),
    );
    const result = await createLocalDocumentsAdapter().collect(
      request(["file_bad", "file_synthetic"]),
      ctx,
    );
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private/path");
  });
  it("propagates cheap parser availability and caps results visibly", async () => {
    const ctx = context();
    expect((await createLocalDocumentsAdapter().test(ctx)).limitations).toContain(
      "Docling unavailable",
    );
    ctx.limits = ResearchLimits.parse({ maxResults: 1 });
    expect(
      (await createLocalDocumentsAdapter().collect(request(["file_synthetic", "file_other"]), ctx))
        .status,
    ).toBe("partial");
    expect(ctx.documents?.read).toHaveBeenCalledTimes(1);
  });
  it("lets both BMW agents reuse one parent-cached import without changing original record identities", async () => {
    const ctx = context();
    const underlyingRead = vi.fn().mockResolvedValue([CollectedItem.parse(record)]);
    const cache = new Map<string, Promise<CollectedItem[]>>();
    ctx.documents!.read = async (id, pages) => {
      const key = `${id}:${pages}`;
      if (!cache.has(key)) cache.set(key, underlyingRead());
      return cache.get(key)!;
    };
    const adapter = createLocalDocumentsAdapter();
    const [sales, strategy] = await Promise.all([
      adapter.collect(request(), ctx),
      adapter.collect({ ...request(), agentId: "bmw_strategy" }, ctx),
    ]);
    expect(underlyingRead).toHaveBeenCalledTimes(1);
    expect(sales.items[0]?.recordId).toBe(strategy.items[0]?.recordId);
  });
});
