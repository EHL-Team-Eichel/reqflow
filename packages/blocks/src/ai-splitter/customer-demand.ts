import type { SplitterGroup, SplitterSignal } from "@reqflow/core";
import type { PlannedGroup } from "./raw-protocol";

/** Internal identity survives aggregation even when multiple canonical needs share a report group. */
export type DemandSignal = SplitterSignal & { needId: string };

type UnitSummary = {
  stance: SplitterSignal["stance"];
  impact: number | null;
  confidence: number | null;
};
function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/**
 * Source/record IDs change on reimport, so they cannot identify an impact observation.
 * Within one already-deduplicated unit, canonical need + exact excerpt identifies the evidence.
 * Keep distinct needs/excerpts independent. If that same observation has different AI anchor
 * judgements, average each distinct available anchor once; copies never add judgement weight.
 * Original signals/citations remain untouched for the report and stance conflict detection.
 */
function observationImpact(entries: DemandSignal[]): number | null {
  const observations = new Map<string, Set<number>>();
  for (const signal of entries) {
    if (signal.impact === null) continue;
    const key = JSON.stringify([signal.needId, signal.evidence.excerpt]);
    const impacts = observations.get(key) ?? new Set<number>();
    impacts.add(signal.impact);
    observations.set(key, impacts);
  }
  return mean([...observations.values()].map((impacts) => mean([...impacts])!));
}

/** One vote per feedback unit/group. Conflicting stances within one unit become unclear. */
export function summarizeUnits(
  signals: DemandSignal[],
  feedback: Set<string>,
): Map<string, UnitSummary> {
  const units = new Map<string, DemandSignal[]>();
  for (const signal of signals) {
    if (!feedback.has(signal.evidence.recordId)) continue;
    const entries = units.get(signal.unitId) ?? [];
    entries.push(signal);
    units.set(signal.unitId, entries);
  }
  return new Map(
    [...units].map(([id, entries]) => {
      const stances = new Set(entries.map((s) => s.stance));
      const stance = stances.size === 1 ? entries[0]!.stance : "unclear";
      return [
        id,
        {
          stance,
          impact: stance === "support" ? observationImpact(entries) : null,
          confidence: mean(entries.flatMap((s) => (s.confidence === null ? [] : [s.confidence]))),
        },
      ];
    }),
  );
}
export function stanceCounts(units: Map<string, UnitSummary>) {
  const count = { support: 0, opposition: 0, unclear: 0 };
  for (const unit of units.values()) count[unit.stance]++;
  return count;
}

export function thresholds(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    portId: `out-${i}`,
    min: (100 * (count - i - 1)) / count,
    max: (100 * (count - i)) / count,
  }));
}
/** Inclusive lower bounds, exclusive upper bounds except 100; no quantiles or tie splitting. */
export function demandBand(score: number | null, count: number): number {
  if (score === null) return count - 1;
  for (const [i, band] of thresholds(count).entries()) if (score >= band.min) return i;
  return count - 1;
}
export function bandLabels(count: number): string[] {
  if (count === 2) return ["High", "Low"];
  if (count === 3) return ["High", "Medium", "Low"];
  if (count === 5) return ["Very High", "High", "Medium", "Low", "Very Low"];
  return thresholds(count).map((t) => `Demand ${format(t.min)}–${format(t.max)}`);
}
function format(value: number): string {
  return Number(value.toFixed(2)).toString();
}

/**
 * Demand is CODE ONLY: F=100*support/max_support, I=mean available supporting unit impacts,
 * score=0.7F+0.3I. Each unit contributes once; reimported evidence observations add no impact weight.
 * No available supporting impact means null I/contribution/score, never a fabricated zero.
 */
export function calculateGroups(
  plan: PlannedGroup[],
  signals: DemandSignal[],
  feedback: Set<string>,
  count: number,
  customerMode: boolean,
): SplitterGroup[] {
  const summaries = plan.map((group) =>
    summarizeUnits(
      signals.filter((s) => s.groupId === group.id),
      feedback,
    ),
  );
  const counts = summaries.map(stanceCounts);
  const maxSupport = Math.max(0, ...counts.map((c) => c.support));
  return plan.map((group, i) => {
    const units = summaries[i]!;
    const impact = mean(
      [...units.values()].flatMap((u) =>
        u.stance === "support" && u.impact !== null ? [u.impact] : [],
      ),
    );
    const frequency = maxSupport > 0 ? (100 * counts[i]!.support) / maxSupport : null;
    const frequencyContribution = frequency === null ? null : 0.7 * frequency;
    const impactContribution = impact === null ? null : 0.3 * impact;
    const score =
      frequencyContribution === null || impactContribution === null
        ? null
        : Math.min(100, Math.max(0, frequencyContribution + impactContribution));
    const missingImpacts = [...units.values()].filter(
      (u) => u.stance === "support" && u.impact === null,
    ).length;
    return {
      id: group.id,
      label: group.label,
      description: group.description,
      outputPortId: `out-${customerMode ? demandBand(score, count) : i}`,
      ...counts[i]!,
      frequency,
      impact,
      frequencyContribution,
      impactContribution,
      score,
      scoreOrigin: score === null ? "not_computed" : "calculated",
      confidence: mean(
        [...units.values()].flatMap((u) => (u.confidence === null ? [] : [u.confidence])),
      ),
      assumptions: [
        "Frequency measures distinct feedback entries, not people or population prevalence.",
        "Within each feedback unit, canonical need plus verbatim excerpt identifies an impact observation; reimported copies add no impact weight.",
        ...(missingImpacts
          ? [
              `${missingImpacts} supporting feedback units have no expressed impact; available impacts only contribute to the mean.`,
            ]
          : []),
        ...(impact === null
          ? ["Expressed supporting impact is absent; customer demand score is not computed."]
          : []),
      ],
    };
  });
}
