import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyPipelineData, type SplitterGroup } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { EvidenceBalance, ScoreBreakdown, SourceHeatmap } from "./SplitterCharts";
import { SplitterEvidence } from "./SplitterEvidence";

const group: SplitterGroup = {
  id: "need",
  label: "Synthetic comfort",
  description: "Synthetic need",
  outputPortId: "out-0",
  support: 2,
  opposition: 2,
  unclear: 1,
  frequency: 80,
  impact: 60,
  frequencyContribution: 56,
  impactContribution: 18,
  score: 74,
  scoreOrigin: "calculated",
  confidence: 0.7,
  assumptions: [],
};

describe("accessible splitter graphics and exact evidence", () => {
  it("renders stored contributions rather than rebuilding a score from weights", () => {
    const html = renderToStaticMarkup(
      createElement(ScoreBreakdown, { group: { ...group, score: 91 } }),
    );
    expect(html).toContain("Frequency contribution: 56; impact contribution: 18; total score: 91");
    expect(html).toContain("width:56%");
    expect(html).toContain("width:18%");
    expect(html).toContain('role="img"');
    const unscored = renderToStaticMarkup(
      createElement(ScoreBreakdown, {
        group: { ...group, score: null, frequencyContribution: null, impactContribution: null },
      }),
    );
    expect(unscored).toContain("total score: Not computed");
    expect(unscored).not.toContain("total score: 0");
  });

  it("keeps overlapping stance counts separate and labels them accessibly", () => {
    const html = renderToStaticMarkup(createElement(EvidenceBalance, { group }));
    expect(html).toContain("2 support, 2 opposition, 1 unclear");
    expect(html).toContain("Stance counts may overlap; not customers");
    expect(html).not.toContain("5 feedback");
  });

  it("renders denominator from the report and missing cells as unreported, not zero", () => {
    const report = {
      groups: [group, { ...group, id: "missing", label: "Missing need" }],
      sourceMatrix: [
        {
          sourceId: "src_synthetic",
          groupId: "need",
          support: 2,
          opposition: 2,
          unclear: 1,
          denominator: 3,
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(SourceHeatmap, { report, data: null, onSelect: () => {} }),
    );
    expect(html).toContain("/ 3 units in this source");
    expect(html).toContain("Not reported");
    expect(html).not.toContain("67%");
    expect(html).toContain("not customers or population");
  });

  it("shows verbatim excerpts, original record fields and saved URI without refreshing sources", () => {
    const data = emptyPipelineData();
    data.sources.push({
      id: "src_synthetic",
      kind: "customer_feedback",
      origin: "bmw_internal",
      title: "Synthetic survey",
      uri: "file_synthetic",
      retrievedAt: "2026-01-01T00:00:00Z",
      reliability: "medium",
    });
    data.records.push({
      id: "rec_synthetic",
      sourceId: "src_synthetic",
      text: "Original text: exact synthetic statement.",
      locator: "row 7",
      fields: { OriginalColumn: "Unchanged synthetic value", Nested: { count: 2 } },
    });
    const html = renderToStaticMarkup(
      createElement(SplitterEvidence, {
        data,
        loading: false,
        error: null,
        evidence: {
          sourceId: "src_synthetic",
          recordId: "rec_synthetic",
          excerpt: "exact synthetic statement",
          locator: "row 7, column Feedback",
        },
      }),
    );
    expect(html).toContain("exact synthetic statement");
    expect(html).toContain("Original text: exact synthetic statement.");
    expect(html).toContain("Unchanged synthetic value");
    expect(html).toContain("file_synthetic");
    expect(html).toContain("row 7, column Feedback");
    expect(html).not.toContain("href=");
  });

  it("keeps saved excerpts visible when original data cannot load, without fabricated provenance", () => {
    const html = renderToStaticMarkup(
      createElement(SplitterEvidence, {
        data: null,
        loading: false,
        error: "Saved outputs unavailable",
        evidence: {
          sourceId: "src_synthetic",
          recordId: "rec_synthetic",
          excerpt: "Exact stored excerpt",
        },
      }),
    );
    expect(html).toContain("Exact stored excerpt");
    expect(html).toContain("Saved outputs unavailable");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Source URI</dt>");
  });
});
