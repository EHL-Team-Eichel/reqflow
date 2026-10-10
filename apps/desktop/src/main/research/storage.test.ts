import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  AuditEvent,
  DEFAULT_SETTINGS,
  emptyPipelineData,
  ResearchDataset,
  WorkflowRun,
  type PipelineData,
} from "@reqflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResearchStore, validRun } from "./storage";

const at = "2026-10-10T12:00:00.000Z";
function dataset(): ResearchDataset {
  return ResearchDataset.parse({
    schemaVersion: 1,
    runId: "run_synthetic",
    retrievedAt: at,
    synthetic: true,
    sources: [
      {
        id: "src_synthetic",
        kind: "sales_volume",
        origin: "bmw_internal",
        title: "Synthetic table",
        retrievedAt: at,
      },
    ],
    records: [
      {
        id: "rec_synthetic",
        sourceId: "src_synthetic",
        text: "Synthetic deliveries\t7",
        recordType: "table",
        provider: "local_documents",
        originalSourceId: "file_synthetic",
        originalRecordId: "file_synthetic:sheet:1",
        originalUrl: "reqflow-file:///file_synthetic",
        collectingAgents: ["bmw_sales", "bmw_strategy"],
        runIds: ["run_synthetic"],
        retrievedAt: at,
        datePrecision: "unknown",
        contentHash: "synthetic-content-hash",
        locator: "Synthetic!A1:B2",
        limitations: ["Synthetic original has no publication date."],
        table: {
          headers: ["Metric", "Count"],
          rows: [["Synthetic deliveries", 7]],
          units: ["vehicles"],
          footnotes: ["Synthetic note"],
        },
        metadata: {
          originalArtifact: { fileId: "file_synthetic" },
          provenance: [{ page_no: 2, bbox: { l: 1, t: 2, r: 3, b: 4 } }],
          originalFields: { "Synthetic Extra": false },
        },
        fields: { original: { "Synthetic Extra": false } },
      },
    ],
    results: [
      {
        agentId: "bmw_sales",
        status: "success",
        recordIds: ["rec_synthetic"],
        requests: 0,
        limitations: [],
      },
    ],
  });
}
function run(status: WorkflowRun["status"], id = "run_synthetic"): WorkflowRun {
  return WorkflowRun.parse({
    id,
    workflowId: "wf_synthetic",
    workflowVersion: 1,
    graph: { blocks: [], edges: [] },
    scope: DEFAULT_SETTINGS.defaultScope,
    status,
    startedBy: { type: "system", component: "synthetic-test" },
    startedAt: at,
    blockRuns: [],
  });
}
function event(id: string): AuditEvent {
  return AuditEvent.parse({
    id,
    at,
    actor: { type: "human", userId: "synthetic-pm", name: "Synthetic PM" },
    action: "settings.changed",
    entityType: "settings",
    entityId: "app",
    changes: [],
    rationale: "Synthetic configuration change, no credential values.",
  });
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reqflow-storage-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ResearchStore", () => {
  it("rejects provenance amplification before JSON serialization and preserves prior originals", async () => {
    const store = new ResearchStore(dir);
    await store.load();
    await store.write("bounded-original.json", { original: "Synthetic retained original" });
    const repeated = "s".repeat(1024 * 1024);
    const oversized = Array.from({ length: 65 }, () => ({ original: repeated }));
    await expect(store.write("bounded-original.json", oversized)).rejects.toMatchObject({
      code: "storage_limit",
    });
    expect(JSON.parse(await readFile(join(dir, "bounded-original.json"), "utf8"))).toEqual({
      original: "Synthetic retained original",
    });
    expect((await readdir(dir)).filter((name) => name.startsWith(".write-"))).toEqual([]);
  });
  it("initializes and persists schema-valid defaults without shared mutable settings", async () => {
    const first = new ResearchStore(dir);
    await first.load();
    first.state.settings.app.theme = "dark";
    const second = new ResearchStore(dir);
    await second.load();

    expect(second.state).toEqual({ settings: DEFAULT_SETTINGS, workflows: [], runs: [] });
    expect(JSON.parse(await readFile(join(dir, "app-state.json"), "utf8"))).toEqual(second.state);
  });

  it("reloads saved settings and completed run history", async () => {
    const store = new ResearchStore(dir);
    await store.load();
    store.state.settings.app.theme = "dark";
    store.state.runs = [run("completed")];
    await store.saveState();
    const restored = new ResearchStore(dir);

    await restored.load();

    expect(restored.state).toEqual(store.state);
  });

  it("captures a save snapshot before later in-memory mutations", async () => {
    const store = new ResearchStore(dir);
    await store.load();
    store.state.settings.app.theme = "dark";

    const saved = store.saveState();
    store.state.settings.app.theme = "light";
    await saved;
    const restored = new ResearchStore(dir);
    await restored.load();

    expect(restored.state.settings.app.theme).toBe("dark");
  });

  it.each(["queued", "running"] as const)(
    "marks an interrupted %s run failed on restart while retaining its dataset and provenance output",
    async (status) => {
      const store = new ResearchStore(dir);
      await store.load();
      store.state.runs = [run(status)];
      const raw = dataset();
      const outputs = {
        research: { out: { ...emptyPipelineData(), sources: raw.sources, records: raw.records } },
      };
      await store.write("run_synthetic.research.json", raw);
      await store.write("run_synthetic.outputs.json", outputs);
      await store.saveState();
      const restored = new ResearchStore(dir);

      await restored.load();

      expect(restored.state.runs[0]).toMatchObject({
        status: "failed",
        finishedAt: expect.any(String),
        error: expect.stringMatching(/stopped.*preserved research results/i),
      });
      expect(await restored.dataset("run_synthetic")).toEqual(raw);
      expect(await restored.outputs("run_synthetic")).toEqual(outputs);
      const again = new ResearchStore(dir);
      await again.load();
      expect(again.state.runs).toEqual(restored.state.runs);
    },
  );

  it.each(["completed", "failed", "cancelled", "waiting_for_review"] as const)(
    "does not rewrite a %s run as interrupted",
    async (status) => {
      const store = new ResearchStore(dir);
      await store.load();
      store.state.runs = [run(status)];
      await store.saveState();
      const restored = new ResearchStore(dir);

      await restored.load();

      expect(restored.state.runs).toEqual([run(status)]);
    },
  );

  it("validates preserved pipeline data without stripping original ResearchRecord extensions", async () => {
    const store = new ResearchStore(dir);
    await store.load();
    const raw = dataset();
    const envelope: PipelineData = {
      ...emptyPipelineData(),
      sources: raw.sources,
      records: raw.records,
    };
    await store.write("run_synthetic.outputs.json", { research: { out: envelope } });

    const outputs = await store.outputs("run_synthetic");

    expect(outputs.research?.out).toEqual(envelope);
  });

  it("appends schema-valid audit events without overwriting previous history", async () => {
    const store = new ResearchStore(dir);
    await store.load();

    await store.audit(event("aud_first"));
    await store.audit(event("aud_second"));

    expect(await store.read("audit.json", z.array(AuditEvent))).toEqual([
      event("aud_first"),
      event("aud_second"),
    ]);
  });

  it.each(["missing", "existing"] as const)(
    "retains every concurrent audit append when history is %s",
    async (history) => {
      const store = new ResearchStore(dir);
      await store.load();
      const previous = history === "existing" ? [event("aud_previous")] : [];
      for (const entry of previous) await store.audit(entry);
      const concurrent = Array.from({ length: 8 }, (_, index) => event(`aud_concurrent_${index}`));

      await Promise.all(concurrent.map((entry) => store.audit(entry)));

      const restored = new ResearchStore(dir);
      await restored.load();
      const persisted = await restored.read("audit.json", z.array(AuditEvent));
      expect(persisted).toHaveLength(previous.length + concurrent.length);
      expect(persisted).toEqual(expect.arrayContaining([...previous, ...concurrent]));
    },
  );

  it("does not replace a corrupt audit log with a fresh one", async () => {
    const store = new ResearchStore(dir);
    await store.load();
    const contents = '{"synthetic-private-marker":';
    await writeFile(join(dir, "audit.json"), contents);

    await expect(store.audit(event("aud_new"))).rejects.toMatchObject({ code: "storage_error" });

    expect(await readFile(join(dir, "audit.json"), "utf8")).toBe(contents);
  });

  it.each(["not json: synthetic-private-marker", '{"settings":"synthetic-private-marker"}'])(
    "reports corrupt app state without including its contents",
    async (contents) => {
      await writeFile(join(dir, "app-state.json"), contents);

      await expect(new ResearchStore(dir).load()).rejects.toMatchObject({
        code: "storage_error",
        message: "App state could not be read or failed validation.",
      });
    },
  );

  it.each(["research", "outputs"] as const)(
    "reports missing %s data distinctly from corrupt data",
    async (kind) => {
      const store = new ResearchStore(dir);
      await store.load();
      const read = () =>
        kind === "research" ? store.dataset("run_synthetic") : store.outputs("run_synthetic");
      await expect(read()).rejects.toMatchObject({ code: "not_found" });
      await writeFile(join(dir, `run_synthetic.${kind}.json`), '{"synthetic-private-marker":');

      await expect(read()).rejects.toMatchObject({
        code: "storage_error",
        message: "Stored local data could not be read or failed validation.",
      });
    },
  );

  it("rejects invalid preserved output records rather than returning unchecked data", async () => {
    const store = new ResearchStore(dir);
    await store.load();
    await store.write("run_synthetic.outputs.json", {
      research: {
        out: {
          ...emptyPipelineData(),
          records: [{ id: "rec_invalid", text: "Synthetic incomplete record" }],
        },
      },
    });

    await expect(store.outputs("run_synthetic")).rejects.toMatchObject({ code: "storage_error" });
  });

  it("serializes writes and leaves only the final complete file", async () => {
    const store = new ResearchStore(dir);
    await store.load();

    await Promise.all([
      store.write("synthetic.json", { revision: 1 }),
      store.write("synthetic.json", { revision: 2 }),
    ]);

    expect(await store.read("synthetic.json", z.object({ revision: z.number() }))).toEqual({
      revision: 2,
    });
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("persisted run identifiers", () => {
  it.each([
    "../run_synthetic",
    "run_../../outside",
    "/tmp/run_synthetic",
    "run_a/b",
    "run_a\\b",
    "run_",
    "wf_synthetic",
  ])("rejects filesystem-path input %j before reading a dataset or outputs", async (id) => {
    const store = new ResearchStore(dir);

    expect(() => validRun(id)).toThrow();
    await expect(store.dataset(id)).rejects.toThrow();
    await expect(store.outputs(id)).rejects.toThrow();
  });
});
