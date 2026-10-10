import {
  CollectedItem,
  ResearchLimits,
  ResearchProviderConfig,
  ResearchScope,
} from "@reqflow/core";
import { describe, expect, it, vi } from "vitest";
import type { ProviderContext } from "../provider";
import { createEurostatAdapter } from "./eurostat";

// Synthetic observations with Eurostat JSON-stat 2.0 dimensions and sparse values/status.
const fixture = () => ({
  version: "2.0",
  class: "dataset",
  label: "Synthetic count",
  source: "ESTAT",
  updated: "2025-01-01T00:00:00Z",
  id: ["unit", "geo", "time"],
  size: [1, 2, 2],
  value: { 0: 10, 2: 0 },
  status: { 0: "ep", 1: "c" },
  dimension: {
    unit: { label: "Unit of measure", category: { index: { NR: 0 }, label: { NR: "Number" } } },
    geo: {
      label: "Geopolitical entity",
      category: {
        index: { DE: 0, EU27_2020: 1 },
        label: { DE: "Germany", EU27_2020: "European Union - 27 countries (from 2020)" },
      },
    },
    time: {
      label: "Time",
      category: { index: { "2023": 0, "2024": 1 }, label: { "2023": "2023", "2024": "2024" } },
    },
  },
  note: ["Synthetic source footnote"],
  extension: {
    status: { label: { e: "estimated", p: "provisional", c: "confidential" } },
    annotation: [{ type: "NOTE", text: "Synthetic annotation" }],
  },
});
function context(pages: unknown[]): ProviderContext {
  return {
    http: {
      json: vi.fn().mockImplementation(async () => {
        const p = pages.shift();
        if (p instanceof Error) throw p;
        return p;
      }),
      text: vi.fn(),
      requests: 0,
    },
    credentials: {},
    config: ResearchProviderConfig.parse({ enabled: true }),
    limits: ResearchLimits.parse({}),
    signal: new AbortController().signal,
    log: vi.fn(),
    now: () => "2026-10-10T00:00:00.000Z",
  };
}
const request = (
  datasets: { id: string; filters: Record<string, string> }[] = [
    { id: "demo_pjan", filters: { geo: "DE", sinceTimePeriod: "2023", untilTimePeriod: "2024" } },
  ],
) => ({
  agentId: "regional_context" as const,
  queries: [],
  scope: ResearchScope.parse({ eurostatDatasets: datasets }),
});

describe("Eurostat adapter", () => {
  it("requires explicit datasets and never substitutes random statistics or EU geography", async () => {
    const ctx = context([]);
    const result = await createEurostatAdapter().collect(request([]), ctx);
    expect(result.status).toBe("blocked");
    expect(ctx.http.json).not.toHaveBeenCalled();
  });
  it("preserves dimension order, code/labels, nulls, zero, exact quality flags, units and notes", async () => {
    const ctx = context([fixture()]);
    const result = await createEurostatAdapter().collect(request(), ctx);
    expect(result.status).toBe("success");
    const item = CollectedItem.parse(result.items[0]);
    expect(item.recordType).toBe("table");
    expect(item.table?.headers).toEqual([
      "unit",
      "unit_label",
      "geo",
      "geo_label",
      "time",
      "time_label",
      "value",
      "status",
    ]);
    expect(item.table?.rows[0]).toEqual([
      "NR",
      "Number",
      "DE",
      "Germany",
      "2023",
      "2023",
      10,
      "ep",
    ]);
    expect(item.table?.rows[1]?.slice(-2)).toEqual([null, "c"]);
    expect(item.table?.rows[2]?.slice(-2)).toEqual([0, null]);
    expect(item.table?.units).toEqual(["Number"]);
    expect(item.table?.footnotes).toContain("Synthetic source footnote");
    expect(item.table?.footnotes).toContain("Synthetic annotation");
    expect(item.table?.dimensions).toEqual(fixture().dimension);
    expect(item.metadata.extension).toEqual(fixture().extension);
    expect(item.market).toBeUndefined();
    const url = new URL(vi.mocked(ctx.http.json).mock.calls[0]![0]);
    expect(url.searchParams.get("geo")).toBe("DE");
    expect(url.searchParams.get("sinceTimePeriod")).toBe("2023");
    expect(url.searchParams.get("untilTimePeriod")).toBe("2024");
  });
  it("accepts array indexes and dense arrays, rejects invalid shapes without silent data loss", async () => {
    const data = fixture();
    const ctx = context([
      {
        ...data,
        value: [1, null, 3, 4],
        status: "p",
        dimension: {
          ...data.dimension,
          geo: {
            category: { index: ["DE", "EU27_2020"], label: data.dimension.geo.category.label },
          },
        },
      },
    ]);
    const result = await createEurostatAdapter().collect(request(), ctx);
    expect(result.items[0]?.table?.rows[3]?.slice(-2)).toEqual([4, "p"]);
    const bad = await createEurostatAdapter().collect(
      request(),
      context([{ ...data, size: [1, 3, 2] }]),
    );
    expect(bad.status).toBe("error");
    expect(bad.items).toHaveLength(0);
  });
  it("reports partial dataset failure and asynchronous response without fabricating data", async () => {
    const result = await createEurostatAdapter().collect(
      request([
        { id: "one", filters: {} },
        { id: "two", filters: {} },
      ]),
      context([fixture(), { warning: { status: 413, label: "ASYNCHRONOUS_RESPONSE" } }]),
    );
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(1);
    expect(result.limitations.join(" ")).toMatch(/asynchronous/i);
  });
  it("rejects incompatible time/geo filters and does not equate publication dates with observation periods", async () => {
    const ctx = context([]);
    const result = await createEurostatAdapter().collect(
      request([{ id: "demo_pjan", filters: { time: "2024", lastTimePeriod: "1" } }]),
      ctx,
    );
    expect(result.status).toBe("blocked");
    expect(ctx.http.json).not.toHaveBeenCalled();
    const dated = context([fixture()]);
    await createEurostatAdapter().collect(
      {
        ...request(),
        scope: ResearchScope.parse({
          publishedFrom: "2022-01-01",
          eurostatDatasets: [{ id: "demo_pjan", filters: { freq: "A", geo: "DE" } }],
        }),
      },
      dated,
    );
    expect(
      new URL(vi.mocked(dated.http.json).mock.calls[0]![0]).searchParams.has("sinceTimePeriod"),
    ).toBe(false);
  });
  it("connection probe fetches only one tiny predefined observation, not a research run", async () => {
    const ctx = context([fixture()]);
    expect((await createEurostatAdapter().test(ctx)).state).toBe("success");
    expect(ctx.http.json).toHaveBeenCalledTimes(1);
    const url = new URL(vi.mocked(ctx.http.json).mock.calls[0]![0]);
    expect(url.searchParams.get("lastTimePeriod")).toBe("1");
    expect(url.searchParams.get("geo")).toBe("DE");
    expect(url.searchParams.get("age")).toBe("TOTAL");
  });
  it("retains category-specific footnotes/unit metadata and rejects oversized observations instead of dropping them", async () => {
    const data = fixture();
    const category = {
      ...data.dimension.geo.category,
      note: { DE: "Synthetic geographic definition" },
      unit: { DE: { label: "persons", decimals: 0 } },
    };
    const result = await createEurostatAdapter().collect(
      request(),
      context([
        { ...data, dimension: { ...data.dimension, geo: { ...data.dimension.geo, category } } },
      ]),
    );
    expect(result.items[0]?.table?.units).toContain("persons");
    expect(result.items[0]?.table?.footnotes.join(" ")).toContain(
      "Synthetic geographic definition",
    );
    const oversized = await createEurostatAdapter().collect(
      request(),
      context([{ ...data, size: [1, 10001, 2] }]),
    );
    expect(oversized.items).toHaveLength(0);
    expect(oversized.limitations.join(" ")).toMatch(/narrow filters/i);
  });
});
