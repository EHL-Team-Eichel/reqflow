import { useState } from "react";
import {
  type ReasoningTrace,
  type ReasoningStep,
  type RequirementReasoning,
  type CritiqueVerdict,
} from "@reqflow/core";
import {
  formatPercent,
  levelLabel,
  levelColorClass,
  levelBgClass,
  formatVerdict,
  roleLabel,
  formatDuration,
} from "./format";
import { cx } from "@/lib/cx";

export function ReasoningView({
  trace,
  focusRequirementId,
}: {
  trace: ReasoningTrace;
  focusRequirementId?: string;
}) {
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [activeReqId, setActiveReqId] = useState<string | null>(
    focusRequirementId && trace.requirements.some((r) => r.requirementId === focusRequirementId)
      ? focusRequirementId
      : (trace.requirements[0]?.requirementId ?? null),
  );

  const activeStep = trace.steps.find((s) => s.id === activeStepId) ?? null;
  const activeReq = trace.requirements.find((r) => r.requirementId === activeReqId) ?? null;

  const modelsUsed = Array.from(
    new Set(
      trace.steps.map((s) => s.model).filter((m) => m !== "deterministic" && m !== "offline"),
    ),
  );

  return (
    <div className="flex flex-col gap-6 text-sm" data-testid="reasoning-view">
      {trace.offline && (
        <div className="rounded-lg bg-warn-soft px-4 py-3 text-warn">
          Offline demo: no AI model was involved. Add an API setup in Settings → AI to use real
          agents.
        </div>
      )}

      <div className="text-muted">
        {trace.requirements.length} requirements · {trace.heldBack.length} themes held back ·{" "}
        {trace.offline ? "no AI calls" : `${trace.totals.calls} AI calls`} ·{" "}
        {formatDuration(trace.totals.durationMs)}
        {modelsUsed.length > 0 && ` · Models: ${modelsUsed.join(", ")}`}
      </div>

      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
          How the agents worked
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {trace.steps.map((step, i) => (
            <div key={step.id} className="flex items-center gap-2">
              <StepCard
                step={step}
                isActive={activeStepId === step.id}
                onClick={() => setActiveStepId(activeStepId === step.id ? null : step.id)}
              />
              {i < trace.steps.length - 1 && <span className="text-muted">→</span>}
            </div>
          ))}
        </div>
        {activeStep && <StepDetails step={activeStep} />}
      </section>

      <section className="flex items-start gap-6">
        <div className="flex flex-1 flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Requirements</h3>
          {trace.requirements.map((req) => (
            <button
              key={req.requirementId}
              type="button"
              data-testid="reasoning-requirement"
              onClick={() => setActiveReqId(req.requirementId)}
              className={cx(
                "flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors",
                activeReqId === req.requirementId
                  ? "border-brand bg-brand-soft/20"
                  : "border-line bg-panel hover:bg-panel-2",
              )}
            >
              <div className="font-medium text-ink">
                {req.requirementId}: {req.title}
              </div>
              <div className="flex items-center gap-2 text-xs">
                {req.confidence && (
                  <div className="flex items-center gap-1.5">
                    <div className={cx("h-2 w-12 overflow-hidden rounded-full bg-line")}>
                      <div
                        className={cx("h-full", levelBgClass(req.confidence.level))}
                        style={{ width: `${req.confidence.value * 100}%` }}
                      />
                    </div>
                    <span className={cx(levelColorClass(req.confidence.level))}>
                      {formatPercent(req.confidence.value)} · {levelLabel(req.confidence.level)}
                    </span>
                  </div>
                )}
                <VerdictChip verdict={req.verdict} />
                {req.ranks.length > 0 && (
                  <span className="rounded bg-panel-2 px-1.5 py-0.5 text-muted">
                    from {Math.min(...req.ranks)}. Priority
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
        <div className="flex-1 rounded-xl border border-line bg-panel p-4">
          {activeReq ? (
            <ReqDetails req={activeReq} />
          ) : (
            <div className="text-muted">Select a requirement to see why it exists.</div>
          )}
        </div>
      </section>

      <details className="group border-t border-line pt-4">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted group-open:mb-3">
          Held back themes ({trace.heldBack.length})
        </summary>
        <ul className="flex flex-col gap-2">
          {trace.heldBack.map((hb, i) => (
            <li key={i} className="flex gap-4 border-l-2 border-line pl-3">
              <span className="font-medium text-ink w-48 shrink-0">{hb.theme}</span>
              <span className="text-muted flex-1">{hb.reason}</span>
              <span className="text-muted tabular-nums">{hb.signals} signals</span>
            </li>
          ))}
        </ul>
      </details>

      <details className="group border-t border-line pt-4">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted group-open:mb-3">
          Inputs
        </summary>
        <ul className="flex flex-col gap-1">
          {trace.inputs.map((inp, i) => (
            <li key={i} className="flex gap-4">
              <span className="w-48 text-ink">{inp.label}</span>
              <span className="text-muted">
                {Object.entries(inp.counts)
                  .map(([k, v]) => `${v} ${k}`)
                  .join(", ")}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function StepCard({
  step,
  isActive,
  onClick,
}: {
  step: ReasoningStep;
  isActive: boolean;
  onClick: () => void;
}) {
  const statusColor = {
    done: "bg-ok",
    warning: "bg-warn",
    failed: "bg-danger",
    skipped: "bg-line",
  }[step.status];

  return (
    <button
      type="button"
      data-testid="reasoning-step"
      onClick={onClick}
      className={cx(
        "flex w-48 flex-col gap-1.5 rounded-xl border p-3 text-left transition-colors",
        isActive ? "border-brand bg-brand-soft/20" : "border-line bg-panel hover:bg-panel-2",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
          {roleLabel(step.role)}
        </span>
        <div className={cx("size-2 rounded-full", statusColor)} title={step.status} />
      </div>
      <div className="font-medium text-ink leading-tight">{step.title}</div>
      <div className="line-clamp-2 text-xs text-muted">{step.summary}</div>
      {step.stats.length > 0 && (
        <div className="mt-1 flex gap-3 text-xs">
          {step.stats.slice(0, 2).map((s, i) => (
            <div key={i}>
              <span className="block text-lg font-light text-ink leading-none">{s.value}</span>
              <span className="text-[10px] text-muted">{s.label}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-1 text-[10px] text-muted truncate">{step.model}</div>
    </button>
  );
}

function StepDetails({ step }: { step: ReasoningStep }) {
  return (
    <div className="mt-3 rounded-xl border border-brand bg-brand-soft/10 p-4">
      <div className="mb-2 text-ink">{step.summary}</div>
      {step.notes.length > 0 && (
        <ul className="mb-4 list-disc pl-5 text-muted">
          {step.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-4 text-xs text-muted">
        {step.stats.map((s, i) => (
          <div key={i}>
            <strong className="text-ink">{s.value}</strong> {s.label}
          </div>
        ))}
        <div>
          <strong className="text-ink">{step.model}</strong> model
        </div>
        {step.setup && (
          <div>
            <strong className="text-ink">{step.setup}</strong> setup
          </div>
        )}
        <div>
          <strong className="text-ink">{step.calls}</strong> calls
        </div>
        <div>
          <strong className="text-ink">{formatDuration(step.durationMs)}</strong>
        </div>
      </div>
    </div>
  );
}

function VerdictChip({ verdict }: { verdict: CritiqueVerdict }) {
  const c = {
    accepted: "bg-ok text-white",
    revised: "bg-brand text-white",
    flagged: "bg-danger text-white",
  }[verdict];
  return (
    <span
      className={cx("rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider", c)}
    >
      {formatVerdict(verdict)}
    </span>
  );
}

function ReqDetails({ req }: { req: RequirementReasoning }) {
  return (
    <div className="flex flex-col gap-6">
      <h3 className="text-lg font-medium text-ink">Why this requirement?</h3>

      {req.evidence.length > 0 && (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Evidence (up to 5)
          </h4>
          <div className="flex flex-col gap-2">
            {req.evidence.slice(0, 5).map((e, i) => (
              <blockquote
                key={i}
                className="flex flex-col gap-1 border-l-2 border-brand pl-3 italic text-ink"
              >
                "{e.excerpt}"
                <div className="flex gap-2 text-[10px] not-italic font-medium uppercase tracking-wider text-muted">
                  {e.rank && (
                    <span className="rounded bg-panel-2 px-1 py-0.5">{e.rank}. Priority</span>
                  )}
                  {!e.supports && (
                    <span className="rounded bg-danger-soft px-1 py-0.5 text-danger">
                      Argues against
                    </span>
                  )}
                </div>
              </blockquote>
            ))}
          </div>
        </section>
      )}

      {req.contextUsed.length > 0 && (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Context used</h4>
          <div className="flex flex-wrap gap-1">
            {req.contextUsed.map((c, i) => (
              <span key={i} className="rounded-full bg-panel-2 px-2 py-0.5 text-xs text-ink">
                {c}
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
          The thought chain
        </h4>
        <div className="flex flex-col gap-3">
          {req.thoughts.map((t, i) => (
            <div key={i} className="flex flex-col">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                {roleLabel(t.role)}
              </span>
              <p className="text-sm text-ink">{t.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Critic</h4>
        <div className="flex items-center gap-2">
          <VerdictChip verdict={req.verdict} />
        </div>
        {req.issues.length > 0 ? (
          <ul className="list-disc pl-4 text-sm text-danger">
            {req.issues.map((iss, i) => (
              <li key={i}>{iss}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No issues found.</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Confidence</h4>
        <div className="flex items-center gap-3">
          <span className={cx("text-3xl font-light", levelColorClass(req.confidence.level))}>
            {formatPercent(req.confidence.value)}
          </span>
          <span className={cx("text-sm font-medium", levelColorClass(req.confidence.level))}>
            {levelLabel(req.confidence.level)}
          </span>
        </div>
        <div className="flex flex-col gap-2">
          {req.confidence.signals.map((sig, i) => (
            <div key={i} className="flex flex-col gap-0.5">
              <div className="flex justify-between text-xs">
                <span className="text-ink">{sig.label}</span>
                <span className="text-muted">
                  {formatPercent(sig.value)} · counts &times;{sig.weight}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
                <div className="h-full bg-brand" style={{ width: `${sig.value * 100}%` }} />
              </div>
              <div className="flex justify-between gap-4">
                {sig.note ? (
                  <span className="text-[10px] text-muted italic">{sig.note}</span>
                ) : (
                  <span />
                )}
                <span className="text-[10px] text-muted shrink-0">{sig.by}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-muted">
          High from 75 %, medium from 50 %. Confidence is how much the agents trust the requirement
          as written — separate from its priority.
        </p>
      </section>
    </div>
  );
}
