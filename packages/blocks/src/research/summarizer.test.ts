import { describe, expect, it, vi } from "vitest";
import {
  CollectedItem,
  DEFAULT_SETTINGS,
  ResearchDataset,
  ResearchScope,
  type LlmClient,
  type ProductScope,
} from "@reqflow/core";
import { normalizeItem } from "./raw";
import { ASSESSMENT_FIELD, type SourceAssessment } from "./assessment";
import { researchTableRows, BMW_FEEDBACK_HEADERS } from "./tabular";
import { jsonByteSize } from "./data-budget";
import {
  defaultDerivate,
  defaultSalesDescription,
  offlineSummarizeRecord,
  parallelMap,
  summarizeResearchDataset,
  summarizeResearchRows,
  SummarizedFeedbackItem,
  SourceSummariesResult,
} from "./summarizer";

const at = "2026-10-11T12:00:00.000Z";
const testScope: ProductScope = {
  ...DEFAULT_SETTINGS.defaultScope,
  vehicleLine: "1 Series",
  vehicleCode: "F70",
  market: "EU",
};

const canonicalResearchScope = ResearchScope.parse({
  brand: "BMW",
  model: "1 Series",
  derivative: "F70",
  markets: ["EU"],
  horizonYears: 4,
  questions: ["Steering and seating dynamics"],
});

function createSamplePassageItem(
  id: string,
  text: string,
  extraMetadata: Record<string, unknown> = {},
) {
  return CollectedItem.parse({
    provider: "firecrawl",
    sourceId: `source_${id}`,
    sourceUrl: `https://auto-review.example.org/${id}`,
    sourceTitle: `Review ${id}`,
    publisher: "Auto Review Mag",
    recordId: id,
    recordType: "passage",
    text,
    locator: `section_${id}`,
    metadata: extraMetadata,
  });
}

function createSampleTableItem(id: string) {
  return CollectedItem.parse({
    provider: "firecrawl",
    sourceId: `source_table_${id}`,
    sourceUrl: `https://specs.example.org/${id}`,
    sourceTitle: `Specifications ${id}`,
    publisher: "Tech Specs Inc",
    recordId: id,
    recordType: "table",
    text: "Technical Specifications Table",
    locator: "spec sheet p. 1",
    table: {
      headers: ["Specification", "Value", "Unit"],
      rows: [
        ["Turning Circle", 10.9, "m"],
        ["Boot Volume", 380, "litres"],
        ["Kerb Weight", 1450, "kg"],
      ],
      units: ["m", "litres", "kg"],
      footnotes: [],
    },
    metadata: { equipmentCode: "OPT-2026" },
  });
}

describe("Research Summarizer (Active Deterministic Quality Assessed)", () => {
  it("keeps legacy unassessed datasets returning researchTableRows without modifications", async () => {
    const item1 = createSamplePassageItem("doc_1", "Legacy unassessed text passage.");
    const { source, record } = normalizeItem(item1, "editorial_reviews", "run_test", at);

    const dataset = ResearchDataset.parse({
      schemaVersion: 1,
      runId: "run_test",
      retrievedAt: at,
      sources: [source],
      records: [record],
      results: [],
      synthetic: true,
    });

    const expected = researchTableRows(dataset);
    const syncRows = summarizeResearchRows(dataset);
    expect(syncRows).toEqual(expected);

    const mockLlm: LlmClient = {
      generateObject: vi.fn(),
      generateText: vi.fn(),
    };
    const asyncRows = await summarizeResearchDataset(dataset, {
      llm: mockLlm,
      scope: testScope,
      signal: new AbortController().signal,
    });
    expect(asyncRows).toEqual(expected);
    expect(mockLlm.generateObject).not.toHaveBeenCalled();
    expect(mockLlm.generateText).not.toHaveBeenCalled();
  });

  it("proves NO metadata amplification with 256 KiB HTML/PDF pages (row.metadata <= 8 KiB)", () => {
    // 256 KiB of realistic raw HTML content in metadata
    const heavyHtml = "<div><p>Raw DOM crawl payload...</p></div>".repeat(7000);
    expect(heavyHtml.length).toBeGreaterThanOrEqual(256 * 1024);

    const text = "The M Sport steering is sharp and provides communicative road feedback.";
    const item = createSamplePassageItem("rec_heavy", text, {
      rawHtml: heavyHtml,
      pdfDump: heavyHtml,
      extraTags: ["chassis", "steering"],
    });

    const { source, record } = normalizeItem(item, "editorial_reviews", "run_heavy", at);
    // Notice normalizeItem creates record.fields = { original: item.metadata, table: item.table }
    expect(record.fields?.original).toBeDefined();

    const assessment: SourceAssessment = {
      version: 1,
      agentId: "editorial_reviews",
      contentHash: record.contentHash,
      scope: canonicalResearchScope,
      runId: "run_heavy",
      verdict: "relevant",
      reasons: ["Detailed steering evaluation."],
      uncertainties: [],
      excerpts: [{ start: 0, end: text.length }],
      tableRows: [],
      model: "model-test",
      summaries: [
        {
          text: "M Sport steering offers communicative feedback and precise control.",
          excerpts: [{ start: 0, end: text.length }],
          tableRows: [],
        },
      ],
    };
    record.fields = { ...record.fields, [ASSESSMENT_FIELD]: [assessment] };

    const dataset = ResearchDataset.parse({
      schemaVersion: 1,
      runId: "run_heavy",
      retrievedAt: at,
      sources: [source],
      records: [record],
      results: [],
      synthetic: true,
    });

    const rows = summarizeResearchRows(dataset);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // 1. row.fields must NOT contain record.fields.original
    expect(row.fields!["original"]).toBeUndefined();
    expect(row.fields!["table"]).toBeUndefined();
    expect(row.fields![ASSESSMENT_FIELD]).toBeUndefined();

    // 2. row.metadata MUST stay <= 8192 bytes total
    const metaBytes = jsonByteSize(row.metadata);
    expect(metaBytes).toBeLessThanOrEqual(8192);

    // 3. rawHtml and pdfDump were archived, not copied into row.metadata
    expect(row.metadata["rawHtml"]).toBeUndefined();
    expect(row.metadata["pdfDump"]).toBeUndefined();
    expect(row.archivedMetadataKeys).toContain("rawHtml");
    expect(row.archivedMetadataKeys).toContain("pdfDump");

    // 4. textOrigin 'ai_summary' is placed in metadata
    expect(row.metadata.textOrigin).toBe("ai_summary");

    // 5. top summaryEvidence and flat 'Original Evidence' provide linkage without duplicate metadata
    expect(row.metadata["originalFields"]).toBeUndefined();
    expect(row.metadata["summaryEvidence"]).toBeUndefined();
    expect(row.fields!["Original Evidence"]).toBe(text);
    expect((row as unknown as { summaryEvidence: unknown }).summaryEvidence).toBeDefined();
  });

  it("retains exact sourceAssociation grouping and avoids synthesizing VFC when already arrays", () => {
    const text = "Customer discussion regarding ride comfort and optional adaptive dampers.";
    const item = createSamplePassageItem("rec_assoc", text, {
      sourceAssociations: [
        {
          sheet: "Feedback",
          row: 10,
          headers: ["Vfc level2 Name", "Vfc level3 Name", "CustomTag"],
          values: ["Seats", "Likes comfort", "TagA"],
        },
        {
          sheet: "Feedback",
          row: 11,
          headers: ["Vfc level2 Name", "Vfc level3 Name", "CustomTag"],
          values: ["Handling / Riding", "Like: performance", "TagB"],
        },
      ],
    });

    const { source, record } = normalizeItem(item, "owner_forums", "run_assoc", at);

    const assessment: SourceAssessment = {
      version: 1,
      agentId: "owner_forums",
      contentHash: record.contentHash,
      scope: canonicalResearchScope,
      runId: "run_assoc",
      verdict: "relevant",
      reasons: ["Owner feedback on seating and ride."],
      uncertainties: [],
      excerpts: [{ start: 0, end: text.length }],
      tableRows: [],
      model: "model-test",
      summaries: [
        {
          text: "Owners appreciate both seating comfort and dynamic handling balance.",
          excerpts: [{ start: 0, end: text.length }],
          tableRows: [],
        },
      ],
    };
    record.fields = { ...record.fields, [ASSESSMENT_FIELD]: [assessment] };

    const dataset = ResearchDataset.parse({
      schemaVersion: 1,
      runId: "run_assoc",
      retrievedAt: at,
      sources: [source],
      records: [record],
      results: [],
      synthetic: true,
    });

    const rows = summarizeResearchRows(dataset);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // Source association fields are grouped as arrays where multiple distinct values exist
    expect(row.fields!["Vfc level2 Name"]).toEqual(["Seats", "Handling / Riding"]);
    expect(row.fields!["Vfc level3 Name"]).toEqual(["Likes comfort", "Like: performance"]);
    expect(row.fields!["CustomTag"]).toEqual(["TagA", "TagB"]);

    // Does NOT synthesize VFC full string when values are arrays
    expect(row.fields!["Vfc level2 3 Name"]).toBeNull();
  });

  it("summarizes table records into ONE passage row preserving only reviewed table rows in evidence", () => {
    const item = createSampleTableItem("table_rec_1");
    const { source, record } = normalizeItem(item, "competitor_models", "run_test_tbl", at);

    // Assessment approves row index 0 ("Turning Circle") and row index 1 ("Boot Volume")
    const assessment: SourceAssessment = {
      version: 1,
      agentId: "competitor_models",
      contentHash: record.contentHash,
      scope: canonicalResearchScope,
      runId: "run_test_tbl",
      verdict: "relevant",
      reasons: ["Key dimensions and luggage capacity."],
      uncertainties: [],
      excerpts: [],
      tableRows: [0, 1],
      model: "test-model",
      summaries: [
        {
          text: "Turning circle is 10.9m and boot volume is 380 litres.",
          excerpts: [],
          tableRows: [0, 1],
        },
      ],
    };
    record.fields = { ...record.fields, [ASSESSMENT_FIELD]: [assessment] };

    const dataset = ResearchDataset.parse({
      schemaVersion: 1,
      runId: "run_test_tbl",
      retrievedAt: at,
      sources: [source],
      records: [record],
      results: [],
      synthetic: true,
    });

    const rows = summarizeResearchRows(dataset);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // AI summary row has recordType 'passage' (derived prose, not table)
    expect(row.recordType).toBe("passage");
    expect(row.metadata.textOrigin).toBe("ai_summary");
    expect(row.text).toBe("Turning circle is 10.9m and boot volume is 380 litres.");
    expect(row.fields!["Customer Feedback"]).toBe(row.text);

    // Table rows preserved on row contain only selected indices (0 and 1, NOT unreviewed row 2)
    expect(row.table).toBeDefined();
    expect(row.table!.rows).toHaveLength(2);
    expect(row.table!.rows[0]).toEqual(["Turning Circle", 10.9, "m"]);
    expect(row.table!.rows[1]).toEqual(["Boot Volume", 380, "litres"]);

    // Evidence fields
    expect(row.fields!["Original Evidence"]).toContain(
      "Specification: Turning Circle; Value: 10.9; Unit: m",
    );
    expect(row.fields!["Original Evidence"]).toContain(
      "Specification: Boot Volume; Value: 380; Unit: litres",
    );
    expect(row.fields!["Original Evidence"]).not.toContain("Kerb Weight");

    // Locator includes table row indices
    expect(row.locator).toContain("table row 1");
    expect(row.locator).toContain("table row 2");
    expect(row.locator).not.toContain("table row 3");
  });

  it("leaves unknown BMW attributes empty (null) without fake default inference", () => {
    const text = "General market observation on electric vehicle range in cold weather.";
    const item = createSamplePassageItem("rec_unknown_attrs", text);
    const { source, record } = normalizeItem(item, "market_studies", "run_unknown", at);

    const assessment: SourceAssessment = {
      version: 1,
      agentId: "market_studies",
      contentHash: record.contentHash,
      scope: canonicalResearchScope,
      runId: "run_unknown",
      verdict: "relevant",
      reasons: ["Cold weather efficiency."],
      uncertainties: [],
      excerpts: [{ start: 0, end: text.length }],
      tableRows: [],
      model: "test-model",
      summaries: [
        {
          text: "Cold weather conditions reduce battery efficiency by up to 20%.",
          excerpts: [{ start: 0, end: text.length }],
          tableRows: [],
        },
      ],
    };
    record.fields = { ...record.fields, [ASSESSMENT_FIELD]: [assessment] };

    const dataset = ResearchDataset.parse({
      schemaVersion: 1,
      runId: "run_unknown",
      retrievedAt: at,
      sources: [source],
      records: [record],
      results: [],
      synthetic: true,
    });

    const rows = summarizeResearchRows(dataset);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // Unknown attributes must NOT be defaulted to [BMW], F70, ICE, Likes, VFC, etc.
    expect(row.fields!["Brand"]).toBeNull();
    expect(row.fields!["Sales Description"]).toBeNull();
    expect(row.fields!["Derivate (e-code)"]).toBeNull();
    expect(row.fields!["Engine Type"]).toBeNull();
    expect(row.fields!["Feedback Type"]).toBeNull();
    expect(row.fields!["Vfc level2 Name"]).toBeNull();
    expect(row.fields!["Vfc level3 Name"]).toBeNull();
    expect(row.fields!["Vfc level2 3 Name"]).toBeNull();

    // Source and ID are populated from record/source
    expect(row.fields!["ID"]).toBe(record.id);
    expect(row.fields!["Source"]).toBe(source.publisher);
  });

  it("rejects irrelevant tail citations (throws on spans outside approved assessment excerpts)", () => {
    const text = "Approved relevant text. Irrelevant trailing advertisement and cookies.";
    const item = createSamplePassageItem("rec_tail_span", text);
    const { source, record } = normalizeItem(item, "editorial_reviews", "run_tail", at);

    // Assessment approves ONLY chars 0..23 ("Approved relevant text.")
    const assessment: SourceAssessment = {
      version: 1,
      agentId: "editorial_reviews",
      contentHash: record.contentHash,
      scope: canonicalResearchScope,
      runId: "run_tail",
      verdict: "relevant",
      reasons: ["Only first sentence is relevant."],
      uncertainties: [],
      excerpts: [{ start: 0, end: 23 }],
      tableRows: [],
      model: "model-test",
      summaries: [
        {
          // Cites unapproved tail extending to char 40
          text: "Summary claiming unapproved tail is valid.",
          excerpts: [{ start: 10, end: 40 }],
          tableRows: [],
        },
      ],
    };
    record.fields = { ...record.fields, [ASSESSMENT_FIELD]: [assessment] };

    const dataset = ResearchDataset.parse({
      schemaVersion: 1,
      runId: "run_tail",
      retrievedAt: at,
      sources: [source],
      records: [record],
      results: [],
      synthetic: true,
    });

    // Must fail clearly and throw an error, never silently drop the unapproved tail
    expect(() => summarizeResearchRows(dataset)).toThrow(
      /not entirely within positively assessed excerpts/i,
    );
  });

  it("rejects irrelevant tail citations (throws on table rows outside approved assessment table rows)", () => {
    const item = createSampleTableItem("rec_tail_row");
    const { source, record } = normalizeItem(item, "competitor_models", "run_tail_tbl", at);

    // Assessment approves ONLY row 0 ("Turning Circle")
    const assessment: SourceAssessment = {
      version: 1,
      agentId: "competitor_models",
      contentHash: record.contentHash,
      scope: canonicalResearchScope,
      runId: "run_tail_tbl",
      verdict: "relevant",
      reasons: ["Only row 0 is relevant."],
      uncertainties: [],
      excerpts: [],
      tableRows: [0],
      model: "model-test",
      summaries: [
        {
          // Cites unapproved row 1 (Kerb weight/Boot volume)
          text: "Summary claiming turning circle and boot volume.",
          excerpts: [],
          tableRows: [0, 1],
        },
      ],
    };
    record.fields = { ...record.fields, [ASSESSMENT_FIELD]: [assessment] };

    const dataset = ResearchDataset.parse({
      schemaVersion: 1,
      runId: "run_tail_tbl",
      retrievedAt: at,
      sources: [source],
      records: [record],
      results: [],
      synthetic: true,
    });

    // Must fail clearly and throw an error on unapproved table row index
    expect(() => summarizeResearchRows(dataset)).toThrow(
      /unapproved table row 1 not in assessment/i,
    );
  });

  it("throws clear error on malformed canonical assessments or mismatched citation record types", () => {
    const text = "Valid text content.";
    const item = createSamplePassageItem("rec_malformed", text);
    const { source, record } = normalizeItem(item, "editorial_reviews", "run_malformed", at);

    // 1. Invalid agentId (not in canonical enum) throws schema validation error
    record.fields = {
      ...record.fields,
      [ASSESSMENT_FIELD]: [
        {
          version: 1,
          agentId: "invalid_fabricated_agent", // invalid enum
          contentHash: record.contentHash,
          scope: canonicalResearchScope,
          runId: "run_malformed",
          verdict: "relevant",
          reasons: ["Test"],
          uncertainties: [],
          excerpts: [{ start: 0, end: 10 }],
          tableRows: [],
          model: "model-test",
          summaries: [],
        },
      ],
    };

    const dataset = ResearchDataset.parse({
      schemaVersion: 1,
      runId: "run_malformed",
      retrievedAt: at,
      sources: [source],
      records: [record],
      results: [],
      synthetic: true,
    });

    expect(() => summarizeResearchRows(dataset)).toThrow();

    // 2. Text record with summary citing tableRows throws clear error
    const validAssessmentMismatch: SourceAssessment = {
      version: 1,
      agentId: "editorial_reviews",
      contentHash: record.contentHash,
      scope: canonicalResearchScope,
      runId: "run_malformed",
      verdict: "relevant",
      reasons: ["Test"],
      uncertainties: [],
      excerpts: [{ start: 0, end: 10 }],
      tableRows: [],
      model: "model-test",
      summaries: [
        {
          text: "Text record but cites tableRows",
          excerpts: [],
          tableRows: [0], // invalid on text record
        },
      ],
    };
    record.fields = { ...record.fields, [ASSESSMENT_FIELD]: [validAssessmentMismatch] };
    const datasetMismatch = ResearchDataset.parse({
      schemaVersion: 1,
      runId: "run_malformed",
      retrievedAt: at,
      sources: [source],
      records: [record],
      results: [],
      synthetic: true,
    });
    expect(() => summarizeResearchRows(datasetMismatch)).toThrow(
      /text summary.*cannot cite table rows/i,
    );
  });

  it("omits older canonical assessments with summaries: [] (no fallback)", () => {
    const text = "Relevant feedback without summaries generated.";
    const item = createSamplePassageItem("rec_no_summaries", text);
    const { source, record } = normalizeItem(item, "editorial_reviews", "run_test", at);

    const assessment: SourceAssessment = {
      version: 1,
      agentId: "editorial_reviews",
      contentHash: record.contentHash,
      scope: canonicalResearchScope,
      runId: "run_test",
      verdict: "relevant",
      reasons: ["Relevant but older run without summaries."],
      uncertainties: [],
      excerpts: [{ start: 0, end: text.length }],
      tableRows: [],
      model: "test-model",
      summaries: [], // empty summaries
    };
    record.fields = { ...record.fields, [ASSESSMENT_FIELD]: [assessment] };

    const dataset = ResearchDataset.parse({
      schemaVersion: 1,
      runId: "run_test",
      retrievedAt: at,
      sources: [source],
      records: [record],
      results: [],
      synthetic: true,
    });

    const rows = summarizeResearchRows(dataset);
    expect(rows).toHaveLength(0);
  });

  it("omits records when assessment contentHash mismatches", () => {
    const text = "Content hash mismatch check.";
    const item = createSamplePassageItem("rec_mismatch", text);
    const { source, record } = normalizeItem(item, "editorial_reviews", "run_test", at);

    const assessment: SourceAssessment = {
      version: 1,
      agentId: "editorial_reviews",
      contentHash: "outdated_content_hash",
      scope: canonicalResearchScope,
      runId: "run_test",
      verdict: "relevant",
      reasons: ["Mismatched hash"],
      uncertainties: [],
      excerpts: [{ start: 0, end: text.length }],
      tableRows: [],
      model: "test-model",
      summaries: [
        {
          text: "Summary with stale hash.",
          excerpts: [{ start: 0, end: text.length }],
          tableRows: [],
        },
      ],
    };
    record.fields = { ...record.fields, [ASSESSMENT_FIELD]: [assessment] };

    const dataset = ResearchDataset.parse({
      schemaVersion: 1,
      runId: "run_test",
      retrievedAt: at,
      sources: [source],
      records: [record],
      results: [],
      synthetic: true,
    });

    const rows = summarizeResearchRows(dataset);
    expect(rows).toHaveLength(0);
  });

  it("dedupes identical summary text+evidence across agents and joins distinct summaries into ONE row", () => {
    const text = "Verbatim road test text with chassis evaluation and infotainment notes.";
    const item = createSamplePassageItem("rec_multi_agent", text);
    const { source, record } = normalizeItem(item, "editorial_reviews", "run_test", at);

    // Agent 1: chassis summary + infotainment summary
    const assessmentAgent1: SourceAssessment = {
      version: 1,
      agentId: "editorial_reviews",
      contentHash: record.contentHash,
      scope: canonicalResearchScope,
      runId: "run_test",
      verdict: "relevant",
      reasons: ["Editorial road test evaluation."],
      uncertainties: [],
      excerpts: [
        { start: 0, end: 40 },
        { start: 40, end: text.length },
      ],
      tableRows: [],
      model: "model-1",
      summaries: [
        {
          text: "Chassis feedback: suspension calibration is well-balanced.",
          excerpts: [{ start: 0, end: 40 }],
          tableRows: [],
        },
        {
          text: "Infotainment: OS9 touchscreen is fast and responsive.",
          excerpts: [{ start: 40, end: text.length }],
          tableRows: [],
        },
      ],
    };

    // Agent 2: duplicate of chassis summary
    const assessmentAgent2: SourceAssessment = {
      version: 1,
      agentId: "owner_forums",
      contentHash: record.contentHash,
      scope: canonicalResearchScope,
      runId: "run_test",
      verdict: "relevant",
      reasons: ["Owner forum consensus."],
      uncertainties: [],
      excerpts: [{ start: 0, end: 40 }],
      tableRows: [],
      model: "model-2",
      summaries: [
        {
          text: "Chassis feedback: suspension calibration is well-balanced.",
          excerpts: [{ start: 0, end: 40 }],
          tableRows: [],
        },
      ],
    };

    record.fields = {
      ...record.fields,
      [ASSESSMENT_FIELD]: [assessmentAgent1, assessmentAgent2],
    };

    const dataset = ResearchDataset.parse({
      schemaVersion: 1,
      runId: "run_test",
      retrievedAt: at,
      sources: [source],
      records: [record],
      results: [],
      synthetic: true,
    });

    const rows = summarizeResearchRows(dataset);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(row.text).toBe(
      "Chassis feedback: suspension calibration is well-balanced.\n\n" +
        "Infotainment: OS9 touchscreen is fast and responsive.",
    );
    expect(row.fields!["Customer Feedback"]).toBe(row.text);
    expect(row.sourceAssessments).toEqual([
      { agentId: "editorial_reviews", verdict: "relevant", model: "model-1" },
      { agentId: "owner_forums", verdict: "relevant", model: "model-2" },
    ]);
  });

  it("does not mutate the input dataset", () => {
    const text = "Dataset immutability test.";
    const item = createSamplePassageItem("rec_immutable", text);
    const { source, record } = normalizeItem(item, "editorial_reviews", "run_test", at);

    const assessment: SourceAssessment = {
      version: 1,
      agentId: "editorial_reviews",
      contentHash: record.contentHash,
      scope: canonicalResearchScope,
      runId: "run_test",
      verdict: "relevant",
      reasons: ["Test immutability"],
      uncertainties: [],
      excerpts: [{ start: 0, end: text.length }],
      tableRows: [],
      model: "model-test",
      summaries: [
        {
          text: "Immutability verified summary.",
          excerpts: [{ start: 0, end: text.length }],
          tableRows: [],
        },
      ],
    };
    record.fields = { ...record.fields, [ASSESSMENT_FIELD]: [assessment] };

    const dataset = ResearchDataset.parse({
      schemaVersion: 1,
      runId: "run_test",
      retrievedAt: at,
      sources: [source],
      records: [record],
      results: [],
      synthetic: true,
    });

    const datasetSnapshot = JSON.parse(JSON.stringify(dataset));
    summarizeResearchRows(dataset);
    expect(JSON.parse(JSON.stringify(dataset))).toEqual(datasetSnapshot);
  });

  it("exports utility helpers for external compatibility", async () => {
    expect(defaultDerivate("1 Series")).toBe("F70");
    expect(defaultDerivate("5 Series")).toBe("G60");
    expect(defaultDerivate("7 Series")).toBe("G70");
    expect(defaultSalesDescription("1 Series")).toBe("[BMW 1 Series]");
    expect(defaultSalesDescription("5 Series")).toBe("[BMW 5 Series]");
    expect(defaultSalesDescription("7 Series")).toBe("[BMW 7 Series]");

    const item = createSamplePassageItem("util_doc", "Test defect in touchscreen");
    const { source, record } = normalizeItem(item, "editorial_reviews", "run_test", at);
    const offlineItem = offlineSummarizeRecord(record, source, testScope);
    expect(offlineItem.brand).toBe("[BMW]");
    expect(offlineItem.feedbackType).toBe("Defect");

    const mapped = await parallelMap(
      [1, 2, 3],
      2,
      async (n) => n * 2,
      new AbortController().signal,
    );
    expect(mapped).toEqual([2, 4, 6]);

    expect(BMW_FEEDBACK_HEADERS).toHaveLength(12);
    expect(SummarizedFeedbackItem).toBeDefined();
    expect(SourceSummariesResult).toBeDefined();
  });
});
