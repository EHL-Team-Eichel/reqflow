import { useSettings } from "@/lib/settings";

export function PersistenceBanner() {
  const persistence = useSettings((s) => s.persistence);
  const error = useSettings((s) => s.error);

  if (persistence === "saved") return null;

  if (persistence === "loading") {
    return (
      <div className="mb-6 rounded-lg bg-panel-2 p-3 text-sm text-muted">Loading settings…</div>
    );
  }

  if (persistence === "unavailable") {
    return (
      <div className="mb-6 rounded-lg bg-warn-soft p-3 text-sm text-warn">
        Changes apply right away but aren't saved to disk yet, so they reset when the app restarts.
        (Saving settings is the next step for WS1.)
      </div>
    );
  }

  if (persistence === "error") {
    return <div className="mb-6 rounded-lg bg-danger-soft p-3 text-sm text-danger">{error}</div>;
  }

  return null;
}
