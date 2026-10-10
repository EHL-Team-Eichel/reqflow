import type { PipelineData, Source, SourceRecord } from "@reqflow/core";
import { parseNumber } from "../../raw/columns";
import { sampleEvenly } from "./evidence";

/**
 * Context inputs are background, not evidence: the agents read them to judge what matters for
 * the successor but never turn them into requirements. Sales volumes are summarized by code, so
 * every number the agents see is exact; anything else gets a profile the context reader explains.
 */

const YEAR_IN_NAME = /(?:^|\D)((?:19|20)\d{2})(?:\D|$)/;
const YEAR_COLUMN = /^(year|jahr|period|periode|zeitraum)$/i;
const VOLUME_COLUMN = /volume|units|sales|absatz|st(ü|ue)ck|menge|qty|quantity|count|anzahl/i;
const MARKET_NAME = /^(market|markt|country|land|region)$/i;
const MARKET_CODE = /(market|country|land|region)[ _-]?(code|iso)|^code$/i;

interface Series {
  label: string;
  byYear: Map<number, number>;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (from: number, to: number) => {
  if (from === 0) return to === 0 ? "±0 %" : "new";
  const p = Math.round(((to - from) / from) * 100);
  return `${p > 0 ? "+" : p < 0 ? "−" : "±"}${Math.abs(p)} %`;
};

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  return Array.isArray(value) ? value.map(text).join(" | ") : String(value).trim();
}

/** Volume series per row label (market) from one sheet, wide (volume_2024 …) or long (year, volume). */
function seriesOf(records: SourceRecord[]): Series[] | null {
  const keys = [...new Set(records.flatMap((r) => Object.keys(r.fields ?? {})))];
  const numericShare = (key: string) => {
    const filled = records.map((r) => r.fields?.[key]).filter((v) => text(v) !== "");
    return filled.length ? filled.filter((v) => parseNumber(v) !== null).length / filled.length : 0;
  };
  const labelOf = (r: SourceRecord) => {
    const f = r.fields ?? {};
    const name = keys.find((k) => MARKET_NAME.test(k.trim()) && text(f[k]));
    const code = keys.find((k) => MARKET_CODE.test(k.trim()) && text(f[k]));
    if (name && code && text(f[name]) !== text(f[code]))
      return `${text(f[name])} (${text(f[code])})`;
    if (name || code) return text(f[(name ?? code)!]);
    const other = keys.find((k) => !YEAR_IN_NAME.test(k) && numericShare(k) < 0.5 && text(f[k]));
    return other ? text(f[other]) : (r.locator ?? r.id);
  };

  const periodKeys = keys.filter((k) => YEAR_IN_NAME.test(k) && numericShare(k) >= 0.8);
  if (periodKeys.length >= 2) {
    return records.map((r) => ({
      label: labelOf(r),
      byYear: new Map(
        periodKeys.flatMap((k) => {
          const v = parseNumber(r.fields?.[k]);
          return v === null ? [] : [[Number(YEAR_IN_NAME.exec(k)![1]), v] as [number, number]];
        }),
      ),
    }));
  }
  const yearKey = keys.find((k) => YEAR_COLUMN.test(k.trim()));
  const volumeKey = keys.find((k) => VOLUME_COLUMN.test(k) && numericShare(k) >= 0.8);
  if (!yearKey || !volumeKey) return null;
  const byLabel = new Map<string, Series>();
  for (const r of records) {
    const year = Number(text(r.fields?.[yearKey]).slice(0, 4));
    const v = parseNumber(r.fields?.[volumeKey]);
    if (!Number.isInteger(year) || year < 1900 || v === null) continue;
    const label = labelOf(r);
    const s = byLabel.get(label) ?? { label, byYear: new Map() };
    s.byYear.set(year, (s.byYear.get(year) ?? 0) + v);
    byLabel.set(label, s);
  }
  return byLabel.size ? [...byLabel.values()] : null;
}

/** Facts about one sheet of sales volumes, every number computed here. */
function sheetFacts(source: Source | undefined, title: string, series: Series[]): string[] {
  const years = [...new Set(series.flatMap((s) => [...s.byYear.keys()]))].sort((a, b) => a - b);
  if (years.length === 0) return [];
  const thisYear = new Date(source?.retrievedAt ?? Date.now()).getUTCFullYear();
  const actual = years.filter((y) => y <= thisYear);
  const plan = years.filter((y) => y > thisYear);
  const total = (y: number) => series.reduce((sum, s) => sum + (s.byYear.get(y) ?? 0), 0);
  const facts: string[] = [];

  const totals = years.map((y, i) => {
    const prev = years[i - 1];
    const change = prev !== undefined ? ` (${pct(total(prev), total(y))} vs ${prev})` : "";
    return `${y}${plan.includes(y) ? " plan" : ""} ${fmt(total(y))}${change}`;
  });
  facts.push(`${title}: total ${totals.join(" · ")}.`);

  const last = actual.at(-1) ?? years[0]!;
  const lastTotal = total(last);
  if (series.length > 1 && lastTotal > 0) {
    const shares = series
      .map((s) => [s.label, (s.byYear.get(last) ?? 0) / lastTotal] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, share]) => `${label} ${Math.round(share * 100)} %`);
    facts.push(`${title}: share of ${last} volume — ${shares.join(", ")}.`);
  }
  const first = actual[0];
  if (first !== undefined && last !== first && series.length > 1) {
    const changes = series
      .filter((s) => s.byYear.has(first) && s.byYear.has(last))
      .map((s) => `${s.label} ${pct(s.byYear.get(first)!, s.byYear.get(last)!)}`);
    if (changes.length) facts.push(`${title}: change ${first}→${last} — ${changes.join(", ")}.`);
  }
  const target = plan.at(-1);
  if (target !== undefined && series.length > 1) {
    const changes = series
      .filter((s) => s.byYear.has(last) && s.byYear.has(target))
      .map((s) => `${s.label} ${pct(s.byYear.get(last)!, s.byYear.get(target)!)}`);
    if (changes.length) {
      facts.push(
        `${title}: plan ${last}→${target} — ${changes.join(", ")} (${target} is a plan figure, not an actual).`,
      );
    }
  }
  return facts;
}

/**
 * Sales volumes as exact facts (totals, market shares, actual and planned change). null when
 * the data doesn't look like sales volumes per period; the caller falls back to Auto.
 */
export function salesDigest(data: PipelineData): { facts: string[]; sheets: number } | null {
  const bySource = new Map<string, SourceRecord[]>();
  for (const r of data.records) {
    const list = bySource.get(r.sourceId) ?? [];
    list.push(r);
    bySource.set(r.sourceId, list);
  }
  const facts: string[] = [];
  let sheets = 0;
  for (const [sourceId, records] of bySource) {
    const series = seriesOf(records);
    if (!series?.length) continue;
    const source = data.sources.find((s) => s.id === sourceId);
    const sheetFactsList = sheetFacts(source, source?.title ?? sourceId, series);
    if (sheetFactsList.length) {
      sheets++;
      facts.push(...sheetFactsList);
    }
  }
  // The Raw block's own sales findings (e.g. a market's volume falling) are facts too.
  for (const f of data.findings.filter((f) => f.kind === "usage_pattern")) facts.push(f.statement);
  return sheets ? { facts, sheets } : null;
}

export interface ContextSample {
  handle: string; // "k1"
  recordId: string;
  sourceId: string;
  text: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What the context reader sees of data it has to work out by itself: sources, columns with their
 * value ranges, upstream findings and an even sample of records it can cite.
 */
export function contextProfile(data: PipelineData): { profile: string; samples: ContextSample[] } {
  const lines: string[] = [];
  for (const s of data.sources) {
    const records = data.records.filter((r) => r.sourceId === s.id);
    lines.push(`Source "${s.title}" (${s.kind}, ${records.length} records)`);
    const keys = [...new Set(records.flatMap((r) => Object.keys(r.fields ?? {})))].slice(0, 15);
    for (const key of keys) {
      const values = records.map((r) => text(r.fields?.[key])).filter(Boolean);
      const numbers = values.map(parseNumber).filter((n): n is number => n !== null);
      if (values.length && numbers.length / values.length >= 0.8) {
        const min = Math.min(...numbers);
        const max = Math.max(...numbers);
        const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
        lines.push(`  column "${key}": numbers ${fmt(min)}–${fmt(max)}, mean ${fmt(mean)}`);
      } else {
        const counts = new Map<string, number>();
        for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
        const top = [...counts]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([v, n]) => `"${clip(v, 40)}" ×${n}`);
        lines.push(`  column "${key}": ${counts.size} distinct values, e.g. ${top.join(", ")}`);
      }
    }
  }
  const findings = data.findings
    .slice(0, 20)
    .map((f) => `  finding (${f.kind}): ${clip(f.statement, 200)}`);
  if (findings.length) lines.push("Upstream findings:", ...findings);
  const samples = sampleEvenly(data.records, 24).map((r, i) => ({
    handle: `k${i + 1}`,
    recordId: r.id,
    sourceId: r.sourceId,
    text: clip(r.text, 280),
  }));
  return { profile: lines.join("\n"), samples };
}
