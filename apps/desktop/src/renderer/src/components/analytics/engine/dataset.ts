import type { PipelineData, Source, SourceKind, SourceRecord } from "@reqflow/core";
import { countryColumnScore, countryRecognitionRate, normalizeCountry } from "./countries";
import { looksLikeSentimentColumn, scoreSentiment, sentimentFromLabel } from "./sentiment";
import { parseTime, timeColumnScore, timeRecognitionRate } from "./time";
import { topicsOf } from "./topics";
import type {
  AnalyticsDataset,
  AnalyticsInput,
  AnalyticsRow,
  BuildOptions,
  ColumnProfile,
  ColumnRole,
  Sentiment,
  YearSeriesPoint,
} from "./types";

/**
 * Turns what arrived on the Analytics block's inputs into rows the charts can count. Every
 * column's meaning is detected from its header and its values (or set by the user), and every
 * detection is written to `notes`, so the view can say where a number comes from.
 */

/** Sources whose records are people's words, not tables of figures. */
const TEXT_KINDS: ReadonlySet<SourceKind> = new Set([
  "customer_feedback",
  "customer_study",
  "review",
  "competitor",
  "market_trend",
  "other_web",
]);

const ID_HEADERS = new Set([
  "id",
  "feedbackid",
  "responseid",
  "respondentid",
  "respondent",
  "customerid",
  "customer",
  "kundenid",
  "kundennummer",
  "caseid",
  "ticketid",
  "commentid",
  "verbatimid",
  "personid",
  "userid",
  "author",
  "authorid",
]);

/** A category with more values than this is a free-text field, not a dimension. */
const MAX_CATEGORY_VALUES = 250;
const MAX_CATEGORY_LABEL = 80;

const normHeader = (h: string) => h.toLowerCase().replace(/[\s_\-./%()]+/g, "");

/** A merged record can carry a list of values for one column; null/"" mean "no value". */
function valuesOf(value: unknown): unknown[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v) => v !== null && v !== undefined && !(typeof v === "string" && !v.trim()));
}

function textOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value.trim() : String(value);
}

function isNumeric(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && /^-?\d+([.,]\d+)?$/.test(value.trim());
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const n = Number(value.trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** A 4-digit year inside a header ("volume_2024", "Sales 2030", "2025"), else null. */
export function yearOfHeader(header: string): number | null {
  const match = /(?:^|\D)((?:19|20)\d{2})(?:\D|$)/.exec(header);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1990 && year <= 2100 ? year : null;
}

interface ColumnStats {
  name: string;
  filled: number;
  values: unknown[]; // every non-empty value (lists flattened)
  distinct: Set<string>;
  numeric: number;
  totalLength: number;
  equalsText: number; // records whose value is their record text
}

function profileColumns(
  records: { fields?: Record<string, unknown>; text: string }[],
): Map<string, ColumnStats> {
  const stats = new Map<string, ColumnStats>();
  for (const record of records) {
    for (const [name, raw] of Object.entries(record.fields ?? {})) {
      let s = stats.get(name);
      if (!s) {
        s = {
          name,
          filled: 0,
          values: [],
          distinct: new Set(),
          numeric: 0,
          totalLength: 0,
          equalsText: 0,
        };
        stats.set(name, s);
      }
      const values = valuesOf(raw);
      if (!values.length) continue;
      s.filled++;
      if (values.length === 1 && textOf(values[0]) === record.text.trim()) s.equalsText++;
      for (const v of values) {
        s.values.push(v);
        const text = textOf(v);
        if (s.distinct.size <= MAX_CATEGORY_VALUES * 4) s.distinct.add(text);
        if (isNumeric(v)) s.numeric++;
        s.totalLength += text.length;
      }
    }
  }
  return stats;
}

const findHeader = (stats: Map<string, ColumnStats>, wanted: string | undefined) => {
  const w = wanted?.trim();
  if (!w) return undefined;
  return [...stats.keys()].find((h) => h.toLowerCase() === w.toLowerCase()) ?? null;
};

interface Detected {
  roles: Map<string, ColumnRole>;
  country: string | null;
  time: string | null;
  id: string | null;
  sentiment: string | null;
  categories: string[];
  yearColumns: { name: string; year: number }[];
  notes: string[];
}

function detectColumns(
  stats: Map<string, ColumnStats>,
  records: number,
  options: BuildOptions,
): Detected {
  const notes: string[] = [];
  const roles = new Map<string, ColumnRole>();
  const all = [...stats.values()];
  const avgLength = (s: ColumnStats) => (s.values.length ? s.totalLength / s.values.length : 0);

  // The comment itself: equal to the record text, or long, mostly distinct prose.
  for (const s of all) {
    const prose = avgLength(s) > 40 && s.distinct.size > 0.5 * s.filled;
    if (s.filled && (s.equalsText > 0.5 * s.filled || prose)) roles.set(s.name, "text");
  }

  const yearColumns = all
    .map((s) => ({ s, year: yearOfHeader(s.name) }))
    .filter(({ s, year }) => year !== null && s.filled && s.numeric >= 0.5 * s.values.length)
    .map(({ s, year }) => ({ name: s.name, year: year! }));
  for (const { name } of yearColumns) roles.set(name, "year_series");

  const free = () => all.filter((s) => !roles.has(s.name) && s.filled > 0);

  // Country: the user's column, else the best-named column whose values are countries.
  let country: string | null = null;
  const wantedCountry = findHeader(stats, options.countryColumn);
  if (wantedCountry === null) {
    notes.push(`There is no column "${options.countryColumn}" for the country; detecting it.`);
  }
  if (wantedCountry) country = wantedCountry;
  else {
    const candidates = free()
      .map((s) => {
        const sample = s.values.slice(0, 2000);
        const codes = sample.filter(
          (v) => typeof v === "string" && /^[A-Za-z]{2,3}$/.test(v.trim()),
        );
        return {
          s,
          score: countryColumnScore(s.name),
          rate: countryRecognitionRate(sample),
          codes: sample.length ? codes.length / sample.length : 0,
        };
      })
      .filter(({ s, score, rate }) =>
        score > 0 ? rate >= 0.5 : rate >= 0.8 && s.distinct.size <= 300 && s.distinct.size > 0,
      )
      // Prefer codes ("DE") over names ("Germany") when a table has both, like the Raw block does.
      .sort((a, b) => b.score - a.score || b.rate - a.rate || b.codes - a.codes);
    country = candidates[0]?.s.name ?? null;
  }
  if (country) roles.set(country, "country");

  // Time: the user's column, else a date-like column (by name and values).
  let time: string | null = null;
  const wantedTime = findHeader(stats, options.timeColumn);
  if (wantedTime === null) {
    notes.push(`There is no column "${options.timeColumn}" for the time; detecting it.`);
  }
  if (wantedTime) time = wantedTime;
  else {
    const candidates = free()
      .map((s) => {
        const score = timeColumnScore(s.name);
        const sample = s.values.slice(0, 2000);
        // Plain numbers are years only in a column named like time (else "units: 2024" would be a date).
        const onlyNumbers = s.numeric === s.values.length;
        const rate = score > 0 || !onlyNumbers ? timeRecognitionRate(s.name, sample) : 0;
        return { s, score, rate };
      })
      .filter(({ s, score, rate }) =>
        score > 0 ? rate >= 0.6 : rate >= 0.9 && s.distinct.size > 1,
      )
      .sort((a, b) => b.score - a.score || b.rate - a.rate);
    time = candidates[0]?.s.name ?? null;
  }
  if (time) roles.set(time, "time");

  const idColumn =
    free().find(
      (s) =>
        ID_HEADERS.has(normHeader(s.name)) &&
        s.distinct.size > 0.3 * s.filled &&
        avgLength(s) <= 64,
    )?.name ?? null;
  if (idColumn) roles.set(idColumn, "id");

  const sentiment =
    free().find((s) =>
      looksLikeSentimentColumn(
        s.name,
        s.values.slice(0, 2000).map((v) => textOf(v)),
      ),
    )?.name ?? null;

  const categories: string[] = [];
  for (const s of free()) {
    const distinct = s.distinct.size;
    if (s.numeric >= 0.8 * s.values.length) {
      roles.set(s.name, "number");
    } else if (
      distinct >= 2 &&
      distinct <= MAX_CATEGORY_VALUES &&
      avgLength(s) <= MAX_CATEGORY_LABEL &&
      s.filled >= 0.2 * records
    ) {
      roles.set(s.name, "category");
      categories.push(s.name);
    } else {
      roles.set(s.name, "other");
    }
  }
  // Fewest values first (they make the clearest charts); the sentiment column (Feedback Type, …)
  // leads, because it is the classification a PM looks at first.
  categories.sort((a, b) => stats.get(a)!.distinct.size - stats.get(b)!.distinct.size);
  if (sentiment) {
    const at = categories.indexOf(sentiment);
    if (at !== -1) categories.splice(at, 1);
    categories.unshift(sentiment);
  }

  return { roles, country, time, id: idColumn, sentiment, categories, yearColumns, notes };
}

/** Majority of the labels that name a sentiment; null when none do. A tie is neutral. */
function sentimentOfLabels(values: unknown[]): Sentiment | null {
  const counts: Record<Sentiment, number> = { positive: 0, neutral: 0, negative: 0 };
  let any = false;
  for (const v of values) {
    const s = sentimentFromLabel(textOf(v));
    if (s) {
      counts[s]++;
      any = true;
    }
  }
  if (!any) return null;
  if (counts.positive === counts.negative && counts.positive > 0) return "neutral";
  return (Object.entries(counts) as [Sentiment, number][]).sort((a, b) => b[1] - a[1])[0]![0];
}

const SCORE_OF: Record<Sentiment, number> = { positive: 1, neutral: 0, negative: -1 };

export function buildDataset(
  inputs: readonly AnalyticsInput[],
  options: BuildOptions = {},
): AnalyticsDataset {
  const ready = inputs.filter(
    (i): i is AnalyticsInput & { data: PipelineData } => i.status === "ready" && !!i.data,
  );
  const allRecords = ready.flatMap((i) => i.data.records);
  const stats = profileColumns(allRecords);
  // Sources name their columns differently ("market" here, "Country" there), so every column
  // role is detected per source file; the same source on two inputs is detected once.
  const recordsBySource = new Map<string, SourceRecord[]>();
  for (const record of allRecords) {
    const list = recordsBySource.get(record.sourceId) ?? [];
    list.push(record);
    recordsBySource.set(record.sourceId, list);
  }
  const perSource = new Map<string, Detected>();
  for (const [sourceId, records] of recordsBySource) {
    perSource.set(sourceId, detectColumns(profileColumns(records), records.length, options));
  }
  const detections = [...perSource.values()];
  const namesOf = (pick: (d: Detected) => string | null) => [
    ...new Set(detections.map(pick).filter((n): n is string => !!n)),
  ];
  const countryNames = namesOf((d) => d.country);
  const timeNames = namesOf((d) => d.time);
  const idNames = namesOf((d) => d.id);
  const sentimentNames = namesOf((d) => d.sentiment);
  const quoted = (names: string[]) => names.map((n) => `"${n}"`).join(" / ");
  const sentimentFirst = new Set(sentimentNames);
  const categoryColumns = [
    ...new Set([
      ...sentimentNames,
      ...detections.flatMap((d) => d.categories.filter((c) => !sentimentFirst.has(c))),
    ]),
  ];
  const yearColumnNames = [...new Set(detections.flatMap((d) => d.yearColumns.map((c) => c.name)))];
  const notes = [...new Set(detections.flatMap((d) => d.notes))];
  const now = options.now ?? Date.now();
  const thisYear = new Date(now).getUTCFullYear();

  const sourceKinds = ready.flatMap((i) => i.data.sources.map((s) => s.kind));
  let textCount = 0;
  for (const input of ready) {
    const kinds = new Map(input.data.sources.map((s) => [s.id, s.kind]));
    for (const r of input.data.records) {
      const kind = kinds.get(r.sourceId);
      if (kind && TEXT_KINDS.has(kind)) textCount++;
    }
  }
  const hasTextColumn = detections.some((d) => [...d.roles.values()].includes("text"));
  const textual =
    allRecords.length > 0 &&
    (textCount >= 0.5 * allRecords.length ||
      (hasTextColumn && !sourceKinds.includes("sales_volume")));

  let marketFallback = 0;
  const rows: AnalyticsRow[] = [];
  const yearSeries: YearSeriesPoint[] = [];
  for (const input of ready) {
    const sources = new Map<string, Source>(input.data.sources.map((s) => [s.id, s]));
    for (const record of input.data.records) {
      const source = sources.get(record.sourceId);
      const detected = perSource.get(record.sourceId)!;
      const fields = record.fields ?? {};

      let country: string | null = null;
      if (detected.country) {
        const value = valuesOf(fields[detected.country])[0];
        if (value !== undefined) country = normalizeCountry(value)?.code ?? textOf(value);
      } else if (record.market) {
        const known = normalizeCountry(record.market);
        if (known) {
          country = known.code;
          marketFallback++;
        }
      }

      const timeValue = detected.time ? valuesOf(fields[detected.time])[0] : undefined;
      const time =
        timeValue === undefined
          ? null
          : parseTime(timeValue, { allowSerial: timeColumnScore(detected.time!) > 0 });

      const personValue = detected.id ? valuesOf(fields[detected.id])[0] : undefined;

      const fromColumn = detected.sentiment
        ? sentimentOfLabels(valuesOf(fields[detected.sentiment]))
        : null;
      let sentiment: Sentiment = "neutral";
      let sentimentScore = 0;
      if (fromColumn) {
        sentiment = fromColumn;
        sentimentScore = SCORE_OF[fromColumn];
      } else if (textual) {
        const scored = scoreSentiment(record.text);
        sentiment = scored.label;
        sentimentScore = scored.score;
      }

      const categories: Record<string, string[]> = {};
      for (const column of detected.categories) {
        const values = [...new Set(valuesOf(fields[column]).map(textOf))];
        if (values.length) categories[column] = values;
      }

      const text = record.text;
      rows.push({
        id: record.id,
        input: input.index,
        sourceId: record.sourceId,
        sourceTitle: source?.title ?? record.sourceId,
        sourceKind: source?.kind ?? "other_internal",
        text,
        words: text.trim() ? text.trim().split(/\s+/).length : 0,
        country,
        time,
        person: personValue === undefined ? null : textOf(personValue),
        language: record.language ?? null,
        sentiment,
        sentimentScore,
        sentimentFrom: fromColumn ? "column" : "lexicon",
        topics: textual ? topicsOf(text) : [],
        categories,
        ...(record.locator ? { locator: record.locator } : {}),
      });

      for (const { name, year } of detected.yearColumns) {
        const value = toNumber(valuesOf(fields[name])[0]);
        if (value === null) continue;
        const firstText = Object.entries(fields).find(
          ([key, v]) => key !== name && typeof v === "string" && v.trim() && !isNumeric(v),
        );
        yearSeries.push({
          year,
          column: name,
          label: country
            ? country
            : firstText
              ? String(firstText[1]).trim()
              : (record.locator ?? record.id),
          country,
          input: input.index,
          value,
          planned: year > thisYear,
        });
      }
    }
  }

  const roleOf = (name: string): ColumnRole => {
    const roles = detections.map((d) => d.roles.get(name)).filter((r): r is ColumnRole => !!r);
    return roles.find((r) => r !== "other") ?? roles[0] ?? "other";
  };
  const columns: ColumnProfile[] = [...stats.values()].map((s) => ({
    name: s.name,
    role: roleOf(s.name),
    filled: s.filled,
    distinct: s.distinct.size,
  }));

  if (rows.length) {
    const countries = new Set(rows.map((r) => r.country).filter(Boolean));
    if (countryNames.length) {
      const without = rows.filter((r) => r.country === null).length;
      notes.push(
        `Country from the column${countryNames.length > 1 ? "s" : ""} ${quoted(countryNames)} (${countries.size} countries${without ? `; ${without} records without one` : ""}).`,
      );
      if (marketFallback)
        notes.push(`${marketFallback} records use the market they were tagged with.`);
    } else if (marketFallback) {
      notes.push(
        `No country column; ${marketFallback} records use the market they were tagged with.`,
      );
    } else {
      notes.push("No country column found, so country charts stay empty.");
    }
    if (timeNames.length) {
      const dated = rows.filter((r) => r.time !== null).length;
      notes.push(
        `Time from the column${timeNames.length > 1 ? "s" : ""} ${quoted(timeNames)} (${dated} of ${rows.length} records dated).`,
      );
    } else {
      notes.push(
        "No time column yet. The timeline fills in as soon as a dataset has a date, month, quarter or year column.",
      );
    }
    if (idNames.length) {
      const people = new Set(rows.map((r) => r.person).filter(Boolean)).size;
      const anonymous = rows.filter((r) => r.person === null).length;
      notes.push(
        `People counted by the column${idNames.length > 1 ? "s" : ""} ${quoted(idNames)}: ${people} people${anonymous ? ` plus ${anonymous} records without an ID, one person each` : ""}, ${rows.length} records.`,
      );
    } else {
      notes.push("No ID column, so every record counts as one person.");
    }
    if (textual) {
      notes.push(
        sentimentNames.length
          ? `Sentiment from the column${sentimentNames.length > 1 ? "s" : ""} ${quoted(sentimentNames)} where it names one, else from a word list.`
          : "Sentiment from an English and German word list (rules, no AI).",
      );
    } else {
      notes.push(
        "These records are tables of figures, so there is no sentiment or topic to count.",
      );
    }
    if (yearColumnNames.length) {
      notes.push(
        `Year columns read as a time series: ${yearColumnNames.join(", ")}${
          yearSeries.some((p) => p.planned) ? " (years after this one are plans)" : ""
        }.`,
      );
    }
  }

  return {
    inputs: inputs.map((i) => ({
      index: i.index,
      label: i.label,
      records: i.status === "ready" && i.data ? i.data.records.length : 0,
      sources: i.status === "ready" && i.data ? i.data.sources.length : 0,
    })),
    rows,
    columns,
    countryColumn: countryNames.join(" / ") || null,
    timeColumn: timeNames.join(" / ") || null,
    idColumn: idNames.join(" / ") || null,
    sentimentColumn: sentimentNames.join(" / ") || null,
    categoryColumns,
    textual,
    yearSeries,
    notes,
  };
}
