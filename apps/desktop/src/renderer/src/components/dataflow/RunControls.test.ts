import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createBlock, ResearchDataset, type Workflow } from "@reqflow/core";
import { fixtureScope, fixtureRun, fixtureWorkflow } from "@reqflow/core/fixtures";
import {
  boundedRawPreview,
  cancelWorkflow,
  collectionSummary,
  exportResearchDataset,
  reconcileRun,
  startEditorWorkflow,
} from "./run-controls";

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
