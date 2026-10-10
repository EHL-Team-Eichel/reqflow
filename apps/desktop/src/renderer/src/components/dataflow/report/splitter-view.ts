import {
  graphAt,
  getDownstreamBlockIds,
  walkBlocks,
  type Lineage,
  type SplitterGroup,
  type SplitterReport,
  type SplitterSignal,
  type WorkflowRun,
} from "@reqflow/core";
import { pausedHil } from "../run-store";

export const SPLITTER_MODE_HELP: Record<SplitterReport["mode"], string> = {
  customer_priority:
    "Groups raw feedback into customer needs, then routes by 70% normalized frequency and 30% interpreted impact. This is not the six-factor requirement priority.",
  car_parts:
    "AI discovers car-part groups from raw evidence. Each item has one output; it may provide signals for several needs. No requirement decision is made.",
  custom:
    "AI interprets your instruction to discover or route groups. A score exists only when the saved report records a scoring method.",
  priority:
    "Routes upstream requirements by their existing six-factor priority. Raw-feedback need scores are a different measure.",
  category: "Routes by the existing requirement category, not by customer importance.",
  sentiment:
    "Routes by interpreted sentiment. Sentiment is not customer priority or evidence confidence.",
};

export function splitterBranches(mode: string, count: number): string[] {
  if (!Number.isInteger(count) || count < 2 || count > 10)
    throw new Error("Choose an output count from 2 to 10.");
  if (mode === "customer_priority") {
    const presets: Record<number, string[]> = {
      2: ["High", "Low"],
      3: ["High", "Medium", "Low"],
      4: ["Very High", "High", "Low", "Very Low"],
      5: ["Very High", "High", "Medium", "Low", "Very Low"],
    };
    return (
      presets[count] ??
      Array.from(
        { length: count },
        (_, i) => `Band ${i + 1}${i === 0 ? " (highest)" : i === count - 1 ? " (lowest)" : ""}`,
      )
    );
  }
  return Array.from(
    { length: count },
    (_, i) => `${mode === "car_parts" ? "Part group" : "Group"} ${i + 1}`,
  );
}

/** Geometry only: never recompute a score, a weighted contribution, or a routing threshold here. */
export const chartWidth = (value: number | null) =>
  value === null || !Number.isFinite(value) ? 0 : Math.min(100, Math.max(0, value));
export const formatScore = (value: number | null) =>
  value === null ? "Not computed" : Number(value.toFixed(1)).toString();
export const formatConfidence = (value: number | null) =>
  value === null ? "Not reported" : `${Math.round(value * 100)}%`;

export function rankedGroups(groups: readonly SplitterGroup[]) {
  const sorted = [...groups].sort((a, b) =>
    a.score === null ? (b.score === null ? 0 : 1) : b.score === null ? -1 : b.score - a.score,
  );
  let previous: number | null = null;
  let rank = 0;
  return sorted.map((group, index) => {
    if (group.score !== null && (rank === 0 || group.score !== previous)) rank = index + 1;
    previous = group.score;
    return { group, rank: group.score === null ? null : rank };
  });
}

export function reportForStep(run: WorkflowRun | null | undefined, blockId: string) {
  const report = run?.blockRuns.find((br) => br.blockId === blockId)?.splitterReport;
  return report && report.runId === run?.id && report.blockId === blockId ? report : null;
}

export function reportsInLineage(run: WorkflowRun | null, lineage: Lineage) {
  return lineage.steps
    .flatMap((step) => {
      const report = step.block.kind === "ai_splitter" ? reportForStep(run, step.block.id) : null;
      return report ? [{ step, report }] : [];
    })
    .sort((a, b) => a.step.distance - b.step.distance);
}

export interface SignalFilter {
  groupId?: string;
  sourceId?: string;
  stance?: SplitterSignal["stance"] | "all";
  query?: string;
}

export function filterSignals(report: SplitterReport, filter: SignalFilter) {
  const query = filter.query?.trim().toLowerCase();
  return report.signals.filter(
    (signal) =>
      (!filter.groupId || signal.groupId === filter.groupId) &&
      (!filter.sourceId || signal.evidence.sourceId === filter.sourceId) &&
      (!filter.stance || filter.stance === "all" || signal.stance === filter.stance) &&
      (!query ||
        [
          signal.reason,
          signal.evidence.excerpt,
          signal.evidence.locator,
          signal.evidence.recordId,
          signal.unitId,
        ].some((text) => text?.toLowerCase().includes(query))),
  );
}

/** Stance sets can overlap. Never sum them into a claimed unique feedback/customer count. */
export function matrixDescription(cell: SplitterReport["sourceMatrix"][number]) {
  return `${cell.support} support · ${cell.opposition} opposition · ${cell.unclear} unclear / ${
    cell.denominator === null
      ? "denominator not reported"
      : `${cell.denominator} units in this source`
  }`;
}

export function splitterReviewGate(run: WorkflowRun | null, blockId: string) {
  const gate = pausedHil(run);
  if (
    !run ||
    !gate ||
    gate.block.params.allowEdits !== true ||
    reportForStep(run, blockId)?.input.primaryLayer !== "records"
  )
    return null;
  if (!run.blockRuns.some((br) => br.blockId === blockId && br.status === "succeeded")) return null;
  const splitter = [...walkBlocks(run.graph)].find(
    (step) => step.block.id === blockId && step.block.kind === "ai_splitter",
  );
  if (!splitter || JSON.stringify(splitter.path) !== JSON.stringify(gate.path)) return null;
  const graph = graphAt(run.graph, gate.path);
  if (!graph.edges.some((edge) => edge.source === blockId && edge.target === gate.block.id))
    return null;
  const downstream = getDownstreamBlockIds(graph, blockId);
  return run.blockRuns.some((br) => downstream.has(br.blockId) && br.status === "succeeded")
    ? null
    : gate;
}

/** Persisted revisions invalidate saved output reads, including the HIL's exact input ports. */
export function reportRevision(run: WorkflowRun | null | undefined) {
  return (
    run?.blockRuns
      .map((br) => `${br.blockId}:${br.splitterReport?.reviews.length ?? 0}`)
      .join("|") ?? ""
  );
}
