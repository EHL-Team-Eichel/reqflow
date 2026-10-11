import { describe, expect, it, vi } from "vitest";
import { DecisionKind, DECISION_TO_STATUS, Requirement } from "@reqflow/core";
import { fixtureRequirements } from "@reqflow/core/fixtures";
import type { ReqflowApi, RequirementDetail } from "@reqflow/core/ipc";
import {
  buildRequirementDecision,
  buildRequirementEdit,
  requirementDraft,
  reviewError,
  saveRequirementReview,
} from "./requirement-review";

const shown = Requirement.parse(fixtureRequirements[0]);
function mockApi(current = shown) {
  const detail: RequirementDetail = {
    requirement: current,
    findings: [],
    sources: [],
    records: [],
    versions: [current],
  };
  const saved = { ...shown, version: shown.version + 1 };
  return {
    requirements: {
      get: vi.fn<ReqflowApi["requirements"]["get"]>().mockResolvedValue(detail),
      edit: vi.fn<ReqflowApi["requirements"]["edit"]>().mockResolvedValue(saved),
      decide: vi.fn<ReqflowApi["requirements"]["decide"]>().mockResolvedValue(saved),
    },
  };
}

describe("review payloads", () => {
  it("sends only changed content and trimmed rationale, never protected fields", () => {
    const draft = { ...requirementDraft(shown), title: "  Synthetic revised title  " };
    expect(buildRequirementEdit(shown, draft, "  Clarified customer need  ")).toEqual({
      title: "Synthetic revised title",
      rationale: "Clarified customer need",
    });
    expect(draft.title).toBe("  Synthetic revised title  ");
    expect(shown).toEqual(fixtureRequirements[0]);
  });

  it("does not normalize untouched stored fields even when other fields change", () => {
    const original = {
      ...shown,
      title: "  Stored title  ",
      assumptions: ["  Original assumption  "],
      targets: [
        {
          metric: " Original metric ",
          target: " Original target ",
          acceptance: " Original acceptance ",
        },
      ],
    };
    const draft = { ...requirementDraft(original), description: "Revised synthetic description" };
    expect(buildRequirementEdit(original, draft, "Explanation")).toEqual({
      description: "Revised synthetic description",
      rationale: "Explanation",
    });
    draft.targets[0]!.target = " Revised target ";
    expect(buildRequirementEdit(original, draft, "Explanation").targets).toEqual([
      {
        metric: " Original metric ",
        target: "Revised target",
        acceptance: " Original acceptance ",
      },
    ]);
  });

  it("rejects no-op and whitespace-only changes", () => {
    const original = {
      ...shown,
      assumptions: ["Original assumption"],
      uncertainties: ["Original uncertainty"],
    };
    const draft = requirementDraft(original);
    expect(() => buildRequirementEdit(original, draft, "Explanation")).toThrow(
      "at least one field",
    );
    draft.title = ` ${draft.title} `;
    draft.description = `${draft.description}\n`;
    draft.assumptions = "\n Original assumption \n";
    draft.uncertainties = " Original uncertainty \n";
    draft.targets = draft.targets.map((target) => ({
      metric: ` ${target.metric} `,
      target: ` ${target.target} `,
      acceptance: ` ${target.acceptance} `,
    }));
    expect(() => buildRequirementEdit(original, draft, "Explanation")).toThrow(
      "at least one field",
    );
  });

  it("validates blank text, category, priority, title length and trimmed rationale", () => {
    for (const change of [
      { title: "   " },
      { description: "\n " },
      { title: "x".repeat(121) },
      { category: "invalid" },
      { priority: "invalid" },
    ]) {
      expect(() =>
        buildRequirementEdit(shown, { ...requirementDraft(shown), ...change }, "Explanation"),
      ).toThrow();
    }
    for (const rationale of ["", "   ", " ab "]) {
      expect(() =>
        buildRequirementEdit(
          shown,
          { ...requirementDraft(shown), title: "Revised title" },
          rationale,
        ),
      ).toThrow();
      expect(() => buildRequirementDecision("approve", rationale)).toThrow();
    }
  });

  it("supports adding, editing and removing targets with nonblank acceptance", () => {
    const draft = requirementDraft(shown);
    draft.targets = [{ metric: " Metric ", target: " Target ", acceptance: " Acceptance " }];
    expect(buildRequirementEdit(shown, draft, "Explanation").targets).toEqual([
      { metric: "Metric", target: "Target", acceptance: "Acceptance" },
    ]);
    for (const key of ["metric", "target", "acceptance"] as const) {
      expect(() =>
        buildRequirementEdit(
          shown,
          { ...draft, targets: [{ ...draft.targets[0]!, [key]: "  " }] },
          "Explanation",
        ),
      ).toThrow();
    }
    const original = { ...shown, targets: draft.targets };
    // A requirement keeps at least one measurable target (RequirementEdit contract).
    expect(() =>
      buildRequirementEdit(original, { ...requirementDraft(original), targets: [] }, "Explanation"),
    ).toThrow();
  });

  it("parses assumption/uncertainty lines and allows explicit clearing", () => {
    const original = {
      ...shown,
      assumptions: ["Old assumption"],
      uncertainties: ["Old uncertainty"],
    };
    const draft = {
      ...requirementDraft(original),
      assumptions: " First \r\n\n Second ",
      uncertainties: "  \n",
    };
    expect(buildRequirementEdit(original, draft, "Explanation")).toEqual({
      assumptions: ["First", "Second"],
      uncertainties: [],
      rationale: "Explanation",
    });
  });

  it.each(DecisionKind.options)("constructs explicit %s decisions", (decision) => {
    expect(buildRequirementDecision(decision, "  Human rationale  ")).toEqual({
      decision,
      rationale: "Human rationale",
    });
  });

  it("permits priority override only for approval and validates action/priority", () => {
    expect(buildRequirementDecision("approve", "Explanation", "must")).toEqual({
      decision: "approve",
      rationale: "Explanation",
      priority: "must",
    });
    for (const decision of ["reject", "defer", "challenge", "reopen"]) {
      expect(() => buildRequirementDecision(decision, "Explanation", "must")).toThrow(
        "only available when approving",
      );
    }
    expect(() => buildRequirementDecision("", "Explanation")).toThrow();
    expect(() => buildRequirementDecision("approve", "Explanation", "invalid")).toThrow();
  });
});

describe("API-shaped review submission", () => {
  it("fetches detail before editing and sends the exact changed-fields payload", async () => {
    const client = mockApi();
    const draft = { ...requirementDraft(shown), title: "Updated title" };
    const saved = await saveRequirementReview(client, shown, {
      kind: "edit",
      draft,
      rationale: "Human edit",
    });
    expect(client.requirements.get).toHaveBeenCalledExactlyOnceWith(shown.id);
    expect(client.requirements.edit).toHaveBeenCalledExactlyOnceWith(shown.id, {
      title: "Updated title",
      rationale: "Human edit",
    });
    expect(client.requirements.get.mock.invocationCallOrder[0]).toBeLessThan(
      client.requirements.edit.mock.invocationCallOrder[0]!,
    );
    expect(client.requirements.decide).not.toHaveBeenCalled();
    expect(saved.version).toBe(shown.version + 1);
  });

  it.each(DecisionKind.options)(
    "fetches before %s and returns backend state without inventing a decision",
    async (decision) => {
      const client = mockApi();
      const saved = { ...shown, version: shown.version + 1, status: DECISION_TO_STATUS[decision] };
      client.requirements.decide.mockResolvedValue(saved);
      expect(
        await saveRequirementReview(client, shown, {
          kind: "decision",
          decision,
          rationale: "Human decision",
          ...(decision === "approve" ? { priority: "could" } : {}),
        }),
      ).toEqual(saved);
      expect(client.requirements.get).toHaveBeenCalledExactlyOnceWith(shown.id);
      expect(client.requirements.decide).toHaveBeenCalledExactlyOnceWith(shown.id, {
        decision,
        rationale: "Human decision",
        ...(decision === "approve" ? { priority: "could" } : {}),
      });
      expect(client.requirements.get.mock.invocationCallOrder[0]).toBeLessThan(
        client.requirements.decide.mock.invocationCallOrder[0]!,
      );
      expect(client.requirements.edit).not.toHaveBeenCalled();
    },
  );

  it.each(["edit", "decision"] as const)("refuses stale %s without mutation", async (kind) => {
    const client = mockApi({ ...shown, version: shown.version + 1 });
    const submission =
      kind === "edit"
        ? {
            kind,
            draft: { ...requirementDraft(shown), title: "Updated title" },
            rationale: "Explanation",
          }
        : { kind, decision: "approve", rationale: "Explanation" };
    await expect(saveRequirementReview(client, shown, submission)).rejects.toThrow(
      "Reload its details",
    );
    expect(client.requirements.edit).not.toHaveBeenCalled();
    expect(client.requirements.decide).not.toHaveBeenCalled();
  });

  it("rejects invalid submissions before any IPC call", async () => {
    const client = mockApi();
    await expect(
      saveRequirementReview(client, shown, {
        kind: "edit",
        draft: requirementDraft(shown),
        rationale: "Explanation",
      }),
    ).rejects.toThrow();
    await expect(
      saveRequirementReview(client, shown, {
        kind: "decision",
        decision: "approve",
        rationale: " ab ",
      }),
    ).rejects.toThrow();
    expect(client.requirements.get).not.toHaveBeenCalled();
    expect(client.requirements.decide).not.toHaveBeenCalled();
    expect(client.requirements.edit).not.toHaveBeenCalled();
  });

  it("propagates fetch failures without mutation and mutation failures without retries", async () => {
    const client = mockApi();
    const submission = {
      kind: "decision",
      decision: "challenge",
      rationale: "Check competing evidence",
    } as const;
    client.requirements.get.mockRejectedValueOnce(new Error("Detail unavailable"));
    await expect(saveRequirementReview(client, shown, submission)).rejects.toThrow(
      "Detail unavailable",
    );
    expect(client.requirements.decide).not.toHaveBeenCalled();
    client.requirements.decide.mockRejectedValueOnce(new Error("Decision unavailable"));
    await expect(saveRequirementReview(client, shown, submission)).rejects.toThrow(
      "Decision unavailable",
    );
    expect(client.requirements.decide).toHaveBeenCalledTimes(1);
    client.requirements.edit.mockRejectedValueOnce(new Error("Edit unavailable"));
    await expect(
      saveRequirementReview(client, shown, {
        kind: "edit",
        draft: { ...requirementDraft(shown), title: "Updated" },
        rationale: "Explanation",
      }),
    ).rejects.toThrow("Edit unavailable");
    expect(client.requirements.edit).toHaveBeenCalledTimes(1);
  });

  it("does not mutate after the view closes during the preflight", async () => {
    const client = mockApi();
    let active = true;
    client.requirements.get.mockImplementation(async () => {
      active = false;
      return { requirement: shown, findings: [], sources: [], records: [], versions: [] };
    });
    await expect(
      saveRequirementReview(
        client,
        shown,
        { kind: "decision", decision: "approve", rationale: "Explanation" },
        () => active,
      ),
    ).rejects.toThrow("no longer open");
    expect(client.requirements.decide).not.toHaveBeenCalled();
  });

  it("formats validation and IPC errors clearly", () => {
    try {
      buildRequirementDecision("approve", " ");
    } catch (error) {
      expect(reviewError(error)).toContain("rationale");
    }
    expect(reviewError(new Error("Reload details"))).toBe("Reload details");
    expect(reviewError(null)).toContain("Unable to save");
  });
});
