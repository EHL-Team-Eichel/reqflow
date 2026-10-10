import { createHash } from "node:crypto";
import {
  CATEGORY_LABELS,
  Finding,
  formatRequirementId,
  Requirement,
  Theme,
  type EvidenceLevel,
  type EvidenceRef,
  type FindingKind,
  type PipelineData,
  type Priority,
  type ProductScope,
  type RequirementCategory,
  type Source,
  type SourceKind,
  type SourceRecord,
} from "@reqflow/core";
import { classifyRecord, normalize, type Mention, type Method } from "./splitter";
import {
  ASPECTS,
  COMPONENTS,
  GENERAL_ASPECT,
  regionOf,
  type AspectRule,
  type ComponentRule,
  type Polarity,
} from "./taxonomy";

/** Sources whose records are people's words; tables of figures are left to the Raw block's findings. */
export const TEXT_SOURCE_KINDS: ReadonlySet<SourceKind> = new Set([
  "customer_feedback",
  "review",
  "competitor",
  "market_trend",
  "other_web",
]);
/** Evidence refs stored per finding; `mentions` always counts every supporting record. */
export const MAX_EVIDENCE_PER_FINDING = 20;
/** At least this many comments before a theme counts as more than anecdotal (evidence level B). */
export const MIN_COMMENTS_NOT_ANECDOTAL = 10;
/** Themes backed by fewer comments stay findings (in the audit trail) instead of becoming requirements. */
export const MIN_COMMENTS_FOR_REQUIREMENT = 2;
/** Evidence level A needs conflicting praise below this share of all comments on the theme. */
export const MAX_CONFLICT_SHARE_FOR_A = 0.25;
const QUANTITATIVE: ReadonlySet<SourceKind> = new Set([
  "customer_study",
  "equipment_data",
  "sales_volume",
]);
const METHOD_CONFIDENCE: Record<Method, number> = { bmw_tag: 0.9, text_rule: 0.6 };
const ACTOR = { type: "ai", component: "add_to_car", model: "deterministic" } as const;

export interface RankedInput {
  ranking: string; // the port's label, e.g. "Must have"
  priority: Priority;
  data: PipelineData;
}

export interface DeriveOptions {
  scope: ProductScope;
  runId: string;
  now: string; // ISO datetime, stamped on every requirement
  mergeDuplicates: boolean;
  firstSeq?: number; // first requirement sequence number in this scope (default 1)
}

export interface DeriveStats {
  records: number;
  byBmwTag: number;
  byKeywordRule: number;
  unclassified: number;
  /** Comments that name a topic without a clear complaint, request or praise. */
  unclear: number;
  skippedByKind: Record<string, number>;
  coveredByInputFindings: number;
  unmappedTags: Record<string, number>;
  /** Themes with complaints or requests from fewer than MIN_COMMENTS_FOR_REQUIREMENT comments. */
  heldBack: number;
}

export interface Derived {
  findings: Finding[]; // in scope, referenced by themes and requirements
  excluded: Finding[]; // out of scope (pricing, dealer topics), kept for the audit trail
  themes: Theme[];
  requirements: Requirement[];
  stats: DeriveStats;
}

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const COMPONENT_BY_ID = new Map(COMPONENTS.map((c) => [c.id, c]));
const ASPECT_BY_ID = new Map([...ASPECTS, GENERAL_ASPECT].map((a) => [a.id, a]));

const KIND_OF: Record<Polarity, FindingKind> = {
  negative: "complaint",
  request: "unmet_need",
  positive: "praise",
};
const POLARITY_OF: Partial<Record<FindingKind, Polarity>> = {
  complaint: "negative",
  competitor_advantage: "request",
  unmet_need: "request",
  market_trend: "request",
  praise: "positive",
};

/** A theme for findings that arrive ready-made and name no component: their own category. */
function categoryComponent(category: RequirementCategory): ComponentRule {
  return { id: `area_${category}`, label: CATEGORY_LABELS[category], area: category };
}

interface Observation {
  input: number;
  record: SourceRecord;
  mention: Mention;
}

interface Group {
  key: string;
  input: number; // first (highest-ranked) input the theme arrived on
  component: ComponentRule;
  aspect: AspectRule;
  observations: Observation[];
  inputFindings: Finding[];
}

function statement(c: ComponentRule, a: AspectRule, p: Polarity): string {
  if (a.id === GENERAL_ASPECT.id) {
    return {
      negative: `${c.label}: customers report problems.`,
      request: `${c.label}: customers ask for changes.`,
      positive: `${c.label}: customers praise it.`,
    }[p];
  }
  return {
    negative: `${c.label}: customers complain about ${a.topic}.`,
    request: `${c.label}: customers ask for better ${a.topic}.`,
    positive: `${c.label}: customers praise ${a.topic}.`,
  }[p];
}

function areaOf(c: ComponentRule, a: AspectRule): RequirementCategory {
  return c.area ?? a.area;
}

function evidenceLevel(
  supporting: Finding[],
  sources: Map<string, Source>,
  comments: number,
  praise: number,
): EvidenceLevel {
  const used = new Set(supporting.flatMap((f) => f.evidence.map((e) => e.sourceId)));
  const kinds = [...used].map((id) => sources.get(id)?.kind);
  const webOnly = kinds.every((k) => k === "market_trend" || k === "other_web");
  if (kinds.length > 0 && webOnly) return "D";
  const quantitative = kinds.some((k) => k !== undefined && QUANTITATIVE.has(k));
  const conflictShare = praise / Math.max(1, comments + praise);
  if (used.size >= 2 && quantitative && conflictShare < MAX_CONFLICT_SHARE_FOR_A) return "A";
  if (used.size >= 2 || comments >= MIN_COMMENTS_NOT_ANECDOTAL) return "B";
  return "C";
}

/**
 * Turns what arrived on the ranked inputs into findings, themes and requirements, deterministically:
 * same inputs and options → same ids, texts and order (only `now` is taken from the caller).
 */
export function deriveRequirements(inputs: RankedInput[], o: DeriveOptions): Derived {
  const stats: DeriveStats = {
    records: 0,
    byBmwTag: 0,
    byKeywordRule: 0,
    unclassified: 0,
    unclear: 0,
    skippedByKind: {},
    coveredByInputFindings: 0,
    unmappedTags: {},
    heldBack: 0,
  };
  const sources = new Map<string, Source>();
  for (const input of inputs) for (const s of input.data.sources) sources.set(s.id, s);

  const groups = new Map<string, Group>();
  const groupFor = (input: number, c: ComponentRule, a: AspectRule): Group => {
    const key = o.mergeDuplicates ? `${c.id}|${a.id}` : `${input}|${c.id}|${a.id}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, input, component: c, aspect: a, observations: [], inputFindings: [] };
      groups.set(key, g);
    }
    g.input = Math.min(g.input, input);
    return g;
  };

  inputs.forEach((input, i) => {
    // Findings made upstream (AI Filter, Raw usage findings) join a theme by their statement.
    const cited = new Set<string>();
    for (const f of input.data.findings) {
      for (const e of f.evidence) if (e.recordId) cited.add(e.recordId);
      const norm = normalize(f.statement);
      const c = COMPONENTS.find((x) => x.text?.test(norm)) ?? categoryComponent(f.category);
      const a = ASPECTS.find((x) => x.text?.test(norm)) ?? GENERAL_ASPECT;
      groupFor(i, c, a).inputFindings.push(f);
    }
    for (const record of input.data.records) {
      const kind = sources.get(record.sourceId)?.kind ?? "unknown source";
      if (kind === "unknown source" || !TEXT_SOURCE_KINDS.has(kind as SourceKind)) {
        stats.skippedByKind[kind] = (stats.skippedByKind[kind] ?? 0) + 1;
        continue;
      }
      if (cited.has(record.id)) {
        stats.coveredByInputFindings++;
        continue;
      }
      stats.records++;
      const { mentions, unmappedTags } = classifyRecord(record);
      for (const t of unmappedTags) stats.unmappedTags[t] = (stats.unmappedTags[t] ?? 0) + 1;
      if (mentions.length === 0) {
        stats.unclassified++;
        continue;
      }
      if (mentions[0]!.method === "bmw_tag") stats.byBmwTag++;
      else stats.byKeywordRule++;
      if (mentions.every((m) => m.polarity === null)) stats.unclear++;
      for (const m of mentions) {
        const c = COMPONENT_BY_ID.get(m.component)!;
        const a = ASPECT_BY_ID.get(m.aspect)!;
        groupFor(i, c, a).observations.push({ input: i, record, mention: m });
      }
    }
  });

  const findings: Finding[] = [];
  const excluded: Finding[] = [];
  const themes: Theme[] = [];
  const candidates: {
    group: Group;
    theme: Theme;
    byPolarity: Record<Polarity, Finding | undefined>;
    counts: Record<Polarity, number>;
  }[] = [];

  for (const g of groups.values()) {
    const c = g.component;
    const a = g.aspect;
    const themeId = `thm_${hash(`atc|${g.key}`)}`;
    const outOfScope = c.outOfScope ?? a.outOfScope;
    const byPolarity: Record<Polarity, Finding | undefined> = {
      negative: undefined,
      request: undefined,
      positive: undefined,
    };
    const counts: Record<Polarity, number> = { negative: 0, request: 0, positive: 0 };
    for (const p of ["negative", "request", "positive"] as const) {
      const obs = g.observations.filter((x) => x.mention.polarity === p);
      if (obs.length === 0) continue;
      const records = [...new Map(obs.map((x) => [x.record.id, x])).values()];
      counts[p] = records.length;
      const ordered = [
        ...records.filter((x) => x.mention.method === "bmw_tag"),
        ...records.filter((x) => x.mention.method !== "bmw_tag"),
      ];
      const evidence: EvidenceRef[] = ordered.slice(0, MAX_EVIDENCE_PER_FINDING).map((x) => {
        if (!x.record.text.includes(x.mention.excerpt)) {
          throw new Error(`Excerpt for ${x.record.id} is not verbatim from the record text.`);
        }
        return {
          sourceId: x.record.sourceId,
          recordId: x.record.id,
          excerpt: x.mention.excerpt,
          ...(x.record.locator ? { locator: x.record.locator } : {}),
        };
      });
      const confidence =
        records.reduce((sum, x) => sum + METHOD_CONFIDENCE[x.mention.method], 0) / records.length;
      const finding = Finding.parse({
        id: `fnd_${hash(`atc|${g.key}|${p}`)}`,
        kind: KIND_OF[p],
        statement: statement(c, a, p),
        category: areaOf(c, a),
        evidence,
        mentions: records.length,
        ...(p === "negative" ? { sentiment: -1 } : p === "positive" ? { sentiment: 1 } : {}),
        markets: [...new Set(records.map((x) => regionOf(x.record.market)))].sort(),
        themeId,
        confidence: Math.round(confidence * 100) / 100,
        inScope: !outOfScope,
        ...(outOfScope ? { outOfScopeReason: outOfScope } : {}),
      });
      byPolarity[p] = finding;
      (outOfScope ? excluded : findings).push(finding);
    }
    const own = Object.values(byPolarity).filter((f): f is Finding => f !== undefined);
    if (outOfScope || own.length + g.inputFindings.length === 0) continue;
    const comments = new Set(g.observations.map((x) => x.record.id)).size;
    const byTag = new Set(
      g.observations.filter((x) => x.mention.method === "bmw_tag").map((x) => x.record.id),
    ).size;
    const markets = [...new Set(own.flatMap((f) => f.markets))].sort();
    const theme = Theme.parse({
      id: themeId,
      label: `${c.label} › ${a.label}`,
      summary:
        `${plural(counts.negative, "complaint")}, ${plural(counts.request, "request")} and ` +
        `${counts.positive} praise in ${plural(comments, "comment")} ` +
        `(${byTag} placed by BMW's classification, ${comments - byTag} by keyword rules)` +
        (markets.length ? `; markets: ${markets.join(", ")}` : "") +
        (g.inputFindings.length
          ? `; plus ${plural(g.inputFindings.length, "upstream finding")}`
          : "") +
        ".",
      category: areaOf(c, a),
      findingIds: [...own, ...g.inputFindings].map((f) => f.id),
    });
    themes.push(theme);
    candidates.push({ group: g, theme, byPolarity, counts });
  }

  // Requirements: one per theme with complaints or requests (praise alone is not a change request).
  const ranked = candidates
    .map((x) => {
      const upstreamSupport = x.group.inputFindings.filter(
        (f) => f.inScope && POLARITY_OF[f.kind] !== "positive",
      );
      const weight =
        x.counts.negative + x.counts.request + upstreamSupport.reduce((n, f) => n + f.mentions, 0);
      return { ...x, upstreamSupport, weight };
    })
    .filter((x) => {
      if (x.weight >= MIN_COMMENTS_FOR_REQUIREMENT) return true;
      if (x.weight > 0) stats.heldBack++;
      return false;
    })
    .sort(
      (a, b) =>
        a.group.input - b.group.input || b.weight - a.weight || (a.theme.id < b.theme.id ? -1 : 1),
    );

  const totalComments = Math.max(1, stats.records);
  const requirements = ranked.map((x, i) => {
    const { group: g, counts, byPolarity } = x;
    const c = g.component;
    const a =
      g.aspect.id === GENERAL_ASPECT.id && counts.request > counts.negative
        ? ASPECT_BY_ID.get("features")!
        : g.aspect;
    const supporting = [byPolarity.negative, byPolarity.request, ...x.upstreamSupport].filter(
      (f): f is Finding => f !== undefined,
    );
    const conflicting = [
      byPolarity.positive,
      ...g.inputFindings.filter((f) => POLARITY_OF[f.kind] === "positive"),
    ].filter((f): f is Finding => f !== undefined);
    const comments = counts.negative + counts.request;
    const praise = conflicting.reduce((n, f) => n + f.mentions, 0);
    const markets = [...new Set(supporting.flatMap((f) => f.markets))].sort();
    const textRuleComments = new Set(
      g.observations
        .filter((o2) => o2.mention.polarity !== "positive" && o2.mention.method === "text_rule")
        .map((o2) => o2.record.id),
    ).size;
    const example = supporting.find((f) => f.evidence.length > 0)?.evidence[0]?.excerpt ?? "";
    const share = Math.round((1000 * comments) / totalComments) / 10;
    const ranking = inputs[g.input]!;

    const uncertainties: string[] = [];
    if (comments > 0 && comments < MIN_COMMENTS_NOT_ANECDOTAL) {
      uncertainties.push(`Only ${plural(comments, "comment")}: this could be anecdotal.`);
    }
    if (textRuleComments > 0) {
      uncertainties.push(
        `${textRuleComments} of ${comments} comments were placed by keyword rules on untagged text, not by BMW's own classification.`,
      );
    }
    if (praise > 0) {
      uncertainties.push(
        `${plural(praise, "customer comment")} praise the same aspect; changing it could disappoint them.`,
      );
    }
    if (markets.length > 0 && !markets.includes(o.scope.market)) {
      uncertainties.push(
        `No evidence from ${o.scope.market}; all of it comes from ${markets.join(", ")}.`,
      );
    }
    uncertainties.push(
      "Counts are comments, not affected vehicles: not yet weighted by sales volume.",
    );

    const assumptions = [
      `What customers of the current ${o.scope.vehicleLine} report still matters to customers of its successor in ${o.scope.horizonYears} years.`,
    ];
    if (markets.length > 0 && !markets.every((m) => m === o.scope.market)) {
      assumptions.push(
        `Feedback from ${markets.join(", ")} is representative for customers in ${o.scope.market}.`,
      );
    }

    const verb =
      counts.negative >= counts.request
        ? `${plural(counts.negative, "complaint")}` +
          (counts.request ? ` and ${plural(counts.request, "request")}` : "")
        : `${plural(counts.request, "request")}` +
          (counts.negative ? ` and ${plural(counts.negative, "complaint")}` : "");
    const upstream = x.upstreamSupport.length
      ? ` ${plural(x.upstreamSupport.length, "upstream finding")} point the same way.`
      : "";
    const description =
      (comments > 0
        ? `Customers raise ${lower(c.label)} › ${lower(a.label)}: ${verb} in the ${plural(totalComments, "classified comment")} of this run` +
          (markets.length ? ` (${markets.join(", ")})` : "") +
          "." +
          (example
            ? ` Example: "${example.length > 160 ? `${example.slice(0, 159)}…` : example}".`
            : "")
        : `Upstream findings point to ${lower(c.label)} › ${lower(a.label)}.`) +
      upstream +
      ` The successor should ${a.action} so that this feedback no longer recurs.`;

    return Requirement.parse({
      id: formatRequirementId(o.scope.vehicleCode, o.scope.market, (o.firstSeq ?? 1) + i),
      version: 1,
      title: `${c.label}: ${a.action}`.slice(0, 120),
      description,
      category: areaOf(c, g.aspect),
      scope: o.scope,
      targets:
        comments > 0
          ? [
              {
                metric: `Share of customer comments about ${lower(c.label)} › ${lower(a.label)} that are complaints or requests`,
                target: `At most half of today's share (today ${share} %: ${comments} of ${totalComments} classified comments)`,
                acceptance:
                  "Classify post-launch customer feedback for the successor with the same rules and compare the share.",
              },
            ]
          : [],
      findingIds: supporting.map((f) => f.id),
      sourceIds: [...new Set(supporting.flatMap((f) => f.evidence.map((e) => e.sourceId)))].sort(),
      conflictingFindingIds: conflicting.map((f) => f.id),
      priority: ranking.priority,
      priorityRationale:
        `Arrived on the "${ranking.ranking}" input (${g.input + 1} of ${inputs.length}), so the flow ranked it ${ranking.priority}.` +
        ` Within that input it is #${ranked.filter((y) => y.group.input === g.input).indexOf(x) + 1} by number of complaints and requests (${x.weight}).`,
      evidenceLevel: evidenceLevel(supporting, sources, comments, praise),
      kano: a.kano,
      assumptions,
      uncertainties,
      status: "proposed",
      createdBy: ACTOR,
      createdAt: o.now,
      updatedAt: o.now,
      runId: o.runId,
    });
  });

  return { findings, excluded, themes, requirements, stats };
}

export { ACTOR as ADD_TO_CAR_ACTOR };
