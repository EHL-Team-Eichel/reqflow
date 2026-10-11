import {
  createBlock,
  DEFAULT_SETTINGS,
  type ReqflowApi,
  type Workflow,
  type WorkflowSave,
} from "@reqflow/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataflowStore } from "./store";
import { createWorkflowStore } from "./workflow-store";

const scope = DEFAULT_SETTINGS.defaultScope;
const stamp = "2026-10-11T12:00:00.000Z";
const document = (patch: Partial<Workflow> = {}): Workflow => ({
  id: "wf_saved",
  name: "Saved flow",
  scope: structuredClone(scope),
  version: 1,
  createdAt: stamp,
  updatedAt: stamp,
  blocks: [createBlock("raw", { id: "saved-raw", position: { x: 0, y: 0 } })],
  edges: [],
  ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const editor = createDataflowStore();
  let writes = 0;
  let blocked = false;
  const save = vi.fn(async (input: WorkflowSave) =>
    document({ ...structuredClone(input), id: input.id ?? "wf_created", version: ++writes }),
  );
  const get = vi.fn(async () => document());
  const list = vi.fn(async () => [document()]);
  const runs = vi.fn(async () => []);
  const start = vi.fn();
  const reset = vi.fn(() => !blocked);
  const attach = vi.fn();
  const setId = vi.fn();
  const storage = new Map<string, string>();
  const api = { workflows: { save, get, list }, runs: { list: runs, start } } as unknown as Pick<
    ReqflowApi,
    "workflows" | "runs"
  >;
  const store = createWorkflowStore(api, editor, {
    defaultScope: () => scope,
    blocked: () => blocked,
    resetRun: reset,
    attachRun: attach,
    setWorkflowId: setId,
    storage: () => ({
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
      removeItem: (key) => {
        storage.delete(key);
      },
    }),
  });
  const stop = store.getState().watch();
  return {
    editor,
    store,
    save,
    get,
    list,
    runs,
    start,
    reset,
    attach,
    setId,
    storage,
    stop,
    block: (value: boolean) => {
      blocked = value;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("workflow persistence", () => {
  it("debounces draft changes and autosaves without executing a run", async () => {
    vi.useFakeTimers();
    const test = setup();
    test.editor.getState().addBlock("raw", { x: 0, y: 0 });
    test.editor.getState().setName("Synthetic flow");
    expect(test.store.getState().dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(799);
    expect(test.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(test.save).toHaveBeenCalledOnce();
    expect(test.store.getState()).toMatchObject({ id: "wf_created", dirty: false, saving: false });
    expect(test.start).not.toHaveBeenCalled();
    test.stop();
  });

  it("serializes the first creation and keeps later edits dirty until their own snapshot saves", async () => {
    const test = setup();
    const first = deferred<Workflow>();
    test.save.mockImplementationOnce(() => first.promise);
    test.editor.getState().addBlock("raw", { x: 0, y: 0 });
    const initial = test.store.getState().save();
    await Promise.resolve();
    test.editor.getState().setName("Edited during save");
    const next = test.store.getState().save();
    first.resolve(
      document({
        id: "wf_created",
        name: "Data Flow",
        blocks: structuredClone(test.editor.getState().root.blocks),
      }),
    );
    await initial;
    expect(test.store.getState().dirty).toBe(true);
    await next;
    expect(test.save.mock.calls[1]?.[0].id).toBe("wf_created");
    expect(test.save.mock.calls[1]?.[0].name).toBe("Edited during save");
    expect(test.store.getState().dirty).toBe(false);
    test.stop();
  });

  it("holds later autosaves until Start has captured the selected snapshot", async () => {
    const test = setup();
    test.editor.getState().addBlock("raw", { x: 0, y: 0 });
    const reservation = await test.store
      .getState()
      .saveForRun({ ...structuredClone(test.editor.getState().root), name: "Data Flow", scope });
    test.editor.getState().setName("Next run only");
    const later = test.store.getState().save();
    await Promise.resolve();
    expect(test.save).toHaveBeenCalledOnce();
    reservation.release();
    await later;
    expect(test.save).toHaveBeenCalledTimes(2);
    expect(test.save.mock.calls[1]?.[0].name).toBe("Next run only");
    test.stop();
  });

  it("reports save failure, allows retry, and avoids an automatic retry loop", async () => {
    vi.useFakeTimers();
    const test = setup();
    test.save.mockRejectedValueOnce(new Error("Storage unavailable"));
    test.editor.getState().addBlock("raw", { x: 0, y: 0 });
    await vi.advanceTimersByTimeAsync(800);
    expect(test.store.getState()).toMatchObject({ error: "Storage unavailable", dirty: true });
    await vi.advanceTimersByTimeAsync(10000);
    expect(test.save).toHaveBeenCalledOnce();
    await test.store.getState().save();
    expect(test.store.getState()).toMatchObject({ error: null, dirty: false });
    test.editor.getState().setName("");
    await expect(test.store.getState().save()).rejects.toThrow(/name/);
    expect(test.store.getState().error).toMatch(/name/);
    test.stop();
  });

  it("does not let an old in-flight creation attach to a new document", async () => {
    const test = setup();
    const first = deferred<Workflow>();
    test.save.mockImplementationOnce(() => first.promise);
    test.editor.getState().addBlock("raw", { x: 0, y: 0 });
    const saving = test.store.getState().save();
    await Promise.resolve();
    expect(test.store.getState().newDraft(() => true)).toBe(true);
    first.resolve(document({ id: "wf_old" }));
    await saving;
    expect(test.store.getState().id).toBeNull();
    expect(test.editor.getState().root.blocks).toEqual([]);
    expect(test.setId).not.toHaveBeenCalled();
    test.stop();
  });

  it("loads original IDs and saved scope without starting or resuming anything", async () => {
    const test = setup();
    const saved = document({
      scope: { ...scope, market: "US" },
      description: "Synthetic description",
    });
    test.get.mockResolvedValue(saved);
    expect(await test.store.getState().load(saved.id)).toBe(true);
    expect(test.editor.getState().root.blocks[0]?.id).toBe("saved-raw");
    expect(test.store.getState().scope.market).toBe("US");
    test.store.getState().updateGlobalScope(scope);
    expect(test.store.getState().scope.market).toBe("US");
    expect(test.attach).toHaveBeenCalledWith(saved.id, null);
    expect(test.start).not.toHaveBeenCalled();
    test.editor.getState().renameBlock("saved-raw", "Renamed source");
    await test.store.getState().save();
    expect(test.save.mock.calls[0]?.[0]).toMatchObject({
      id: saved.id,
      description: saved.description,
      scope: saved.scope,
    });
    test.stop();
  });

  it("protects busy/paused runs and respects cancelled replacement", async () => {
    const test = setup();
    test.block(true);
    expect(test.store.getState().newDraft(() => true)).toBe(false);
    expect(await test.store.getState().load("wf_saved")).toBe(false);
    expect(test.get).not.toHaveBeenCalled();
    test.block(false);
    test.editor.getState().addBlock("raw", { x: 0, y: 0 });
    expect(test.store.getState().newDraft(() => false)).toBe(false);
    expect(await test.store.getState().load("wf_saved", () => false)).toBe(false);
    expect(test.editor.getState().root.blocks).toHaveLength(1);
    test.stop();
  });

  it("keeps edits made while a load is pending and rejects malformed replies", async () => {
    const test = setup();
    const waiting = deferred<Workflow>();
    test.get.mockImplementationOnce(() => waiting.promise);
    const loading = test.store.getState().load("wf_saved");
    test.editor.getState().addBlock("raw", { x: 0, y: 0 });
    waiting.resolve(document());
    expect(await loading).toBe(false);
    expect(test.editor.getState().root.blocks[0]?.id).not.toBe("saved-raw");
    expect(test.store.getState().error).toMatch(/changed while loading/);
    test.get.mockResolvedValueOnce({ id: "wf_saved" } as Workflow);
    expect(await test.store.getState().load("wf_saved", () => true)).toBe(false);
    expect(test.store.getState().error).toMatch(/invalid/);
    test.stop();
  });

  it("restores last selection only if startup has not received user edits", async () => {
    const test = setup();
    test.storage.set("reqflow:last-workflow", "wf_saved");
    await test.store.getState().initialize();
    expect(test.editor.getState().root.blocks[0]?.id).toBe("saved-raw");
    test.stop();
    const changed = setup();
    const pending = deferred<Workflow[]>();
    changed.list.mockImplementationOnce(() => pending.promise);
    changed.storage.set("reqflow:last-workflow", "wf_saved");
    const initialization = changed.store.getState().initialize();
    changed.editor.getState().addBlock("raw", { x: 0, y: 0 });
    changed.editor.getState().undo();
    pending.resolve([document()]);
    await initialization;
    expect(changed.get).not.toHaveBeenCalled();
    changed.stop();
  });
});
