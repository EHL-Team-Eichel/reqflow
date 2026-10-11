import React, { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  CATEGORY_LABELS,
  ALLOWED_DECISIONS,
  Priority,
  RequirementCategory,
  type Requirement,
} from "@reqflow/core";
import { api } from "@/lib/api";
import { PRIORITY_LABELS } from "./labels";
import {
  requirementDraft,
  reviewError,
  saveRequirementReview,
  type RequirementDraft,
} from "./requirement-review";

export interface RequirementReviewProps {
  requirement: Requirement;
  onSaved: (requirement: Requirement) => void;
}

const control =
  "w-full rounded-md border border-line bg-panel-2 px-3 py-2 text-sm focus-visible:outline-brand disabled:opacity-50";
const button =
  "rounded-md border border-line px-3 py-2 text-sm hover:bg-panel-2 focus-visible:outline-brand disabled:opacity-50";
const actionLabels: Record<string, string> = {
  approve: "Approve",
  reject: "Reject",
  defer: "Defer",
  challenge: "Challenge",
  reopen: "Reopen",
};

export function RequirementReview(props: RequirementReviewProps) {
  return <ReviewForm key={`${props.requirement.id}:${props.requirement.version}`} {...props} />;
}

function ReviewForm({ requirement, onSaved }: RequirementReviewProps) {
  const [shown, setShown] = useState(requirement);
  const [draft, setDraft] = useState(() => requirementDraft(requirement));
  const [editing, setEditing] = useState(false);
  const [decision, setDecision] = useState("");
  const [priority, setPriority] = useState("");
  const [challengeConsent, setChallengeConsent] = useState(false);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef(false);
  const submitting = useRef(false);
  const id = useId();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  function update<K extends keyof RequirementDraft>(key: K, value: RequirementDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError("");
    setNotice("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    if (!editing && decision === "challenge" && !challengeConsent) {
      setError("Confirm sending the challenge to the configured AI before continuing.");
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await saveRequirementReview(
        api,
        shown,
        editing
          ? { kind: "edit", draft, rationale }
          : { kind: "decision", decision, rationale, priority },
        () => active.current,
      );
      if (!active.current) return;
      setShown(saved);
      setDraft(requirementDraft(saved));
      setRationale("");
      setDecision("");
      setPriority("");
      setChallengeConsent(false);
      setEditing(false);
      setError("");
      setNotice("Review saved.");
      // Parent refresh failures must not make a completed mutation look retryable.
      try {
        await onSaved(saved);
      } catch {
        if (active.current)
          setNotice("Review saved, but the parent view could not refresh. Reload the details.");
      }
    } catch (failure) {
      if (active.current) setError(reviewError(failure));
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <section
      className="space-y-3 rounded-lg border border-line p-4 text-sm"
      aria-label="Human requirement review"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Human review</h3>
        <button
          type="button"
          className={button}
          disabled={busy}
          aria-expanded={editing}
          onClick={() => {
            setEditing(!editing);
            setDraft(requirementDraft(shown));
            setRationale("");
            setDecision("");
            setPriority("");
            setChallengeConsent(false);
            setError("");
            setNotice("");
          }}
        >
          {editing ? "Cancel content edit" : "Edit content"}
        </button>
      </div>
      <p className="text-xs text-muted">
        Version {shown.version}. Saving records your rationale in the audit trail. No workflow
        resumes automatically.
      </p>
      <p className="text-xs text-muted">
        Challenge marks the requirement Challenged and asks the configured AI to re-check it against
        its linked evidence. Read the answer in History; it is advice, not a human approval or new
        evidence, and the requirement stays Challenged until you decide.
      </p>
      <form onSubmit={submit} aria-busy={busy}>
        <fieldset disabled={busy} className="space-y-3">
          <legend className="sr-only">
            {editing ? "Edit requirement content" : "Record a decision"}
          </legend>
          {editing ? (
            <div
              className="max-h-[50vh] space-y-3 overflow-y-auto pr-2"
              aria-label="Content fields"
            >
              <Field label="Title">
                <input
                  className={control}
                  value={draft.title}
                  maxLength={120}
                  onChange={(e) => update("title", e.target.value)}
                />
              </Field>
              <Field label="Description">
                <textarea
                  className={control}
                  rows={3}
                  value={draft.description}
                  onChange={(e) => update("description", e.target.value)}
                />
              </Field>
              <Field label="Category">
                <select
                  className={control}
                  value={draft.category}
                  onChange={(e) => update("category", e.target.value)}
                >
                  {RequirementCategory.options.map((value) => (
                    <option key={value} value={value}>
                      {CATEGORY_LABELS[value]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Priority">
                <select
                  className={control}
                  value={draft.priority}
                  onChange={(e) => update("priority", e.target.value)}
                >
                  {!shown.priority && <option value="">Not prioritized</option>}
                  {Priority.options.map((value) => (
                    <option key={value} value={value}>
                      {PRIORITY_LABELS[value]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Priority rationale">
                <textarea
                  className={control}
                  rows={2}
                  value={draft.priorityRationale}
                  onChange={(e) => update("priorityRationale", e.target.value)}
                />
              </Field>
              <div className="space-y-2">
                <h4 className="font-medium">Targets and acceptance criteria</h4>
                {draft.targets.map((target, index) => (
                  <div key={index} className="space-y-2 rounded-md border border-line p-3">
                    {(["metric", "target", "acceptance"] as const).map((key) => (
                      <Field
                        key={key}
                        label={`${key === "metric" ? "Metric" : key === "target" ? "Target" : "Acceptance"} ${index + 1}`}
                      >
                        <textarea
                          className={control}
                          rows={2}
                          value={target[key]}
                          onChange={(e) =>
                            update(
                              "targets",
                              draft.targets.map((item, i) =>
                                i === index ? { ...item, [key]: e.target.value } : item,
                              ),
                            )
                          }
                        />
                      </Field>
                    ))}
                    <button
                      type="button"
                      className={button}
                      disabled={draft.targets.length <= 1}
                      title={
                        draft.targets.length <= 1
                          ? "A requirement needs at least one measurable target."
                          : undefined
                      }
                      onClick={() =>
                        update(
                          "targets",
                          draft.targets.filter((_, i) => i !== index),
                        )
                      }
                    >
                      Remove target {index + 1}
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className={button}
                  onClick={() =>
                    update("targets", [
                      ...draft.targets,
                      { metric: "", target: "", acceptance: "" },
                    ])
                  }
                >
                  Add target
                </button>
              </div>
              <Field label="Assumptions (one per line)">
                <textarea
                  className={control}
                  rows={3}
                  value={draft.assumptions}
                  onChange={(e) => update("assumptions", e.target.value)}
                />
              </Field>
              <Field label="Uncertainties (one per line)">
                <textarea
                  className={control}
                  rows={3}
                  value={draft.uncertainties}
                  onChange={(e) => update("uncertainties", e.target.value)}
                />
              </Field>
              <p className="text-xs text-muted">
                Evidence links, scope, decision status, confidence and score are not edited here.
              </p>
            </div>
          ) : (
            <>
              <Field label="Action">
                <select
                  className={control}
                  value={decision}
                  onChange={(e) => {
                    setDecision(e.target.value);
                    setPriority("");
                    setChallengeConsent(false);
                    setError("");
                    setNotice("");
                  }}
                >
                  <option value="">Choose an action</option>
                  {ALLOWED_DECISIONS[shown.status].map((value) => (
                    <option key={value} value={value}>
                      {actionLabels[value]}
                    </option>
                  ))}
                </select>
              </Field>
              {decision === "approve" && (
                <Field label="Approval priority override (optional)">
                  <select
                    className={control}
                    value={priority}
                    onChange={(e) => setPriority(e.target.value)}
                  >
                    <option value="">Keep current priority</option>
                    {Priority.options.map((value) => (
                      <option key={value} value={value}>
                        {PRIORITY_LABELS[value]}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {decision === "challenge" && (
                <label className="flex items-start gap-2 rounded-md border border-warn p-3 text-xs">
                  <input
                    type="checkbox"
                    checked={challengeConsent}
                    onChange={(e) => setChallengeConsent(e.target.checked)}
                  />
                  <span>
                    I agree to send this requirement ID and my rationale to the configured AI. An
                    external provider may charge for the request. Do not include confidential data
                    unless sharing is authorized.
                  </span>
                </label>
              )}
            </>
          )}
          <Field label="Rationale">
            <textarea
              className={control}
              rows={2}
              value={rationale}
              aria-describedby={`${id}-rationale`}
              onChange={(e) => {
                setRationale(e.target.value);
                setError("");
                setNotice("");
              }}
            />
          </Field>
          <p id={`${id}-rationale`} className="text-xs text-muted">
            Required: at least 3 characters after trimming whitespace.
          </p>
          <button
            type="submit"
            className={`${button} bg-panel-2 font-medium`}
            disabled={
              busy ||
              rationale.trim().length < 3 ||
              (!editing && (!decision || (decision === "challenge" && !challengeConsent)))
            }
          >
            {busy
              ? "Saving..."
              : editing
                ? "Save content edits"
                : decision === "challenge"
                  ? "Send challenge to AI"
                  : "Record decision"}
          </button>
        </fieldset>
      </form>
      {error && (
        <p role="alert" className="text-warn whitespace-pre-wrap">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-muted">
          {notice}
        </p>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}
