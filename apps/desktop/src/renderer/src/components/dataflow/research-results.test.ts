import { describe, expect, it, vi } from "vitest";
import React, { createElement, type ButtonHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createBlock, emptyPipelineData, ResearchDataset, type ReqflowApi } from "@reqflow/core";
import { fixtureRun } from "@reqflow/core/fixtures";
import { canLoadResearchDataset, loadResearchDataset, loadRunOutput } from "./research-results";
import { RawOutputPreview, ResearchDatasetSummary } from "./ResearchResults";
import { exportResearchDataset } from "./run-controls";

vi.mock("../ui/Button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) =>
    createElement("button", props),
}));
vi.mock("../../lib/api", () => ({ api: {} }));
vi.mock("./run-session", () => ({ runStore: {} }));
vi.stubGlobal("React", React);

const excerpt =
  '=HYPERLINK("https://example.invalid")\r\n<script>sourceScript()</script><img src=x onerror=sourceScript()> 😀';
const dataset = ResearchDataset.parse({
  schemaVersion: 1,
  runId: fixtureRun.id,
  sources: [
    {
      id: "src_synthetic",
      kind: "other_web",
      origin: "web",
      title: "Synthetic original",
      retrievedAt: fixtureRun.startedAt,
    },
  ],
  records: [
    {
      id: "rec_synthetic",
      sourceId: "src_synthetic",
      text: excerpt,
      fields: { originalColumn: "=1+1" },
      recordType: "passage",
      originalSourceId: "original_source",
      originalRecordId: "original_record",
      originalUrl: "https://example.invalid/original",
      provider: "firecrawl",
      collectingAgents: ["editorial_reviews"],
      runIds: [fixtureRun.id],
      retrievedAt: fixtureRun.startedAt,
      datePrecision: "unknown",
      metadata: { originalHtml: "<em>Original</em>", nested: { retained: true } },
      table: {
        headers: ["Synthetic original column"],
        rows: [["=1+1"], [null], [3]],
        units: ["original unit"],
        footnotes: ["Original footnote"],
        dimensions: { market: "explicit synthetic market" },
      },
      context: { text: "Original surrounding context", url: "https://example.invalid/thread" },
      limitations: ["Unknown publication date"],
      contentHash: "synthetic_hash",
    },
  ],
  results: [
    {
      agentId: "editorial_reviews",
      status: "partial",
      recordIds: ["rec_synthetic"],
      requests: 1,
      limitations: ["Provider rate limited after the first original"],
    },
    {
      agentId: "reddit",
      status: "missing_credentials",
      recordIds: [],
      requests: 0,
      limitations: [],
    },
    { agentId: "youtube", status: "empty", recordIds: [], requests: 1, limitations: [] },
  ],
  retrievedAt: fixtureRun.startedAt,
  synthetic: true,
});
const research = createBlock("research", { id: "research", position: { x: 0, y: 0 } });
const run = {
  ...fixtureRun,
  status: "completed" as const,
  graph: { blocks: [research], edges: [] },
};

describe("research results under the shared run lifecycle", () => {
  it.each(["completed", "failed", "cancelled"] as const)(
    "can retrieve preserved partial originals for a %s run",
    async (status) => {
      expect(canLoadResearchDataset({ ...run, status })).toBe(true);
      const read = vi.fn<ReqflowApi["research"]["dataset"]>().mockResolvedValue(dataset);
      const result = await loadResearchDataset({ research: { dataset: read } }, run.id);
      expect(read).toHaveBeenCalledExactlyOnceWith(run.id);
      expect(result.records[0]!.text).toBe(excerpt);
      expect(result.records[0]!.metadata).toEqual(dataset.records[0]!.metadata);
      expect(result.records[0]!.table).toEqual(dataset.records[0]!.table);
      expect(result.records[0]!.context).toEqual(dataset.records[0]!.context);
      expect(result.records[0]!.originalUrl).toBe(dataset.records[0]!.originalUrl);
      expect(result.sources[0]!.reliability).toBeUndefined();
      expect(result.results).toEqual(dataset.results);
      expect(dataset.records[0]!.fields).toEqual({ originalColumn: "=1+1" });
    },
  );

  it("waits for completed/failed/cancelled collection, including nested Research blocks", () => {
    for (const status of ["queued", "running", "waiting_for_review"] as const)
      expect(canLoadResearchDataset({ ...run, status })).toBe(false);
    const custom = createBlock("custom", { id: "custom", position: { x: 0, y: 0 } });
    custom.inner!.blocks.push(research);
    expect(canLoadResearchDataset({ ...run, graph: { blocks: [custom], edges: [] } })).toBe(true);
    expect(canLoadResearchDataset({ ...run, graph: { blocks: [], edges: [] } })).toBe(false);
    expect(canLoadResearchDataset(null)).toBe(false);
  });

  it("rejects another run's dataset and malformed responses instead of showing invented empty data", async () => {
    const read = vi.fn().mockResolvedValue({ ...dataset, runId: "run_other" });
    await expect(loadResearchDataset({ research: { dataset: read } }, run.id)).rejects.toThrow(
      "Research dataset belongs to another run",
    );
    read.mockResolvedValue({ ...dataset, records: [{ text: "missing provenance" }] });
    await expect(loadResearchDataset({ research: { dataset: read } }, run.id)).rejects.toThrow(
      "Malformed research dataset",
    );
    read.mockRejectedValue(new Error("Saved originals unavailable offline"));
    await expect(loadResearchDataset({ research: { dataset: read } }, run.id)).rejects.toThrow(
      "Saved originals unavailable offline",
    );
  });

  it("displays actual raw/source counts and per-agent partial, missing-credential and empty statuses", () => {
    const html = renderToStaticMarkup(
      createElement(ResearchDatasetSummary, { dataset, exporting: false, onExport: vi.fn() }),
    );
    expect(html).toContain('data-testid="research-results"');
    expect(html).toContain("Research: 1 sources · 1 raw records");
    expect(html).toContain("Synthetic fixture data");
    expect(html).toContain("editorial reviews:");
    expect(html).toContain("Partial collection — review limitations");
    expect(html).toContain("Provider rate limited after the first original");
    expect(html).toContain("No credentials configured");
    expect(html).toContain("No matching records");
    expect(html).toContain("1 records · 1 requests");
    expect(html).not.toContain("Collection complete");
    for (const format of ["json", "xlsx", "csv"]) {
      expect(html).toContain(`data-testid="research-export-${format}"`);
      expect(html).toContain(`Export ${format.toUpperCase()}`);
    }
  });

  it("shows an honest empty-results message and disables exports while a native dialog is open", () => {
    const html = renderToStaticMarkup(
      createElement(ResearchDatasetSummary, {
        dataset: { ...dataset, records: [], sources: [], results: [] },
        exporting: true,
        onExport: vi.fn(),
      }),
    );
    expect(html).toContain("Research: 0 sources · 0 raw records");
    expect(html).toContain("No agent collection results were recorded");
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });

  it.each(["json", "xlsx", "csv"] as const)(
    "exports preserved partial results as %s using only the native IPC API",
    async (format) => {
      const read = vi.fn<ReqflowApi["research"]["dataset"]>().mockResolvedValue(dataset);
      const researchExport = vi
        .fn<ReqflowApi["exports"]["research"]>()
        .mockResolvedValue({ path: `synthetic.${format}` });
      const originals = await loadResearchDataset({ research: { dataset: read } }, run.id);
      await expect(
        exportResearchDataset({ exports: { research: researchExport } }, originals, format),
      ).resolves.toEqual({ path: `synthetic.${format}` });
      expect(researchExport).toHaveBeenCalledExactlyOnceWith({ runId: run.id, format });
      expect(originals.records[0]!.text).toBe(excerpt);
    },
  );

  it("validates block output without stripping Research metadata/provenance or evaluating source HTML", async () => {
    const ports = {
      out: { ...emptyPipelineData(), sources: dataset.sources, records: dataset.records },
    };
    const blockOutput = vi.fn<ReqflowApi["runs"]["blockOutput"]>().mockResolvedValue(ports);
    const originals = await loadRunOutput({ runs: { blockOutput } }, run.id, research.id);
    expect(originals).toBe(ports);
    expect(blockOutput).toHaveBeenCalledExactlyOnceWith(run.id, research.id);
    const html = renderToStaticMarkup(createElement(RawOutputPreview, { ports: originals }));
    expect(html).toContain('data-testid="research-output-preview"');
    expect(html).toContain("&lt;script&gt;sourceScript()&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=sourceScript()&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("originalRecordId");
    expect(html).toContain("originalHtml");
    expect(html).toContain("Unknown publication date");
    expect(html).toContain("Original footnote");
    expect(html).toContain("Original surrounding context");
    expect(html).toContain("=HYPERLINK(");
    expect(dataset.records[0]!.text).toBe(excerpt);
  });

  it("rejects malformed output and keeps IPC failures visible for retry", async () => {
    const blockOutput = vi.fn().mockResolvedValue({ out: { records: [] } });
    await expect(loadRunOutput({ runs: { blockOutput } }, run.id, research.id)).rejects.toThrow(
      "Malformed block output",
    );
    blockOutput.mockRejectedValue(new Error("Persisted output unavailable"));
    await expect(loadRunOutput({ runs: { blockOutput } }, run.id, research.id)).rejects.toThrow(
      "Persisted output unavailable",
    );
  });
});
