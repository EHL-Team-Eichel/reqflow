import { useState, useEffect, useRef } from "react";
import { XIcon } from "@/components/ui/icons";
import { MStripe } from "@/components/ui/MStripe";
import { ReqflowError, api } from "@/lib/api";
import type { ReasoningTrace } from "@reqflow/core";
import { ReasoningView } from "./ReasoningView";

export function ReasoningDialog({
  title,
  load,
  focusRequirementId,
  onClose,
}: {
  title: string;
  load: () => Promise<ReasoningTrace | null>;
  focusRequirementId?: string;
  onClose: () => void;
}) {
  const [trace, setTrace] = useState<ReasoningTrace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    load()
      .then((res) => {
        if (!active) return;
        setTrace(res);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ReqflowError && err.code === "not_implemented") {
          setError("The thought process isn't available in this build yet.");
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);

  // Handle escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={title}
        className="relative flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
        data-testid="reasoning-dialog"
      >
        <MStripe />
        <div className="flex shrink-0 items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-lg font-medium text-ink">{title}</h2>
          <button
            type="button"
            className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-ink"
            onClick={onClose}
            aria-label="Close thought process"
          >
            <XIcon className="size-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="text-muted">Loading the thought process…</div>
          ) : error ? (
            <div className="text-danger">{error}</div>
          ) : !trace ? (
            <div className="text-muted">
              No thought process recorded yet. Run the flow, then open this again.
            </div>
          ) : (
            <ReasoningView trace={trace} focusRequirementId={focusRequirementId} />
          )}
        </div>
      </div>
    </div>
  );
}
