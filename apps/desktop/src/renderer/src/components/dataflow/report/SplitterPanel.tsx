import { useRef, useState } from "react";
import { useStore } from "zustand";
import type { PipelineData, SplitterAssignment, SplitterReport, WorkflowRun } from "@reqflow/core";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Select, TextArea, TextInput } from "@/components/ui/controls";
import { runStore } from "../run-session";
import { ConfidenceLabel, EvidenceBalance, ScoreBreakdown, SourceHeatmap } from "./SplitterCharts";
import { SplitterEvidence } from "./SplitterEvidence";
import { saveSplitterCorrection, type SplitterReviewApi } from "./splitter-review";
import {
  filterSignals,
  formatScore,
  rankedGroups,
  SPLITTER_MODE_HELP,
  splitterReviewGate,
} from "./splitter-view";

const ORIGIN_LABELS = {
  calculated: "Computed score",
  upstream: "Upstream score",
  human_override: "Human override",
  not_computed: "Not computed",
};
type Section = "Ranking & balance" | "Source × need" | "Item routes";

export function SplitterPanel({
  report,
  run,
  data,
  loading,
  error,
  onRetry,
}: {
  report: SplitterReport | null;
  run: WorkflowRun | null;
  data: PipelineData | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (!report)
    return (
      <div data-testid="splitter-report-empty" className="p-6 text-sm">
        <h3 className="font-semibold text-ink">Scores & routing · not computed</h3>
        <p className="mt-2 text-muted">
          {run
            ? "This saved run has no analytical splitter report. Legacy output remains available in Source / raw data; no score or classification has been invented."
            : "This flow has not run. Run the splitter to store classifications, score components and evidence. No preview score is computed in the renderer."}
        </p>
      </div>
    );
  return (
    <StoredSplitterPanel
      key={`${report.runId}:${report.blockId}`}
      report={report}
      run={run}
      data={data}
      loading={loading}
      error={error}
      onRetry={onRetry}
    />
  );
}

function StoredSplitterPanel({
  report,
  run,
  data,
  loading,
  error,
  onRetry,
}: {
  report: SplitterReport;
  run: WorkflowRun | null;
  data: PipelineData | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const ranking = rankedGroups(report.groups);
  const [section, setSection] = useState<Section>("Ranking & balance");
  const [groupId, setGroupId] = useState(ranking[0]?.group.id ?? "");
  const [sourceId, setSourceId] = useState("");
  const [stance, setStance] = useState<"all" | "support" | "opposition" | "unclear">("all");
  const [query, setQuery] = useState("");
  const [signalLimit, setSignalLimit] = useState(30);
  const [routeLimit, setRouteLimit] = useState(30);
  const detailRef = useRef<HTMLDivElement>(null);
  const group = report.groups.find((item) => item.id === groupId);
  const signals = filterSignals(report, {
    groupId: groupId || undefined,
    sourceId: sourceId || undefined,
    stance,
    query,
  });
  const routes = report.assignments.filter(
    (item) =>
      (!groupId || item.groupIds.includes(groupId) || item.primaryGroupId === groupId) &&
      (!query.trim() ||
        `${item.itemId} ${item.reason} ${item.evidence.map((ref) => ref.excerpt).join(" ")}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())),
  );
  const branchLabel = (portId: string) =>
    report.branches.find((branch) => branch.portId === portId)?.label ?? portId;
  const selectEvidence = (nextGroupId: string, nextSourceId = "") => {
    setGroupId(nextGroupId);
    setSourceId(nextSourceId);
    setStance("all");
    setQuery("");
    setSignalLimit(30);
    requestAnimationFrame(() =>
      detailRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  };

  return (
    <div data-testid="splitter-report" className="space-y-4 p-4 text-ink">
      {loading && (
        <p role="status" className="text-xs text-muted">
          Reading exact original records from this saved run. Report values remain available below.
        </p>
      )}
      {error && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-danger bg-danger-soft p-3 text-xs">
          <p role="alert" className="min-w-0 flex-1 text-danger">
            Could not read saved originals: {error}. Report excerpts remain available; no source has
            been refreshed.
          </p>
          <Button onClick={onRetry}>Retry saved data read</Button>
        </div>
      )}
      <div className="rounded-lg border border-line bg-panel-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">Saved splitter analysis</h3>
          <span className="rounded bg-brand-soft px-2 py-1 text-xs font-medium text-brand">
            Run snapshot · review v{report.reviews.length}
          </span>
        </div>
        <p className="mt-2 text-sm text-muted">{SPLITTER_MODE_HELP[report.mode]}</p>
        <div className="mt-3 grid grid-cols-4 gap-3 text-xs">
          <Metric value={report.input.feedbackUnitCount} label="Feedback units" />
          <Metric value={report.input.contextUnitCount} label="Context units" />
          <Metric value={report.input.recordCount} label="Original records" />
          <Metric value={report.input.sourceCount} label="Sources" />
        </div>
        <p className="mt-3 text-xs text-muted">
          {report.input.countingBasis} Duplicate units: {report.input.duplicateUnitCount}. Customer
          count: unknown; feedback units are not customers.
        </p>
        <p className="mt-1 text-xs text-muted">
          Primary routing layer: {report.input.primaryLayer} · {report.input.primaryCount} items.
          Original records and provenance remain in Source / raw data.
        </p>
      </div>

      <section
        className="rounded-lg border border-line p-3 text-xs"
        aria-label="Scoring method and limitations"
      >
        <p className="font-medium">
          Stored formula: <span className="font-mono">{report.scoreMethod.formula}</span>
        </p>
        <p className="mt-1 text-muted">
          Frequency weight {Math.round(report.scoreMethod.frequencyWeight * 100)}% · impact weight{" "}
          {Math.round(report.scoreMethod.impactWeight * 100)}%. Components below are saved values,
          not recalculated here.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge>AI interpretation: groups, stance, impact & confidence</Badge>
          <Badge>Computed: frequency & weighted score when reported</Badge>
          {report.reviews.length > 0 && (
            <Badge>Human override: {report.reviews.length} saved routing review(s)</Badge>
          )}
        </div>
        <details className="mt-3">
          <summary className="cursor-pointer font-medium text-brand">
            Method, model, thresholds & limitations
          </summary>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-muted">
            <dt>Method</dt>
            <dd className="break-words">{report.scoreMethod.id}</dd>
            <dt>Models</dt>
            <dd className="break-words">{report.models.join(", ") || "Not reported"}</dd>
            <dt>Snapshot</dt>
            <dd>
              {report.createdAt} · {report.runId} · {report.blockId}
            </dd>
            <dt>Impact scale</dt>
            <dd>
              {report.scoreMethod.impactScale.length ? (
                <ul className="list-inside list-disc space-y-1">
                  {report.scoreMethod.impactScale.map((label, index) => (
                    <li key={index}>{label}</li>
                  ))}
                </ul>
              ) : (
                "Not reported"
              )}
            </dd>
            <dt>Thresholds</dt>
            <dd>
              {report.scoreMethod.thresholds.length ? (
                <ul>
                  {report.scoreMethod.thresholds.map((threshold, index) => (
                    <li key={index}>
                      {branchLabel(threshold.portId)} ({threshold.portId}): {threshold.min} to{" "}
                      {threshold.max}
                    </li>
                  ))}
                </ul>
              ) : (
                "Not computed / not applicable"
              )}
            </dd>
            <dt>Limitations</dt>
            <dd>
              {report.limitations.length ? (
                <ul className="list-inside list-disc space-y-1">
                  {report.limitations.map((limitation, index) => (
                    <li key={index}>{limitation}</li>
                  ))}
                </ul>
              ) : (
                "No limitations recorded; this does not establish representativeness."
              )}
            </dd>
          </dl>
        </details>
      </section>

      <div className="flex flex-wrap gap-2" aria-label="Analysis views">
        {(["Ranking & balance", "Source × need", "Item routes"] as Section[]).map((tab) => (
          <Button
            key={tab}
            aria-pressed={section === tab}
            variant={section === tab ? "primary" : "secondary"}
            onClick={() => setSection(tab)}
          >
            {tab}
          </Button>
        ))}
      </div>

      {section === "Ranking & balance" && (
        <section aria-label="Need ranking" className="space-y-3">
          <div className="flex flex-wrap gap-4 text-xs text-muted">
            <span>
              <span aria-hidden="true" className="mr-1 inline-block h-2 w-3 rounded bg-brand" />
              Frequency contribution
            </span>
            <span>
              <span aria-hidden="true" className="mr-1 inline-block h-2 w-3 rounded bg-warn" />
              Impact contribution
            </span>
            <span>Scale 0–100 · ties share rank · confidence is not score</span>
          </div>
          {!ranking.length && (
            <p className="text-sm text-muted">
              Need ranking not computed in this report. Inspect item routes for stored
              classifications.
            </p>
          )}
          {ranking.map(({ group: item, rank }) => (
            <div
              key={item.id}
              className={`rounded-lg border p-3 ${groupId === item.id ? "border-brand bg-brand-soft/30" : "border-line"}`}
            >
              <div className="mb-2 flex items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => selectEvidence(item.id)}
                  className="min-w-0 text-left font-medium text-brand hover:underline focus-visible:outline-2 focus-visible:outline-brand"
                  aria-label={`Inspect evidence for ${item.label}`}
                >
                  {rank !== null ? `${rank}. ` : "Unranked · "}
                  {item.label}
                  <span className="mt-1 block text-xs font-normal text-muted">
                    Analytical branch: {branchLabel(item.outputPortId)} ·{" "}
                    {ORIGIN_LABELS[item.scoreOrigin]}
                  </span>
                </button>
                <div className="shrink-0 text-right">
                  <span className="text-lg font-semibold tabular-nums">
                    {formatScore(item.score)}
                  </span>
                  {item.score !== null && <span className="text-xs text-muted"> /100</span>}
                </div>
              </div>
              <ScoreBreakdown group={item} />
              <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
                <EvidenceBalance group={item} />
                <ConfidenceLabel confidence={item.confidence} />
              </div>
            </div>
          ))}
          <p className="text-xs text-muted">
            Support / opposition / unclear are stored stance counts, not additive unique-customer
            totals. Inspect conflicting evidence before continuing.
          </p>
        </section>
      )}

      {section === "Source × need" && (
        <SourceHeatmap report={report} data={data} onSelect={selectEvidence} />
      )}

      {section === "Item routes" && (
        <section aria-label="Saved item routing" className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {report.branches.map((branch) => (
              <div
                key={branch.portId}
                className="rounded border border-line bg-panel-2 px-3 py-2 text-sm"
              >
                <span className="font-medium">{branch.label}</span>{" "}
                <span className="text-muted">
                  ({branch.portId}) · {branch.primaryItemCount} {report.input.primaryLayer}
                </span>
              </div>
            ))}
          </div>
          <Field label="Filter routes by group">
            {(id) => (
              <Select
                id={id}
                value={groupId}
                options={[
                  { value: "", label: "All groups" },
                  ...report.groups.map((item) => ({ value: item.id, label: item.label })),
                ]}
                onChange={(value) => {
                  setGroupId(value);
                  setRouteLimit(30);
                }}
              />
            )}
          </Field>
          <Field label="Filter item routes">
            {(id) => (
              <TextInput
                id={id}
                value={query}
                onChange={(value) => {
                  setQuery(value);
                  setRouteLimit(30);
                }}
                placeholder="Item ID, reason or exact excerpt"
              />
            )}
          </Field>
          <p className="text-xs text-muted">
            {routes.length} saved assignments match. Each primary item has one output. Human
            corrections do not approve requirements or change computed scores.
          </p>
          {!splitterReviewGate(run, report.blockId) && (
            <p className="rounded bg-panel-2 p-3 text-xs text-muted">
              Read-only snapshot. Corrections require a directly connected, editable paused HIL on
              the same workplace, before other downstream blocks consume these outputs.
            </p>
          )}
          {routes.slice(0, routeLimit).map((assignment) => (
            <RouteDetail
              key={`${assignment.itemId}:${report.reviews.length}`}
              assignment={assignment}
              report={report}
              run={run}
              data={data}
              loading={loading}
              error={error}
            />
          ))}
          {!routes.length && (
            <p className="text-sm text-muted">No saved assignments match this group or filter.</p>
          )}
          {routes.length > routeLimit && (
            <Button onClick={() => setRouteLimit((count) => count + 30)}>
              Show next 30 routes ({routes.length - routeLimit} remaining)
            </Button>
          )}
        </section>
      )}

      {section !== "Item routes" && (
        <section
          ref={detailRef}
          aria-label="Exact need evidence"
          className="space-y-3 rounded-lg border border-line p-4"
        >
          <h4 className="font-semibold">Evidence drill-down · {group?.label ?? "All needs"}</h4>
          {group && (
            <>
              <p className="text-sm text-muted">{group.description}</p>
              {group.assumptions.length > 0 && (
                <div className="text-xs text-warn">
                  <strong>Assumptions</strong>
                  <ul className="list-inside list-disc">
                    {group.assumptions.map((assumption, index) => (
                      <li key={index}>{assumption}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Evidence stance">
              {(id) => (
                <Select
                  id={id}
                  value={stance}
                  onChange={(value) => {
                    setStance(value as typeof stance);
                    setSignalLimit(30);
                  }}
                  options={[
                    { value: "all", label: "All stances" },
                    { value: "support", label: "Support" },
                    { value: "opposition", label: "Opposition" },
                    { value: "unclear", label: "Unclear" },
                  ]}
                />
              )}
            </Field>
            <Field label="Evidence source">
              {(id) => (
                <Select
                  id={id}
                  value={sourceId}
                  onChange={(value) => {
                    setSourceId(value);
                    setSignalLimit(30);
                  }}
                  options={[
                    { value: "", label: "All sources" },
                    ...[...new Set(report.signals.map((signal) => signal.evidence.sourceId))].map(
                      (id) => ({
                        value: id,
                        label: data?.sources.find((source) => source.id === id)?.title ?? id,
                      }),
                    ),
                  ]}
                />
              )}
            </Field>
          </div>
          <Field label="Filter exact evidence">
            {(id) => (
              <TextInput
                id={id}
                value={query}
                onChange={(value) => {
                  setQuery(value);
                  setSignalLimit(30);
                }}
                placeholder="Excerpt, locator, unit or reason"
              />
            )}
          </Field>
          <p className="text-xs text-muted">
            {signals.length} stored signals match. Signals are shown exactly as saved; multiple
            signals may refer to the same feedback unit.
          </p>
          {signals.slice(0, signalLimit).map((signal, index) => (
            <details
              key={`${signal.groupId}:${signal.unitId}:${index}`}
              className="rounded-lg border border-line p-3"
            >
              <summary className="cursor-pointer text-sm">
                <span className="font-medium">{signal.stance}</span> ·{" "}
                {signal.evidence.excerpt.slice(0, 120)}
                {signal.evidence.excerpt.length > 120 ? "…" : ""}
              </summary>
              <div className="mt-3 space-y-3">
                <p className="text-xs text-muted">
                  <Badge>AI interpretation</Badge> {signal.reason}
                </p>
                <p className="text-xs text-muted">
                  Unit {signal.unitId} · interpreted impact {formatScore(signal.impact)} ·{" "}
                  <ConfidenceLabel confidence={signal.confidence} />
                </p>
                <SplitterEvidence
                  evidence={signal.evidence}
                  data={data}
                  loading={loading}
                  error={error}
                />
              </div>
            </details>
          ))}
          {!signals.length && (
            <p className="text-sm text-muted">
              No exact signals stored for this selection. Inspect Item routes for assignment
              evidence; no signals have been fabricated.
            </p>
          )}
          {signals.length > signalLimit && (
            <Button onClick={() => setSignalLimit((count) => count + 30)}>
              Show next 30 signals ({signals.length - signalLimit} remaining)
            </Button>
          )}
        </section>
      )}

      {report.reviews.length > 0 && (
        <details className="rounded-lg border border-line p-3 text-xs">
          <summary className="cursor-pointer font-medium">
            Human routing history · computed scores preserved
          </summary>
          <div className="mt-3 space-y-3">
            {report.reviews.map((review) => (
              <div key={review.version} className="border-t border-line pt-2">
                <p className="font-medium">
                  v{review.version} · {review.at} ·{" "}
                  {review.actor.type === "human" ? review.actor.name : review.actor.component}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-muted">{review.rationale}</p>
                {review.changes.map((change, index) => (
                  <p key={index} className="mt-1 break-words">
                    {change.itemId}: {branchLabel(change.fromPortId)} to{" "}
                    {branchLabel(change.toPortId)}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-muted">{label}</div>
    </div>
  );
}
function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded border border-line bg-panel-2 px-2 py-1 text-xs text-muted">
      {children}
    </span>
  );
}

function RouteDetail({
  assignment,
  report,
  run,
  data,
  loading,
  error,
}: {
  assignment: SplitterAssignment;
  report: SplitterReport;
  run: WorkflowRun | null;
  data: PipelineData | null;
  loading: boolean;
  error: string | null;
}) {
  const eligible = !!splitterReviewGate(run, report.blockId);
  const busy = useStore(runStore, (state) => state.busy);
  const [toPortId, setToPortId] = useState(assignment.outputPortId);
  const [rationale, setRationale] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const lastReview = [...report.reviews]
    .reverse()
    .find((review) => review.changes.some((change) => change.itemId === assignment.itemId));
  const currentLabel =
    report.branches.find((branch) => branch.portId === assignment.outputPortId)?.label ??
    assignment.outputPortId;
  const save = async () => {
    if (!run) return;
    setSaveError(null);
    try {
      await saveSplitterCorrection(
        runStore,
        api.runs as SplitterReviewApi,
        run.id,
        report.blockId,
        {
          expectedVersion: report.reviews.length,
          rationale,
          changes: [{ itemId: assignment.itemId, toPortId }],
        },
      );
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <details
      className="rounded-lg border border-line p-3"
      data-testid="splitter-route"
      data-item-id={assignment.itemId}
    >
      <summary className="cursor-pointer text-sm">
        <span className="font-medium">{assignment.itemId}</span> · {currentLabel}{" "}
        {lastReview && <span className="text-warn">· Human override</span>}
        {assignment.evidence[0] && (
          <span className="mt-1 block text-xs text-muted">
            {assignment.evidence[0].excerpt.slice(0, 120)}
            {assignment.evidence[0].excerpt.length > 120 ? "…" : ""}
          </span>
        )}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-muted">
          <Badge>AI interpretation · original reason</Badge> {assignment.reason}
        </p>
        <p className="text-xs text-muted">
          Unit {assignment.unitId} · <ConfidenceLabel confidence={assignment.confidence} />
        </p>
        {lastReview && (
          <p className="rounded bg-warn-soft p-3 text-xs text-warn">
            <strong>Human override v{lastReview.version}</strong> · {lastReview.rationale}. Computed
            score is unchanged.
          </p>
        )}
        {assignment.evidence.map((evidence, index) => (
          <SplitterEvidence
            key={index}
            evidence={evidence}
            data={data}
            loading={loading}
            error={error}
          />
        ))}
        {!assignment.evidence.length && (
          <p className="text-xs text-warn">
            No exact assignment evidence stored. Nothing has been invented.
          </p>
        )}
        {eligible && (
          <div className="space-y-3 rounded-lg border border-line bg-panel-2 p-3">
            <h5 className="text-sm font-semibold">Correct this route before continuing</h5>
            <Field label="Corrected output">
              {(id) => (
                <Select
                  id={id}
                  disabled={busy}
                  value={toPortId}
                  onChange={setToPortId}
                  options={report.branches.map((branch) => ({
                    value: branch.portId,
                    label: `${branch.label} (${branch.portId})`,
                  }))}
                />
              )}
            </Field>
            <Field label="Human rationale (required)">
              {(id) => (
                <TextArea
                  id={id}
                  disabled={busy}
                  value={rationale}
                  onChange={setRationale}
                  maxLength={2000}
                  placeholder="Why is this evidence better routed to this output?"
                />
              )}
            </Field>
            <p className="text-xs text-muted">
              Persists routing and audit history only. Computed scores and original evidence stay
              unchanged. Requirement decisions remain in Car.
            </p>
            {saveError && (
              <p role="alert" className="text-xs text-danger">
                {saveError}
              </p>
            )}
            <Button
              variant="primary"
              disabled={busy || !rationale.trim() || toPortId === assignment.outputPortId}
              onClick={() => void save()}
              data-testid="splitter-save-correction"
            >
              {busy ? "Saving…" : "Save routing correction"}
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}
