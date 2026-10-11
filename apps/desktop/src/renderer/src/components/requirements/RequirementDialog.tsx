import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { XIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/Button";
import type { ClassifiedRequirement } from "../car/classify";
import { loadRequirementDetail, type DetailState } from "./detail-loader";
import { RequirementDetails } from "./RequirementDetails";

/** Native modal traps focus, handles Escape, and restores focus to the compact requirement card. */
export function RequirementDialog({
  item,
  onClose,
}: {
  item: ClassifiedRequirement;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

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
      className="fixed inset-0 m-auto h-[min(90vh,52rem)] max-h-[90vh] w-[min(54rem,calc(100vw-3rem))] max-w-none overflow-hidden rounded-xl border border-line bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/50"
    >
      <div className="flex h-full flex-col">
        <header className="flex shrink-0 items-start gap-4 border-b border-line p-5">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs text-muted">
              {r.id} · Version {r.version}
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
        <div className="min-h-0 flex-1 overflow-y-auto p-5" aria-busy={state.status === "loading"}>
          {state.status === "loading" && (
            <p role="status" className="text-sm text-muted">
              Loading full requirement and sources…
            </p>
          )}
          {state.status === "error" && (
            <div role="alert" className="space-y-3 text-sm">
              <p className="text-warn">{state.message}</p>
              <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </Button>
            </div>
          )}
          {state.status === "ready" && <RequirementDetails detail={state.detail} />}
        </div>
      </div>
    </dialog>
  );
}
