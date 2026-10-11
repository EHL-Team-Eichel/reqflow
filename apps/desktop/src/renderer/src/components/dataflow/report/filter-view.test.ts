import {
  FilterReport,
  WorkflowRun,
  emptyPipelineData,
  type FilterReviewState,
} from "@reqflow/core";
import { describe, expect, it, vi } from "vitest";
import {
  filterDisposition,
  filterPage,
  filterProvenance,
  filterRestoreGuard,
  filterRestoreRequest,
  filterRows,
  pendingFilterOverride,
  safeFilterJson,
  saveFilterRestore,
  settleFilterRequest,
} from "./filter-view";

function syntheticReport() {
  return FilterReport.parse({
    schemaVersion: 1,
    runId: "run_filter_test",
    blockId: "filter",
    createdAt: "2026-10-11T12:00:00Z",
    primaryLayer: "records",
    configurationHash: "a".repeat(64),
    configuration: {
      criterion: "Keep synthetic seat feedback",
      include: "Comfort",
      exclude: "Unrelated",
      examples: "Guidance only",
      fields: ["text"],
      model: "fast",
      minConfidence: 0.7,
      keepUnsure: true,
    },
    originalInput: {
      ...emptyPipelineData(),
      extraEnvelope: { synthetic: true },
      sources: [
        {
          id: "src_test",
          kind: "customer_feedback",
          origin: "bmw_internal",
          title: "Synthetic source",
          retrievedAt: "2026-10-11T12:00:00Z",
          uri: "file_synthetic",
        },
      ],
      records: Array.from({ length: 44 }, (_, index) => ({
        id: `rec_${index}`,
        sourceId: "src_test",
        text: `Synthetic seat feedback ${index}`,
        locator: `row ${index}`,
        fields: { Custom: `Structured ${index}` },
        extraProvenance: "preserved",
      })),
    },
    decisions: Array.from({ length: 44 }, (_, index) => ({
      itemId: `rec_${index}`,
      itemHash: "b".repeat(64),
      modelDecision: index < 40 ? "keep" : "exclude",
      outcome: index < 40 ? "keep" : index === 40 ? "exclude" : "review",
      confidence: 0.5,
      reason: "Synthetic reason",
      quotes: [{ recordId: `rec_${index}`, excerpt: `Synthetic seat feedback ${index}` }],
      model: "synthetic-model",
      forwarded: index < 40 || index === 42,
      retainedAsContext: index === 41,
    })),
    warnings: ["Missing requested synthetic field"],
  });
}

function syntheticRun(report = syntheticReport()) {
  return WorkflowRun.parse({
    id: report.runId,
    workflowId: "wf_filter_test",
    workflowVersion: 1,
    graph: { blocks: [], edges: [] },
    scope: { vehicleLine: "Synthetic", vehicleCode: "TEST", market: "EU", horizonYears: 4 },
    status: "completed",
    startedBy: { type: "human", userId: "tester", name: "Synthetic tester" },
    startedAt: report.createdAt,
    blockRuns: [
      { blockId: report.blockId, status: "succeeded", counts: {}, logs: [], filterReport: report },
    ],
  });
}

describe("saved AI Filter presentation", () => {
  it("resolves saved theme evidence and locations through linked findings", () => {
    const report = syntheticReport();
    report.originalInput.findings = [
      {
        id: "fnd_synthetic",
        kind: "complaint",
        statement: "Synthetic seat concern",
        category: "comfort",
        evidence: [
          {
            sourceId: "src_test",
            recordId: "rec_0",
            locator: "row 0",
            excerpt: "Synthetic seat feedback 0",
          },
        ],
        mentions: 1,
        markets: ["EU"],
        confidence: 0.5,
        inScope: true,
      },
    ];
    const theme = {
      id: "thm_synthetic",
      label: "Synthetic comfort",
      summary: "Synthetic theme",
      category: "comfort" as const,
      findingIds: ["fnd_synthetic"],
    };
    report.originalInput.themes = [theme];
    report.primaryLayer = "themes";
    report.decisions = [{ ...report.decisions[0]!, itemId: theme.id }];
    const row = filterRows(report)[0]!;
    expect(row.original).toEqual(theme);
    expect(filterProvenance(report, row.original)).toMatchObject({
      sources: [{ id: "src_test" }],
      records: [{ id: "rec_0", locator: "row 0" }],
      findings: [{ id: "fnd_synthetic" }],
      evidence: [{ excerpt: "Synthetic seat feedback 0" }],
    });
    expect(filterProvenance(report, undefined)).toBeNull();
  });
  it("uses final outcomes for tabs, preserving separate model and context dispositions", () => {
    const report = syntheticReport();
    const rows = filterRows(report);
    expect(filterPage(rows, "keep", "", 0).counts).toEqual({ keep: 40, exclude: 1, review: 3 });
    expect(filterPage(rows, "review", "", 0).rows.map((row) => row.decision.itemId)).toEqual([
      "rec_41",
      "rec_42",
      "rec_43",
    ]);
    expect(report.decisions[41]!.modelDecision).toBe("exclude");
    expect(filterDisposition(report.decisions[41]!)).toBe(
      "Held / not forwarded; retained as supporting context",
    );
    expect(filterDisposition(report.decisions[42]!)).toBe("Forwarded; not retained as context");
  });
  it("searches originals, extra fields, exact quotes, reasons, models and location; bounds pages", () => {
    const report = syntheticReport();
    const rows = filterRows(report);
    for (const query of ["Structured 40", "row 40", "Synthetic seat feedback 40"])
      expect(filterPage(rows, "exclude", query, 99).total).toBe(1);
    expect(filterPage(rows, "keep", "SYNTHETIC-MODEL", -5).rows).toHaveLength(20);
    expect(filterPage(rows, "keep", "", 99).page).toBe(1);
    expect(filterPage(rows, "keep", "nothing matches", 99).rows).toEqual([]);
    expect(filterPage(rows, "keep", "", 1).rows[0]!.decision.itemId).toBe("rec_20");
    expect(safeFilterJson(rows[0]!.original)).toContain("extraProvenance");
    expect(report.originalInput.extraEnvelope).toEqual({ synthetic: true });
    expect(safeFilterJson({ text: "<script>synthetic</script>" })).toContain("<script>");
  });
});

describe("next-run restore guards", () => {
  it("requires excluded or held review, valid run status, rationale and current version", () => {
    const report = syntheticReport();
    const run = syntheticRun(report);
    const state = { version: 7, overrides: [] };
    const excluded = report.decisions[40]!;
    const held = report.decisions[41]!;
    expect(filterRestoreRequest(run, report, excluded, state, "  Human rationale  ")).toEqual({
      expectedVersion: 7,
      itemIds: [excluded.itemId],
      rationale: "Human rationale",
    });
    expect(filterRestoreGuard(run, report, held, state)).toBeNull();
    expect(
      filterRestoreGuard({ ...run, status: "waiting_for_review" }, report, held, state),
    ).toBeNull();
    for (const status of ["queued", "running", "failed", "cancelled"] as const)
      expect(filterRestoreGuard({ ...run, status }, report, excluded, state)).not.toBeNull();
    for (const item of [report.decisions[0]!, report.decisions[42]!])
      expect(filterRestoreGuard(run, report, item, state)).not.toBeNull();
    expect(() => filterRestoreRequest(run, report, excluded, state, "  ")).toThrow();
    expect(() => filterRestoreRequest(run, report, excluded, state, "x".repeat(2001))).toThrow();
    expect(() =>
      filterRestoreRequest(run, report, excluded, { ...state, version: -1 }, "Reason"),
    ).toThrow();
    expect(filterRestoreGuard(run, report, excluded, null)).not.toBeNull();
    expect(filterRestoreGuard({ ...run, id: "run_other" }, report, excluded, state)).not.toBeNull();
  });
  it("marks only overrides with matching item and configuration fingerprints", () => {
    const report = syntheticReport();
    const item = report.decisions[40]!;
    const override = {
      itemId: item.itemId,
      itemHash: item.itemHash,
      configurationHash: report.configurationHash,
      actor: { type: "human" as const, userId: "tester", name: "Tester" },
      at: report.createdAt,
      rationale: "Synthetic human reason",
      version: 2,
    };
    expect(pendingFilterOverride(report, item, { version: 2, overrides: [override] })).toEqual(
      override,
    );
    for (const mismatch of [
      { itemHash: "c".repeat(64) },
      { configurationHash: "c".repeat(64) },
      { itemId: "rec_other" },
    ])
      expect(
        pendingFilterOverride(report, item, {
          version: 2,
          overrides: [{ ...override, ...mismatch }],
        }),
      ).toBeUndefined();
    expect(
      filterRestoreGuard(syntheticRun(report), report, item, { version: 2, overrides: [override] }),
    ).toContain("already pending");
  });
});

describe("pending state async boundaries", () => {
  it("saves then reads only pending state without mutating historical report", async () => {
    const report = syntheticReport();
    const before = structuredClone(report);
    const override = {
      itemId: "rec_40",
      itemHash: report.decisions[40]!.itemHash,
      configurationHash: report.configurationHash,
      actor: { type: "human" as const, userId: "tester", name: "Synthetic tester" },
      at: report.createdAt,
      rationale: "Synthetic reason",
      version: 1,
    };
    const api = {
      reviewFilter: vi.fn().mockResolvedValue({ version: 1, overrides: [override] }),
      filterReviewState: vi.fn().mockResolvedValue({ version: 2, overrides: [override] }),
    };
    const input = filterRestoreRequest(
      syntheticRun(report),
      report,
      report.decisions[40]!,
      { version: 0, overrides: [] },
      "Synthetic reason",
    );
    const refreshed = vi.fn();
    expect(await saveFilterRestore(api, report, input, refreshed)).toEqual({
      version: 2,
      overrides: [override],
    });
    expect(api.reviewFilter).toHaveBeenCalledExactlyOnceWith(report.runId, report.blockId, input);
    expect(api.filterReviewState).toHaveBeenCalledExactlyOnceWith(report.runId, report.blockId);
    expect(refreshed).not.toHaveBeenCalled();
    expect(report).toEqual(before);
  });
  it("does not claim a restore when the read-back lacks its matching fingerprint", async () => {
    const report = syntheticReport();
    const api = {
      reviewFilter: vi.fn().mockResolvedValue({ version: 1, overrides: [] }),
      filterReviewState: vi.fn().mockResolvedValue({ version: 1, overrides: [] }),
    };
    await expect(
      saveFilterRestore(
        api,
        report,
        { expectedVersion: 0, itemIds: ["rec_40"], rationale: "Reason" },
        vi.fn(),
      ),
    ).rejects.toThrow("did not confirm a matching persisted restore");
    expect(api.reviewFilter).toHaveBeenCalledTimes(1);
  });
  it("refreshes conflict versions and requires explicit retry, never repeats a write", async () => {
    const report = syntheticReport();
    const api = {
      reviewFilter: vi.fn().mockRejectedValue(new Error("Version conflict")),
      filterReviewState: vi.fn().mockResolvedValue({ version: 3, overrides: [] }),
    };
    const refreshed = vi.fn();
    await expect(
      saveFilterRestore(
        api,
        report,
        { expectedVersion: 1, itemIds: ["rec_40"], rationale: "Reason" },
        refreshed,
      ),
    ).rejects.toThrow("explicitly retry");
    expect(api.reviewFilter).toHaveBeenCalledTimes(1);
    expect(refreshed).toHaveBeenCalledWith({ version: 3, overrides: [] });
    api.filterReviewState.mockRejectedValue(new Error("Read failed"));
    await expect(
      saveFilterRestore(
        api,
        report,
        { expectedVersion: 1, itemIds: ["rec_40"], rationale: "Reason" },
        refreshed,
      ),
    ).rejects.toThrow("refresh also failed");
    expect(refreshed).toHaveBeenLastCalledWith(null);
  });
  it("ignores stale successes and stale errors after run/block changes", async () => {
    let current = true;
    let resolve!: (state: FilterReviewState) => void;
    const success = vi.fn();
    const failure = vi.fn();
    const request = settleFilterRequest(
      () =>
        new Promise<FilterReviewState>((done) => {
          resolve = done;
        }),
      () => current,
      success,
      failure,
    );
    current = false;
    resolve({ version: 1, overrides: [] });
    await request;
    expect(success).not.toHaveBeenCalled();
    await settleFilterRequest(
      async () => {
        throw new Error("Old selection failure");
      },
      () => current,
      success,
      failure,
    );
    expect(failure).not.toHaveBeenCalled();
    current = true;
    await settleFilterRequest(
      async () => {
        throw new Error("Current read failure");
      },
      () => current,
      success,
      failure,
    );
    expect(failure).toHaveBeenCalledWith("Current read failure");
  });
});
