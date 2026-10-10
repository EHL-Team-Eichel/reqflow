import { CollectedItem, ResearchLimits, ResearchScope, type ConnectionReport } from "@reqflow/core";
import { z } from "zod";
import { ProviderError, type ProviderAdapter, type ProviderContext } from "../provider";

const Dimension = z
  .object({
    label: z.string().optional(),
    category: z
      .object({
        index: z.union([z.record(z.string(), z.number().int().nonnegative()), z.array(z.string())]),
        label: z.record(z.string(), z.string()).optional(),
      })
      .passthrough(),
  })
  .passthrough();
const Dataset = z
  .object({
    version: z.literal("2.0"),
    class: z.literal("dataset"),
    label: z.string().optional(),
    id: z.array(z.string()).min(1),
    size: z.array(z.number().int().nonnegative()),
    dimension: z.record(z.string(), Dimension),
    value: z.union([z.array(z.number().nullable()), z.record(z.string(), z.number().nullable())]),
    status: z
      .union([
        z.string(),
        z.array(z.string().nullable()),
        z.record(z.string(), z.string().nullable()),
      ])
      .optional(),
    updated: z.string().optional(),
    source: z.string().optional(),
    note: z.unknown().optional(),
    extension: z.unknown().optional(),
  })
  .passthrough();
const COVERAGE = [
  "Raw Eurostat observations only; no inferred customer preference, vehicle attribution or forecast.",
  "Geography codes and labels are preserved exactly; EU, Europe and individual markets are not treated as equivalent.",
  "Publication date scope is not an observation time filter; select time/sinceTimePeriod/untilTimePeriod explicitly.",
];
const ENDPOINT = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/";
const MAX_CELLS = 20_000;
function requestUrl(id: string, filters: Record<string, string>, languages: string[]): string {
  const normalized = Object.fromEntries(
    Object.entries(filters).map(([key, value]) => [key.toLowerCase(), value]),
  );
  if (Object.keys(normalized).length !== Object.keys(filters).length)
    throw new ProviderError("unsupported", "Duplicate filters");
  const time = [
    "time",
    "time_period",
    "sincetimeperiod",
    "untiltimeperiod",
    "lasttimeperiod",
  ].filter((key) => key in normalized);
  if (
    time.length > 1 &&
    !(time.length === 2 && time.includes("sincetimeperiod") && time.includes("untiltimeperiod"))
  )
    throw new ProviderError("unsupported", "Incompatible time filters");
  if ("geo" in normalized && "geolevel" in normalized)
    throw new ProviderError("unsupported", "Incompatible geography filters");
  const url = new URL(`${ENDPOINT}${id}`);
  url.searchParams.set("format", "JSON");
  url.searchParams.set(
    "lang",
    languages.map((l) => l.toUpperCase()).find((l) => ["EN", "DE", "FR"].includes(l)) || "EN",
  );
  for (const [key, value] of Object.entries(filters)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) || /key|token|password|url|format|lang/i.test(key))
      throw new ProviderError("unsupported", "Invalid dimension filter");
    url.searchParams.set(key, value);
  }
  return url.toString();
}
function notes(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(notes);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const text = object.text ?? object.label ?? object.title;
    return typeof text === "string" ? [text] : [JSON.stringify(object)];
  }
  return [String(value)];
}
function tableItem(raw: unknown, id: string, sourceUrl: string): CollectedItem | undefined {
  const envelope = z
    .object({ warning: z.unknown().optional(), error: z.unknown().optional() })
    .passthrough()
    .parse(raw);
  if (envelope.warning)
    throw new ProviderError(
      "limit_reached",
      "Eurostat asynchronous response; narrow dataset filters and retry later.",
    );
  if (envelope.error) throw new ProviderError("unreachable", "Eurostat query failed.");
  const data = Dataset.parse(raw);
  if (data.id.length !== data.size.length || new Set(data.id).size !== data.id.length)
    throw new ProviderError("unsupported", "Invalid dimensions");
  const count = data.size.reduce((product, size) => product * size, 1);
  if (!Number.isSafeInteger(count) || count > MAX_CELLS)
    throw new ProviderError(
      "limit_reached",
      "Eurostat dataset exceeds local observation limit; narrow filters.",
    );
  const codes = data.id.map((dimension, i) => {
    const index = data.dimension[dimension]?.category.index;
    if (!index) throw new ProviderError("unsupported", "Missing dimension");
    const sorted = Array.isArray(index)
      ? index
      : Object.entries(index)
          .sort((a, b) => a[1] - b[1])
          .map(([code]) => code);
    if (
      sorted.length !== data.size[i] ||
      new Set(sorted).size !== sorted.length ||
      (!Array.isArray(index) && sorted.some((code, position) => index[code] !== position))
    )
      throw new ProviderError("unsupported", "Invalid category index");
    return sorted;
  });
  for (const values of [data.value, data.status]) {
    if (!values || typeof values === "string") continue;
    if (
      Array.isArray(values)
        ? values.length > count
        : Object.keys(values).some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= count)
    )
      throw new ProviderError("unsupported", "Invalid observation index");
  }
  if (!count) return undefined;
  const headers = [
    ...data.id.flatMap((dimension) => [dimension, `${dimension}_label`]),
    "value",
    "status",
  ];
  const rows = Array.from({ length: count }, (_, position) => {
    let remainder = position;
    const indices = new Array<number>(data.id.length);
    for (let i = data.id.length - 1; i >= 0; i--) {
      indices[i] = remainder % data.size[i]!;
      remainder = Math.floor(remainder / data.size[i]!);
    }
    const coordinates = data.id.flatMap((dimension, i) => {
      const code = codes[i]![indices[i]!]!;
      return [code, data.dimension[dimension]?.category.label?.[code] ?? null];
    });
    const value = data.value[String(position) as keyof typeof data.value] ?? null;
    const status =
      typeof data.status === "string"
        ? data.status
        : (data.status?.[String(position) as keyof typeof data.status] ?? null);
    return [...coordinates, value, status];
  });
  const extension =
    data.extension && typeof data.extension === "object"
      ? (data.extension as Record<string, unknown>)
      : {};
  const footnotes = [
    ...notes(data.note),
    ...notes(extension.note),
    ...notes(extension.annotation),
    ...data.id.flatMap((id) => {
      const dimension = data.dimension[id]!;
      return [...notes(dimension.note), ...notes(dimension.category.note)];
    }),
  ];
  const unit = data.id.find((d) => d.toLowerCase() === "unit");
  const units = unit
    ? Object.values(data.dimension[unit]?.category.label ?? {}).length
      ? Object.values(data.dimension[unit]!.category.label!)
      : codes[data.id.indexOf(unit)]!
    : [];
  for (const dimension of Object.values(data.dimension)) {
    const categoryUnits = dimension.category.unit;
    if (categoryUnits && typeof categoryUnits === "object") {
      for (const value of Object.values(categoryUnits)) {
        if (
          value &&
          typeof value === "object" &&
          "label" in value &&
          typeof value.label === "string" &&
          !units.includes(value.label)
        )
          units.push(value.label);
      }
    }
  }
  return CollectedItem.parse({
    provider: "eurostat",
    sourceId: id,
    sourceUrl,
    sourceTitle: data.label || id,
    sourceKind: "market_trend",
    publisher: "Eurostat",
    recordId: `${id}:${new URL(sourceUrl).searchParams.toString()}`,
    recordType: "table",
    text: [
      data.label || id,
      headers.join("\t"),
      ...rows.map((row) =>
        row.map((value) => (value === null ? "null" : String(value))).join("\t"),
      ),
    ].join("\n"),
    locator: `JSON-stat dataset ${id}; row-major observations 0-${count - 1}`,
    table: { headers, rows, units, footnotes, dimensions: data.dimension },
    metadata: {
      datasetId: id,
      dimensionOrder: data.id,
      size: data.size,
      updated: data.updated,
      source: data.source,
      note: data.note,
      extension: data.extension,
      rawValue: data.value,
      rawStatus: data.status,
      qualityFlagsPreserved: true,
    },
    limitations: [...COVERAGE],
  });
}
function failure(
  error: unknown,
  ctx: ProviderContext,
): { state: ConnectionReport["state"]; message: string } {
  if (ctx.signal.aborted || (error instanceof ProviderError && error.code === "cancelled"))
    return { state: "unreachable", message: "Eurostat request cancelled." };
  if (error instanceof ProviderError && error.code === "rate_limited")
    return { state: "rate_limited", message: "Eurostat rate limit reached." };
  if (error instanceof ProviderError && error.code === "limit_reached")
    return {
      state: "unsupported",
      message: error.message.startsWith("Eurostat ")
        ? error.message
        : "Eurostat request budget reached.",
    };
  if (error instanceof ProviderError && error.code === "unsupported")
    return {
      state: "unsupported",
      message: "Eurostat query or JSON-stat dimensions are unsupported or incompatible.",
    };
  return {
    state: "unreachable",
    message: "Eurostat request failed or returned invalid JSON-stat data.",
  };
}

export function createEurostatAdapter(): ProviderAdapter {
  return {
    id: "eurostat",
    async collect(request, ctx) {
      const scope = ResearchScope.parse(request.scope),
        limits = ResearchLimits.parse(ctx.limits);
      if (!scope.eurostatDatasets.length)
        return {
          items: [],
          status: "blocked",
          limitations: [
            ...COVERAGE,
            "Select explicit scope.eurostatDatasets and dimension filters before collecting statistics.",
          ],
        };
      const items: CollectedItem[] = [],
        limitations = [...COVERAGE],
        seen = new Set<string>();
      let failed = false,
        blocked = false,
        requests = 0;
      for (const dataset of scope.eurostatDatasets) {
        if (ctx.signal.aborted)
          return {
            items,
            status: "cancelled",
            limitations: [...limitations, "Eurostat request cancelled."],
          };
        if (
          items.length >= limits.maxResults ||
          requests >= limits.maxRequests ||
          ctx.http.requests >= limits.maxRequests
        )
          return {
            items,
            status: "partial",
            limitations: [
              ...limitations,
              "Eurostat dataset collection truncated by request/result limit.",
            ],
          };
        let dispatched = false;
        try {
          const url = requestUrl(dataset.id, dataset.filters, scope.languages);
          if (seen.has(url)) continue;
          seen.add(url);
          requests++;
          dispatched = true;
          const item = tableItem(await ctx.http.json(url, { signal: ctx.signal }), dataset.id, url);
          if (item) items.push(item);
        } catch (error) {
          if (ctx.signal.aborted || (error instanceof ProviderError && error.code === "cancelled"))
            return {
              items,
              status: "cancelled",
              limitations: [...limitations, "Eurostat request cancelled."],
            };
          failed = true;
          blocked ||= !dispatched && error instanceof ProviderError && error.code === "unsupported";
          limitations.push(`${dataset.id}: ${failure(error, ctx).message}`);
        }
      }
      return {
        items,
        status: failed
          ? items.length
            ? "partial"
            : blocked
              ? "blocked"
              : "error"
          : items.length
            ? "success"
            : "empty",
        limitations,
      };
    },
    async test(ctx) {
      try {
        if (ctx.signal.aborted) throw new ProviderError("cancelled", "Cancelled");
        if (ctx.http.requests >= ctx.limits.maxRequests)
          throw new ProviderError("limit_reached", "Budget reached");
        const url = requestUrl(
          "demo_pjan",
          { geo: "DE", sex: "T", age: "TOTAL", lastTimePeriod: "1" },
          ["en"],
        );
        tableItem(await ctx.http.json(url, { signal: ctx.signal }), "demo_pjan", url);
        return {
          state: "success",
          message: "Eurostat JSON-stat API available (single-observation connection probe).",
          testedAt: ctx.now(),
          capabilities: ["explicit_datasets", "dimensions", "raw_metrics", "quality_flags"],
          limitations: [...COVERAGE],
        };
      } catch (error) {
        return {
          ...failure(error, ctx),
          testedAt: ctx.now(),
          capabilities: [],
          limitations: [...COVERAGE],
        };
      }
    },
  };
}
