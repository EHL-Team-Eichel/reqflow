import type { PipelineData, SourceKind, TimeGranularity } from "@reqflow/core";

/**
 * Types of the analytics engine. Everything here is computed from the data that arrives on the
 * block's inputs, by rules only: no model call, nothing invented. A record without a country or a
 * time stays "unknown" and is counted as such, never guessed.
 */

export type Granularity = Exclude<TimeGranularity, "auto">;

/** One input port of the Analytics block and what arrived on it. */
export interface AnalyticsInput {
  index: number; // port position: 0 for "in-0"
  port: string; // "in-0"
  label: string; // the name the user gave the input ("Input 1", "F70 EU", …)
  status: "ready" | "loading" | "unconnected" | "needs_run" | "error";
  data: PipelineData | null; // only when status is "ready"
  message?: string; // why there is no data (needs_run, error)
}

export type Sentiment = "positive" | "neutral" | "negative";
export const SENTIMENTS: readonly Sentiment[] = ["positive", "neutral", "negative"];

/** One record, reduced to what the charts need. */
export interface AnalyticsRow {
  id: string; // the record id (rec_…)
  input: number; // index of the input it arrived on
  sourceId: string;
  sourceTitle: string;
  sourceKind: SourceKind;
  text: string;
  words: number;
  /** ISO 3166-1 alpha-2 code when recognised ("DE"), else the trimmed original value; null = none. */
  country: string | null;
  /** UTC epoch milliseconds of the record's time value; null when it has none. */
  time: number | null;
  /** Who said it (the ID column's value): several records can be one person. null = unknown. */
  person: string | null;
  language: string | null;
  sentiment: Sentiment;
  sentimentScore: number; // -1 … 1
  /** Where the sentiment comes from: a column like "Feedback Type", or the word lexicon. */
  sentimentFrom: "column" | "lexicon";
  topics: string[]; // topic ids from the rule lexicon (topics.ts), in lexicon order
  /** Values of the categorical columns (merged rows can carry several values per column). */
  categories: Record<string, string[]>;
  locator?: string;
}

export type ColumnRole =
  "country" | "time" | "id" | "text" | "category" | "number" | "year_series" | "other";

export interface ColumnProfile {
  name: string;
  role: ColumnRole;
  filled: number; // records with a value
  distinct: number; // distinct values (lists count each entry)
}

/** A numeric column named by a year ("volume_2024"): a value per row and year. */
export interface YearSeriesPoint {
  year: number;
  column: string;
  /** The row's label: its country when known, else its first text column, else the record id. */
  label: string;
  country: string | null;
  input: number;
  value: number;
  /** True for years after the current year: a plan, not an actual. */
  planned: boolean;
}

export interface AnalyticsDataset {
  inputs: { index: number; label: string; records: number; sources: number }[];
  rows: AnalyticsRow[];
  columns: ColumnProfile[];
  countryColumn: string | null;
  timeColumn: string | null;
  idColumn: string | null;
  sentimentColumn: string | null;
  /** Low-cardinality columns that work as chart dimensions (Source, Engine Type, …). */
  categoryColumns: string[];
  /** True when most records are people's words (feedback), false for tables of figures. */
  textual: boolean;
  yearSeries: YearSeriesPoint[];
  /** Plain-language notes on what was detected and what is missing ("No time column …"). */
  notes: string[];
}

export interface BuildOptions {
  countryColumn?: string; // "" or undefined = detect
  timeColumn?: string; // "" or undefined = detect
  now?: number; // epoch ms, for "planned" years; defaults to Date.now()
}

/** What the charts look at. Every field is optional: empty = no restriction. */
export interface AnalyticsFilters {
  inputs?: number[];
  countries?: string[]; // codes as in AnalyticsRow.country; "∅" (UNKNOWN_KEY) = no country
  from?: number | null; // epoch ms, inclusive
  to?: number | null; // epoch ms, exclusive
  sentiments?: Sentiment[];
  topics?: string[];
  search?: string; // a phrase query (text.ts syntax)
}

/** The key used for "no value" in counts (no country, no time, no topic). */
export const UNKNOWN_KEY = "∅";

/** A count of records under one key. `share` is of the rows counted (0–1). */
export interface CountRow {
  key: string;
  label: string;
  count: number;
  share: number;
  /** Distinct people (ID column) among those records; equals count when there is no ID column. */
  people: number;
}

/** One point of a time series. `t` is the bucket start (UTC epoch ms). */
export interface SeriesPoint {
  t: number;
  label: string;
  value: number;
}
export interface Series {
  key: string;
  label: string;
  colorIndex: number; // palette slot (0-based), fixed per entity, never by rank
  points: SeriesPoint[];
}
