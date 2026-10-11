import type { Finding, Source, SourceRecord } from "@reqflow/core";

export interface ScoringEvidence {
  findings: Finding[]; // supporting findings (any kind)
  conflicting?: Finding[]; // findings that argue against it
  records: SourceRecord[]; // supporting records (used when there are no findings)
  sources: Source[]; // the sources those findings/records come from
}

export type DeterministicFactor =
  "customer_impact" | "evidence_strength" | "competitive_gap" | "trend_momentum";

const QUANTITATIVE_SOURCE_KINDS = new Set(["customer_study", "equipment_data", "sales_volume"]);

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Deterministic prioritization factors (0–5, pure functions, no LLM):
 * - customer_impact: base from mentions (m=0→0, 1→1, 2–4→2, 5–9→3, 10–24→4, ≥25→5) over complaint/unmet_need/praise/usage_pattern,
 *   plus pain bonus +1 (cap 5) if weighted mean sentiment ≤ -0.3 or >50% mentions are complaint/unmet_need,
 *   plus quantitative bonus +0.5 (cap 5) if usage_pattern cites quantitative BMW data.
 * - evidence_strength: sum of distinct cited source reliability weights (high 1.5, med 1, low 0.5, missing 0.75) + 1 if quantitative BMW data,
 *   min(5, points), minus 1 (floor 0) if conflicting findings have ≥ half supporting mentions.
 * - competitive_gap: competitor_advantage mentions (0→0, 1→2, 2–4→3, 5–9→4, ≥10→5).
 * - trend_momentum: market_trend mentions (same scale as competitive_gap), +1 (cap 5) if ≥2 distinct sources.
 */
export function deterministicFactors(
  e: ScoringEvidence,
): Record<DeterministicFactor, { value: number; note: string }> {
  const sourcesById = new Map<string, Source>(e.sources.map((s) => [s.id, s]));

  // ── 1. Customer Impact ─────────────────────────────────────────────────────────────
  const relevantFindings = e.findings.filter(
    (f) =>
      f.kind === "complaint" ||
      f.kind === "unmet_need" ||
      f.kind === "praise" ||
      f.kind === "usage_pattern",
  );

  let m = 0;
  let hasFindings = false;
  if (e.findings.length > 0) {
    hasFindings = true;
    m = relevantFindings.reduce((sum, f) => sum + f.mentions, 0);
  } else {
    m = e.records.length;
  }

  let customerImpactValue = 0;
  let customerImpactNote = "No customer mentions in the evidence.";

  if (m > 0) {
    let base = 0;
    if (m === 1) base = 1;
    else if (m <= 4) base = 2;
    else if (m <= 9) base = 3;
    else if (m <= 24) base = 4;
    else base = 5;

    let painBonus = false;
    let quantBonus = false;
    let meanSentiment = 0;
    let painMentions = 0;

    if (hasFindings && relevantFindings.length > 0) {
      const weightedSentimentSum = relevantFindings.reduce(
        (sum, f) => sum + f.mentions * (f.sentiment ?? 0),
        0,
      );
      meanSentiment = weightedSentimentSum / m;
      painMentions = relevantFindings
        .filter((f) => f.kind === "complaint" || f.kind === "unmet_need")
        .reduce((sum, f) => sum + f.mentions, 0);

      if (round1(meanSentiment) <= -0.3 || painMentions > m / 2) {
        painBonus = true;
      }

      const hasQuantUsage = relevantFindings.some(
        (f) =>
          f.kind === "usage_pattern" &&
          f.evidence.some((ev) => {
            const src = sourcesById.get(ev.sourceId);
            return src && QUANTITATIVE_SOURCE_KINDS.has(src.kind);
          }),
      );
      if (hasQuantUsage) {
        quantBonus = true;
      }
    }

    let val = base;
    if (painBonus) val = Math.min(5, val + 1);
    if (quantBonus) val = Math.min(5, val + 0.5);
    customerImpactValue = round1(val);

    const countPart = hasFindings
      ? `${m} customer mention${m === 1 ? "" : "s"} in ${relevantFindings.length} finding${relevantFindings.length === 1 ? "" : "s"}`
      : `${m} customer mention${m === 1 ? "" : "s"} across ${m} record${m === 1 ? "" : "s"}`;

    const sentimentStr =
      round1(meanSentiment) <= 0 ? `${round1(meanSentiment)}` : `+${round1(meanSentiment)}`;
    const mostlyPain = painMentions > m / 2;
    const painPart = !hasFindings
      ? ""
      : mostlyPain
        ? `, mostly complaints or unmet needs (mean sentiment ${sentimentStr})`
        : painBonus
          ? `, clearly negative (mean sentiment ${sentimentStr})`
          : ` (mean sentiment ${sentimentStr})`;
    const quantPart = quantBonus ? "; quantitative BMW data backs it." : ".";
    customerImpactNote = `${countPart}${painPart}${quantPart}`;
  }

  // ── 2. Evidence Strength ───────────────────────────────────────────────────────────
  const citedSourceIds = new Set<string>();
  if (e.findings.length > 0) {
    for (const f of e.findings) {
      for (const ev of f.evidence) {
        citedSourceIds.add(ev.sourceId);
      }
    }
  } else {
    for (const r of e.records) {
      citedSourceIds.add(r.sourceId);
    }
  }

  let evidenceStrengthValue = 0;
  let evidenceStrengthNote = "No sources in the evidence.";

  if (citedSourceIds.size > 0) {
    let points = 0;
    let high = 0;
    let medium = 0;
    let low = 0;
    let unrated = 0;
    let hasQuantBmw = false;

    for (const id of citedSourceIds) {
      const src = sourcesById.get(id);
      if (src && QUANTITATIVE_SOURCE_KINDS.has(src.kind)) {
        hasQuantBmw = true;
      }
      const rel = src?.reliability;
      if (rel === "high") {
        points += 1.5;
        high++;
      } else if (rel === "medium") {
        points += 1.0;
        medium++;
      } else if (rel === "low") {
        points += 0.5;
        low++;
      } else {
        points += 0.75;
        unrated++;
      }
    }

    if (hasQuantBmw) points += 1.0;
    let val = Math.min(5, points);

    const conflicting = e.conflicting ?? [];
    const conflictingMentions = conflicting.reduce((sum, f) => sum + f.mentions, 0);
    const supportingMentions =
      e.findings.length > 0 ? e.findings.reduce((sum, f) => sum + f.mentions, 0) : e.records.length;

    const conflictPenalty =
      conflicting.length > 0 &&
      supportingMentions > 0 &&
      conflictingMentions >= supportingMentions / 2;

    if (conflictPenalty) {
      val = Math.max(0, val - 1);
    }
    evidenceStrengthValue = round1(val);

    const relCounts: string[] = [];
    if (high) relCounts.push(`${high} high`);
    if (medium) relCounts.push(`${medium} medium`);
    if (low) relCounts.push(`${low} low`);
    if (unrated) relCounts.push(`${unrated} unrated`);
    const relSummary = relCounts.join(", ") + " reliability";

    const quantStr = hasQuantBmw ? " incl. quantitative BMW data" : "";
    const conflictStr =
      conflicting.length > 0
        ? `; ${conflicting.length} conflicting finding${conflicting.length === 1 ? "" : "s"}.`
        : ".";

    evidenceStrengthNote = `${citedSourceIds.size} independent source${citedSourceIds.size === 1 ? "" : "s"} (${relSummary})${quantStr}${conflictStr}`;
  }

  // ── 3. Competitive Gap ─────────────────────────────────────────────────────────────
  const compFindings = e.findings.filter((f) => f.kind === "competitor_advantage");
  const c = compFindings.reduce((sum, f) => sum + f.mentions, 0);

  let competitiveGapValue = 0;
  let competitiveGapNote = "No competitor advantage in the evidence.";

  if (c > 0) {
    if (c === 1) competitiveGapValue = 2;
    else if (c <= 4) competitiveGapValue = 3;
    else if (c <= 9) competitiveGapValue = 4;
    else competitiveGapValue = 5;

    competitiveGapNote = `${c} competitor mention${c === 1 ? "" : "s"} in ${compFindings.length} finding${compFindings.length === 1 ? "" : "s"}.`;
  }

  // ── 4. Trend Momentum ──────────────────────────────────────────────────────────────
  const trendFindings = e.findings.filter((f) => f.kind === "market_trend");
  const t = trendFindings.reduce((sum, f) => sum + f.mentions, 0);

  let trendMomentumValue = 0;
  let trendMomentumNote = "No market trend in the evidence.";

  if (t > 0) {
    let base = 0;
    if (t === 1) base = 2;
    else if (t <= 4) base = 3;
    else if (t <= 9) base = 4;
    else base = 5;

    const trendSources = new Set(trendFindings.flatMap((f) => f.evidence.map((ev) => ev.sourceId)));
    if (trendSources.size >= 2) {
      base = Math.min(5, base + 1);
    }
    trendMomentumValue = round1(base);
    trendMomentumNote = `${t} market trend mention${t === 1 ? "" : "s"} in ${trendFindings.length} finding${trendFindings.length === 1 ? "" : "s"} from ${trendSources.size} source${trendSources.size === 1 ? "" : "s"}.`;
  }

  return {
    customer_impact: { value: customerImpactValue, note: customerImpactNote },
    evidence_strength: { value: evidenceStrengthValue, note: evidenceStrengthNote },
    competitive_gap: { value: competitiveGapValue, note: competitiveGapNote },
    trend_momentum: { value: trendMomentumValue, note: trendMomentumNote },
  };
}
