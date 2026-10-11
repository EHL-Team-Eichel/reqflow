import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { DEFAULT_SETTINGS, type ProductScope } from "@reqflow/core";
import { BlockRegistry } from "@reqflow/engine";
import {
  buildOpenCodeAgentPrompt,
  resolveOpenCodeModel,
  runOpenCode,
  parseOpenCodeExcelFile,
  ingestOpenCodeDirectory,
  researchOpencodeImplementations,
} from "./index";

const sampleScope: ProductScope = {
  vehicleLine: "1 Series",
  vehicleCode: "F70",
  derivative: "5-door",
  market: "EU",
  horizonYears: 4,
};

describe("OpenCode Research prompts", () => {
  it("generates structured prompt including research skill installation and Excel output schema", () => {
    const prompt = buildOpenCodeAgentPrompt({
      agentId: "competitor_models",
      scope: sampleScope,
      question: "How does the Audi A3 infotainment compare to BMW iDrive?",
      maxResults: 5,
    });

    expect(prompt).toContain("Competitor Benchmark Analysis");
    expect(prompt).toContain("1 Series");
    expect(prompt).toContain("F70");
    expect(prompt).toContain("EU");
    expect(prompt).toContain("How does the Audi A3 infotainment compare to BMW iDrive?");
    expect(prompt).toContain(
      "npx skills add https://github.com/mattpocock/skills --skill research -y",
    );
    expect(prompt).toContain("research_competitor_models.xlsx");
    expect(prompt).toContain("Customer Feedback");
    expect(prompt).toContain("Vfc level2 3 Name");
  });
});

describe("Model resolution", () => {
  it("prefers block param model over settings", () => {
    const model = resolveOpenCodeModel("openai/gpt-4o", {
      provider: "google",
      model: "gemini-2.5-flash",
    });
    expect(model).toBe("openai/gpt-4o");
  });

  it("formats provider/model from settings when model has no slash", () => {
    const model = resolveOpenCodeModel(undefined, {
      provider: "google",
      model: "gemini-3.8-flash",
    });
    expect(model).toBe("google/gemini-3.8-flash");
  });

  it("preserves model as-is if it already contains provider slash", () => {
    const model = resolveOpenCodeModel(undefined, {
      provider: "google",
      model: "google/gemini-3.8-flash",
    });
    expect(model).toBe("google/gemini-3.8-flash");
  });
});

describe("OpenCode Excel Ingestion", () => {
  it("parses valid Excel sheet with BMW headers into Source and SourceRecord", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "reqflow-opencode-test-"));
    const xlsxPath = path.join(tempDir, "research_reddit.xlsx");

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Feedback");
    sheet.addRow([
      "ID",
      "Source",
      "Brand",
      "Sales Description",
      "Country",
      "Derivate (e-code)",
      "Engine Type",
      "Feedback Type",
      "Customer Feedback",
      "Vfc level2 3 Name",
      "Source URL",
      "Published At",
    ]);
    sheet.addRow([
      "OPN-REDDIT-001",
      "Reddit r/BMW",
      "BMW",
      "BMW 120 M Sport",
      "EU",
      "F70",
      "Mild-Hybrid",
      "Complaint",
      "Owners complain about missing physical iDrive rotary controller in the new cabin.",
      "Infotainment : Controls & Rotary Dial",
      "https://reddit.com/r/BMW/comments/sample",
      "2025-06-15",
    ]);

    await workbook.xlsx.writeFile(xlsxPath);

    const parsed = await parseOpenCodeExcelFile(xlsxPath, "reddit");
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0]?.title).toBe("Reddit r/BMW");
    expect(parsed.sources[0]?.kind).toBe("customer_feedback");

    expect(parsed.records).toHaveLength(1);
    const rec = parsed.records[0]!;
    expect(rec.text).toContain("missing physical iDrive rotary controller");
    expect(rec.fields?.ID).toBe("OPN-REDDIT-001");
    expect(rec.fields?.["Derivate (e-code)"]).toBe("F70");
    expect(rec.fields?.["Vfc level2 3 Name"]).toBe("Infotainment : Controls & Rotary Dial");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("ingests all agent files in a directory", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "reqflow-opencode-test-"));

    for (const agentId of ["reddit", "editorial_reviews"]) {
      const xlsxPath = path.join(tempDir, `research_${agentId}.xlsx`);
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Data");
      sheet.addRow(["ID", "Customer Feedback", "Source", "Source URL"]);
      sheet.addRow([
        `ID-${agentId}-1`,
        `Sample observation for ${agentId}`,
        `${agentId} source`,
        "https://example.com",
      ]);
      await workbook.xlsx.writeFile(xlsxPath);
    }

    const { sources, records } = await ingestOpenCodeDirectory(tempDir, [
      "reddit",
      "editorial_reviews",
    ]);
    expect(sources.length).toBeGreaterThanOrEqual(1);
    expect(records).toHaveLength(2);

    await rm(tempDir, { recursive: true, force: true });
  });
});

describe("OpenCode block execution", () => {
  it("runs block with mock runner and produces PipelineData", async () => {
    const registry = new BlockRegistry(researchOpencodeImplementations);
    const block = registry.get("research_opencode");

    const tempDir = await mkdtemp(path.join(tmpdir(), "reqflow-opencode-runner-"));

    const mockRunner = async ({ workingDir, args }: { workingDir: string; args: string[] }) => {
      // Find which agent prompt was passed
      const promptArg = args[args.length - 1] ?? "";
      let agentId = "editorial_reviews";
      if (promptArg.includes("competitor_models")) agentId = "competitor_models";

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Feedback");
      sheet.addRow([
        "ID",
        "Source",
        "Brand",
        "Customer Feedback",
        "Vfc level2 3 Name",
        "Source URL",
      ]);
      sheet.addRow([
        `OPN-${agentId.toUpperCase()}-001`,
        `${agentId} Test Press`,
        "BMW",
        `Outstanding ride quality on 18-inch wheels observed by ${agentId}.`,
        "Driving Dynamics : Ride Quality",
        `https://example.com/${agentId}`,
      ]);
      await workbook.xlsx.writeFile(path.join(workingDir, `research_${agentId}.xlsx`));

      return { stdout: "OK", stderr: "", exitCode: 0 };
    };

    const logs: string[] = [];
    const ctx = {
      runId: "run_test_123",
      blockId: "block_opencode_1",
      scope: sampleScope,
      settings: DEFAULT_SETTINGS,
      llm: {} as any,
      agents: {} as any,
      audit: { record: async () => {} } as any,
      files: {} as any,
      web: null,
      car: {} as any,
      log: (msg: string) => logs.push(msg),
      progress: () => {},
      signal: new AbortController().signal,
      resumed: false,
    };

    const result = await block.run(
      {},
      {
        agents: ["editorial_reviews"],
        question: "Ride comfort assessment",
        workingDir: tempDir,
        runner: mockRunner,
        skipSkillInstall: true,
      },
      ctx,
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const out = result.outputs["out"];
      expect(out).toBeDefined();
      expect(out!.records).toHaveLength(1);
      expect(out!.records[0]!.text).toContain("Outstanding ride quality");
      expect(out!.sources).toHaveLength(1);
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  it("throws clear error if OpenCode produces no Excel files", async () => {
    const registry = new BlockRegistry(researchOpencodeImplementations);
    const block = registry.get("research_opencode");
    const tempDir = await mkdtemp(path.join(tmpdir(), "reqflow-opencode-runner-fail-"));

    const failingRunner = async () => ({
      stdout: "",
      stderr: "Process failed",
      exitCode: 1,
    });

    const ctx = {
      runId: "run_test_fail",
      blockId: "block_opencode_2",
      scope: sampleScope,
      settings: DEFAULT_SETTINGS,
      llm: {} as any,
      agents: {} as any,
      audit: { record: async () => {} } as any,
      files: {} as any,
      web: null,
      car: {} as any,
      log: () => {},
      progress: () => {},
      signal: new AbortController().signal,
      resumed: false,
    };

    await expect(
      block.run(
        {},
        {
          agents: ["reddit"],
          workingDir: tempDir,
          runner: failingRunner,
          skipSkillInstall: true,
        },
        ctx,
      ),
    ).rejects.toThrow(/OpenCode research completed but produced no valid \.xlsx feedback records/);

    await rm(tempDir, { recursive: true, force: true });
  });
});
