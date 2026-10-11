import {
  BLOCK_SPECS,
  blockPorts,
  isBoundaryBlockKind,
  isParamVisible,
  splitterOutputLabels,
  type PaletteBlockKind,
  type WorkflowBlock,
} from "@reqflow/core";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { NumberInput, Select, ValidatedTextInput } from "@/components/ui/controls";
import { Field } from "@/components/ui/Field";
import { ReportIcon, XIcon } from "@/components/ui/icons";
import { settingsStore } from "@/lib/settings";
import { BlockIcon } from "./BlockIcon";
import { confirmDelete } from "./confirm-delete";
import { GROUP_STYLE } from "./groups";
import { ParamField } from "./ParamField";
import { RawPreview } from "./RawPreview";
import { ResearchConfiguration } from "./ResearchConfiguration";
import { AiFilterConfiguration } from "./AiFilterConfiguration";
import { ResearchOpenCodeConfiguration } from "./ResearchOpenCodeConfiguration";
import { canPreview } from "./usePreview";
import { dataflowStore, selectInspectedBlock, useDataflow } from "./store";
import { SPLITTER_MODE_HELP, splitterBranches } from "./report/splitter-view";
import { RunOutput } from "./RunOutput";

/** Side panel for the selected block: name, ports, inner workplace, parameters, delete. */
export function Inspector() {
  const block = useDataflow(selectInspectedBlock);
  if (!block) return null;
  // Keyed by block, so field drafts and errors never leak from one block to the next.
  return isBoundaryBlockKind(block.kind) ? (
    <BoundaryInspector key={block.id} block={block} />
  ) : (
    <BlockInspector key={block.id} block={block} kind={block.kind} />
  );
}

function Shell(props: { header: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <aside
      data-testid="inspector"
      aria-label="Block details"
      className="absolute top-2 right-2 bottom-2 flex w-80 flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-lg"
    >
      <div className="flex items-start gap-3 border-b border-line p-4">
        <div className="min-w-0 flex-1">{props.header}</div>
        <button
          type="button"
          aria-label="Close details"
          onClick={() => dataflowStore.getState().selectBlock(null)}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-ink"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{props.children}</div>
      {props.footer && <div className="border-t border-line p-4">{props.footer}</div>}
    </aside>
  );
}

function BlockInspector({ block, kind }: { block: WorkflowBlock; kind: PaletteBlockKind }) {
  const spec = BLOCK_SPECS[kind];
  const style = GROUP_STYLE[spec.group];
  const ports = blockPorts(block);
  const innerCount = block.inner?.blocks.filter((b) => !isBoundaryBlockKind(b.kind)).length ?? 0;
  const params = spec.params.filter(
    (p) => isParamVisible(p, block.params) && (block.kind !== "ai_splitter" || p.key !== "splitBy"),
  );
  const researchQuestion =
    kind === "research" ? spec.params.find((p) => p.key === "question") : undefined;
  const portList = (list: { label: string }[]) =>
    list.length ? list.map((p) => p.label).join(", ") : "none";

  const onDelete = () => {
    if (settingsStore.getState().settings.app.confirmBeforeDelete && !confirmDelete([block])) {
      return;
    }
    dataflowStore.getState().deleteSelection();
  };

  return (
    <Shell
      header={
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className={`grid size-8 shrink-0 place-items-center rounded-lg ${style.tile}`}>
              <BlockIcon kind={kind} className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink">{spec.label}</div>
              <div className="text-xs text-muted">{style.name}</div>
            </div>
          </div>
          <ValidatedTextInput
            aria-label="Block name"
            value={block.label}
            onCommit={(label) => dataflowStore.getState().renameBlock(block.id, label)}
          />
        </div>
      }
      footer={
        <Button
          data-testid="inspector-delete"
          variant="danger"
          className="w-full"
          onClick={onDelete}
        >
          Delete block
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <p className="text-sm text-muted">{spec.description}</p>
        {block.kind === "add_to_car" && (
          <>
            <Button
              data-testid="inspector-open-reasoning"
              onClick={() => dataflowStore.getState().openReasoning(block.id)}
            >
              Open thought process
            </Button>
          </>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="font-medium text-ink">Inputs</dt>
          <dd className="text-muted">{portList(ports.inputs)}</dd>
          <dt className="font-medium text-ink">Outputs</dt>
          <dd className="text-muted">{portList(ports.outputs)}</dd>
        </dl>
        {spec.hasInnerWorkplace && (
          <Button
            data-testid="inspector-open-inner"
            onClick={() => dataflowStore.getState().openInner(block.id)}
          >
            Open its workplace ·{" "}
            {innerCount === 0 ? "empty" : `${innerCount} block${innerCount === 1 ? "" : "s"}`}
          </Button>
        )}
        {block.kind === "ai_splitter" && (
          <div className="flex flex-col gap-3">
            <Button
              data-testid="inspector-open-splitter-report"
              variant="primary"
              onClick={() => dataflowStore.getState().openReport(block.id)}
            >
              Open scores & routing report
            </Button>
            <p className="text-xs text-muted">
              Inspect saved classifications, score components and exact evidence. Double-click opens
              the inner workplace; an empty workplace uses AI routing.
            </p>
          </div>
        )}
        {block.kind === "ai_filter" && (
          <Button
            data-testid="inspector-open-filter-report"
            onClick={() => dataflowStore.getState().openReport(block.id)}
          >
            <ReportIcon className="size-4" />
            Open filtering & review report
          </Button>
        )}
        {block.kind === "hil" && (
          <Button
            data-testid="inspector-open-report"
            onClick={() => dataflowStore.getState().openReport(block.id)}
          >
            Open review report
          </Button>
        )}
        <section className="flex flex-col gap-4">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Parameters</h3>
          {researchQuestion && <ParamField block={block} spec={researchQuestion} />}
          {kind === "research" && <ResearchConfiguration block={block} />}
          {kind === "research_opencode" && <ResearchOpenCodeConfiguration block={block} />}
          {kind === "ai_filter" && <AiFilterConfiguration block={block} />}
          {spec.params.length === 0 ? (
            <p className="text-sm text-muted">
              No parameters. Build this block's logic in its workplace.
            </p>
          ) : (
            <>
              {block.kind === "ai_splitter" && <SplitterControls block={block} />}
              {params
                .filter(
                  (p) =>
                    kind !== "ai_filter" &&
                    p !== researchQuestion &&
                    (block.kind !== "ai_splitter" || !["splitBy", "partDepth"].includes(p.key)),
                )
                .map((p) => (
                  <ParamField
                    key={p.key}
                    block={block}
                    spec={
                      kind === "research" && p.key === "market"
                        ? {
                            ...p,
                            label: "Fallback market (legacy)",
                            help: "Used only when the Research scope has no Markets override. The scope form writes only scopeJson.",
                          }
                        : p
                    }
                  />
                ))}
            </>
          )}
        </section>
        {canPreview(block) && <RawPreview block={block} />}
        <RunOutput block={block} />
      </div>
    </Shell>
  );
}

function SplitterControls({ block }: { block: WorkflowBlock }) {
  const [error, setError] = useState<string | null>(null);
  const mode = String(block.params.splitBy);
  const branches = block.params.branches as string[];
  const modeSpec = BLOCK_SPECS.ai_splitter.params.find((param) => param.key === "splitBy");
  const depthSpec = BLOCK_SPECS.ai_splitter.params.find((param) => param.key === "partDepth");
  const help = SPLITTER_MODE_HELP[mode as keyof typeof SPLITTER_MODE_HELP];
  const update = (nextMode: string, count: number) => {
    try {
      const generated = splitterBranches(nextMode === "car_parts" ? "custom" : nextMode, count);
      // Car-part outputs come from the chosen depth; the branch list is kept for other modes.
      const regenerate = nextMode === "customer_priority" || nextMode === "custom";
      setError(
        dataflowStore.getState().setParams(block.id, {
          ...block.params,
          splitBy: nextMode,
          branches: regenerate
            ? generated
            : Array.from({ length: count }, (_, i) => branches[i] ?? generated[i]!),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <Field label="Split by" help={help}>
        {(id) =>
          modeSpec?.type === "select" && (
            <Select
              id={id}
              value={mode}
              options={modeSpec.options}
              onChange={(next) => update(next, branches.length)}
            />
          )
        }
      </Field>
      {mode === "car_parts" && depthSpec && (
        <div data-testid="splitter-depth">
          <ParamField block={block} spec={depthSpec} />
        </div>
      )}
      {mode === "car_parts" ? (
        <Field
          label="Outputs"
          help="Set by the depth: one output per area or part group, plus Other for feedback about no specific part."
        >
          {() => (
            <p className="text-sm text-ink" data-testid="splitter-part-outputs">
              {splitterOutputLabels(block.params).join(" · ")}
            </p>
          )}
        </Field>
      ) : (
        <Field
          label="Output count (2–10)"
          error={error}
          help="One output per branch. Changing the count regenerates preset labels; removed outputs lose their connections. The saved run is unchanged."
        >
          {(id) => (
            <NumberInput
              id={id}
              value={branches.length}
              min={2}
              max={10}
              step={1}
              unit="outputs"
              onChange={(count) => update(mode, count)}
            />
          )}
        </Field>
      )}
    </div>
  );
}

function BoundaryInspector({ block }: { block: WorkflowBlock }) {
  const isInput = block.kind === "block_input";
  return (
    <Shell
      header={
        <div className="flex items-center gap-3">
          <BlockIcon
            kind={isInput ? "block_input" : "block_output"}
            className="size-5 text-muted"
          />
          <span className="text-sm font-medium text-ink">
            {isInput ? "Input" : "Output"}: {block.label}
          </span>
        </div>
      }
    >
      <p className="text-sm text-muted">
        {isInput
          ? `What arrives at the block's “${block.label}” input enters this workplace here.`
          : `What reaches this point leaves the block on its “${block.label}” output.`}{" "}
        It belongs to the block's ports, so it can't be deleted.
      </p>
    </Shell>
  );
}
