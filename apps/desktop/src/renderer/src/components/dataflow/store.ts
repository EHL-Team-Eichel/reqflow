import {
  BLOCK_SPECS,
  MAX_ANALYTICS_INPUTS,
  checkConnection,
  connect as connectPorts,
  createBlock,
  emptyGraph,
  graphAt,
  isBoundaryBlockKind,
  moveBlock,
  nextBlockLabel,
  removeBlocks,
  removeEdges,
  renameBlock as renameInGraph,
  setBlockParams,
  updateGraphAt,
  walkBlocks,
  withSplitterWorkplaces,
  type BlockParams,
  type Connection,
  type ConnectionCheck,
  type PaletteBlockKind,
  type WorkflowBlock,
  type WorkflowGraph,
  type WorkflowTemplate,
} from "@reqflow/core";
import type { EdgeChange, NodeChange } from "@xyflow/react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { instantiateTemplate } from "./templates";

/**
 * Editor state for the Data Flow page. The workflow is one tree of workplaces (`root`); `path`
 * says which inner workplace is open. All graph rules live in @reqflow/core (graph.ts) — this
 * store only applies them to the open workplace and turns errors into a visible notice.
 */

export type XY = { x: number; y: number };
/** A React Flow connection: handle ids are port ids. */
export type FlowConnection = {
  source: string | null;
  target: string | null;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};
export interface Notice {
  id: number;
  tone: "info" | "error";
  message: string;
}
export interface Crumb {
  depth: number; // pass to goTo()
  label: string;
}

export interface DataflowState {
  name: string;
  root: WorkflowGraph;
  path: string[]; // ids of blocks whose inner workplaces are open, outermost first
  selectedBlockIds: string[];
  selectedEdgeIds: string[];
  measured: Record<string, { width: number; height: number }>; // React Flow sizes, by block id
  notice: Notice | null;
  /** The HIL review report that is open, if any (block id + the workplace it sits on). */
  report: { blockId: string; path: string[] } | null;
  /** The Add to Car block whose thought process is open, if any. */
  reasoning: { blockId: string } | null;
  /** The Analytics block whose full-screen view is open, if any (block id + its workplace). */
  analytics: { blockId: string; path: string[] } | null;

  /** Adds a block to the open workplace, selects it and returns its id. */
  addBlock(kind: PaletteBlockKind, position: XY): string;
  loadTemplate(template: WorkflowTemplate, beforeReplace?: () => boolean): boolean;
  applyNodeChanges(changes: NodeChange[]): void;
  applyEdgeChanges(changes: EdgeChange[]): void;
  /** For React Flow's isValidConnection: same rules as connect(), without side effects. */
  checkConnection(connection: FlowConnection): ConnectionCheck;
  connect(connection: FlowConnection): boolean;
  /** Deletes the selected blocks (boundary blocks excluded) and edges. */
  deleteSelection(): void;
  /** Returns an error message, or null when applied. */
  setParams(blockId: string, params: BlockParams): string | null;
  renameBlock(blockId: string, label: string): string | null;
  selectBlock(blockId: string | null): void;
  openInner(blockId: string): void;
  goTo(depth: number): void;
  /** Opens the review report of a block on the open workplace. */
  openReport(blockId: string): void;
  closeReport(): void;
  /** Opens the thought process of an Add to Car block (anywhere in the workflow). */
  openReasoning(blockId: string): void;
  closeReasoning(): void;
  /** Opens the full-screen analytics of an Analytics block on the open workplace. */
  openAnalytics(blockId: string): void;
  closeAnalytics(): void;
  /** Adds one more input to an Analytics block ("Input 2", "Input 3", …). Returns an error or null. */
  addAnalyticsInput(blockId: string): string | null;
  /** Opens the workplace at `path` and selects the block there (closes the report). */
  revealBlock(path: string[], blockId: string): void;
  notify(tone: Notice["tone"], message: string): void;
  dismissNotice(): void;
}

/** Ids look like "ai-filter-3f9c1a2b": readable in logs, unique across the workflow. */
export function newBlockId(kind: PaletteBlockKind): string {
  return `${kind.replace(/_/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
}

export function toCoreConnection(c: FlowConnection): Connection | null {
  if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return null;
  return {
    source: c.source,
    sourcePort: c.sourceHandle,
    target: c.target,
    targetPort: c.targetHandle,
  };
}

/** Breadcrumb for the open workplace: "Workplace › Research › AI Filter". */
export function breadcrumbOf(root: WorkflowGraph, path: readonly string[]): Crumb[] {
  const crumbs: Crumb[] = [{ depth: 0, label: "Workplace" }];
  let graph = root;
  path.forEach((id, i) => {
    const block = graph.blocks.find((b) => b.id === id);
    crumbs.push({ depth: i + 1, label: block?.label ?? id });
    graph = block?.inner ?? emptyGraph();
  });
  return crumbs;
}

export const selectWorkplace = (s: DataflowState): WorkflowGraph => graphAt(s.root, s.path);

/** The block the inspector shows: exactly one selected block on the open workplace. */
export function selectInspectedBlock(s: DataflowState): WorkflowBlock | null {
  if (s.selectedBlockIds.length !== 1) return null;
  return selectWorkplace(s).blocks.find((b) => b.id === s.selectedBlockIds[0]) ?? null;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Readable first Zod issue, e.g. `Branches: Too small: expected array to have >=2 items`. */
function paramError(err: unknown, kind: WorkflowBlock["kind"]): string {
  const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  const issue = issues?.[0];
  if (!issue) return message(err);
  const key = String(issue.path[0] ?? "");
  const label = isBoundaryBlockKind(kind)
    ? key
    : (BLOCK_SPECS[kind].params.find((p) => p.key === key)?.label ?? key);
  return label ? `${label}: ${issue.message}` : issue.message;
}

export function createDataflowStore(initial: WorkflowGraph = emptyGraph()) {
  let noticeId = 0;

  return createStore<DataflowState>()((set, get) => {
    /** Runs `update` on the open workplace; on error, shows it and leaves the state unchanged. */
    const edit = (update: (graph: WorkflowGraph) => WorkflowGraph): boolean => {
      try {
        const current = selectWorkplace(get());
        const next = update(current);
        if (next !== current) set({ root: updateGraphAt(get().root, get().path, () => next) });
        return true;
      } catch (err) {
        get().notify("error", message(err));
        return false;
      }
    };

    return {
      name: "Data Flow",
      root: withSplitterWorkplaces(initial),
      path: [],
      selectedBlockIds: [],
      selectedEdgeIds: [],
      measured: {},
      notice: null,
      report: null,
      reasoning: null,
      analytics: null,

      loadTemplate(template, beforeReplace) {
        try {
          const root = instantiateTemplate(template, newBlockId);
          if (beforeReplace && !beforeReplace()) {
            get().notify("error", "Finish or cancel the current run before loading a template.");
            return false;
          }
          set({
            name: template.name.trim(),
            root,
            path: [],
            selectedBlockIds: [],
            selectedEdgeIds: [],
            measured: {},
            report: null,
            reasoning: null,
            analytics: null,
          });
          get().notify(
            "info",
            `Loaded "${template.name}". Configure the data sources, then press Start when ready.`,
          );
          return true;
        } catch (err) {
          get().notify("error", message(err));
          return false;
        }
      },

      addBlock(kind, position) {
        const id = newBlockId(kind);
        const label = nextBlockLabel(get().root, BLOCK_SPECS[kind].label);
        const block = createBlock(kind, { id, label, position });
        if (edit((g) => ({ ...g, blocks: [...g.blocks, block] }))) {
          set({ selectedBlockIds: [id], selectedEdgeIds: [] });
        }
        return id;
      },

      applyNodeChanges(changes) {
        let selected = new Set(get().selectedBlockIds);
        let measured = get().measured;
        const removed: string[] = [];
        const ok = edit((graph) => {
          let g = graph;
          for (const c of changes) {
            if (c.type === "position" && c.position) g = moveBlock(g, c.id, c.position);
            else if (c.type === "dimensions" && c.dimensions) {
              measured = { ...measured, [c.id]: c.dimensions };
            } else if (c.type === "select") {
              selected = new Set(selected);
              if (c.selected) selected.add(c.id);
              else selected.delete(c.id);
            } else if (c.type === "remove") removed.push(c.id);
          }
          return removed.length ? removeBlocks(g, removed) : g;
        });
        if (!ok) return;
        for (const id of removed) selected.delete(id);
        set({ selectedBlockIds: [...selected], measured });
      },

      applyEdgeChanges(changes) {
        let selected = new Set(get().selectedEdgeIds);
        const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
        for (const c of changes) {
          if (c.type !== "select") continue;
          selected = new Set(selected);
          if (c.selected) selected.add(c.id);
          else selected.delete(c.id);
        }
        if (removed.length && !edit((g) => removeEdges(g, removed))) return;
        for (const id of removed) selected.delete(id);
        set({ selectedEdgeIds: [...selected] });
      },

      checkConnection(connection) {
        const c = toCoreConnection(connection);
        if (!c) return { ok: false, reason: "Connect an output port to an input port." };
        return checkConnection(selectWorkplace(get()), c);
      },

      connect(connection) {
        const c = toCoreConnection(connection);
        if (!c) {
          get().notify("error", "Connect an output port to an input port.");
          return false;
        }
        return edit((g) => connectPorts(g, c));
      },

      deleteSelection() {
        const graph = selectWorkplace(get());
        const blocks = graph.blocks
          .filter((b) => get().selectedBlockIds.includes(b.id) && !isBoundaryBlockKind(b.kind))
          .map((b) => b.id);
        const edges = get().selectedEdgeIds;
        if (edit((g) => removeEdges(removeBlocks(g, blocks), edges))) {
          set({ selectedBlockIds: [], selectedEdgeIds: [] });
        }
      },

      setParams(blockId, params) {
        const graph = selectWorkplace(get());
        const block = graph.blocks.find((b) => b.id === blockId);
        if (!block) return `Block "${blockId}" is not on this workplace`;
        try {
          const result = setBlockParams(graph, blockId, params);
          set({ root: updateGraphAt(get().root, get().path, () => result.graph) });
          const n = result.removedEdges.length;
          if (n > 0) {
            get().notify(
              "info",
              `Removed ${n} connection${n === 1 ? "" : "s"} from ports that no longer exist.`,
            );
          }
          return null;
        } catch (err) {
          return paramError(err, block.kind);
        }
      },

      renameBlock(blockId, label) {
        try {
          const graph = renameInGraph(selectWorkplace(get()), blockId, label);
          set({ root: updateGraphAt(get().root, get().path, () => graph) });
          return null;
        } catch (err) {
          return message(err);
        }
      },

      selectBlock(blockId) {
        set({ selectedBlockIds: blockId ? [blockId] : [], selectedEdgeIds: [] });
      },

      openInner(blockId) {
        const block = selectWorkplace(get()).blocks.find((b) => b.id === blockId);
        if (!block?.inner) {
          get().notify("error", `"${block?.label ?? blockId}" has no inner workplace.`);
          return;
        }
        set({ path: [...get().path, blockId], selectedBlockIds: [], selectedEdgeIds: [] });
      },

      goTo(depth) {
        if (depth < 0 || depth > get().path.length) return;
        set({ path: get().path.slice(0, depth), selectedBlockIds: [], selectedEdgeIds: [] });
      },

      openReport(blockId) {
        const block = selectWorkplace(get()).blocks.find((b) => b.id === blockId);
        if (!block) {
          get().notify("error", `Block "${blockId}" is not on this workplace.`);
          return;
        }
        set({ report: { blockId, path: [...get().path] } });
      },

      closeReport() {
        set({ report: null });
      },

      openReasoning(blockId) {
        const found = [...walkBlocks(get().root)].find(({ block }) => block.id === blockId);
        if (found?.block.kind !== "add_to_car") {
          get().notify("error", `"${found?.block.label ?? blockId}" has no thought process.`);
          return;
        }
        set({ reasoning: { blockId } });
      },

      closeReasoning() {
        set({ reasoning: null });
      },

      openAnalytics(blockId) {
        const block = selectWorkplace(get()).blocks.find((b) => b.id === blockId);
        if (block?.kind !== "analytics") {
          get().notify("error", `"${block?.label ?? blockId}" has no analytics.`);
          return;
        }
        set({ analytics: { blockId, path: [...get().path] } });
      },

      closeAnalytics() {
        set({ analytics: null });
      },

      addAnalyticsInput(blockId) {
        const block = selectWorkplace(get()).blocks.find((b) => b.id === blockId);
        if (block?.kind !== "analytics") {
          return `"${block?.label ?? blockId}" is not an Analytics block.`;
        }
        const current = Array.isArray(block.params.inputs) ? block.params.inputs.map(String) : [];
        if (current.length >= MAX_ANALYTICS_INPUTS) {
          return `An Analytics block has at most ${MAX_ANALYTICS_INPUTS} inputs.`;
        }
        let n = current.length + 1;
        while (current.includes(`Input ${n}`)) n++;
        return get().setParams(blockId, { ...block.params, inputs: [...current, `Input ${n}`] });
      },

      revealBlock(path, blockId) {
        try {
          if (!graphAt(get().root, path).blocks.some((b) => b.id === blockId)) {
            throw new Error(`Block "${blockId}" no longer exists.`);
          }
        } catch (err) {
          get().notify("error", message(err));
          return;
        }
        set({
          path: [...path],
          selectedBlockIds: [blockId],
          selectedEdgeIds: [],
          report: null,
          reasoning: null,
          analytics: null,
        });
      },

      notify(tone, text) {
        set({ notice: { id: ++noticeId, tone, message: text } });
      },

      dismissNotice() {
        set({ notice: null });
      },
    };
  });
}

/** The editor's store. Lives for the whole app session, so switching tabs keeps the flow. */
export const dataflowStore = createDataflowStore();

/**
 * `useDataflow((s) => s.path)`. Select primitives or existing objects; derive new arrays/objects
 * with useMemo (zustand 5 re-renders forever on selectors that return a new object every time).
 */
export function useDataflow<T>(selector: (state: DataflowState) => T): T {
  return useStore(dataflowStore, selector);
}
