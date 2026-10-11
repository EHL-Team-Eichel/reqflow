import {
  BLOCK_SPECS,
  blockPorts,
  emptyPipelineData,
  isPaletteBlockKind,
  type PipelineData,
  type WorkflowBlock,
} from "@reqflow/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ReqflowError } from "@/lib/api";
import { useStore } from "zustand";
import { workflowStore } from "./run-session";

export type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: PipelineData; logs: string[] }
  | { status: "error"; message: string; logs: string[] };

/** Blocks without inputs (Raw, Research) can show their own output without a run. */
export function canPreview(block: WorkflowBlock): boolean {
  return isPaletteBlockKind(block.kind) && blockPorts(block).inputs.length === 0;
}

const logsOf = (details: unknown): string[] =>
  details && typeof details === "object" && Array.isArray((details as { logs?: unknown }).logs)
    ? ((details as { logs: unknown[] }).logs.filter((l) => typeof l === "string") as string[])
    : [];

/**
 * Runs `api.blocks.preview` for one block. The result is dropped when the block or its params
 * change (a stale preview would show the wrong file), and late answers from older requests are ignored.
 */
export function useBlockPreview(block: WorkflowBlock | null) {
  const scope = useStore(workflowStore, (s) => s.scope);
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const request = useRef(0);

  useEffect(() => {
    request.current++;
    setState({ status: "idle" });
  }, [block?.id, block?.params, scope]);

  const load = useCallback(async () => {
    if (!block || !isPaletteBlockKind(block.kind)) return;
    const id = ++request.current;
    setState({ status: "loading" });
    try {
      const res = await api.blocks.preview({ kind: block.kind, params: block.params, scope });
      if (id !== request.current) return;
      const data = Object.values(res.outputs)[0] ?? emptyPipelineData();
      setState({ status: "ready", data, logs: res.logs });
    } catch (err) {
      if (id !== request.current) return;
      const message =
        err instanceof ReqflowError && err.code === "not_implemented"
          ? `The ${BLOCK_SPECS[block.kind].label} block isn't built yet, so there is nothing to preview.`
          : err instanceof Error
            ? err.message
            : String(err);
      setState({
        status: "error",
        message,
        logs: err instanceof ReqflowError ? logsOf(err.details) : [],
      });
    }
  }, [block, scope]);

  return { state, load };
}
