import {
  emptyGraph,
  ProductScope,
  validateGraph,
  Workflow,
  WorkflowRun,
  type ProductScope as Scope,
  type ReqflowApi,
  type WorkflowGraph,
  type WorkflowSave,
} from "@reqflow/core";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { DataflowState } from "./store";

type WorkflowApi = Pick<ReqflowApi, "workflows" | "runs">;
interface SessionOptions {
  defaultScope(): Scope;
  blocked(): boolean;
  resetRun(): boolean;
  setWorkflowId(id: string): void;
  attachRun(id: string, run: WorkflowRun | null): void;
  storage?: () => Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}
interface WorkflowState {
  id: string | null;
  scope: Scope;
  scopeOrigin: "global" | "saved";
  version: number | null;
  description?: string;
  dirty: boolean;
  saving: boolean;
  loading: boolean;
  listing: boolean;
  library: Workflow[];
  error: string | null;
  storageWarning: string | null;
  initialize(): Promise<void>;
  watch(): () => void;
  refresh(): Promise<void>;
  save(): Promise<Workflow>;
  saveForRun(input: WorkflowSave): Promise<{ workflow: Workflow; release(): void }>;
  load(id: string, confirm?: () => boolean): Promise<boolean>;
  newDraft(confirm?: () => boolean): boolean;
  detachWorkflow(): boolean;
  updateGlobalScope(scope: Scope): void;
  useGlobalScope(): void;
}

const LAST_WORKFLOW = "reqflow:last-workflow";
const failureMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Workflow operation failed.";
const fingerprint = (input: WorkflowSave) =>
  JSON.stringify({
    blocks: input.blocks,
    edges: input.edges,
    name: input.name,
    scope: input.scope,
    description: input.description,
  });

/** Serializes draft writes and holds them behind Start until main has captured its run snapshot. */
export function createWorkflowStore(
  api: WorkflowApi,
  editor: StoreApi<DataflowState>,
  options: SessionOptions,
) {
  let epoch = 0;
  let listRequest = 0;
  let initialized = false;
  let editorRevision = 0;
  let libraryRevision = 0;
  let replacing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let saved: Workflow | null = null;
  const initialScope = structuredClone(options.defaultScope());
  let savedFingerprint = fingerprint({
    ...editor.getState().root,
    name: editor.getState().name,
    scope: initialScope,
  });

  return createStore<WorkflowState>()((set, get) => {
    const snapshot = (): WorkflowSave => ({
      ...structuredClone(editor.getState().root),
      name: editor.getState().name,
      scope: structuredClone(get().scope),
      ...(get().description === undefined ? {} : { description: get().description }),
    });
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const remember = (id: string | null) => {
      try {
        const storage = options.storage?.();
        if (!storage) {
          if (options.storage)
            set({
              storageWarning:
                "Last-workflow restore is unavailable. Saved flows remain available through Open.",
            });
          return;
        }
        if (id) storage.setItem(LAST_WORKFLOW, id);
        else storage.removeItem(LAST_WORKFLOW);
      } catch {
        set({
          storageWarning:
            "Last-workflow restore is unavailable. Saved flows remain available through Open.",
        });
      }
    };
    const changed = () => {
      if (replacing) return;
      const dirty = fingerprint(snapshot()) !== savedFingerprint;
      set({ dirty });
      clearTimer();
      if (dirty && editor.getState().name.trim())
        timer = setTimeout(() => {
          timer = undefined;
          void get()
            .save()
            .catch(() => {}); // save records a visible error; no automatic retry loop.
        }, 800);
    };
    const valid = (input: WorkflowSave) => {
      if (!input.name.trim()) throw new Error("Give the workflow a name before saving.");
      ProductScope.parse(input.scope);
      const issues = validateGraph(input);
      if (issues.length) throw new Error(`Workflow cannot be saved: ${issues[0]!.message}`);
    };
    const write = async (input: WorkflowSave, documentEpoch: number): Promise<Workflow> => {
      if (documentEpoch !== epoch)
        throw new Error("The document changed before its queued save started.");
      const wanted = fingerprint(input);
      if (saved && wanted === savedFingerprint) return saved;
      set({ saving: true, error: null });
      try {
        valid(input);
        const response = await api.workflows.save({
          ...input,
          ...(get().id ? { id: get().id! } : {}),
        });
        const checked = Workflow.safeParse(response);
        if (!checked.success) throw new Error("The saved workflow response is invalid.");
        const result = checked.data;
        if (documentEpoch === epoch) {
          saved = result;
          libraryRevision++;
          savedFingerprint = wanted;
          set({
            id: result.id,
            version: result.version,
            description: result.description,
            dirty: fingerprint(snapshot()) !== wanted,
            library: [result, ...get().library.filter((entry) => entry.id !== result.id)],
          });
          options.setWorkflowId(result.id);
          remember(result.id);
        }
        return result;
      } catch (error) {
        if (documentEpoch === epoch) set({ error: failureMessage(error), dirty: true });
        throw error;
      } finally {
        if (documentEpoch === epoch) set({ saving: false });
      }
    };
    const detach = () => {
      epoch++;
      clearTimer();
      saved = null;
      const scope = structuredClone(options.defaultScope());
      set({
        id: null,
        scope,
        scopeOrigin: "global",
        version: null,
        description: undefined,
        saving: false,
        error: null,
        dirty: false,
      });
      savedFingerprint = fingerprint({ ...emptyGraph(), name: "Data Flow", scope });
      remember(null);
    };

    return {
      id: null,
      scope: initialScope,
      scopeOrigin: "global",
      version: null,
      dirty: false,
      saving: false,
      loading: false,
      listing: false,
      library: [],
      error: null,
      storageWarning: null,
      watch() {
        const unsubscribe = editor.subscribe((next, previous) => {
          if (next.root !== previous.root || next.name !== previous.name) {
            editorRevision++;
            changed();
          }
        });
        changed();
        return unsubscribe;
      },
      async initialize() {
        if (initialized) return;
        initialized = true;
        const revision = editorRevision;
        await get().refresh();
        if (
          editorRevision !== revision ||
          get().error ||
          get().dirty ||
          editor.getState().root.blocks.length ||
          options.blocked()
        )
          return;
        let id: string | null = null;
        try {
          id = options.storage?.()?.getItem(LAST_WORKFLOW) ?? null;
        } catch {
          set({
            storageWarning:
              "Last-workflow restore is unavailable. Use Open to restore a saved flow.",
          });
        }
        if (id && get().library.some((entry) => entry.id === id)) await get().load(id);
      },
      async refresh() {
        const request = ++listRequest;
        const revision = libraryRevision;
        set({ listing: true });
        try {
          const response = await api.workflows.list();
          const library = response.map((entry) => {
            const result = Workflow.safeParse(entry);
            if (!result.success) throw new Error("The workflow library contains invalid data.");
            return result.data;
          });
          if (request === listRequest) {
            const entries = new Map(library.map((entry) => [entry.id, entry]));
            if (revision !== libraryRevision)
              for (const entry of get().library) {
                if (!entries.has(entry.id) || entries.get(entry.id)!.version < entry.version)
                  entries.set(entry.id, entry);
              }
            set({ library: [...entries.values()], error: null });
          }
        } catch (error) {
          if (request === listRequest) set({ error: failureMessage(error) });
        } finally {
          if (request === listRequest) set({ listing: false });
        }
      },
      async save() {
        clearTimer();
        const input = snapshot();
        const currentEpoch = epoch;
        const operation = queue.then(() => write(input, currentEpoch));
        queue = operation.catch(() => {});
        return operation;
      },
      async saveForRun(input) {
        clearTimer();
        const currentEpoch = epoch;
        const snapshot = structuredClone(input);
        const operation = queue.then(async () => {
          const workflow = await write(
            {
              ...snapshot,
              ...(get().description === undefined ? {} : { description: get().description }),
            },
            currentEpoch,
          );
          let release!: () => void;
          const hold = new Promise<void>((resolve) => {
            release = resolve;
          });
          return { workflow, hold, release };
        });
        queue = operation.then((result) => result.hold).catch(() => {});
        const result = await operation;
        return { workflow: result.workflow, release: result.release };
      },
      async load(id, confirm) {
        if (options.blocked() || get().loading) {
          set({ error: "Finish or cancel the current run before opening another workflow." });
          return false;
        }
        if (get().dirty && confirm && !confirm()) return false;
        const before = fingerprint(snapshot());
        const revision = editorRevision;
        const currentEpoch = epoch;
        set({ loading: true, error: null });
        try {
          const response = Workflow.safeParse(await api.workflows.get(id));
          if (!response.success || response.data.id !== id)
            throw new Error("The selected workflow is invalid.");
          const workflow = response.data;
          const issues = validateGraph(workflow);
          if (issues.length)
            throw new Error(`The selected workflow is invalid: ${issues[0]!.message}`);
          const runs = await api.runs.list(id);
          const checkedRuns = runs.map((run) => {
            const parsed = WorkflowRun.safeParse(run);
            if (!parsed.success) throw new Error("The saved run history is invalid.");
            return parsed.data;
          });
          const latest =
            checkedRuns
              .filter((run) => run.workflowId === id)
              .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
          if (
            currentEpoch !== epoch ||
            revision !== editorRevision ||
            before !== fingerprint(snapshot()) ||
            options.blocked()
          )
            throw new Error(
              "The current workflow changed while loading. Your edits were kept; open the saved flow again when ready.",
            );
          if (!options.resetRun())
            throw new Error("Finish or cancel the current run before switching workflows.");
          replacing = true;
          epoch++;
          clearTimer();
          editor
            .getState()
            .replaceWorkflow({ blocks: workflow.blocks, edges: workflow.edges }, workflow.name);
          saved = workflow;
          libraryRevision++;
          set({
            id,
            scope: workflow.scope,
            scopeOrigin: "saved",
            version: workflow.version,
            description: workflow.description,
            dirty: false,
            saving: false,
          });
          savedFingerprint = fingerprint(snapshot());
          options.attachRun(id, latest);
          remember(id);
          return true;
        } catch (error) {
          set({ error: failureMessage(error) });
          return false;
        } finally {
          replacing = false;
          set({ loading: false });
        }
      },
      newDraft(confirm) {
        if (options.blocked() || get().loading) {
          set({ error: "Finish or cancel the current run before creating a new workflow." });
          return false;
        }
        if (get().dirty && confirm && !confirm()) return false;
        if (!options.resetRun()) return false;
        replacing = true;
        detach();
        editor.getState().replaceWorkflow(emptyGraph(), "Data Flow");
        replacing = false;
        return true;
      },
      detachWorkflow() {
        if (options.blocked() || get().loading || !options.resetRun()) return false;
        detach();
        return true;
      },
      updateGlobalScope(scope) {
        if (get().scopeOrigin !== "global" || JSON.stringify(scope) === JSON.stringify(get().scope))
          return;
        const pristine =
          !get().id &&
          !get().dirty &&
          !editor.getState().root.blocks.length &&
          editor.getState().name === "Data Flow";
        set({ scope: ProductScope.parse(scope) });
        if (pristine) savedFingerprint = fingerprint(snapshot());
        changed();
      },
      useGlobalScope() {
        set({ scopeOrigin: "global", scope: structuredClone(options.defaultScope()) });
        changed();
      },
    };
  });
}
