import { connect, createBlock, type SplitterReport, type WorkflowRun } from "@reqflow/core";
import { fixtureRun } from "@reqflow/core/fixtures";
import { describe, expect, it, vi } from "vitest";
import { saveSplitterCorrection } from "./splitter-review";

function setup() {
  const splitter = createBlock("ai_splitter", { id: "splitter", position: { x: 0, y: 0 } });
  const hil = createBlock("hil", { id: "review", position: { x: 300, y: 0 } });
  const report: SplitterReport = {
    schemaVersion: 1,
    runId: fixtureRun.id,
    blockId: splitter.id,
    createdAt: fixtureRun.startedAt,
    mode: "custom",
    models: [],
    input: {
      primaryLayer: "records",
      primaryCount: 1,
      recordCount: 1,
      sourceCount: 1,
      feedbackUnitCount: 1,
      contextUnitCount: 0,
      duplicateUnitCount: 0,
      customerCount: null,
      countingBasis: "Synthetic unit",
    },
    branches: [
      { portId: "out-0", label: "A", primaryItemCount: 1 },
      { portId: "out-1", label: "B", primaryItemCount: 0 },
    ],
    groups: [],
    signals: [],
    sourceMatrix: [],
    assignments: [
      {
        itemId: "rec_synthetic",
        unitId: "unit",
        groupIds: [],
        primaryGroupId: null,
        outputPortId: "out-0",
        reason: "Synthetic route",
        confidence: null,
        evidence: [],
      },
    ],
    scoreMethod: {
      id: "none",
      formula: "Not computed",
      frequencyWeight: 0,
      impactWeight: 0,
      impactScale: [],
      thresholds: [],
    },
    limitations: [],
    reviews: [],
  };
  const run: WorkflowRun = {
    ...fixtureRun,
    status: "waiting_for_review",
    graph: connect(
      { blocks: [splitter, hil], edges: [] },
      { source: splitter.id, sourcePort: "out-0", target: hil.id, targetPort: "in" },
    ),
    blockRuns: [
      { blockId: splitter.id, status: "succeeded", counts: {}, logs: [], splitterReport: report },
      { blockId: hil.id, status: "waiting_for_review", counts: {}, logs: [] },
    ],
  };
  let state = { run: run as WorkflowRun | null, busy: false, error: null as string | null };
  const store = {
    getState: () => state,
    setState: (patch: Partial<typeof state>) => {
      state = { ...state, ...patch };
    },
  };
  const review = {
    expectedVersion: 0,
    rationale: "Human correction",
    changes: [{ itemId: "rec_synthetic", toPortId: "out-1" }],
  };
  return { run, report, store, review };
}

describe("persisted splitter corrections", () => {
  it("uses the IPC result, never changes local routes optimistically", async () => {
    const { run, store, review } = setup();
    const saved = structuredClone(run);
    saved.blockRuns[0]!.splitterReport!.assignments[0]!.outputPortId = "out-1";
    saved.blockRuns[0]!.splitterReport!.reviews.push({
      version: 1,
      at: run.startedAt,
      actor: { type: "human", userId: "synthetic", name: "Reviewer" },
      rationale: review.rationale,
      changes: [{ itemId: "rec_synthetic", fromPortId: "out-0", toPortId: "out-1" }],
    });
    let resolve!: (value: WorkflowRun) => void;
    const method = vi.fn().mockImplementation(
      () =>
        new Promise<WorkflowRun>((done) => {
          resolve = done;
        }),
    );
    const request = saveSplitterCorrection(
      store,
      { reviewSplitter: method },
      run.id,
      "splitter",
      review,
    );
    expect(store.getState().busy).toBe(true);
    expect(store.getState().run).toBe(run);
    expect(method).toHaveBeenCalledExactlyOnceWith(run.id, "splitter", review);
    resolve(saved);
    await request;
    expect(store.getState().run).toEqual(saved);
    expect(store.getState().busy).toBe(false);
  });

  it("shows stale-version or transport errors while retaining the saved snapshot", async () => {
    const { run, store, review } = setup();
    await expect(
      saveSplitterCorrection(
        store,
        { reviewSplitter: vi.fn().mockRejectedValue(new Error("Review version changed")) },
        run.id,
        "splitter",
        review,
      ),
    ).rejects.toThrow("Review version changed");
    expect(store.getState().run).toBe(run);
    expect(store.getState().error).toBe("Review version changed");
    expect(store.getState().busy).toBe(false);
  });

  it("rejects blank rationale, unsupported IPC, same-route changes, and ineligible gates", async () => {
    const { run, store, review } = setup();
    const method = vi.fn();
    await expect(
      saveSplitterCorrection(store, { reviewSplitter: method }, run.id, "splitter", {
        ...review,
        rationale: " ",
      }),
    ).rejects.toThrow();
    await expect(saveSplitterCorrection(store, {}, run.id, "splitter", review)).rejects.toThrow(
      "not available",
    );
    await expect(
      saveSplitterCorrection(store, { reviewSplitter: method }, run.id, "splitter", {
        ...review,
        changes: [{ itemId: "rec_synthetic", toPortId: "out-0" }],
      }),
    ).rejects.toThrow("different output");
    store.setState({ run: { ...run, status: "completed" } });
    await expect(
      saveSplitterCorrection(store, { reviewSplitter: method }, run.id, "splitter", review),
    ).rejects.toThrow("editable paused HIL");
    expect(method).not.toHaveBeenCalled();
  });

  it("rejects a stale expected version without applying or sending a local change", async () => {
    const { run, store, review } = setup();
    const method = vi.fn();
    await expect(
      saveSplitterCorrection(store, { reviewSplitter: method }, run.id, "splitter", {
        ...review,
        expectedVersion: 1,
      }),
    ).rejects.toThrow("Review version changed");
    expect(method).not.toHaveBeenCalled();
    expect(store.getState().run).toBe(run);
  });
});
