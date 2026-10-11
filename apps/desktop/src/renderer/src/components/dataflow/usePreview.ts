import {
  BLOCK_SPECS,
  blockPorts,
  emptyPipelineData,
  isPaletteBlockKind,
  type PipelineData,
  type WorkflowBlock,
} from "@reqflow/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { api, ReqflowError } from "@/lib/api";
import { useSettings } from "@/lib/settings";
import { runStore } from "./run-session";
import { previewSource } from "./source-preview";

export type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: PipelineData; logs: string[] }
  | { status: "error"; message: string; logs: string[] };

/** Raw reads its source; Research reads its persisted output from a matching run. */
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
  const scope = useSettings((s) => s.settings.defaultScope);
  const run = useStore(runStore, (s) => s.run);
  const savedStatus = run?.blockRuns.find((entry) => entry.blockId === block?.id)?.status;
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const request = useRef(0);

  useEffect(() => {
    request.current++;
    setState({ status: "idle" });
  }, [block?.id, block?.params, block?.inner, scope, run?.id, savedStatus]);

  const load = useCallback(async () => {
    if (!block || !isPaletteBlockKind(block.kind)) return;
    const id = ++request.current;
    setState({ status: "loading" });
    try {
      const res = await previewSource(api, block, scope, run);
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
  }, [block, scope, run]);

  return { state, load };
}
