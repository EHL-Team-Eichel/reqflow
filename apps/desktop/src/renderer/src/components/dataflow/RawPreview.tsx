import { countPipelineData, type WorkflowBlock } from "@reqflow/core";
import { Button } from "@/components/ui/Button";
import { useBlockPreview } from "./usePreview";

/** Inspector section for blocks without inputs: read the data now and show what came out. */
export function RawPreview({ block }: { block: WorkflowBlock }) {
  const { state, load } = useBlockPreview(block);
  return (
    <section data-testid="block-preview" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Data preview</h3>
        <Button
          size="sm"
          data-testid="preview-load"
          disabled={state.status === "loading"}
          onClick={() => void load()}
        >
          {state.status === "loading"
            ? "Reading…"
            : state.status === "idle"
              ? "Preview data"
              : "Read again"}
        </Button>
      </div>
      {state.status === "idle" && (
        <p className="text-xs text-muted">Reads the file or query now, without running the flow.</p>
      )}
      {state.status === "error" && (
        <p role="alert" className="rounded-lg bg-danger-soft p-2.5 text-xs text-danger">
          {state.message}
        </p>
      )}
      {state.status === "ready" && <PreviewSummary state={state} />}
      {(state.status === "ready" || state.status === "error") && state.logs.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer select-none">
            Notes from reading ({state.logs.length})
          </summary>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">
            {state.logs.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function PreviewSummary({
  state,
}: {
  state: Extract<ReturnType<typeof useBlockPreview>["state"], { status: "ready" }>;
}) {
  const counts = countPipelineData(state.data);
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return (
    <div className="flex flex-col gap-2">
      <p data-testid="preview-counts" className="text-sm font-medium text-ink">
        {parts.length ? parts.join(" · ") : "No rows"}
      </p>
      <ul className="flex flex-col gap-1.5">
        {state.data.records.slice(0, 3).map((r) => (
          <li key={r.id} className="rounded-lg bg-panel-2 p-2 text-xs">
            <span className="line-clamp-2 text-ink">{r.text}</span>
            <span className="text-muted">{r.locator}</span>
          </li>
        ))}
      </ul>
      {state.data.findings.length > 0 && (
        <ul className="list-disc space-y-1 pl-4 text-xs text-ink">
          {state.data.findings.slice(0, 3).map((f) => (
            <li key={f.id}>{f.statement}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
