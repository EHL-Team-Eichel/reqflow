import { emptyPipelineData, type PipelineData, type SourceKind } from "@reqflow/core";
import type { AnalyticsInput } from "./types";

/**
 * Synthetic data for the analytics tests: invented comments, never BMW's. Shaped like a feedback
 * export (ID, Country, Feedback Type, comment, date, a constant Brand column, a classification
 * column) and like a sales table (one row per market, one volume column per year).
 */
export interface FakeRow {
  id: string;
  country?: string;
  type?: string | string[];
  text: string;
  date?: string;
  engine?: string;
}

export function feedbackData(
  rows: readonly FakeRow[],
  opts: { source?: string; kind?: SourceKind; dateHeader?: string } = {},
): PipelineData {
  const sourceId = `src_${opts.source ?? "feedback"}`;
  return {
    ...emptyPipelineData(),
    sources: [
      {
        id: sourceId,
        kind: opts.kind ?? "customer_feedback",
        origin: "bmw_internal",
        title: `${opts.source ?? "feedback"}.xlsx`,
        retrievedAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    records: rows.map((r, i) => ({
      id: `rec_${opts.source ?? "feedback"}_${i + 2}`,
      sourceId,
      text: r.text,
      locator: `row ${i + 2}`,
      market: "EU",
      fields: {
        ID: r.id,
        Brand: "BMW",
        Country: r.country ?? null,
        "Feedback Type": r.type ?? null,
        "Customer Feedback": r.text,
        ...(r.date !== undefined ? { [opts.dateHeader ?? "Date"]: r.date } : {}),
        "Engine Type": r.engine ?? "ICE",
      },
    })),
  };
}

export function salesData(): PipelineData {
  const sourceId = "src_sales";
  const markets: [string, string, number, number, number][] = [
    ["Germany", "DE", 120, 130, 150],
    ["France", "FR", 80, 70, 90],
    ["Italy", "IT", 60, 65, 40],
  ];
  return {
    ...emptyPipelineData(),
    sources: [
      {
        id: sourceId,
        kind: "sales_volume",
        origin: "bmw_internal",
        title: "sales.xlsx",
        retrievedAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    records: markets.map(([market, code, a, b, c], i) => ({
      id: `rec_sales_${i + 2}`,
      sourceId,
      text: `market: ${market}; market_code: ${code}; volume_2024: ${a}; volume_2025: ${b}; volume_2030: ${c}`,
      fields: { market, market_code: code, volume_2024: a, volume_2025: b, volume_2030: c },
      locator: `row ${i + 2}`,
    })),
  };
}

export function readyInput(index: number, label: string, data: PipelineData): AnalyticsInput {
  return { index, port: `in-${index}`, label, status: "ready", data };
}

/** Twelve invented comments across three countries and three months. */
export const SAMPLE_ROWS: FakeRow[] = [
  {
    id: "A1",
    country: "DE",
    type: "Complaint",
    text: "The seat is uncomfortable on long trips.",
    date: "2025-01-10",
  },
  {
    id: "A2",
    country: "DE",
    type: "Praise",
    text: "Great navigation and a clear display.",
    date: "2025-01-22",
  },
  {
    id: "A3",
    country: "GB",
    type: "Complaint",
    text: "Wind noise above 120 km/h is annoying.",
    date: "2025-02-03",
    engine: "BEV",
  },
  {
    id: "A4",
    country: "GB",
    type: "Suggestion",
    text: "Please add wireless Apple CarPlay.",
    date: "2025-02-14",
  },
  {
    id: "A5",
    country: "FR",
    type: "Complaint",
    text: "The seat heating takes too long.",
    date: "2025-02-20",
  },
  {
    id: "A6",
    country: "FR",
    type: "Praise",
    text: "Love the design and the comfortable seat.",
    date: "2025-03-01",
  },
  {
    id: "A7",
    country: "DE",
    type: "Complaint",
    text: "Navigation lags and the screen freezes.",
    date: "2025-03-05",
  },
  {
    id: "A8",
    country: "DE",
    type: "Praise",
    text: "Excellent handling and steering.",
    date: "2025-03-09",
  },
  {
    id: "A1",
    country: "DE",
    type: "Complaint",
    text: "Also the trunk is too small.",
    date: "2025-03-12",
  },
  {
    id: "A9",
    country: "GB",
    type: "Complaint",
    text: "Road noise on the motorway.",
    date: "2025-03-15",
    engine: "BEV",
  },
  { id: "A10", type: "Suggestion", text: "A bigger screen would be nice.", date: "2025-03-20" },
  {
    id: "A11",
    country: "Germany",
    type: ["Complaint", "Praise"],
    text: "Good seat, bad noise.",
    date: "2025-03-28",
  },
];
