import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { createElement, type ButtonHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  createBlock,
  DEFAULT_SETTINGS,
  ResearchDataset,
  type ReqflowApi,
  type Workflow,
  type WorkflowRun,
} from "@reqflow/core";
import { fixtureScope, fixtureRun, fixtureWorkflow } from "@reqflow/core/fixtures";
import { createRunStore } from "./run-store";
import { runStore } from "./run-session";
import { RunControls } from "./RunControls";
import {
  boundedRawPreview,
  cancelWorkflow,
  collectionSummary,
  exportResearchDataset,
  reconcileRun,
  startEditorWorkflow,
} from "./run-controls";

// Exercise the real shared run store and control markup without adding a DOM dependency.
vi.mock("../ui/Button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) =>
    createElement("button", props),
}));
vi.mock("../../lib/api", () => ({ api: {} }));
vi.mock("../../lib/settings", () => ({
  useSettings: (select: (state: { settings: typeof DEFAULT_SETTINGS }) => unknown) =>
    select({ settings: DEFAULT_SETTINGS }),
}));
vi.mock("./store", () => ({
  useDataflow: (select: (state: { name: string; root: typeof fixtureRun.graph }) => unknown) =>
    select({ name: "Feedback to requirements", root: fixtureRun.graph }),
  dataflowStore: { setState: vi.fn() },
}));
vi.mock("./run-session", () => ({ runStore: { current: null } }));
vi.stubGlobal("React", React);

describe("shared run controls integration", () => {
  let store: ReturnType<typeof createRunStore>;
  let emit: (run: WorkflowRun) => void;
  let resume: ReturnType<typeof vi.fn<ReqflowApi["runs"]["resume"]>>;
  let cancel: ReturnType<typeof vi.fn<ReqflowApi["runs"]["cancel"]>>;
  const hil = createBlock("hil", { id: "review", position: { x: 150, y: 0 } });
  const research = createBlock("research", { id: "research", position: { x: 0, y: 0 } });
  const paused: WorkflowRun = {
    ...fixtureRun,
    status: "waiting_for_review",
    graph: { blocks: [research, hil], edges: [] },
    blockRuns: [
      {
        blockId: research.id,
        status: "succeeded",
        counts: { sources: 1, records: 2 },
        logs: [{ at: fixtureRun.startedAt, message: "Synthetic originals collected" }],
      },
      { blockId: hil.id, status: "waiting_for_review", counts: {}, logs: [] },
    ],
  };
  const render = () =>
    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(RunControls)));

  beforeEach(() => {
    const listeners = new Set<(run: WorkflowRun) => void>();
    emit = (run) => listeners.forEach((listener) => listener(run));
    resume = vi.fn<ReqflowApi["runs"]["resume"]>();
    cancel = vi.fn<ReqflowApi["runs"]["cancel"]>().mockResolvedValue({
      ...paused,
      status: "cancelled",
    });
    store = createRunStore({
      workflows: {} as ReqflowApi["workflows"],
      runs: {
        resume,
        cancel,
        start: vi.fn(),
        list: vi.fn(),
        blockOutput: vi.fn(),
        reviewSplitter: vi.fn(),
        get: vi.fn().mockResolvedValue(paused),
        onUpdate: (listener) => {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      },
    });
    store.setState({ run: paused, workflowId: paused.workflowId });
    // Every component reads this same instance, as Inspector/HilReport/templates do in the app.
    Object.assign(runStore, store, { getInitialState: store.getState });
  });

  it("keeps Start/review controls, block counts/logs and both smoke selector families", () => {
    const html = render();
    expect(html).toContain('data-testid="flow-run" disabled=""');
    expect(html).toContain("Review required");
    expect(html).toContain('data-testid="flow-cancel"');
    expect(html).toContain('data-testid="flow-review"');
    expect(html).toContain('data-testid="flow-run-status"');
    expect(html).toContain('data-testid="flow-run-details"');
    expect(html).toContain('data-testid="run-controls"');
    expect(html).toContain("1 sources · 2 records");
    expect(html).toContain("Synthetic originals collected");
    expect(html).toContain("Inspect output");
    expect(html).toContain(paused.id);
    expect(resume).not.toHaveBeenCalled();
  });

  it("shows running after explicit HIL resume and allows cancellation before resume replies", async () => {
    let resolve!: (run: WorkflowRun) => void;
    resume.mockImplementation(() => new Promise((yes) => (resolve = yes)));
    const unsubscribe = store.getState().subscribe();
    await Promise.resolve();
    expect(render()).toContain("Waiting for human review");
    const pending = store.getState().resume(paused.id, hil.id, true);
    emit({ ...paused, status: "running" });
    const html = render();
    expect(html).toContain('data-testid="flow-run-status"');
    expect(html).toContain("Running");
    expect(html).not.toContain('data-testid="flow-review"');
    expect(html).not.toContain("Waiting for human review");
    expect(html).toContain('data-testid="flow-cancel"');
    expect(html).not.toContain('data-testid="flow-cancel" disabled');
    await store.getState().cancel();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(paused.id);
    resolve({ ...paused, status: "running" });
    await pending;
    expect(store.getState().run?.status).toBe("cancelled");
    expect(render()).toContain("Cancelled");
    unsubscribe();
  });

  it("uses a terminal resume response and resets controls when the shared template session resets", async () => {
    resume.mockResolvedValue({ ...paused, status: "completed" });
    await store.getState().resume(paused.id, hil.id, true);
    expect(render()).toContain("Completed");
    expect(store.getState().reset()).toBe(true);
    const html = render();
    expect(html).not.toContain(paused.id);
    expect(html).not.toContain('data-testid="flow-review"');
    expect(html).not.toContain('data-testid="flow-cancel"');
    expect(html).toContain("Start saves and runs the entire workflow");
  });
});

const previewLimit = 20_000;
const truncationMarker = "Source preview truncated; full original available through export.";

describe("bounded raw output preview", () => {
  it.each(
    [
      null,
      true,
      12.5,
      "Exact synthetic source/display marker",
      [],
      {},
      { out: { records: [{ text: "Exact synthetic source/display marker", metadata: {} }] } },
      { 'quoted"key': [null, false, { empty: [] }, "\\\t\u0000"] },
      Object.assign(Object.create(null), { text: "plain IPC JSON" }),
    ].map((input) => [input]),
  )("preserves complete JSON and excerpts when they fit (%j)", (input) => {
    const preview = boundedRawPreview(input);
    expect(preview).toBe(JSON.stringify(input, null, 2));
    expect(JSON.parse(preview)).toEqual(input);
    expect(preview).not.toContain(truncationMarker);
  });

  it("bounds a 64 MiB-shaped output without serializing its records or full strings", () => {
    const text = "Exact synthetic source/display marker. ".padEnd(16 * 1024, "x");
    const source = Object.freeze({ title: text, excerpt: text });
    const record = Object.freeze({ text, source });
    // Reuse strings/records; never allocate their enormous serialized representation in this test.
    const records = Object.freeze(Array(4096).fill(record));
    const ports = Object.freeze({ out: Object.freeze({ records }) });
    const originalStringify = JSON.stringify;
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation((value) => {
      if (typeof value !== "string" || value.length > previewLimit)
        throw new Error("Preview must stringify only bounded string leaves, never whole records");
      return originalStringify(value);
    });
    let preview: string;
    try {
      preview = boundedRawPreview(ports);
      expect(stringify.mock.calls.length).toBeLessThan(20);
      for (const [value] of stringify.mock.calls) {
        expect(typeof value).toBe("string");
        expect((value as string).length).toBeLessThanOrEqual(previewLimit);
      }
    } finally {
      stringify.mockRestore();
    }
    expect(preview.length).toBeLessThanOrEqual(previewLimit);
    expect(preview).toContain("Exact synthetic source/display marker");
    expect(preview).toContain(truncationMarker);
    expect(records).toHaveLength(4096);
    expect(records[4095]).toBe(record);
    expect(record.text).toBe(text);
    expect(source.excerpt).toBe(text);
  });

  it("stops before reading unseen properties after the character budget is full", () => {
    const privateGetter = vi.fn(() => {
      throw new Error("Private marker must never be evaluated");
    });
    const input = Object.defineProperty({ excerpt: "x".repeat(64 * 1024) }, "unseenPrivateMarker", {
      enumerable: true,
      get: privateGetter,
    });
    const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptor");
    let preview: string;
    try {
      preview = boundedRawPreview(input);
      expect(descriptors.mock.calls).not.toContainEqual([input, "unseenPrivateMarker"]);
    } finally {
      descriptors.mockRestore();
    }
    expect(privateGetter).not.toHaveBeenCalled();
    expect(preview).not.toContain("unseenPrivateMarker");
    expect(preview).toContain(truncationMarker);
    expect(preview.length).toBeLessThanOrEqual(previewLimit);
  });

  it("bounds enormous property names before visiting their values", () => {
    const key = "😀\u0000".repeat(previewLimit);
    const privateGetter = vi.fn(() => {
      throw new Error("Unseen nested property must never be evaluated");
    });
    const unseen = Object.defineProperty({}, "privateMarker", {
      enumerable: true,
      get: privateGetter,
    });
    const input = Object.freeze({ [key]: unseen });
    const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptor");
    let preview: string;
    try {
      preview = boundedRawPreview(input);
      expect(descriptors.mock.calls).not.toContainEqual([unseen, "privateMarker"]);
    } finally {
      descriptors.mockRestore();
    }
    expect(privateGetter).not.toHaveBeenCalled();
    expect(preview.length).toBeLessThanOrEqual(previewLimit);
    expect(preview).toContain(truncationMarker);
    expect(preview).not.toContain("privateMarker");
    expect(input[key]).toBe(unseen);
  });

  it("never invokes object or array getters, toJSON hooks, or class methods", () => {
    const getter = vi.fn(() => "private marker");
    const hook = vi.fn(() => "private marker");
    const accessor = Object.defineProperty({ text: "Real excerpt" }, "private", {
      enumerable: true,
      get: getter,
    });
    const array = Object.defineProperty(["Real excerpt"], "0", { get: getter });
    class NonJson {
      toJSON = hook;
    }
    for (const input of [accessor, array, { text: "Real excerpt", toJSON: hook }, new NonJson()]) {
      const preview = boundedRawPreview(input);
      expect(preview).toContain(truncationMarker);
      expect(preview).not.toContain("private marker");
    }
    expect(getter).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it("bounds deep metadata and cycles without crashing or changing originals", () => {
    let metadata: Record<string, unknown> = { privateMarker: "unseen deep metadata" };
    for (let i = 0; i < 150; i++) metadata = { nested: metadata };
    const input = Object.freeze({ text: "Real excerpt", metadata });
    const preview = boundedRawPreview(input);
    expect(preview).toContain("Real excerpt");
    expect(preview).not.toContain("unseen deep metadata");
    expect(preview).toContain(truncationMarker);
    expect(preview.length).toBeLessThanOrEqual(previewLimit);
    expect(input.metadata).toBe(metadata);
    const cyclic: Record<string, unknown> = { text: "Real excerpt" };
    cyclic.self = cyclic;
    expect(boundedRawPreview(cyclic)).toContain(truncationMarker);
    expect(cyclic.self).toBe(cyclic);
  });

  it("bounds visits globally across a wide collection", () => {
    const input = Object.freeze(Array(10_000).fill(0));
    const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptor");
    let preview: string;
    try {
      preview = boundedRawPreview(input);
      expect(descriptors.mock.calls.length).toBeLessThanOrEqual(5000);
    } finally {
      descriptors.mockRestore();
    }
    expect(preview).toContain(truncationMarker);
    expect(preview.length).toBeLessThanOrEqual(previewLimit);
    expect(input).toHaveLength(10_000);
  });

  it("keeps reused objects intact rather than treating shared references as cycles", () => {
    const record = Object.freeze({ text: "Real excerpt" });
    const input = Object.freeze({ records: Object.freeze([record, record]) });
    expect(boundedRawPreview(input)).toBe(JSON.stringify(input, null, 2));
    expect(input.records[0]).toBe(input.records[1]);
  });

  it("preserves Unicode, CRLF, and JSON escapes for complete excerpts", () => {
    const text = '😀 e\u0301 中文\r\nsecond line\t"quoted"\\\u0000\ud800';
    const input = Object.freeze({ text });
    const preview = boundedRawPreview(input);
    expect(preview).toBe(JSON.stringify(input, null, 2));
    expect(JSON.parse(preview).text).toBe(text);
    expect(input.text).toBe(text);
  });

  it.each(["😀", "\r\n", '"', "\\", "\u0000"])(
    "never cuts Unicode pairs or JSON escape tokens when truncating %j",
    (character) => {
      const text = character.repeat(previewLimit);
      const preview = boundedRawPreview(text);
      const body = preview.slice(0, preview.indexOf(`\n${truncationMarker}`));
      expect(preview).toContain(truncationMarker);
      expect(preview.length).toBeLessThanOrEqual(previewLimit);
      // A cut string need not be complete JSON; its visible prefix still contains whole tokens.
      const recovered = JSON.parse(`${body}"`) as string;
      expect(text.startsWith(recovered)).toBe(true);
      expect(recovered.endsWith("\r")).toBe(false);
      const lastCodeUnit = recovered.charCodeAt(recovered.length - 1);
      expect(lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff).toBe(false);
    },
  );

  it("preserves JSON exactly at the character limit and marks only actual truncation", () => {
    const text = "x".repeat(previewLimit - 2);
    expect(boundedRawPreview(text)).toBe(JSON.stringify(text));
    const preview = boundedRawPreview(`${text}x`);
    expect(preview.length).toBeLessThanOrEqual(previewLimit);
    expect(preview).toContain(truncationMarker);
  });

  it("leaves formula/HTML source text inert and escaped in the existing React pre display", () => {
    const text =
      '=HYPERLINK("https://example.invalid")\r\n<script>sourceScript()</script><img src=x onerror=sourceScript()>';
    const preview = boundedRawPreview({ text, marker: "Exact synthetic source/display marker" });
    expect(JSON.parse(preview).text).toBe(text);
    const html = renderToStaticMarkup(createElement("pre", null, preview));
    expect(html).toContain("=HYPERLINK(");
    expect(html).toContain("Exact synthetic source/display marker");
    expect(html).toContain("&lt;script&gt;sourceScript()&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=sourceScript()&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain(truncationMarker);
  });
});

describe("run controls IPC boundary", () => {
  it("saves the whole editor root with default scope before starting its saved id", async () => {
    const graph = {
      blocks: [createBlock("research", { id: "research", position: { x: 0, y: 0 } })],
      edges: [],
    };
    const workflow: Workflow = { ...fixtureWorkflow, ...graph, id: "wf_saved", version: 2 };
    const save = vi.fn(async () => workflow);
    const start = vi.fn(async () => {
      expect(save).toHaveBeenCalledOnce();
      return fixtureRun;
    });
    const onSaved = vi.fn();
    await startEditorWorkflow(
      { workflows: { save }, runs: { start } },
      graph,
      fixtureScope,
      "wf_saved",
      onSaved,
    );
    expect(save).toHaveBeenCalledWith({
      id: "wf_saved",
      name: "Research workflow",
      scope: fixtureScope,
      blocks: graph.blocks,
      edges: graph.edges,
    });
    expect(start).toHaveBeenCalledWith("wf_saved");
    expect(onSaved).toHaveBeenCalledWith(workflow);
  });

  it("never starts when save fails; exposes actionable offline/storage error", async () => {
    const start = vi.fn();
    const save = vi.fn(async () => {
      throw new Error("Persistence unavailable");
    });
    const graph = {
      blocks: [createBlock("raw", { id: "raw", position: { x: 0, y: 0 } })],
      edges: [],
    };
    await expect(
      startEditorWorkflow({ workflows: { save }, runs: { start } }, graph, fixtureScope),
    ).rejects.toThrow("Persistence unavailable");
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects an invalid or empty root before IPC", async () => {
    const save = vi.fn();
    const client = { workflows: { save }, runs: { start: vi.fn() } };
    await expect(
      startEditorWorkflow(client, { blocks: [], edges: [] }, fixtureScope),
    ).rejects.toThrow(/Add a block/);
    await expect(
      startEditorWorkflow(
        client,
        {
          blocks: [],
          edges: [
            { id: "bad", source: "none", sourcePort: "out", target: "missing", targetPort: "in" },
          ],
        },
        fixtureScope,
      ),
    ).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it("retains a pushed terminal update when start returns an older running snapshot", () => {
    const completed = { ...fixtureRun, status: "completed" as const };
    expect(reconcileRun(completed, { ...completed, status: "running" })).toBe(completed);
    expect(reconcileRun(completed, { ...completed, id: "run_next", status: "queued" }).status).toBe(
      "queued",
    );
    const paused = { ...completed, status: "waiting_for_review" as const };
    expect(reconcileRun(paused, { ...paused, status: "running" })).toBe(paused);
    expect(reconcileRun(paused, completed)).toBe(completed);
  });

  it("cancels the active run, including human-review pauses", async () => {
    const cancelled = { ...fixtureRun, status: "cancelled" as const };
    const cancel = vi.fn(async () => cancelled);
    const result = await cancelWorkflow(
      { runs: { cancel } },
      { ...fixtureRun, status: "waiting_for_review" },
    );
    expect(cancel).toHaveBeenCalledWith(fixtureRun.id);
    expect(result.status).toBe("cancelled");
    await expect(cancelWorkflow({ runs: { cancel } }, cancelled)).rejects.toThrow(
      /Only active runs/,
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("exposes cancel errors without pretending cancellation succeeded", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("Run service unavailable");
    });
    await expect(
      cancelWorkflow({ runs: { cancel } }, { ...fixtureRun, status: "running" }),
    ).rejects.toThrow("Run service unavailable");
  });

  it.each(["json", "xlsx", "csv"] as const)(
    "exports %s through the native-dialog IPC contract",
    async (format) => {
      const dataset = ResearchDataset.parse({
        schemaVersion: 1,
        runId: fixtureRun.id,
        sources: [],
        records: [],
        results: [],
        retrievedAt: fixtureRun.startedAt,
      });
      const research = vi.fn(async () => null);
      expect(await exportResearchDataset({ exports: { research } }, dataset, format)).toBeNull();
      expect(research).toHaveBeenCalledWith({ runId: fixtureRun.id, format });
    },
  );

  it.each([
    ["blocked", "Blocked — permission or provider approval required"],
    ["missing_credentials", "No credentials configured"],
    ["empty", "No matching records"],
    ["partial", "Partial collection — review limitations"],
    ["error", "Collection failed"],
    ["cancelled", "Collection cancelled"],
    ["success", "Collection complete"],
  ] as const)("distinguishes %s from a genuinely empty collection", (status, expected) => {
    expect(
      collectionSummary({
        agentId: "editorial_reviews",
        status,
        recordIds: [],
        limitations: [],
        requests: 0,
      }),
    ).toBe(expected);
  });
});
