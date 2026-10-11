import { createContext, useContext } from "react";
import type { TimeGranularity } from "@reqflow/core";
import type {
  AnalyticsDataset,
  AnalyticsFilters,
  AnalyticsInput,
  AnalyticsRow,
  Granularity,
} from "./engine/types";

/** What every analytics tab reads: the dataset, the filtered rows and the shared controls. */
export interface AnalyticsContextValue {
  dataset: AnalyticsDataset;
  inputs: AnalyticsInput[];
  /** Rows after the filter bar. Every chart counts these. */
  rows: AnalyticsRow[];
  /** Rows of the whole dataset (for stable colours and "of all" comparisons). */
  allRows: AnalyticsRow[];
  filters: AnalyticsFilters;
  setFilters(patch: Partial<AnalyticsFilters>): void;
  /** Fixed colour of an input (its port position). */
  inputColor(index: number): string;
  /** Fixed colour of a country (by its rank in the whole dataset; later ones are "Other"). */
  countryColor(code: string): string;
  /** The timeline buckets: the block's setting, resolved from the data when "auto". */
  granularity: Granularity;
  granularitySetting: TimeGranularity;
  setGranularity(value: TimeGranularity): void;
  /** Tracked phrases, saved in the block's params so they stay with the workflow. */
  phrases: string[];
  setPhrases(phrases: string[]): void;
  blockLabel: string;
}

export const AnalyticsContext = createContext<AnalyticsContextValue | null>(null);

export function useAnalytics(): AnalyticsContextValue {
  const value = useContext(AnalyticsContext);
  if (!value) throw new Error("useAnalytics() must be used inside the analytics view.");
  return value;
}
