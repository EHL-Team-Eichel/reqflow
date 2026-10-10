// Deterministic judging math: source signals, priority, rank stability and evidence strength.
// No LLM touches these numbers. Every factor is returned so the UI can show it.
//
// Pure module: no relative imports, so `node --test` can load it directly.
import type { Source, SourceRecord } from "@reqflow/core";

// ---------------------------------------------------------------- tunables (documented, PM-visible)

/** A request ("I wish…") counts as this fraction of a complaint when measuring prevalence. */
export const REQUEST_WEIGHT = 0.6;
/** A feedback source needs this many verbatims in a market segment before that segment counts as covered. */
export const MIN_SEGMENT_N = 5;
/** Study dimensions mapped only to the category (aspect "general") count with this weight. */
export const GENERAL_DIMENSION_WEIGHT = 0.5;

/** Severity by aspect (what is wrong). Defects outrank wishes; design taste and price rank lowest. */
export const SEVERITY: Record<string, number> = {
  reliability: 1.0,
  quality: 0.9,
  noise: 0.8,
  usability: 0.8,
  comfort: 0.8,
  efficiency_range: 0.8,
  information: 0.75,
  performance: 0.75,
  visibility: 0.7,
  space: 0.6,
  features: 0.6,
  general: 0.6,
  design: 0.5,
  value_price: 0.4,
};
export const DEFAULT_SEVERITY = 0.6;
export const SAFETY_COMPONENT = "safety";

/** Weights of the evidence-strength factors (sum 1). */
export const STRENGTH_WEIGHTS = {
  volume: 0.3,
  triangulation: 0.25,
  coverage: 0.2,
  labelCertainty: 0.1,
  consistency: 0.15,
} as const;

/** Judge's verdict on whether the evidence supports the proposed action, as a fixed multiplier. */
export const SOLUTION_SUPPORT_FACTOR = {
  strong: 0.9,
  moderate: 0.7,
  weak: 0.45,
  none: 0.2,
} as const;
export type SolutionSupport = keyof typeof SOLUTION_SUPPORT_FACTOR;

/** Upper bounds when the evidence comes from one kind of source only. */
export const CAP_STUDY_ONLY = 0.6;
export const CAP_WEB_ONLY = 0.5;
/** No selected source family clears its support threshold (e.g. 1-2 stray mentions). */
export const CAP_UNSUPPORTED = 0.2;

// ---------------------------------------------------------------- input shapes

export interface Segment {
  derivative: string;
  market: string;
  /** Sales volume in the chosen horizon year; null if the sales file has no row for it. */
  sales: number | null;
}

export const segKey = (s: { derivative: string; market: string }) => `${s.derivative}/${s.market}`;

export interface ProblemDef {
  key: string;
  component: string;
  aspect: string;
  relevance: number;
}

export interface FeedbackCell {
  sourceId: string;
  problemKey: string;
  derivative: string;
  market: string;
  negative: number;
  request: number;
  positive: number;
  unknown: number;
  /** Sum over negative + request verbatims of the measured label accuracy of their classification method. */
  certaintySum: number;
}

export interface StudyObservation {
  evidence?: { record: SourceRecord; source: Source }[];
  sourceId: string;
  problemKey: string;
  dimension: string;
  derivative: string;
  market: string;
  marketResolved: boolean;
  metric: "mean_10pt" | "bottom3_box";
  value: number;
  columnMean: number;
  columnSd: number;
  mapWeight: number;
}

export interface WebItem {
  sourceId: string;
  problemKey: string;
  polarity: "negative" | "request" | "positive";
  verified: boolean;
  tierFactor: number;
}

export interface SourceInfo {
  id: string;
  kind: "feedback" | "study" | "web";
  family: string;
  weight: number;
}

// ---------------------------------------------------------------- helpers

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wilson score interval for k successes in n trials (95%). */
export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (c - r) / d), hi: Math.min(1, (c + r) / d) };
}

export function severityOf(
  component: string,
  aspect: string,
): { severity: number; safety: boolean } {
  if (component === SAFETY_COMPONENT) return { severity: 1, safety: true };
  return { severity: SEVERITY[aspect] ?? DEFAULT_SEVERITY, safety: false };
}

export function band(score: number): "high" | "medium" | "low" {
  return score >= 70 ? "high" : score >= 45 ? "medium" : "low";
}

/** z-score of how much worse than the car's own average this dimension is (positive = worse). */
export function studyBadness(
  o: Pick<StudyObservation, "metric" | "value" | "columnMean" | "columnSd">,
): number {
  const sd = o.columnSd > 1e-9 ? o.columnSd : 1;
  return o.metric === "mean_10pt" ? (o.columnMean - o.value) / sd : (o.value - o.columnMean) / sd;
}

// ---------------------------------------------------------------- source signals

export interface SignalTable {
  /** raw[sourceId][problemKey] before normalization. */
  raw: Record<string, Record<string, number>>;
  /** normalized 0..1 within each source (the source's biggest problem = 1). */
  norm: Record<string, Record<string, number>>;
  /** Segments (derivative/market) each feedback source covers with >= MIN_SEGMENT_N verbatims. */
  coveredSegments: Record<string, string[]>;
}

/**
 * Per-source signal for every problem.
 * - feedback: complaint rate per market segment, combined with the segment's share of sales
 *   (so a market with little feedback but many cars is not drowned out by a talkative one);
 * - study: how far below the car's own average the mapped dimension scores (z, worst dimension wins);
 * - web: share of verified items that complain or ask for something.
 */
export function computeSignals(
  problems: ProblemDef[],
  sources: SourceInfo[],
  segments: Segment[],
  totals: Record<string, Record<string, number>>,
  cells: FeedbackCell[],
  studies: StudyObservation[],
  web: WebItem[],
): SignalTable {
  const raw: SignalTable["raw"] = {};
  const coveredSegments: SignalTable["coveredSegments"] = {};
  const salesBySeg = new Map(segments.map((s) => [segKey(s), s.sales]));
  const knownSales = segments.filter((s) => s.sales !== null && s.sales > 0);

  for (const src of sources) {
    const rawOf: Record<string, number> = (raw[src.id] = {});
    if (src.kind === "feedback") {
      const t = totals[src.id] ?? {};
      const covered = segments.map(segKey).filter((k) => (t[k] ?? 0) >= MIN_SEGMENT_N);
      coveredSegments[src.id] = covered;
      // Segment weights: sales share among covered segments; equal weights if sales are unknown.
      const salesCovered: (number | null)[] = covered.map((k) => salesBySeg.get(k) ?? null);
      const useSales = knownSales.length > 0 && salesCovered.every((v) => v !== null && v > 0);
      const wSum: number = useSales
        ? salesCovered.reduce<number>((a, v) => a + (v ?? 0), 0)
        : covered.length;
      for (const p of problems) {
        let s = 0;
        covered.forEach((k, i) => {
          const c = cells.filter(
            (x) => x.sourceId === src.id && x.problemKey === p.key && segKey(x) === k,
          );
          const hits = c.reduce((a, x) => a + x.negative + REQUEST_WEIGHT * x.request, 0);
          const w = useSales ? (salesCovered[i] ?? 0) / wSum : 1 / wSum;
          s += w * (hits / (t[k] as number));
        });
        rawOf[p.key] = s;
      }
    } else if (src.kind === "study") {
      for (const p of problems) {
        const obs = studies.filter((o) => o.sourceId === src.id && o.problemKey === p.key);
        rawOf[p.key] = obs.reduce((m, o) => Math.max(m, studyBadness(o) * o.mapWeight), 0);
      }
    } else {
      const verified = web.filter((w) => w.sourceId === src.id && w.verified);
      for (const p of problems) {
        const mine = verified.filter((w) => w.problemKey === p.key);
        const hits = mine.reduce(
          (a, w) =>
            a + (w.polarity === "negative" ? 1 : w.polarity === "request" ? REQUEST_WEIGHT : 0),
          0,
        );
        rawOf[p.key] = verified.length ? hits / verified.length : 0;
      }
    }
  }

  const norm: SignalTable["norm"] = {};
  for (const src of sources) {
    const rawOf = raw[src.id] ?? {};
    const vals = Object.values(rawOf);
    const max = vals.length ? Math.max(...vals) : 0;
    const normOf: Record<string, number> = (norm[src.id] = {});
    for (const p of problems) normOf[p.key] = max > 0 ? Math.max(0, rawOf[p.key] ?? 0) / max : 0;
  }
  return { raw, norm, coveredSegments };
}

// ---------------------------------------------------------------- priority

export interface PriorityBreakdown {
  score: number;
  relevance: number;
  severity: number;
  safety: boolean;
  weightedSignal: number;
  perSource: { sourceId: string; weight: number; signal: number; contribution: number }[];
}

export function problemPriority(
  p: ProblemDef,
  sources: SourceInfo[],
  signals: SignalTable,
  overrides?: { weights?: Record<string, number>; severityScale?: number },
): PriorityBreakdown {
  const { severity: sev0, safety } = severityOf(p.component, p.aspect);
  const severity = Math.min(1, sev0 * (overrides?.severityScale ?? 1));
  const perSource = sources.map((s) => {
    const weight = overrides?.weights?.[s.id] ?? s.weight;
    const signal = signals.norm[s.id]?.[p.key] ?? 0;
    return {
      sourceId: s.id,
      weight,
      signal,
      contribution: 100 * p.relevance * severity * weight * signal,
    };
  });
  const weightedSignal = perSource.reduce((a, x) => a + x.weight * x.signal, 0);
  return {
    score: 100 * p.relevance * severity * weightedSignal,
    relevance: p.relevance,
    severity,
    safety,
    weightedSignal,
    perSource,
  };
}

export interface ActionForRanking {
  id: string;
  problemKey: string;
  /** Share of the problem's sampled complaints this action addresses (0..1). */
  coverage: number;
  pinned: boolean;
}

export interface RankedEntry {
  id: string;
  score: number;
  rank: number;
  rankRange: [number, number];
}

function order(entries: { id: string; score: number; pinned: boolean }[]): string[] {
  return [...entries]
    .sort((a, b) =>
      a.pinned === b.pinned ? b.score - a.score || a.id.localeCompare(b.id) : a.pinned ? -1 : 1,
    )
    .map((e) => e.id);
}

/**
 * Ranks actions by problem priority × coverage. Safety items are pinned on top.
 * Rank stability: re-ranks `iterations` times with source weights ×U(0.75,1.25) (renormalized)
 * and severities ×U(0.85,1.15), and reports the 5th–95th percentile rank.
 */
export function rankActions(
  actions: ActionForRanking[],
  problems: ProblemDef[],
  sources: SourceInfo[],
  signals: SignalTable,
  iterations = 300,
  seed = 20261010,
): RankedEntry[] {
  const pByKey = new Map(problems.map((p) => [p.key, p]));
  const scoreWith = (o?: {
    weights?: Record<string, number>;
    severityScale?: Record<string, number>;
  }) =>
    actions.map((a) => {
      const p = pByKey.get(a.problemKey);
      if (!p)
        throw new Error(`rankActions: action ${a.id} references unknown problem ${a.problemKey}`);
      const pr = problemPriority(p, sources, signals, {
        weights: o?.weights,
        severityScale: o?.severityScale?.[p.key],
      });
      return { id: a.id, score: pr.score * a.coverage, pinned: a.pinned };
    });

  const base = scoreWith();
  const baseOrder = order(base);
  const ranks: Record<string, number[]> = Object.fromEntries(
    actions.map((a) => [a.id, [] as number[]]),
  );
  const rnd = mulberry32(seed);
  for (let i = 0; i < iterations; i++) {
    const raw = Object.fromEntries(sources.map((s) => [s.id, s.weight * (0.75 + 0.5 * rnd())]));
    const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
    const weights = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v / sum]));
    const severityScale = Object.fromEntries(problems.map((p) => [p.key, 0.85 + 0.3 * rnd()]));
    order(scoreWith({ weights, severityScale })).forEach((id, idx) => ranks[id]?.push(idx + 1));
  }
  const pctl = (xs: number[], q: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
  };
  return baseOrder.map((id, idx) => ({
    id,
    score: base.find((b) => b.id === id)!.score,
    rank: idx + 1,
    rankRange: [pctl(ranks[id] ?? [], 0.05), pctl(ranks[id] ?? [], 0.95)] as [number, number],
  }));
}

// ---------------------------------------------------------------- evidence strength (confidence, deterministic part)

export type ConflictType =
  "praise_vs_complaints" | "study_contradicts" | "market_divergence" | "web_contradicts";

export interface Conflict {
  type: ConflictType;
  detail: string;
}

export interface EvidenceStrength {
  /** 0..1, after cap. */
  strength: number;
  cap: number | null;
  factors: {
    volume: number;
    triangulation: number;
    coverage: number;
    labelCertainty: number;
    consistency: number;
  };
  supportingFamilies: string[];
  effectiveN: number;
  conflicts: Conflict[];
  gaps: string[];
}

/**
 * How strong the evidence for a problem is, independent of the PM's source ranking:
 * every selected source counts by its reliability tier, not by its priority weight.
 */
export function evidenceStrength(
  p: ProblemDef,
  sources: SourceInfo[],
  segments: Segment[],
  totals: Record<string, Record<string, number>>,
  cells: FeedbackCell[],
  studies: StudyObservation[],
  web: WebItem[],
  signals: SignalTable,
): EvidenceStrength {
  const gaps: string[] = [];
  const conflicts: Conflict[] = [];
  const fbIds = new Set(sources.filter((s) => s.kind === "feedback").map((s) => s.id));
  const mine = cells.filter((c) => c.problemKey === p.key && fbIds.has(c.sourceId));
  const neg = mine.reduce((a, c) => a + c.negative, 0);
  const req = mine.reduce((a, c) => a + c.request, 0);
  const pos = mine.reduce((a, c) => a + c.positive, 0);
  const certaintySum = mine.reduce((a, c) => a + c.certaintySum, 0);
  const labelCertainty = neg + req > 0 ? certaintySum / (neg + req) : 0;

  const webMine = web.filter((w) => w.problemKey === p.key && w.verified);
  const webNeg = webMine.filter((w) => w.polarity !== "positive");
  const webPos = webMine.filter((w) => w.polarity === "positive");
  const unverified = web.filter((w) => w.problemKey === p.key && !w.verified).length;
  if (unverified)
    gaps.push(
      `${unverified} web item(s) could not be verified against the fetched page and were not counted`,
    );

  // Volume: label-certainty-weighted internal mentions + tier-weighted verified web items.
  const effectiveN = certaintySum + webNeg.reduce((a, w) => a + w.tierFactor, 0);
  const volume = effectiveN / (effectiveN + 10);

  // Triangulation over source families.
  const families = new Set<string>();
  const supportingChannels = new Set(
    mine.filter((c) => c.negative + c.request >= 2).map((c) => c.sourceId),
  );
  if (neg + req >= 3) families.add("customer_feedback");
  const studyMine = studies.filter((o) => o.problemKey === p.key);
  const studyBad = studyMine.filter((o) => studyBadness(o) * o.mapWeight >= 0.5);
  if (studyBad.length) families.add("market_research");
  for (const w of webNeg) families.add(sources.find((s) => s.id === w.sourceId)?.family ?? "web");
  const fam = families.size;
  let triangulation = fam === 0 ? 0 : fam === 1 ? 0.35 : fam === 2 ? 0.75 : 1;
  if (supportingChannels.size >= 2) triangulation = Math.min(1, triangulation + 0.1);

  // Coverage: share of in-scope sales in segments where any selected feedback source has data,
  // or a selected study has a market-matched observation for this problem.
  const covered = new Set<string>();
  for (const id of fbIds) for (const k of signals.coveredSegments[id] ?? []) covered.add(k);
  for (const o of studyMine) if (o.marketResolved) covered.add(segKey(o));
  const totalSales = segments.reduce((a, s) => a + (s.sales ?? 0), 0);
  let coverage: number;
  if (totalSales > 0) {
    coverage =
      segments.filter((s) => covered.has(segKey(s))).reduce((a, s) => a + (s.sales ?? 0), 0) /
      totalSales;
  } else {
    coverage = segments.length
      ? segments.filter((s) => covered.has(segKey(s))).length / segments.length
      : 0;
    gaps.push("no sales volumes for the scope: coverage counts segments, not cars");
  }
  for (const s of segments) {
    if (!covered.has(segKey(s)) && (s.sales ?? 0) > 0) {
      gaps.push(
        `no direct evidence for ${s.derivative} in ${s.market} (${s.sales!.toLocaleString("en-US")} cars/yr in scope)`,
      );
    }
  }
  if (studyMine.some((o) => !o.marketResolved)) {
    gaps.push(
      "some study scores have no resolved market in the evidence DB; they are not counted as market coverage",
    );
  }

  // Consistency: share of the feedback that agrees, reduced by each further conflict.
  const agree =
    neg + req + pos > 0
      ? (neg + req) / (neg + req + pos)
      : webMine.length
        ? webNeg.length / webMine.length
        : 0.5;
  if (pos >= 5 && pos >= 0.5 * (neg + req)) {
    conflicts.push({
      type: "praise_vs_complaints",
      detail: `${pos} positive vs ${neg} negative and ${req} request mentions on the same topic`,
    });
  }
  const studyGood = studyMine.filter((o) => studyBadness(o) <= -0.5);
  if (neg + req >= 5 && studyGood.length) {
    const o = studyGood[0]!;
    conflicts.push({
      type: "study_contradicts",
      detail: `feedback complains, but study dimension "${o.dimension}" (${o.derivative}/${o.market}) scores above the car's average`,
    });
  }
  // Market divergence: a well-covered market never mentions what another market complains about.
  const byMarket = new Map<string, { hits: number; n: number }>();
  for (const id of fbIds) {
    for (const [k, n] of Object.entries(totals[id] ?? {})) {
      const m = k.split("/")[1] ?? "";
      const e = byMarket.get(m) ?? { hits: 0, n: 0 };
      e.n += n;
      byMarket.set(m, e);
    }
  }
  for (const c of mine) {
    const e = byMarket.get(c.market);
    if (e) e.hits += c.negative + c.request;
  }
  const wellCovered = [...byMarket.entries()].filter(([, e]) => e.n >= 50);
  const loud = wellCovered.filter(([, e]) => e.hits / e.n >= 0.01);
  const silent = wellCovered.filter(([, e]) => e.hits === 0);
  if (loud.length && silent.length) {
    conflicts.push({
      type: "market_divergence",
      detail: `raised in ${loud.map(([m]) => m).join(", ")} but never in ${silent.map(([m, e]) => `${m} (${e.n} verbatims)`).join(", ")}`,
    });
  }
  if (webPos.length > webNeg.length && neg + req >= 5) {
    conflicts.push({
      type: "web_contradicts",
      detail: `${webPos.length} verified web items praise this vs ${webNeg.length} critical`,
    });
  }
  const others = conflicts.filter((c) => c.type !== "praise_vs_complaints").length;
  const consistency = Math.max(0, agree * Math.pow(0.85, others));

  const factors = {
    volume,
    triangulation,
    coverage,
    labelCertainty: neg + req > 0 ? labelCertainty : webNeg.length ? 0.5 : 0,
    consistency,
  };
  let strength =
    STRENGTH_WEIGHTS.volume * factors.volume +
    STRENGTH_WEIGHTS.triangulation * factors.triangulation +
    STRENGTH_WEIGHTS.coverage * factors.coverage +
    STRENGTH_WEIGHTS.labelCertainty * factors.labelCertainty +
    STRENGTH_WEIGHTS.consistency * factors.consistency;

  let cap: number | null = null;
  if (fam === 0) cap = CAP_UNSUPPORTED;
  else if (!families.has("customer_feedback")) {
    if (families.has("market_research") && webNeg.length === 0) cap = CAP_STUDY_ONLY;
    else if (families.size > 0 && !families.has("market_research")) cap = CAP_WEB_ONLY;
  }
  if (cap !== null) strength = Math.min(strength, cap);
  if (fam === 0) gaps.push("no selected source supports this problem");

  return { strength, cap, factors, supportingFamilies: [...families], effectiveN, conflicts, gaps };
}

/** Final confidence scores (0..100). */
export function confidenceScores(
  strength: number,
  problemSupport: { confirmed: number; checked: number },
  solution: SolutionSupport,
): { problem: number; solution: number } {
  const support =
    problemSupport.checked > 0 ? problemSupport.confirmed / problemSupport.checked : 0;
  const problem = 100 * strength * support;
  return { problem, solution: problem * SOLUTION_SUPPORT_FACTOR[solution] };
}
