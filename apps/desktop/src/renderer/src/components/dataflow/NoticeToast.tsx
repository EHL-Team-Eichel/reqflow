import { useEffect } from "react";
import { useDataflow, dataflowStore } from "./store";
import { cx } from "@/lib/cx";

export function NoticeToast() {
  const notice = useDataflow((s) => s.notice);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => {
      dataflowStore.getState().dismissNotice();
    }, 5000);
    return () => clearTimeout(timer);
  }, [notice?.id]);

  if (!notice) return null;

  const isError = notice.tone === "error";

  return (
    <div
      data-testid="notice"
      role={isError ? "alert" : "status"}
      className={cx(
        "absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2 rounded-lg shadow-lg text-sm border",
        isError ? "bg-danger-soft text-danger border-danger/20" : "bg-panel-2 text-ink border-line",
      )}
    >
      <span>{notice.message}</span>
      <button
        type="button"
        className="opacity-70 hover:opacity-100"
        onClick={() => dataflowStore.getState().dismissNotice()}
        aria-label="Dismiss notice"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
