import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, PipelineData, Requirement, defaultBlockParams } from "@reqflow/core";
import { createLlmClient } from "@reqflow/llm";
import { describe, expect, it } from "vitest";
import {
  feedbackHeader,
  feedbackRows,
  feedbackSheet,
  duplicateIds,
  independentCopyIds,
} from "../../../../data/samples/f70-feedback-test.fixture";
import { classifyRequirement } from "../../../../apps/desktop/src/renderer/src/components/car/classify";
import { agents, context } from "../add-to-car/test-helpers";
import { addToCarBlock } from "../add-to-car/add-to-car";
import { aiSplitterBlock } from "../ai-splitter/ai-splitter";
import { hilBlock } from "../hil/hil";
import { parseCsv } from "./csv";
import { rawBlock } from "./raw";

async function ingest(extension = "xlsx") {
  const c = context(agents({ provider: "mock" }));
  const name = `f70-feedback-test.${extension}`;
  c.ctx.files = {
    get: async () => ({
      id: "file_synthetic_f70",
      name,
      mimeType: "application/octet-stream",
      bytes: new Uint8Array(
        readFileSync(join(import.meta.dirname, "../../../../data/samples", name)),
      ),
    }),
  };
  const result = await rawBlock.run(
    {},
    {
      ...defaultBlockParams("raw"),
      dataset: "customer_feedback",
      sheet: feedbackSheet,
      file: { fileId: "file_synthetic_f70", name },
    },
    c.ctx,
  );
  if (result.status !== "ok") throw new Error("Synthetic feedback ingestion failed.");
  return { ...c, data: PipelineData.parse(result.outputs.out) };
}

describe("synthetic 100-row F70 workbook", () => {
  it("contains exactly the export schema and 101 physical CSV lines", () => {
    expect(feedbackHeader).toHaveLength(12);
    expect(feedbackRows).toHaveLength(100);
    expect(feedbackRows.every((row) => row.length === 12)).toBe(true);
    const csv = readFileSync(
      join(import.meta.dirname, "../../../../data/samples/f70-feedback-test.csv"),
      "utf8",
    );
    expect(csv.trimEnd().split("\n")).toHaveLength(101);
    expect(parseCsv(csv)).toEqual([feedbackHeader, ...feedbackRows]);
    expect(feedbackRows.every((row) => row[1] === "SYNTHETIC TEST - NOT BMW DATA")).toBe(true);
  });

  it.each(["xlsx", "csv"])(
    "ingests %s into 97 records with duplicate classifications merged",
    async (extension) => {
      const { data, logs } = await ingest(extension);
      expect(data.sources).toHaveLength(1);
      expect(data.records).toHaveLength(97);
      expect(data.findings).toHaveLength(0);
      expect(data.records.every((r) => /^[A-Z]{2}$/.test(r.market ?? ""))).toBe(true);
      for (const id of [...duplicateIds, ...independentCopyIds]) {
        expect(data.records.filter((r) => r.fields?.ID === id)).toHaveLength(1);
      }
      expect(logs.join("\n")).toMatch(/Merged 99 rows into 97 records/);
      expect(logs.join("\n")).toMatch(/without comment text/);
    },
  );

  it("pauses at HIL and publishes seven proposed offline categories after review", async () => {
    const { ctx, data, added, audit } = await ingest();
    expect((await hilBlock.run({ in: data }, defaultBlockParams("hil"), ctx)).status).toBe(
      "paused",
    );
    const resumed = await hilBlock.run({ in: data }, defaultBlockParams("hil"), {
      ...ctx,
      resumed: true,
    });
    expect(resumed).toEqual({ status: "ok", outputs: { out: data } });
    await addToCarBlock.run(
      { "in-1": data },
      {
        ...defaultBlockParams("add_to_car"),
        contexts: [],
        maxRequirements: 10,
      },
      ctx,
    );
    const requirements = added.flatMap((a) => a.requirements);
    expect(requirements).toHaveLength(7);
    expect(requirements.map((r) => r.category).sort()).toEqual([
      "comfort",
      "driving_experience",
      "exterior_design",
      "infotainment_digital",
      "interior_quality",
      "space_practicality",
      "usability_controls",
    ]);
    expect(requirements.every((r) => r.status === "proposed" && r.priority === "should")).toBe(
      true,
    );
    expect(audit.filter((e) => e.action === "finding.excluded")).toHaveLength(4);
    for (const r of requirements) Requirement.parse(r);
    const evidence = added[0]!.evidence!;
    const texts = new Map(evidence.records!.map((r) => [r.id, r.text]));
    for (const finding of evidence.findings!) {
      for (const excerpt of finding.evidence)
        expect(texts.get(excerpt.recordId!)).toContain(excerpt.excerpt);
    }
    expect(
      Object.fromEntries(
        requirements.map((r) => [r.category, [r.findingIds.length, r.evidenceLevel]]),
      ),
    ).toEqual({
      space_practicality: [23, "B"],
      infotainment_digital: [20, "B"],
      comfort: [19, "B"],
      usability_controls: [16, "B"],
      driving_experience: [6, "C"],
      exterior_design: [5, "C"],
      interior_quality: [4, "C"],
    });
  });

  it("routes every record exactly once with customer-priority mock and publishes ranked categories", async () => {
    const { ctx, data, added } = await ingest();
    ctx.llm = createLlmClient({ ...DEFAULT_SETTINGS.llm, provider: "mock" });
    const split = await aiSplitterBlock.run({ in: data }, defaultBlockParams("ai_splitter"), ctx);
    if (split.status !== "ok" || !split.splitterReport)
      throw new Error("Expected a saved splitter analysis.");
    const ids = Object.values(split.outputs).flatMap((d) => d.records.map((r) => r.id));
    expect(ids).toHaveLength(97);
    expect(new Set(ids).size).toBe(97);
    expect(new Set(ids)).toEqual(new Set(data.records.map((r) => r.id)));
    expect(Object.values(split.outputs).map((d) => d.records.length)).toEqual([20, 65, 12]);
    expect(split.splitterReport.groups).toHaveLength(11);
    expect(
      split.splitterReport.groups.find((g) => g.label === "Infotainment usability"),
    ).toMatchObject({
      support: 18,
      opposition: 1,
      unclear: 1,
      outputPortId: "out-0",
    });
    await addToCarBlock.run(
      {
        "in-0": split.outputs["out-0"]!,
        "in-1": split.outputs["out-1"]!,
        "in-2": split.outputs["out-2"]!,
      },
      { ...defaultBlockParams("add_to_car"), contexts: [], maxRequirements: 10 },
      ctx,
    );
    const requirements = added.flatMap((a) => a.requirements);
    expect(requirements).toHaveLength(7);
    expect(requirements.every((r) => r.status === "proposed")).toBe(true);
    expect(
      Object.fromEntries(
        requirements.map((r) => [r.category, [r.priority, classifyRequirement(r).partId]]),
      ),
    ).toEqual({
      infotainment_digital: ["must", "curved_display"],
      space_practicality: ["should", "luggage"],
      comfort: ["should", "dashboard"],
      usability_controls: ["should", "dashboard"],
      driving_experience: ["should", "suspension"],
      exterior_design: ["should", "body"],
      interior_quality: ["could", "dashboard"],
    });
  });

  it.each([
    {
      splitBy: "car_parts",
      branches: ["Seats", "Digital", "Interior", "Driving", "Powertrain", "Exterior"],
      instruction: "",
    },
    {
      splitBy: "custom",
      branches: ["Digital", "Other"],
      instruction: "Groups: Infotainment; Other",
    },
    { splitBy: "category", branches: ["Infotainment", "Comfort", "Other"], instruction: "" },
    { splitBy: "sentiment", branches: ["Positive", "Neutral", "Negative"], instruction: "" },
    { splitBy: "priority", branches: ["Must have", "Should have", "Could have"], instruction: "" },
  ])("preserves all 97 records in $splitBy mode", async (params) => {
    const { ctx, data } = await ingest();
    ctx.llm = createLlmClient({ ...DEFAULT_SETTINGS.llm, provider: "mock" });
    const split = await aiSplitterBlock.run(
      { in: data },
      { ...defaultBlockParams("ai_splitter"), ...params },
      ctx,
    );
    if (split.status !== "ok") throw new Error("Expected successful synthetic routing.");
    const ids = Object.values(split.outputs).flatMap((d) => d.records.map((r) => r.id));
    expect(ids).toHaveLength(97);
    expect(new Set(ids).size).toBe(97);
    if (params.splitBy === "priority") {
      expect(Object.values(split.outputs).map((d) => d.records.length)).toEqual([0, 0, 97]);
    }
  });
});
