import { describe, it, expect, vi, afterEach } from "vitest";
import { HilReportRequest, emptyPipelineData, type SourceRecord } from "@reqflow/core";
import {
  fixtureScope,
  fixtureRequirements,
  fixtureSources,
  fixtureFindings,
} from "@reqflow/core/fixtures";
import { exportHilReportPdf, generateReportHtml, renderReportPdf } from "./hil-exporter";

const electron = vi.hoisted(() => {
  const printToPDF = vi.fn(async () => new Uint8Array([37, 80, 68, 70]));
  const loadURL = vi.fn(async () => {});
  const destroy = vi.fn();
  return { printToPDF, loadURL, destroy, options: vi.fn() };
});
vi.mock("electron", () => ({
  BrowserWindow: class {
    constructor(opts: unknown) {
      electron.options(opts);
    }
    loadURL = electron.loadURL;
    webContents = { printToPDF: electron.printToPDF, setWindowOpenHandler: vi.fn() };
    isDestroyed = () => false;
    destroy = electron.destroy;
  },
}));

const record: SourceRecord = {
  id: "rec_selected",
  sourceId: "src_selected",
  text: "Synthetic selected content\nsecond line <script>bad()</script>",
  locator: "row 2",
  fields: { synthetic: "original field value", columns: [1, 2] },
};
function request(): HilReportRequest {
  return {
    metadata: {
      scope: fixtureScope,
      gate: { label: "Review Gate", reviewer: "pm", approvalsNeeded: 1 },
      currentStep: { label: "Raw data", id: "raw" },
      lineageSteps: [
        { id: "raw", label: "Raw data", kind: "raw", path: ["custom"] },
        { id: "hil", label: "Review Gate", kind: "hil", path: [] },
      ],
      lineageLinks: [
        { source: "raw", target: "hil", sourceLabel: "Must have", targetLabel: "Input" },
      ],
    },
    selectedData: { ...emptyPipelineData(), records: [record] },
    fullCounts: { Requirements: 0, Themes: 0, Findings: 0, Records: 20, Sources: 1 },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("HIL export validation", () => {
  it("rejects an empty sample and more than 15 items before opening a dialog", async () => {
    const save = vi.fn();
    await expect(
      exportHilReportPdf({ ...request(), selectedData: emptyPipelineData() }, save),
    ).rejects.toThrow(/between 1 and 15/);
    const req = request();
    req.selectedData.records = Array.from({ length: 16 }, (_, n) => ({
      ...record,
      id: `rec_${n}`,
    }));
    await expect(exportHilReportPdf(req, save)).rejects.toThrow(/between 1 and 15/);
    expect(save).not.toHaveBeenCalled();
  });
  it("rejects duplicate IDs, negative/fractional/inconsistent counts and unbounded metadata", () => {
    const req = request();
    expect(() =>
      HilReportRequest.parse({
        ...req,
        selectedData: { ...req.selectedData, records: [record, record] },
      }),
    ).toThrow(/Duplicate/);
    for (const count of [-1, 1.5, 0]) {
      expect(() =>
        HilReportRequest.parse({ ...req, fullCounts: { ...req.fullCounts, Records: count } }),
      ).toThrow();
    }
    expect(() =>
      HilReportRequest.parse({ ...req, notes: { objective: "x".repeat(2001) } }),
    ).toThrow();
    expect(() =>
      HilReportRequest.parse({
        ...req,
        metadata: { ...req.metadata, lineageSteps: [{ arbitraryHtml: "<script>" }] },
      }),
    ).toThrow();
    expect(() =>
      HilReportRequest.parse({
        ...req,
        metadata: {
          ...req.metadata,
          lineageLinks: [{ source: "missing", target: "hil", sourceLabel: "", targetLabel: "" }],
        },
      }),
    ).toThrow(/reference included/);
  });
  it("rejects oversized source content without truncating or opening a dialog", async () => {
    const req = request();
    req.selectedData.records[0] = { ...record, text: "x".repeat(2_000_001) };
    const save = vi.fn();
    await expect(exportHilReportPdf(req, save)).rejects.toThrow(/exceeds 2 MB/);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("HIL report HTML", () => {
  it("includes selected original fields, escaped verbatim content, omission counts and routed lineage", () => {
    const html = generateReportHtml(request(), "2026-10-11T12:00:00.000Z");
    expect(html).toContain("SAMPLE / FORMAT CHECK");
    expect(html).toContain("1 selected data points out of 21; 20 omitted");
    expect(html).toContain("<td>Records</td><td>1</td><td>20</td><td>19</td>");
    expect(html).toContain("original field value");
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Raw data [Must have] -&gt; Review Gate [Input]");
    expect(html).toContain("custom");
    expect(html).toContain("Live source preview");
    expect(html).toContain("not included in sample; inspect in app");
  });
  it("reports selected requirement scores, targets, evidence gaps and conflicts without inventing linked data", () => {
    const req = request();
    req.selectedData.requirements = [
      {
        ...fixtureRequirements[0]!,
        targets: [],
        evidenceLevel: "C",
        conflictingFindingIds: ["fnd_omitted_conflict"],
      },
    ];
    req.fullCounts.Requirements = 5;
    req.metadata.runId = "run_synthetic";
    req.metadata.runStatus = "waiting_for_review";
    req.notes = { owner: "Synthetic team", nextCheckpoint: "Concept review" };
    const html = generateReportHtml(req);
    expect(html).toContain("Saved run run_synthetic");
    expect(html).toContain("No measurable targets recorded");
    expect(html).toContain("Weak / assumption-led evidence");
    expect(html).toContain("Conflicting evidence");
    expect(html).toContain("fnd_omitted_conflict (not included in sample");
    expect(html).toContain("Synthetic team");
    expect(html).toContain("Concept review");
    expect(html).toContain("Customer impact");
    expect(html).not.toContain(fixtureSources[0]!.title);
    expect(html).not.toContain(fixtureFindings[0]!.statement);
    expect(html).not.toContain(fixtureRequirements[1]!.title);
  });
});

describe("native PDF export", () => {
  it("cancels without rendering or writing", async () => {
    const render = vi.fn();
    const write = vi.fn();
    expect(
      await exportHilReportPdf(request(), async () => ({ canceled: true }), render, write),
    ).toBeNull();
    expect(render).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it("writes actual PDF bytes to the native chosen path and appends .pdf if needed", async () => {
    const render = vi.fn(async () => new TextEncoder().encode("%PDF-synthetic"));
    const write = vi.fn(async () => {});
    const req = request();
    const before = JSON.stringify(req);
    expect(
      await exportHilReportPdf(
        req,
        async () => ({ canceled: false, filePath: "/tmp/report" }),
        render,
        write,
      ),
    ).toEqual({ path: "/tmp/report.pdf" });
    expect(write).toHaveBeenCalledWith(
      "/tmp/report.pdf",
      new TextEncoder().encode("%PDF-synthetic"),
    );
    expect(JSON.stringify(req)).toBe(before);
  });
  it("surfaces dialog, rendering and disk errors", async () => {
    const saved = async () => ({ canceled: false, filePath: "/tmp/report.pdf" });
    await expect(
      exportHilReportPdf(request(), async () => {
        throw new Error("Dialog unavailable");
      }),
    ).rejects.toThrow("Dialog unavailable");
    await expect(
      exportHilReportPdf(request(), saved, async () => {
        throw new Error("Print failed");
      }),
    ).rejects.toThrow("Print failed");
    await expect(
      exportHilReportPdf(
        request(),
        saved,
        async () => new Uint8Array(),
        async () => {
          throw new Error("Disk denied");
        },
      ),
    ).rejects.toThrow("Disk denied");
    await expect(exportHilReportPdf(request(), async () => ({ canceled: false }))).rejects.toThrow(
      "no file path",
    );
  });
  it("disables script/Node, sandboxes the hidden window and destroys it after printing", async () => {
    await renderReportPdf("<p>synthetic</p>");
    expect(electron.options).toHaveBeenCalledWith(
      expect.objectContaining({
        show: false,
        webPreferences: expect.objectContaining({
          javascript: false,
          sandbox: true,
          nodeIntegration: false,
        }),
      }),
    );
    expect(electron.printToPDF).toHaveBeenCalledWith(expect.objectContaining({ pageSize: "A4" }));
    expect(electron.destroy).toHaveBeenCalledTimes(1);
  });
  it("destroys the hidden window on load failure and timeout", async () => {
    electron.loadURL.mockRejectedValueOnce(new Error("Load failed"));
    await expect(renderReportPdf("test")).rejects.toThrow("Load failed");
    expect(electron.destroy).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    electron.printToPDF.mockImplementationOnce(() => new Promise(() => {}));
    const result = renderReportPdf("test");
    const assertion = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(electron.destroy).toHaveBeenCalledTimes(2);
  });
});
