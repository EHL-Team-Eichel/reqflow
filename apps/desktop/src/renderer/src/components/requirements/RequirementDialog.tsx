import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { XIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/Button";
import type { ClassifiedRequirement } from "../car/classify";
import { loadRequirementDetail, type DetailState } from "./detail-loader";
import { MStripe } from "@/components/ui/MStripe";
import { RequirementOriginReport } from "./RequirementOriginReport";
import { RequirementReview } from "./RequirementReview";
import { challengeOutcome } from "./requirement-review";
import { AuditTimeline } from "../audit/AuditTimeline";

/** Native modal traps focus, handles Escape, and restores focus to the compact requirement card. */
export function RequirementDialog({
  item,
  onClose,
  onSaved,
}: {
  item: ClassifiedRequirement;
  onClose: () => void;
  onSaved?: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<"report" | "review" | "history">("report");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
      else {
        // Changing priority can move the card to another group and replace its DOM node.
        const card = document.querySelector<HTMLElement>(
          `[data-requirement-id="${CSS.escape(item.requirement.id)}"]`,
        );
        const fallback = document.querySelector<HTMLElement>(
          '[data-testid="requirement-browser-reload"], [data-testid="car-requirements-tab"]',
        );
        (card ?? fallback)?.focus();
      }
    };
  }, [item.requirement.id]);

  useEffect(
    () => loadRequirementDetail(item.requirement.id, api.requirements.get, setState),
    [item.requirement.id, attempt],
  );

  const r = state.status === "ready" ? state.detail.requirement : item.requirement;
  return (
    <dialog
      ref={dialog}
      aria-labelledby="requirement-detail-title"
      data-testid="car-requirement-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // Backdrop clicks have the dialog as their target, but lie outside its bounds.
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
      className="fixed inset-0 m-auto h-[calc(100vh-3rem)] max-h-[calc(100vh-3rem)] w-[min(1400px,calc(100vw-3rem))] max-w-none overflow-hidden rounded-xl border border-line bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/50"
    >
      <div className="flex h-full flex-col">
        <MStripe />
        <header className="flex shrink-0 items-start gap-4 border-b border-line p-5">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs text-muted">
              Requirement report · {r.id} · Version {r.version}
            </p>
            <h2 id="requirement-detail-title" className="mt-1 text-lg font-semibold">
              {r.title}
            </h2>
          </div>
          <button
            type="button"
            autoFocus
            onClick={onClose}
            aria-label="Close requirement details"
            className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-ink focus-visible:outline-brand"
          >
            <XIcon className="size-5" />
          </button>
        </header>
        <nav
          aria-label="Requirement views"
          className="flex shrink-0 flex-wrap gap-2 border-b border-line px-5 py-2"
        >
          {(
            [
              ["report", "Workflow & sources"],
              ["review", "Review & edit"],
              ["history", "History"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={view === value ? "secondary" : "ghost"}
              aria-pressed={view === value}
              data-testid={`car-requirement-${value}-tab`}
              onClick={() => setView(value)}
            >
              {label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            disabled={state.status === "loading"}
            onClick={() => {
              setNotice(null);
              setAttempt((n) => n + 1);
            }}
            data-testid="car-requirement-reload"
          >
            Reload details
          </Button>
        </nav>
        {notice && (
          <p role="status" className="shrink-0 px-5 py-2 text-xs text-muted">
            {notice}
          </p>
        )}
        <div className="min-h-0 flex-1" aria-busy={state.status === "loading"}>
          {state.status === "loading" && (
            <p role="status" className="p-5 text-sm text-muted">
              Loading full requirement and sources…
            </p>
          )}
          {state.status === "error" && (
            <div role="alert" className="space-y-3 p-5 text-sm">
              <p className="text-warn">{state.message}</p>
              <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </Button>
            </div>
          )}
          {state.status === "ready" &&
            (view === "report" ? (
              <RequirementOriginReport detail={state.detail} />
            ) : view === "review" ? (
              <div className="h-full overflow-auto p-5">
                <RequirementReview
                  requirement={state.detail.requirement}
                  onSaved={async (saved) => {
                    setState((current) =>
                      current.status === "ready"
                        ? {
                            status: "ready",
                            detail: {
                              ...current.detail,
                              requirement: saved,
                              versions: [
                                ...current.detail.versions.filter(
                                  (version) => version.version !== saved.version,
                                ),
                                saved,
                              ],
                            },
                          }
                        : current,
                    );
                    setNotice(
                      `Version ${saved.version} saved with your rationale. Workflow execution is unchanged.`,
                    );
                    // Only a challenge sets "challenged": say whether the AI answered or failed.
                    if (saved.status === "challenged") {
                      const outcome = await api.audit
                        .list({ entityId: saved.id, entityType: "requirement", limit: 20 })
                        .then(challengeOutcome, () => "Open History for the AI's answer.");
                      setNotice(`Version ${saved.version} saved with your challenge. ${outcome}`);
                    }
                    try {
                      await onSaved?.();
                    } catch {
                      setNotice(
                        `Version ${saved.version} saved, but the Car list could not refresh. Reload the list.`,
                      );
                    }
                  }}
                />
              </div>
            ) : (
              <div className="h-full overflow-auto p-5">
                <AuditTimeline requirementId={r.id} refreshKey={r.version} />
              </div>
            ))}
        </div>
      </div>
    </dialog>
  );
}
