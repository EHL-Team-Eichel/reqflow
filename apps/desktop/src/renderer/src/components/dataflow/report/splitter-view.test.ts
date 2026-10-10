import {
  connect,
  createBlock,
  traceLineage,
  type SplitterGroup,
  type SplitterReport,
} from "@reqflow/core";
import { fixtureRun } from "@reqflow/core/fixtures";
import { describe, expect, it } from "vitest";
import {
  chartWidth,
  filterSignals,
  formatScore,
  matrixDescription,
  rankedGroups,
  reportForStep,
  reportRevision,
  reportsInLineage,
  splitterBranches,
  splitterReviewGate,
} from "./splitter-view";

export function syntheticReport(blockId = "splitter"): SplitterReport {
  return {
    schemaVersion: 1,
    runId: fixtureRun.id,
    blockId,
    createdAt: fixtureRun.startedAt,
    mode: "customer_priority",
    models: ["synthetic-model"],
    input: {
      primaryLayer: "records",
      primaryCount: 3,
      recordCount: 3,
      sourceCount: 1,
      feedbackUnitCount: 2,
      contextUnitCount: 1,
      duplicateUnitCount: 0,
      customerCount: null,
      countingBasis: "Unique feedback units; not customers.",
    },
    branches: [
      { portId: "out-0", label: "High", primaryItemCount: 2 },
      { portId: "out-1", label: "Low", primaryItemCount: 1 },
    ],
    groups: [],
    assignments: [],
    signals: [],
    sourceMatrix: [],
    scoreMethod: {
      id: "synthetic-method",
      frequencyWeight: 0.7,
      impactWeight: 0.3,
      formula: "0.7 × normalized frequency + 0.3 × impact",
      impactScale: ["Synthetic scale"],
      thresholds: [
        { portId: "out-0", min: 50, max: 100 },
        { portId: "out-1", min: 0, max: 50 },
      ],
    },
    limitations: ["Synthetic feedback, not a population estimate."],
    reviews: [],
  };
}

function group(id: string, score: number | null): SplitterGroup {
  return {
    id,
    label: id,
    description: "Synthetic need",
    outputPortId: "out-0",
    support: 2,
    opposition: 1,
    unclear: 0,
    frequency: 50,
    impact: 60,
    frequencyContribution: 35,
    impactContribution: 18,
    score,
    scoreOrigin: score === null ? "not_computed" : "calculated",
    confidence: 0.8,
    assumptions: [],
  };
}

export function syntheticPausedRun() {
  const splitter = createBlock("ai_splitter", { id: "splitter", position: { x: 0, y: 0 } });
  const hil = createBlock("hil", { id: "review", position: { x: 300, y: 0 } });
  const graph = connect(
    { blocks: [splitter, hil], edges: [] },
    { source: splitter.id, sourcePort: "out-0", target: hil.id, targetPort: "in" },
  );
  return {
    ...fixtureRun,
    graph,
    status: "waiting_for_review" as const,
    blockRuns: [
      {
        blockId: splitter.id,
        status: "succeeded" as const,
        counts: {},
        logs: [],
        splitterReport: syntheticReport(),
      },
      { blockId: hil.id, status: "waiting_for_review" as const, counts: {}, logs: [] },
    ],
  };
}

describe("splitter snapshot presentation", () => {
  it("ranks stored scores, preserves ties, and never treats null as zero", () => {
    const groups = [
      group("unscored", null),
      group("first", 80),
      group("tie", 80),
      group("zero", 0),
    ];
    expect(rankedGroups(groups).map(({ group, rank }) => [group.id, rank])).toEqual([
      ["first", 1],
      ["tie", 1],
      ["zero", 3],
      ["unscored", null],
    ]);
    expect(groups[0]!.id).toBe("unscored");
    expect(formatScore(null)).toBe("Not computed");
    expect(formatScore(0)).toBe("0");
    expect(chartWidth(-10)).toBe(0);
    expect(chartWidth(140)).toBe(100);
    expect(chartWidth(null)).toBe(0);
  });

  it("generates 2–10 requested outputs without a hidden count parameter", () => {
    expect(splitterBranches("customer_priority", 5)).toEqual([
      "Very High",
      "High",
      "Medium",
      "Low",
      "Very Low",
    ]);
    expect(splitterBranches("customer_priority", 2)).toEqual(["High", "Low"]);
    expect(splitterBranches("car_parts", 10)).toHaveLength(10);
    expect(splitterBranches("custom", 3)).toEqual(["Group 1", "Group 2", "Group 3"]);
    for (const count of [1, 11, 2.5, NaN])
      expect(() => splitterBranches("custom", count)).toThrow("2 to 10");
  });

  it("uses only this run's matching report and finds upstream reports from the HIL snapshot", () => {
    const run = syntheticPausedRun();
    const lineage = traceLineage(run.graph, [], "review");
    expect(reportsInLineage(run, lineage).map(({ step }) => step.block.id)).toEqual(["splitter"]);
    expect(reportForStep(run, "splitter")?.mode).toBe("customer_priority");
    expect(reportForStep(null, "splitter")).toBeNull();
    expect(reportForStep({ ...run, id: "run_other" }, "splitter")).toBeNull();
    expect(reportForStep({ ...run, blockRuns: [] }, "splitter")).toBeNull();
    expect(reportsInLineage(run, traceLineage(run.graph, [], "splitter"))[0]!.report.blockId).toBe(
      "splitter",
    );
  });

  it("filters exact signals without deduplicating or replacing them with summed counts", () => {
    const report = syntheticReport();
    const signal = {
      groupId: "need",
      unitId: "unit",
      stance: "support" as const,
      impact: 50,
      confidence: null,
      evidence: {
        sourceId: "src_synthetic",
        recordId: "rec_synthetic",
        excerpt: "Exact synthetic excerpt",
      },
      reason: "Synthetic reason",
    };
    report.signals = [signal, { ...signal, stance: "opposition" }, { ...signal, groupId: "other" }];
    expect(filterSignals(report, { groupId: "need" })).toHaveLength(2);
    expect(
      filterSignals(report, { groupId: "need", stance: "opposition", query: "EXACT" }),
    ).toEqual([report.signals[1]]);
    expect(filterSignals(report, { sourceId: "src_missing" })).toEqual([]);
    expect(report.signals).toHaveLength(3);
  });

  it("shows per-stance counts and actual denominator; never infers population or sums overlapping units", () => {
    const cell = {
      sourceId: "src_synthetic",
      groupId: "need",
      support: 2,
      opposition: 2,
      unclear: 1,
      denominator: 3,
    };
    expect(matrixDescription(cell)).toBe(
      "2 support · 2 opposition · 1 unclear / 3 units in this source",
    );
    expect(matrixDescription({ ...cell, denominator: null })).toContain("denominator not reported");
  });

  it("allows correction only before continuation at an editable upstream HIL gate", () => {
    const run = syntheticPausedRun();
    expect(splitterReviewGate(run, "splitter")?.block.id).toBe("review");
    expect(splitterReviewGate({ ...run, status: "completed" }, "splitter")).toBeNull();
    expect(splitterReviewGate(run, "review")).toBeNull();
    expect(
      splitterReviewGate({ ...run, graph: { ...run.graph, edges: [] } }, "splitter"),
    ).toBeNull();
    run.graph.blocks[1]!.params.allowEdits = false;
    expect(splitterReviewGate(run, "splitter")).toBeNull();
  });

  it("invalidates historical output reads after a persisted routing review", () => {
    const run = syntheticPausedRun();
    const originalRevision = reportRevision(run);
    const corrected = structuredClone(run);
    corrected.blockRuns[0]!.splitterReport!.reviews.push({
      version: 1,
      at: run.startedAt,
      actor: { type: "human", name: "Synthetic PM", userId: "synthetic" },
      rationale: "Synthetic correction",
      changes: [{ itemId: "rec_synthetic", fromPortId: "out-0", toPortId: "out-1" }],
    });
    expect(reportRevision(corrected)).not.toBe(originalRevision);
    expect(reportRevision(run)).toBe(originalRevision);
  });
});
