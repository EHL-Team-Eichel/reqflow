import {
  CollectedItem,
  ResearchLimits,
  ResearchProviderConfig,
  ResearchScope,
} from "@reqflow/core";
import { describe, expect, it, vi } from "vitest";
import { ProviderError, type ProviderContext } from "../provider";
import { createOpenAlexAdapter } from "./openalex";

// Synthetic records in the official /works response shape, not real study content.
const work = (id: number) => ({
  id: `https://openalex.org/W${id}`,
  title: "Synthetic charging study",
  doi: "https://doi.org/10.0000/synthetic",
  publication_date: "2025-05-01",
  publication_year: 2025,
  language: "en",
  type: "article",
  authorships: [{ author: { display_name: "Synthetic Author" } }],
  abstract_inverted_index: { Charging: [0], is: [1], "slow.": [2] },
  primary_location: {
    is_oa: true,
    pdf_url: "https://example.org/original.pdf",
    landing_page_url: "https://example.org/study",
    source: { display_name: "Synthetic Journal" },
  },
  open_access: { is_oa: true, oa_status: "gold" },
  is_retracted: false,
});
function context(pages: unknown[], overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    http: {
      json: vi.fn().mockImplementation(async () => {
        const page = pages.shift();
        if (page instanceof Error) throw page;
        return page;
      }),
      text: vi.fn(),
      requests: 0,
    },
    credentials: {},
    config: ResearchProviderConfig.parse({ enabled: true }),
    limits: ResearchLimits.parse({ maxResults: 10 }),
    signal: new AbortController().signal,
    log: vi.fn(),
    now: () => "2026-10-10T00:00:00.000Z",
    ...overrides,
  };
}
const request = () => ({
  agentId: "market_studies" as const,
  queries: ["charging comfort"],
  scope: ResearchScope.parse({ publishedFrom: "2024-01-01", publishedTo: "2025-12-31" }),
});

describe("OpenAlex adapter", () => {
  it("uses scope filters, follows cursors, deduplicates works and labels original reconstructed abstracts", async () => {
    const ctx = context([
      { meta: { next_cursor: "next/+=" }, results: [work(1)] },
      { meta: { next_cursor: null }, results: [work(1), work(2)] },
    ]);
    const result = await createOpenAlexAdapter().collect(request(), ctx);
    expect(result.status).toBe("success");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.text).toBe("ABSTRACT\nCharging is slow.");
    expect(result.items[0]?.metadata.contentLevel).toBe("abstract");
    expect(result.items[0]?.metadata.primaryOriginal).toEqual({
      url: "https://example.org/original.pdf",
      retrieved: false,
      accessibility: "provider_metadata",
    });
    result.items.forEach((item) => CollectedItem.parse(item));
    const calls = vi.mocked(ctx.http.json).mock.calls;
    expect(new URL(calls[0]![0]).searchParams.get("filter")).toBe(
      "from_publication_date:2024-01-01,to_publication_date:2025-12-31,language:en|de",
    );
    expect(new URL(calls[1]![0]).searchParams.get("cursor")).toBe("next/+=");
    expect(ctx.http.text).not.toHaveBeenCalled();
    expect(result.items[0]?.market).toBeUndefined();
  });
  it("uses optional API key only in Authorization, never in records or logs", async () => {
    const ctx = context([{ meta: { next_cursor: null }, results: [work(1)] }], {
      credentials: { openalex_api_key: "synthetic-test-key" },
    });
    const result = await createOpenAlexAdapter().collect(request(), ctx);
    expect(vi.mocked(ctx.http.json).mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: "Bearer synthetic-test-key",
    });
    expect(vi.mocked(ctx.http.json).mock.calls[0]?.[0]).not.toContain("synthetic-test-key");
    expect(JSON.stringify(result)).not.toContain("synthetic-test-key");
    expect(ctx.log).not.toHaveBeenCalled();
  });
  it("returns metadata only when abstract absent and never claims complete commercial studies", async () => {
    const ctx = context([
      { meta: { next_cursor: null }, results: [{ ...work(1), abstract_inverted_index: null }] },
    ]);
    const result = await createOpenAlexAdapter().collect(request(), ctx);
    expect(result.items[0]?.recordType).toBe("metadata");
    expect(result.items[0]?.text).toBe("Synthetic charging study");
    expect(result.limitations.join(" ")).toMatch(/commercial/i);
  });
  it("keeps prior pages on failure, sanitizes messages, and reports bounded pagination", async () => {
    const ctx = context([
      { meta: { next_cursor: "more" }, results: [work(1)] },
      new ProviderError("rate_limited", "secret URL must not escape"),
    ]);
    const result = await createOpenAlexAdapter().collect(request(), ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("secret URL");
    const bounded = context([{ meta: { next_cursor: "more" }, results: [work(1)] }], {
      limits: ResearchLimits.parse({ maxResults: 1 }),
    });
    expect((await createOpenAlexAdapter().collect(request(), bounded)).status).toBe("partial");
  });
  it("rejects incomplete inverted indexes instead of inventing missing words", async () => {
    const ctx = context([
      {
        meta: { next_cursor: null },
        results: [{ ...work(1), abstract_inverted_index: { incomplete: [2] } }],
      },
    ]);
    const result = await createOpenAlexAdapter().collect(request(), ctx);
    expect(result.items[0]?.recordType).toBe("metadata");
    expect(result.items[0]?.limitations.join(" ")).toMatch(/index/i);
  });
  it("connection probe is one tiny metadata search; cancellation performs no request", async () => {
    const ctx = context([
      {
        meta: { next_cursor: null },
        results: [{ id: "https://openalex.org/W1", title: "Synthetic" }],
      },
    ]);
    expect((await createOpenAlexAdapter().test(ctx)).state).toBe("success");
    const url = new URL(vi.mocked(ctx.http.json).mock.calls[0]![0]);
    expect(url.searchParams.get("per_page")).toBe("1");
    expect(url.searchParams.get("select")).toBe("id,title");
    const cancelled = context([], { signal: AbortSignal.abort() });
    expect((await createOpenAlexAdapter().collect(request(), cancelled)).status).toBe("cancelled");
    expect(cancelled.http.json).not.toHaveBeenCalled();
  });
});
