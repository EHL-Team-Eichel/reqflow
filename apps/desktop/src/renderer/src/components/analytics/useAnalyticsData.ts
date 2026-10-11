import { useEffect, useMemo, useState } from "react";
import type { WorkflowBlock, WorkflowGraph, WorkflowRun } from "@reqflow/core";
import { api } from "@/lib/api";
import { useSettings } from "@/lib/settings";
import { buildDataset } from "./engine/dataset";
import type { AnalyticsDataset, AnalyticsInput } from "./engine/types";
import { loadInputs, planInputs } from "./load";

export type LoadState =
  | { status: "loading" }
  | { status: "ready"; inputs: AnalyticsInput[]; dataset: AnalyticsDataset }
  | { status: "error"; message: string };

/**
 * Reads every input of the Analytics block (saved run outputs, or a live read of connected
 * sources) and builds the dataset the charts count. Reloads when the wiring, the run, the
 * column choices or `reload` change; late answers of older reads are dropped.
 */
export function useAnalyticsData({
  root,
  path,
  block,
  run,
  reload,
}: {
  root: WorkflowGraph;
  path: string[];
  block: WorkflowBlock;
  run: WorkflowRun | null;
  reload: number;
}): LoadState {
  const scope = useSettings((s) => s.settings.defaultScope);
  const plans = useMemo(() => {
    try {
      return { ok: true as const, plans: planInputs(root, path, block.id) };
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) };
    }
  }, [root, path, block.id]);
  const wiring = plans.ok
    ? JSON.stringify(
        plans.plans.map((p) => [
          p.label,
          p.edges.map(({ edge, source }) => [edge, source?.params]),
        ]),
      )
    : "";
  const countryColumn = String(block.params.countryColumn ?? "");
  const timeColumn = String(block.params.timeColumn ?? "");

  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!plans.ok) {
      setState({ status: "error", message: plans.message });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void loadInputs(plans.plans, {
      run,
      scope,
      blockOutput: api.runs.blockOutput,
      preview: api.blocks.preview,
    }).then(
      (inputs) => {
        if (cancelled) return;
        // Let the "Analysing…" state paint before the (synchronous) counting starts.
        setTimeout(() => {
          if (cancelled) return;
          try {
            const dataset = buildDataset(inputs, { countryColumn, timeColumn });
            setState({ status: "ready", inputs, dataset });
          } catch (err) {
            setState({
              status: "error",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }, 0);
      },
      (err: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // `wiring` stands for the plans' content; `plans` itself changes identity on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wiring, run?.id, run?.status, scope, countryColumn, timeColumn, reload]);

  return state;
}
