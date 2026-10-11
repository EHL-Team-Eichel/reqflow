import {
  FilterReview,
  FilterReviewState,
  decisionLayer,
  filterOriginals,
  type FilterReport,
  type WorkflowRun,
} from "@reqflow/core";

export type FilterDecision = FilterReport["decisions"][number];
export const FILTER_TABS = [
  { value: "keep", label: "Kept" },
  { value: "exclude", label: "Excluded" },
  { value: "review", label: "Needs review" },
] as const;
export type FilterTab = (typeof FILTER_TABS)[number]["value"];

export function safeFilterJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "Not recorded";
  } catch {
    return "Saved value cannot be displayed as JSON.";
  }
}

export function filterRows(report: FilterReport) {
  const originals = filterOriginals(report);
  const records = new Map(report.originalInput.records.map((item) => [item.id, item]));
  const sources = new Map(report.originalInput.sources.map((item) => [item.id, item]));
  return report.decisions.map((decision) => ({
    decision,
    layer: decisionLayer(report, decision),
    original: originals.get(decision.itemId),
    search:
      `${safeFilterJson(decision)} ${safeFilterJson(originals.get(decision.itemId))} ${decision.quotes
        .map((quote) => {
          const record = records.get(quote.recordId);
          const source = sources.get(record?.sourceId ?? "");
          return `${record?.locator ?? ""} ${source?.title ?? ""} ${source?.uri ?? ""}`;
        })
        .join(" ")}`.toLowerCase(),
  }));
}

export function filterProvenance(
  report: FilterReport,
  original: ReturnType<typeof filterRows>[number]["original"],
) {
  if (!original) return null;
  const object = original as unknown as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const findingIds = new Set([
    ...strings(object.findingIds),
    ...strings(object.conflictingFindingIds),
  ]);
  const findings = report.originalInput.findings.filter((item) => findingIds.has(item.id));
  const evidence = [
    ...(Array.isArray(object.evidence)
      ? object.evidence.filter((ref) => ref !== null && typeof ref === "object")
      : []),
    ...findings.flatMap((item) => item.evidence),
  ] as Array<{ sourceId?: string; recordId?: string; locator?: string; excerpt?: string }>;
  const sourceIds = new Set([
    ...strings(object.sourceIds),
    ...evidence.map((ref) => ref.sourceId),
    object.sourceId,
    object.id,
  ]);
  const recordIds = new Set(evidence.map((ref) => ref.recordId));
  return {
    locator: object.locator,
    sources: report.originalInput.sources.filter((item) => sourceIds.has(item.id)),
    records: report.originalInput.records.filter((item) => recordIds.has(item.id)),
    findings,
    evidence,
  };
}

export interface FilterRestoreApi {
  reviewFilter(runId: string, blockId: string, input: FilterReview): Promise<FilterReviewState>;
  filterReviewState(runId: string, blockId: string): Promise<FilterReviewState>;
}

export async function saveFilterRestore(
  api: FilterRestoreApi,
  report: FilterReport,
  input: FilterReview,
  refreshed: (state: FilterReviewState | null) => void,
) {
  try {
    const saved = FilterReviewState.parse(
      await api.reviewFilter(report.runId, report.blockId, input),
    );
    if (saved.version <= input.expectedVersion)
      throw new Error("The backend did not confirm a new restore version.");
    // Read pending state only. No historical run/report/output is fetched or mutated.
    const latest = FilterReviewState.parse(
      await api.filterReviewState(report.runId, report.blockId),
    );
    if (
      latest.version < saved.version ||
      input.itemIds.some((id) => {
        const item = report.decisions.find((decision) => decision.itemId === id);
        return !item || !pendingFilterOverride(report, item, latest);
      })
    )
      throw new Error(
        "The refreshed state did not confirm a matching persisted restore. Check pending state before retrying.",
      );
    return latest;
  } catch (cause) {
    try {
      refreshed(FilterReviewState.parse(await api.filterReviewState(report.runId, report.blockId)));
    } catch (refreshError) {
      refreshed(null);
      throw new Error(
        `${cause instanceof Error ? cause.message : String(cause)} Pending-state refresh also failed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}. The save may have succeeded; refresh before retrying.`,
      );
    }
    throw new Error(
      `${cause instanceof Error ? cause.message : String(cause)} Pending state was refreshed. Check the current version and explicitly retry if needed. Historical output is unchanged.`,
    );
  }
}

export function filterPage(
  rows: ReturnType<typeof filterRows>,
  tab: FilterTab,
  query: string,
  requestedPage: number,
) {
  const counts = { keep: 0, exclude: 0, review: 0 };
  for (const row of rows) counts[row.decision.outcome]++;
  const matching = rows.filter(
    (row) => row.decision.outcome === tab && row.search.includes(query.trim().toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(matching.length / 20));
  const page = Math.min(pages - 1, Math.max(0, Math.floor(requestedPage) || 0));
  return {
    counts,
    total: matching.length,
    pages,
    page,
    rows: matching.slice(page * 20, page * 20 + 20),
  };
}

export function filterDisposition(item: FilterDecision): string {
  return `${item.forwarded ? "Forwarded" : "Held / not forwarded"}${item.retainedAsContext ? "; retained as supporting context" : "; not retained as context"}`;
}

export function pendingFilterOverride(
  report: FilterReport,
  item: FilterDecision,
  state: FilterReviewState | null,
) {
  return state?.overrides.find(
    (override) =>
      override.itemId === item.itemId &&
      override.itemHash === item.itemHash &&
      override.configurationHash === report.configurationHash,
  );
}

export function filterRestoreGuard(
  run: WorkflowRun | null,
  report: FilterReport,
  item: FilterDecision,
  state: FilterReviewState | null,
): string | null {
  if (!run || run.id !== report.runId) return "Open the matching saved run before restoring.";
  if (run.status !== "completed" && run.status !== "waiting_for_review")
    return "Restore is available only for completed runs or runs waiting for review.";
  if (!report.decisions.includes(item)) return "Select an item from this saved report.";
  if (!(item.outcome === "exclude" || (item.outcome === "review" && !item.forwarded)))
    return "Only excluded items or held review items can be restored.";
  if (!state) return "Read pending restore state before saving.";
  if (pendingFilterOverride(report, item, state))
    return "A matching restore is already pending for the next full run.";
  return null;
}

export function filterRestoreRequest(
  run: WorkflowRun | null,
  report: FilterReport,
  item: FilterDecision,
  state: FilterReviewState | null,
  rationale: string,
) {
  const error = filterRestoreGuard(run, report, item, state);
  if (error) throw new Error(error);
  return FilterReview.parse({
    expectedVersion: FilterReviewState.parse(state).version,
    itemIds: [item.itemId],
    rationale,
  });
}

/** Both successes and failures must still belong to the active run/block selection. */
export async function settleFilterRequest<T>(
  read: () => Promise<T>,
  current: () => boolean,
  success: (value: T) => void,
  failure: (message: string) => void,
) {
  try {
    const result = await read();
    if (current()) success(result);
  } catch (cause) {
    if (current()) failure(cause instanceof Error ? cause.message : String(cause));
  }
}
