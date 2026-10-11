import { useEffect, useState, type RefObject } from "react";
import { useReactFlow } from "@xyflow/react";
import { BLOCK_SPECS, type WorkflowTemplate } from "@reqflow/core";
import { z } from "zod";
import { useStore } from "zustand";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { Segmented } from "@/components/settings/Segmented";
import { api } from "@/lib/api";
import { BlockPalette } from "./BlockPalette";
import { BlockIcon } from "./BlockIcon";
import { dataflowStore } from "./store";
import { runStore } from "./run-session";
import { FEEDBACK_TEMPLATES, WorkflowTemplateSchema } from "./templates";

const MODES = [
  { value: "blocks", label: "Blocks" },
  { value: "templates", label: "Templates" },
] as const;

export function WorkflowSidebar({ canvasRef }: { canvasRef: RefObject<HTMLDivElement | null> }) {
  const [mode, setMode] = useState<"blocks" | "templates">("blocks");
  const [shared, setShared] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const status = useStore(runStore, (s) => s.run?.status);
  const busy = useStore(runStore, (s) => s.busy);
  const blocked = busy || ["queued", "running", "waiting_for_review"].includes(status ?? "");
  const { fitView } = useReactFlow();

  useEffect(() => {
    if (mode !== "templates") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.templates
      .list()
      .then((templates) => {
        const parsed = z.array(WorkflowTemplateSchema).safeParse(templates);
        if (!parsed.success) throw new Error("The shared workflow templates are malformed.");
        if (!cancelled) setShared(parsed.data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, retry]);

  const useTemplate = (template: WorkflowTemplate) => {
    const run = runStore.getState();
    if (run.busy || ["queued", "running", "waiting_for_review"].includes(run.run?.status ?? ""))
      return;
    if (
      dataflowStore.getState().root.blocks.length &&
      !window.confirm(
        `Replace the entire current workflow with "${template.name}"? Unsaved canvas edits will be lost. This does not start a run.`,
      )
    )
      return;
    if (!dataflowStore.getState().loadTemplate(template, () => runStore.getState().reset())) return;
    // Fit after the replacement graph and its measured nodes have reached React Flow.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => void fitView({ maxZoom: 0.9, padding: 0.25, duration: 200 })),
    );
  };

  return (
    <Panel
      title={mode === "blocks" ? "Building Blocks" : "Workflow templates"}
      className="w-1/4 min-w-64 max-w-sm"
      testId="palette"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div
          role="group"
          aria-label="Workflow sidebar view"
          className="flex shrink-0 border-b border-line px-3 pb-3"
        >
          <Segmented options={MODES} value={mode} onChange={setMode} testIdPrefix="sidebar-mode-" />
        </div>
        {mode === "blocks" ? (
          <div className="min-h-0 flex-1">
            <BlockPalette canvasRef={canvasRef} />
          </div>
        ) : (
          <div
            className="min-h-0 flex-1 overflow-y-auto space-y-3 p-3"
            data-testid="template-palette"
          >
            <p className="text-xs text-muted">
              Connected setups for the full workflow. Configure your inputs, then press Start.
              Loading a template never runs it or approves requirements.
            </p>
            {blocked && (
              <p role="status" className="rounded-lg bg-warn-soft p-3 text-xs text-warn">
                Finish the current run or cancel it before loading another setup.
              </p>
            )}
            {[...FEEDBACK_TEMPLATES, ...shared].map((template, index) => {
              const kinds = [...new Set(template.graph.blocks.map((block) => block.kind))];
              const sources = template.graph.blocks.filter(
                (block) =>
                  block.kind === "raw" ||
                  block.kind === "research" ||
                  block.kind === "research_opencode",
              ).length;
              const reviews = template.graph.blocks.filter((block) => block.kind === "hil").length;
              const blueprint =
                kinds.includes("research") ||
                kinds.includes("research_opencode") ||
                kinds.includes("ai_filter");
              return (
                <section
                  key={`${index < FEEDBACK_TEMPLATES.length ? "feedback" : "shared"}-${template.name}-${index}`}
                  className="rounded-lg border border-line bg-panel-2 p-3"
                  data-testid="workflow-template"
                >
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted">
                    <BlockIcon kind="custom" className="size-4 text-brand" />
                    {blueprint ? "Advanced blueprint" : "Connected workflow"}
                  </div>
                  <h3 className="text-sm font-medium text-ink">{template.name}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted">{template.description}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {kinds.map((kind) => (
                      <span
                        key={kind}
                        className="rounded border border-line bg-panel px-2 py-1 text-[10px] text-muted"
                      >
                        {kind in BLOCK_SPECS
                          ? BLOCK_SPECS[kind as keyof typeof BLOCK_SPECS].label
                          : kind}
                      </span>
                    ))}
                  </div>
                  <p className="my-3 text-[10px] text-muted">
                    {sources} data source{sources === 1 ? "" : "s"} / {reviews} review gate
                    {reviews === 1 ? "" : "s"} / {template.graph.blocks.length} blocks
                  </p>
                  {blueprint && (
                    <p className="mb-3 text-xs text-warn">
                      Requires working Research / AI Filter blocks and their provider configuration.
                      This is a blueprint, not an immediately runnable demo.
                    </p>
                  )}
                  <Button
                    className="w-full"
                    disabled={blocked}
                    onClick={() => useTemplate(template)}
                    data-testid={`template-use-${index}`}
                  >
                    Use template
                  </Button>
                </section>
              );
            })}
            {loading && (
              <p className="text-xs text-muted" role="status">
                Loading shared templates...
              </p>
            )}
            {error && (
              <div className="rounded-lg border border-line p-3">
                <p role="alert" className="mb-2 text-xs text-danger">
                  {error}
                </p>
                <Button
                  size="sm"
                  data-testid="templates-retry"
                  onClick={() => setRetry((n) => n + 1)}
                >
                  Retry shared templates
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
