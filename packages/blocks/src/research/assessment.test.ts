import { describe, expect, it, vi } from "vitest";
import {
  CollectedItem,
  DEFAULT_SETTINGS,
  ResearchDataset,
  ResearchRequest,
  ResearchScope,
  type LlmClient,
} from "@reqflow/core";
import ExcelJS from "exceljs";
import {
  ASSESSMENT_FIELD,
  assessOriginal,
  SourceAssessment,
  sourceAssessments,
} from "./assessment";
import { normalizeItem, mergeResearchDatasets } from "./raw";
import { researchTableRows } from "./tabular";
import { exportResearchCsv, exportResearchXlsx } from "./export";
import { createResearchCollector } from "./runtime";

const at = "2026-10-11T12:00:00.000Z";
const scope = ResearchScope.parse({ model: "Synthetic compact", markets: ["EU"] });
const signal = new AbortController().signal;
function original(overrides: Partial<CollectedItem> = {}) {
  return CollectedItem.parse({
    provider: "firecrawl",
    sourceId: "synthetic",
    sourceUrl: "https://sources.example.org/review",
    sourceTitle: "Synthetic source",
    recordId: "original",
    recordType: "passage",
    text: "Cookie settings\n\nSynthetic cabin storage is useful.\n\nBuy unrelated shoes.",
    metadata: { rawHtml: "<p>Do not send this duplicate archive payload</p>" },
    ...overrides,
  });
}
type Prompt = {
  agent: { id: string; assignment: string };
  content: { text?: string; rows?: { index: number; values: unknown[] }[] };
  scope: unknown;
};
function client(answer: (prompt: Prompt) => unknown): LlmClient {
  return {
    async generateObject(request) {
      return {
        model: "synthetic-quality",
        object: request.schema.parse(answer(JSON.parse(request.prompt))),
      };
    },
    async generateText() {
      throw new Error("No prose");
    },
  };
}
const selectText = ({ content }: Prompt) => ({
  verdict: "relevant",
  reason: "Applicable product experience.",
  uncertainty: "Single source; authenticity not independently verified.",
  summary: "Synthetic cabin storage provides practical day-to-day usability.",
  excerpts: [
    {
      start: content.text!.indexOf("Synthetic cabin"),
      end: content.text!.indexOf("Synthetic cabin") + "Synthetic cabin storage is useful.".length,
      quote: "Synthetic cabin storage is useful.",
    },
  ],
  tableRows: [],
});
const irrelevant = {
  verdict: "irrelevant",
  reason: "No substantive material for this agent's assignment.",
  uncertainty: "",
  summary: "",
  excerpts: [],
  tableRows: [],
};
function dataset(item: CollectedItem, agentId = "editorial_reviews" as const) {
  const { source, record } = normalizeItem(item, agentId, "run_assess", at);
  return ResearchDataset.parse({
    schemaVersion: 1,
    runId: "run_assess",
    sources: [source],
    records: [record],
    results: [],
    retrievedAt: at,
    synthetic: true,
  });
}

describe("source content assessment inside Research agents", () => {
  it("uses the agent assignment/actual scope and selects exact evidence, leaving originals untouched", async () => {
    const item = original();
    const data = dataset(item);
    const before = JSON.stringify(data);
    const prompts: Prompt[] = [];
    const reserve = vi.fn();
    const llm = client((prompt) => {
      prompts.push(prompt);
      return selectText(prompt);
    });
    const assessment = await assessOriginal(
      item,
      data.records[0]!,
      "editorial_reviews",
      scope,
      llm,
      signal,
      reserve,
    );
    expect(prompts[0]).toMatchObject({
      agent: { id: "editorial_reviews" },
      scope,
      content: { text: item.text },
    });
    expect(prompts[0]!.agent.assignment).toContain("editorial");
    expect(JSON.stringify(prompts)).not.toContain("rawHtml");
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(assessment.model).toBe("synthetic-quality");
    expect(JSON.stringify(data)).toBe(before);
    expect(assessment.summaries).toHaveLength(1);
    expect(assessment.summaries![0]).toEqual({
      text: "Synthetic cabin storage provides practical day-to-day usability.",
      excerpts: [{ start: 17, end: 51 }],
      tableRows: [],
    });
    data.records[0]!.fields![ASSESSMENT_FIELD] = [assessment];
    const rows = researchTableRows(data);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("Synthetic cabin storage is useful.");
    expect(rows[0]!.locator).toContain("chars 18–51");
    expect(rows[0]!.collectedRecordId).toBe(data.records[0]!.id);
    expect(exportResearchCsv(data)).not.toContain("Cookie settings");
    expect(rows[0]!.sourceAssessments).toEqual([
      { agentId: "editorial_reviews", verdict: "relevant", model: "synthetic-quality" },
    ]);
  });

  it.each([
    { ...irrelevant, verdict: "relevant", excerpts: [{ start: 0, end: 4, quote: "fake" }] },
    { ...irrelevant, verdict: "relevant" },
    { ...irrelevant, verdict: "relevant", tableRows: [0] },
    { ...irrelevant, excerpts: [{ start: 0, end: 4, quote: "Cook" }] },
    {
      ...irrelevant,
      verdict: "relevant",
      summary: "",
      excerpts: [{ start: 18, end: 51, quote: "Synthetic cabin storage is useful." }],
    },
    {
      ...irrelevant,
      verdict: "relevant",
      summary: "   ",
      excerpts: [{ start: 18, end: 51, quote: "Synthetic cabin storage is useful." }],
    },
    { ...irrelevant, summary: "Unexpected summary for irrelevant." },
    { ...irrelevant, verdict: "uncertain", summary: "Unexpected summary for uncertain." },
  ])("rejects unsupported or inconsistent evidence selection %#", async (answer) => {
    const item = original();
    await expect(
      assessOriginal(
        item,
        dataset(item).records[0]!,
        "editorial_reviews",
        scope,
        client(() => answer),
        signal,
        () => {},
      ),
    ).rejects.toThrow();
  });

  it("covers every source-text chunk and does not accept an unexamined tail", async () => {
    const item = original({ text: "x".repeat(12_000) + "Synthetic cabin storage is useful." });
    const data = dataset(item);
    const chunks: string[] = [];
    const assessment = await assessOriginal(
      item,
      data.records[0]!,
      "editorial_reviews",
      scope,
      client((prompt) => {
        chunks.push(prompt.content.text!);
        return prompt.content.text!.includes("Synthetic cabin") ? selectText(prompt) : irrelevant;
      }),
      signal,
      () => {},
    );
    expect(chunks.join("")).toBe(item.text);
    expect(chunks).toHaveLength(2);
    expect(assessment.summaries).toHaveLength(1);
    expect(assessment.summaries![0]!.text).toBe(
      "Synthetic cabin storage provides practical day-to-day usability.",
    );
    expect(assessment.summaries![0]!.excerpts).toEqual([{ start: 12000, end: 12034 }]);
    data.records[0]!.fields![ASSESSMENT_FIELD] = [assessment];
    expect(researchTableRows(data).map((row) => row.text)).toEqual([
      "Synthetic cabin storage is useful.",
    ]);
  });

  it("realigns slightly drifted LLM start/end offsets when verbatim quote exists in chunk", async () => {
    const item = original();
    const data = dataset(item);
    const quote = "Synthetic cabin storage is useful.";
    const exactStart = item.text.indexOf(quote);
    const exactEnd = exactStart + quote.length;

    // Simulate LLM returning offsets drifted by 5 characters
    const driftedStart = exactStart - 5;
    const driftedEnd = exactEnd - 5;

    const assessment = await assessOriginal(
      item,
      data.records[0]!,
      "editorial_reviews",
      scope,
      client(() => ({
        ...irrelevant,
        verdict: "relevant",
        reason: "Relevant cabin storage evidence.",
        summary: "Cabin storage provides good usability.",
        excerpts: [{ start: driftedStart, end: driftedEnd, quote }],
      })),
      signal,
      () => {},
    );

    expect(assessment.excerpts).toEqual([{ start: exactStart, end: exactEnd }]);
    expect(assessment.summaries![0]!.excerpts).toEqual([{ start: exactStart, end: exactEnd }]);
  });

  it("exports only checked native rows with typed cells and archives all originals/decisions", async () => {
    const item = original({
      recordType: "table",
      text: "Synthetic native table",
      table: {
        headers: ["Metric", "Count", "Enabled"],
        rows: [
          ["Relevant", 10, true],
          ["Unrelated", 99, false],
        ],
        units: [],
        footnotes: [],
      },
    });
    const data = dataset(item);
    const assessment = await assessOriginal(
      item,
      data.records[0]!,
      "editorial_reviews",
      scope,
      client(() => ({
        ...irrelevant,
        verdict: "relevant",
        reason: "Relevant native metric.",
        summary: "Relevant native metric summary.",
        tableRows: [0],
      })),
      signal,
      () => {},
    );
    expect(assessment.summaries).toEqual([
      {
        text: "Relevant native metric summary.",
        excerpts: [],
        tableRows: [0],
      },
    ]);
    data.records[0]!.fields![ASSESSMENT_FIELD] = [assessment];
    expect(researchTableRows(data)[0]!.fields).toEqual({
      Metric: "Relevant",
      Count: 10,
      Enabled: true,
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await exportResearchXlsx(data)) as never);
    expect(workbook.getWorksheet("Table_1")!.rowCount).toBe(2);
    expect(workbook.getWorksheet("Table_1")!.getRow(2).values).toEqual([, "Relevant", 10, true]);
    expect(workbook.getWorksheet("Metrics Tables")!.rowCount).toBe(3);
    expect(workbook.getWorksheet("Source Assessments")!.getRow(2).getCell(4).value).toBe(
      "relevant",
    );
    expect(data.records[0]!.table!.rows).toHaveLength(2);
  });

  it("merges agent-specific assessments and never carries verdicts over a changed content revision", async () => {
    const item = original();
    const first = dataset(item);
    const second = dataset(item);
    second.records[0]!.collectingAgents = ["technology"];
    first.records[0]!.fields![ASSESSMENT_FIELD] = [
      await assessOriginal(
        item,
        first.records[0]!,
        "editorial_reviews",
        scope,
        client(selectText),
        signal,
        () => {},
      ),
    ];
    second.records[0]!.fields![ASSESSMENT_FIELD] = [
      await assessOriginal(
        item,
        second.records[0]!,
        "technology",
        scope,
        client(() => irrelevant),
        signal,
        () => {},
      ),
    ];
    const merged = mergeResearchDatasets(first, second);
    expect(sourceAssessments(merged.records[0]!)).toHaveLength(2);
    expect(researchTableRows(merged)).toHaveLength(1);
    const changed = dataset(original({ text: "Different content." }));
    changed.retrievedAt = at;
    changed.records[0]!.retrievedAt = at;
    const result = mergeResearchDatasets(merged, changed);
    expect(sourceAssessments(result.records[0]!)).toEqual([]);
    expect(researchTableRows(result)).toEqual([]);
  });

  it("keeps separate decisions for different scopes even when the collecting agent/source is identical", async () => {
    const item = original();
    const first = dataset(item);
    const second = dataset(item);
    first.records[0]!.fields![ASSESSMENT_FIELD] = [
      await assessOriginal(
        item,
        first.records[0]!,
        "editorial_reviews",
        scope,
        client(selectText),
        signal,
        () => {},
      ),
    ];
    second.records[0]!.fields![ASSESSMENT_FIELD] = [
      await assessOriginal(
        item,
        second.records[0]!,
        "editorial_reviews",
        { ...scope, questions: ["Synthetic different topic"] },
        client(() => irrelevant),
        signal,
        () => {},
      ),
    ];
    const merged = mergeResearchDatasets(first, second);
    expect(sourceAssessments(merged.records[0]!)).toHaveLength(2);
    expect(sourceAssessments(merged.records[0]!)[1]!.scope.questions).toEqual([
      "Synthetic different topic",
    ]);
  });

  it("archives an uncertain source decision without emitting it as checked evidence", async () => {
    const item = original();
    const data = dataset(item);
    data.records[0]!.fields![ASSESSMENT_FIELD] = [
      await assessOriginal(
        item,
        data.records[0]!,
        "editorial_reviews",
        scope,
        client(() => ({
          ...irrelevant,
          verdict: "uncertain",
          reason: "Title-only evidence is insufficient.",
          uncertainty: "Full content is unavailable.",
        })),
        signal,
        () => {},
      ),
    ];
    expect(researchTableRows(data)).toEqual([]);
    expect(data.records[0]!.text).toBe(item.text);
    expect(sourceAssessments(data.records[0]!)[0]!.uncertainties).toEqual([
      "Full content is unavailable.",
    ]);
    expect(sourceAssessments(data.records[0]!)[0]!.summaries).toEqual([]);
  });

  it("preserves the complete independent feedback opinion after checking relevance", async () => {
    const item = original({
      recordType: "feedback",
      text: "Synthetic cabin storage is useful.\nThe rest of this opinion provides context.",
    });
    const data = dataset(item);
    data.records[0]!.fields![ASSESSMENT_FIELD] = [
      await assessOriginal(
        item,
        data.records[0]!,
        "editorial_reviews",
        scope,
        client(selectText),
        signal,
        () => {},
      ),
    ];
    expect(researchTableRows(data)).toHaveLength(1);
    expect(researchTableRows(data)[0]!.text).toBe(item.text);
    expect(researchTableRows(data)[0]!.id).toBe(data.records[0]!.id);
  });

  it("refuses oversized native context before reserving a paid review request", async () => {
    const item = original({
      recordType: "table",
      text: "Native table",
      table: { headers: ["Count"], rows: [[1]], units: [], footnotes: ["x".repeat(12_001)] },
    });
    const reserve = vi.fn();
    const answer = vi.fn(() => irrelevant);
    await expect(
      assessOriginal(
        item,
        dataset(item).records[0]!,
        "editorial_reviews",
        scope,
        client(answer),
        signal,
        reserve,
      ),
    ).rejects.toThrow("context exceeds");
    expect(reserve).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  });

  it("checks cancellation after a response and never accepts evidence obtained after abort", async () => {
    const item = original();
    const controller = new AbortController();
    await expect(
      assessOriginal(
        item,
        dataset(item).records[0]!,
        "editorial_reviews",
        scope,
        client((prompt) => {
          controller.abort();
          return selectText(prompt);
        }),
        controller.signal,
        () => {},
      ),
    ).rejects.toThrow();
  });

  it("assesses each original within each agent before usable output; rejected originals stay archived", async () => {
    const item = original();
    const unrelated = original({
      sourceUrl: "https://sources.example.org/other",
      text: "Unrelated shopping.",
    });
    const calls: string[] = [];
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.research.provider = "firecrawl";
    settings.research.apis.firecrawl.enabled = true;
    const collector = createResearchCollector({
      settings,
      credentials: { firecrawl_api_key: "synthetic" },
      reviewLlm: () =>
        client((prompt) => {
          calls.push(prompt.agent.id);
          return prompt.content.text!.includes("Synthetic cabin") &&
            prompt.agent.id === "editorial_reviews"
            ? selectText(prompt)
            : irrelevant;
        }),
      adapters: new Map([
        [
          "firecrawl",
          {
            id: "firecrawl",
            async collect() {
              return { status: "success", items: [item, unrelated], limitations: [] };
            },
            async test() {
              throw new Error("Not used");
            },
          },
        ],
      ]),
      save: async () => {},
    });
    const data = await collector.collect(
      ResearchRequest.parse({
        agents: ["editorial_reviews", "owner_forums"],
        scope,
        limits: { maxResults: 10, maxRequests: 20 },
      }),
      { runId: "run_assess", signal, log: () => {}, progress: () => {} },
    );
    expect(calls).toEqual([
      "editorial_reviews",
      "editorial_reviews",
      "owner_forums",
      "owner_forums",
    ]);
    expect(data.records).toHaveLength(2);
    expect(data.records.every((record) => sourceAssessments(record).length === 2)).toBe(true);
    expect(data.results.map((result) => result.requests)).toEqual([2, 2]);
    expect(researchTableRows(data).map((row) => row.text)).toEqual([
      "Synthetic cabin storage is useful.",
    ]);
  });

  it("archives a source when review/budget fails, without silently emitting unreviewed content", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.research.provider = "firecrawl";
    settings.research.apis.firecrawl.enabled = true;
    const item = original({ text: "x".repeat(12_001) });
    const call = vi.fn(() => irrelevant);
    const saved: ResearchDataset[] = [];
    const collector = createResearchCollector({
      settings,
      credentials: { firecrawl_api_key: "synthetic" },
      reviewLlm: () => client(call),
      adapters: new Map([
        [
          "firecrawl",
          {
            id: "firecrawl",
            async collect() {
              return { status: "success", items: [item], limitations: [] };
            },
            async test() {
              throw new Error("Not used");
            },
          },
        ],
      ]),
      save: async (data) => {
        saved.push(data);
      },
    });
    const data = await collector.collect(
      ResearchRequest.parse({ agents: ["editorial_reviews"], scope, limits: { maxRequests: 1 } }),
      { runId: "run_assess", signal, log: () => {}, progress: () => {} },
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(data.results[0]!.status).toBe("partial");
    expect(data.records[0]!.text).toBe(item.text);
    expect(sourceAssessments(data.records[0]!)[0]!.verdict).toBe("unreviewed");
    expect(sourceAssessments(data.records[0]!)[0]!.summaries).toEqual([]);
    expect(researchTableRows(data)).toEqual([]);
    expect(saved).toHaveLength(1);
  });

  it("records per-chunk summaries with exact original-global offsets when multiple chunks are relevant", async () => {
    const textChunk1 = "Chunk 1 header.\nSynthetic cabin storage is useful.\nChunk 1 footer.";
    const textChunk2 = "Chunk 2 header.\nSynthetic cabin storage is useful.\nChunk 2 footer.";
    const padding = "x".repeat(12_000 - textChunk1.length);
    const fullText = textChunk1 + padding + textChunk2;
    const item = original({ text: fullText });
    const data = dataset(item);

    const assessment = await assessOriginal(
      item,
      data.records[0]!,
      "editorial_reviews",
      scope,
      client((prompt) => ({
        verdict: "relevant",
        reason: "Applicable product experience.",
        uncertainty: "",
        summary: `Summary for chunk at offset ${prompt.content.text!.includes("Chunk 1") ? 0 : 12_000}.`,
        excerpts: [
          {
            start: prompt.content.text!.indexOf("Synthetic cabin"),
            end:
              prompt.content.text!.indexOf("Synthetic cabin") +
              "Synthetic cabin storage is useful.".length,
            quote: "Synthetic cabin storage is useful.",
          },
        ],
        tableRows: [],
      })),
      signal,
      () => {},
    );

    expect(assessment.verdict).toBe("relevant");
    expect(assessment.summaries).toHaveLength(2);
    expect(assessment.summaries![0]).toEqual({
      text: "Summary for chunk at offset 0.",
      excerpts: [{ start: 16, end: 50 }],
      tableRows: [],
    });
    expect(assessment.summaries![1]).toEqual({
      text: "Summary for chunk at offset 12000.",
      excerpts: [{ start: 12016, end: 12050 }],
      tableRows: [],
    });
  });

  it("preserves backwards compatibility when parsing archived assessment without summaries", () => {
    const legacyAssessment = {
      version: 1,
      agentId: "editorial_reviews",
      contentHash: "hash123",
      scope,
      runId: "run_legacy",
      verdict: "relevant",
      reasons: ["Legacy review"],
      uncertainties: [],
      excerpts: [{ start: 0, end: 10 }],
      tableRows: [],
      model: "legacy-model",
    };

    const parsed = SourceAssessment.parse(legacyAssessment);
    expect(parsed.summaries).toEqual([]);
  });
});
