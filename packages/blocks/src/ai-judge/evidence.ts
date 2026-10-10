import type { PipelineData, Source, SourceRecord } from "@reqflow/core";
import { ASPECTS, COMPONENTS, regionOf } from "../add-to-car/taxonomy";
import { classifyRecord, normalize, type Mention } from "../add-to-car/splitter";
import { rocWeights } from "./sources";
import type { FeedbackCell, Segment, SourceInfo, StudyObservation } from "./scoring";
import { segKey } from "./scoring";

/**
 * Turns what arrived on the AI Judge's ranked inputs into the structures the scorer needs.
 * Everything here is deterministic; each item keeps the record it came from.
 */

export const WEB_KINDS: ReadonlySet<Source["kind"]> = new Set([
  "review",
  "competitor",
  "market_trend",
  "other_web",
]);

/** Heuristic trust factors, not measured classifier accuracy; BMW tags remain the preferred labels. */
export const METHOD_CERTAINTY: Record<Mention["method"], number> = { bmw_tag: 1, text_rule: 0.7 };

export interface JudgeFilter {
  /** Vehicle code, e.g. "G60"; null = every derivative in the data. */
  derivative: string | null;
  /** Region (EU, US, CN, RoW); null = all markets, weighted by sales. */
  region: string | null;
}

/** One scored source: a kind of evidence arriving on one ranked input. */
export interface JudgeSource extends SourceInfo {
  label: string;
  input: number; // 0-based input position (= rank − 1)
  tier: 1 | 2 | 3;
}

/** A classified feedback or web record mention that can be cited. */
export interface Citation {
  ref: string; // filled in when sampled for a prompt (E1, E2, …)
  sourceId: string; // scoring source id
  record: SourceRecord;
  source: Source;
  mention: Mention;
  derivative: string;
  region: string;
}

const CODE = /\b([A-Z]\d{1,3})\b/;

/** The derivative a feedback record belongs to: a column whose value is a vehicle code. */
export function derivativeOf(record: SourceRecord, source: Source): string | null {
  for (const [k, v] of Object.entries(record.fields ?? {})) {
    if (typeof v === "string" && /deriv|e-?code|model|baureihe/i.test(k)) {
      const m = CODE.exec(v);
      if (m) return m[1]!;
    }
  }
  const t = CODE.exec(source.title);
  return t ? t[1]! : null;
}

export interface InputEvidence {
  sources: JudgeSource[];
  citations: Citation[];
  cells: FeedbackCell[];
  totals: Record<string, Record<string, number>>;
  studies: StudyObservation[];
  sales: { derivative: string; region: string; volumes: Record<string, number> }[];
  /** Inputs with nothing connected (candidates for web research), by position. */
  emptyInputs: number[];
  notes: string[];
  /** Every source and record seen, to store the cited ones with the requirements. */
  sourceById: Map<string, Source>;
}

/**
 * Weights: inputs get rank-order centroid weights by position; the kinds of evidence on one input
 * (feedback, study, web) share that input's weight equally. Sales volumes and equipment data are
 * context, not weighted.
 */
export function collectEvidence(
  inputs: PipelineData[],
  labels: string[],
  filter: JudgeFilter,
): InputEvidence {
  const notes: string[] = [];
  const top = rocWeights(inputs.length);
  const sources: JudgeSource[] = [];
  const citations: Citation[] = [];
  const cellMap = new Map<string, FeedbackCell>();
  const totals: InputEvidence["totals"] = {};
  const studies: StudyObservation[] = [];
  const sales: InputEvidence["sales"] = [];
  const emptyInputs: number[] = [];
  const sourceById = new Map<string, Source>();

  inputs.forEach((data, i) => {
    for (const s of data.sources) sourceById.set(s.id, s);
    const kindOf = new Map(data.sources.map((s) => [s.id, s.kind]));
    const byKind = {
      feedback: [] as SourceRecord[],
      study: [] as SourceRecord[],
      web: [] as SourceRecord[],
    };
    let other = 0;
    for (const r of data.records) {
      const k = kindOf.get(r.sourceId);
      if (k === "customer_feedback") byKind.feedback.push(r);
      else if (k === "customer_study") byKind.study.push(r);
      else if (k && WEB_KINDS.has(k)) byKind.web.push(r);
      else if (k === "sales_volume") sales.push(...salesRows(r, sourceById.get(r.sourceId)!));
      else other++;
    }
    if (other)
      notes.push(`Input ${i + 1} (${labels[i]}): ${other} record(s) of other kinds are not used.`);
    const present = (["feedback", "study", "web"] as const).filter((k) => byKind[k].length > 0);
    if (data.records.length === 0) emptyInputs.push(i);
    present.forEach((kind) => {
      const id = `in${i}_${kind}`;
      sources.push({
        id,
        kind,
        family:
          kind === "feedback"
            ? "customer_feedback"
            : kind === "study"
              ? "market_research"
              : `web:${labels[i]}`,
        weight: top[i]! / present.length,
        label: present.length > 1 ? `${labels[i]} · ${kind}` : labels[i]!,
        input: i,
        tier: kind === "web" ? 2 : 1,
      });
    });

    for (const kind of ["feedback", "web"] as const) {
      const sid = `in${i}_${kind}`;
      for (const record of byKind[kind]) {
        const source = sourceById.get(record.sourceId)!;
        const derivative = derivativeOf(record, source) ?? "ALL";
        const region = kind === "web" ? "WEB" : regionOf(record.market).toUpperCase();
        if (filter.derivative && derivative !== "ALL" && derivative !== filter.derivative) continue;
        if (filter.region && kind === "feedback" && region !== filter.region) continue;
        if (kind === "feedback") {
          const t = (totals[sid] ??= {});
          const k = segKey({ derivative, market: region });
          t[k] = (t[k] ?? 0) + 1;
        }
        for (const mention of classifyRecord(record).mentions) {
          const problemKey = `${mention.component}|${mention.aspect}`;
          citations.push({ ref: "", sourceId: sid, record, source, mention, derivative, region });
          if (kind !== "feedback") continue;
          const ck = `${sid}|${problemKey}|${derivative}|${region}`;
          const cell = cellMap.get(ck) ?? {
            sourceId: sid,
            problemKey,
            derivative,
            market: region,
            negative: 0,
            request: 0,
            positive: 0,
            unknown: 0,
            certaintySum: 0,
          };
          const p = mention.polarity;
          if (p === "negative" || p === "request" || p === "positive") cell[p]++;
          else cell.unknown++;
          if (p === "negative" || p === "request")
            cell.certaintySum += METHOD_CERTAINTY[mention.method];
          cellMap.set(ck, cell);
        }
      }
    }
    studies.push(...studyObservations(byKind.study, sourceById, `in${i}_study`, filter));
  });

  return {
    sources,
    citations,
    cells: [...cellMap.values()],
    totals,
    studies,
    sales,
    emptyInputs,
    notes,
    sourceById,
  };
}

// ---------------------------------------------------------------- sales volumes

/** Combined sales sheets: which derivative a market row belongs to (dataset README: G68 is China-only). */
const SALES_SPLIT: Record<string, Record<string, string>> = { "G60|G68": { CN: "G68" } };

function salesRows(record: SourceRecord, source: Source): InputEvidence["sales"] {
  const f = record.fields ?? {};
  const entry = Object.entries(f).find(([k]) => /market.?code|^market$|region/i.test(k));
  const market = entry ? String(entry[1] ?? "") : (record.market ?? "");
  if (!market) return [];
  const codes = [...new Set(source.title.match(/\b[A-Z]\d{1,3}\b/g) ?? [])];
  if (codes.length === 0) return [];
  const split = SALES_SPLIT[codes.join("|")];
  const derivative = split?.[market] ?? codes[0]!;
  const volumes: Record<string, number> = {};
  for (const [k, v] of Object.entries(f)) {
    const y = /(20\d\d)/.exec(k);
    if (y && typeof v === "number") volumes[y[1]!] = v;
  }
  return [{ derivative, region: regionOf(market).toUpperCase(), volumes }];
}

export function segmentsFor(
  ev: InputEvidence,
  filter: JudgeFilter,
  year: string,
  notes: string[],
): Segment[] {
  const map = new Map<string, Segment>();
  for (const s of ev.sales) {
    if (filter.derivative && s.derivative !== filter.derivative) continue;
    if (filter.region && s.region !== filter.region) continue;
    const v = s.volumes[year];
    if (v === undefined) notes.push(`No ${year} sales volume for ${s.derivative}/${s.region}.`);
    else if (v > 0)
      map.set(segKey({ derivative: s.derivative, market: s.region }), {
        derivative: s.derivative,
        market: s.region,
        sales: v,
      });
  }
  for (const t of Object.values(ev.totals)) {
    for (const k of Object.keys(t)) {
      if (map.has(k)) continue;
      const [derivative, market] = k.split("/") as [string, string];
      map.set(k, { derivative, market, sales: null });
      if (ev.sales.length)
        notes.push(`No sales volume for ${k}: its feedback is weighted equally, not by cars sold.`);
    }
  }
  if (!ev.sales.length)
    notes.push("No sales volumes arrived: markets are weighted equally, not by cars sold.");
  return [...map.values()];
}

// ---------------------------------------------------------------- customer studies

const BOTTOM3 = /^(i hate it|a failure|unsatisfactory)$/i;

/** Maps a study dimension ("Overall seating comfort") to component › aspect with the same rules as feedback. */
export function dimensionTopic(dimension: string): { component: string; aspect: string } | null {
  const norm = normalize(dimension);
  const c = COMPONENTS.find((x) => x.text?.test(norm));
  if (!c) return null;
  const a = ASPECTS.find((x) => x.text?.test(norm));
  return { component: c.id, aspect: a?.id ?? "general" };
}

/**
 * Study tables as Raw reads them: a "Section" column (the dimension), a "Label" column ("Mean", or a
 * rating such as "I Love It") and one column per model, named like "BMW 5 Series G60 (EU)". The market
 * comes from the column's group label, else from the source title (e.g. a "US_2025" sheet).
 */
export function studyObservations(
  records: SourceRecord[],
  sourceById: Map<string, Source>,
  sourceId: string,
  filter: JudgeFilter,
): StudyObservation[] {
  type Acc = {
    dimension: string;
    derivative: string;
    market: string;
    resolved: boolean;
    mean?: number;
    bottom3: number;
    ratings: number;
    evidence: { record: SourceRecord; source: Source }[];
  };
  const acc = new Map<string, Acc>();
  for (const r of records) {
    const f = r.fields ?? {};
    const dimension = String(f.Section ?? "").trim();
    const label = String(f.Label ?? "").trim();
    if (!dimension || !label) continue;
    const titleMarket = /\b(EU|US|CN)\b/.exec(sourceById.get(r.sourceId)?.title ?? "")?.[1];
    for (const [col, v] of Object.entries(f)) {
      if (typeof v !== "number") continue;
      const code = CODE.exec(col)?.[1];
      if (!code) continue;
      const group = /\((China|CN|EU|Europe|US|USA|United States)\)/i.exec(col)?.[1];
      const market = group
        ? regionOf(/^china$/i.test(group) ? "CN" : /^(eu|europe)$/i.test(group) ? "EU" : "US")
        : titleMarket;
      const key = `${dimension}|${code}|${market ?? "?"}`;
      const a = acc.get(key) ?? {
        dimension,
        derivative: code,
        market: market ?? "?",
        resolved: !!market,
        bottom3: 0,
        ratings: 0,
        evidence: [],
      };
      const source = sourceById.get(r.sourceId);
      if (source && !a.evidence.some((e) => e.record.id === r.id))
        a.evidence.push({ record: r, source });
      if (/^mean$/i.test(label)) a.mean = v;
      else if (BOTTOM3.test(label)) a.bottom3 += v;
      if (!/^mean$|sample/i.test(label)) a.ratings++;
      acc.set(key, a);
    }
  }
  const raw: Omit<StudyObservation, "columnMean" | "columnSd">[] = [];
  for (const a of acc.values()) {
    if (filter.derivative && a.derivative !== filter.derivative) continue;
    if (filter.region && a.resolved && a.market !== filter.region) continue;
    const topic = dimensionTopic(a.dimension);
    if (!topic) continue;
    const base = {
      sourceId,
      problemKey: `${topic.component}|${topic.aspect}`,
      dimension: a.dimension,
      derivative: a.derivative,
      market: a.market,
      marketResolved: a.resolved,
      mapWeight: 1,
      evidence: a.evidence,
    };
    if (a.mean !== undefined) raw.push({ ...base, metric: "mean_10pt", value: a.mean });
    else if (a.ratings > 0) raw.push({ ...base, metric: "bottom3_box", value: a.bottom3 });
  }
  // Compare each score with the car's own average over all its dimensions (same metric, column).
  const all = [...acc.values()].map((a) => ({
    key: `${a.derivative}|${a.market}|${a.mean !== undefined ? "mean_10pt" : "bottom3_box"}`,
    value: a.mean ?? a.bottom3,
  }));
  const stat = new Map<string, { mean: number; sd: number }>();
  for (const k of new Set(all.map((x) => x.key))) {
    const xs = all.filter((x) => x.key === k).map((x) => x.value);
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    stat.set(k, { mean: m, sd: Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length) });
  }
  return raw.map((o) => {
    const s = stat.get(`${o.derivative}|${o.market}|${o.metric}`)!;
    return { ...o, columnMean: s.mean, columnSd: s.sd };
  });
}
