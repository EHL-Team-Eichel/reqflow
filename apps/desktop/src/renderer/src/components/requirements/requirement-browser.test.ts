import { describe, expect, it, vi } from "vitest";
import type { ExportFormat, Requirement } from "@reqflow/core";
import { fixtureRequirements } from "@reqflow/core/fixtures";
import { classifyRequirement } from "../car/classify";
import { exportAllRequirements, filterAndGroupRequirements } from "./requirement-browser";

const base = fixtureRequirements[0]!;
function requirement(id: number, overrides: Partial<Requirement> = {}): Requirement {
  return {
    ...base,
    id: `REQ-F70-EU-${String(id).padStart(3, "0")}`,
    priority: "should",
    ...overrides,
  };
}
const ids = (requirements: readonly Requirement[], options = {}) =>
  filterAndGroupRequirements(requirements, options).flatMap((group) =>
    group.items.map((item) => item.requirement.id),
  );

describe("requirements browser filtering and ranking", () => {
  it("returns all five bands in order, without inferring a missing priority", () => {
    const missing = requirement(1, { priority: undefined, inputRank: 1 });
    const groups = filterAndGroupRequirements([
      missing,
      requirement(2, { priority: "wont" }),
      requirement(3, { priority: "must" }),
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "Must",
      "Should",
      "Could",
      "Won't",
      "Unprioritized",
    ]);
    expect(groups[0]!.items[0]!.requirement.id).toBe("REQ-F70-EU-003");
    expect(groups[4]!.items[0]!.requirement).toBe(missing);
    expect(groups[4]!.items[0]!.assignment).toEqual(classifyRequirement(missing));
  });

  it("ranks by score descending, missing last, retaining ties and zero scores", () => {
    const score = base.score!;
    const requirements = [
      requirement(1, { score: undefined }),
      requirement(2, { score: { ...score, total: 20 } }),
      requirement(3, { score: { ...score, total: 90 } }),
      requirement(4, { score: { ...score, total: 20 } }),
      requirement(5, { score: { ...score, total: 0 } }),
      requirement(6, { score: undefined }),
    ];
    expect(ids(requirements)).toEqual([3, 2, 4, 5, 1, 6].map((id) => `REQ-F70-EU-00${id}`));
  });

  it("does not mutate input order or nested requirement fields", () => {
    const input = [requirement(1), requirement(2, { title: "AAA" })];
    const snapshot = structuredClone(input);
    Object.freeze(input);
    for (const item of input) {
      Object.freeze(item.targets);
      Object.freeze(item);
    }
    ids(input, { sort: "title" });
    expect(input).toEqual(snapshot);
  });

  it("sorts updated dates newest first, comparing instants and retaining ties", () => {
    const input = [
      requirement(1, { updatedAt: "2026-10-09T10:00:00.000Z" }),
      requirement(2, { updatedAt: "2026-10-10T10:00:00.000Z" }),
      requirement(3, { updatedAt: "2026-10-10T12:00:00.000+02:00" }),
    ];
    expect(ids(input, { sort: "updated" })).toEqual([input[1]!.id, input[2]!.id, input[0]!.id]);
  });

  it("sorts title case-insensitively with stable ties, within priority bands", () => {
    const input = [
      requirement(1, { title: "Zulu", priority: "must" }),
      requirement(2, { title: "alpha" }),
      requirement(3, { title: "Alpha" }),
      requirement(4, { title: "Beta" }),
    ];
    expect(ids(input, { sort: "title" })).toEqual(input.map((r) => r.id));
  });

  it("combines category, status, evidence and a trimmed case-insensitive query", () => {
    const desired = requirement(1, {
      category: "comfort",
      status: "deferred",
      evidenceLevel: "D",
      title: "Quiet cabin",
    });
    const input = [
      desired,
      requirement(2, {
        category: "comfort",
        status: "deferred",
        evidenceLevel: "C",
        title: "Quiet cabin",
      }),
      requirement(3, {
        category: "comfort",
        status: "proposed",
        evidenceLevel: "D",
        title: "Quiet cabin",
      }),
      requirement(4, {
        category: "range_charging",
        status: "deferred",
        evidenceLevel: "D",
        title: "Quiet cabin",
      }),
    ];
    expect(
      ids(input, { category: "comfort", status: "deferred", evidence: "D", query: "  QUIET  " }),
    ).toEqual([desired.id]);
  });

  it("searches IDs, descriptions, category labels and all target fields", () => {
    const r = requirement(1, {
      title: "Synthetic",
      description: "Distinct description",
      targets: [
        { metric: "Synthetic metric", target: "Unique target", acceptance: "Special acceptance" },
      ],
    });
    for (const query of [
      r.id,
      "distinct description",
      "synthetic metric",
      "unique target",
      "special acceptance",
    ]) {
      expect(ids([r], { query })).toEqual([r.id]);
    }
    expect(ids([requirement(2, { category: "comfort" })], { query: "comfort" })).toEqual([
      "REQ-F70-EU-002",
    ]);
    expect(ids([r], { query: "   " })).toEqual([r.id]);
  });

  it("returns empty bands for no matches and for an empty store", () => {
    for (const groups of [
      filterAndGroupRequirements([base], { query: "not-a-match-xyz" }),
      filterAndGroupRequirements([]),
    ]) {
      expect(groups).toHaveLength(5);
      expect(groups.every((group) => group.items.length === 0)).toBe(true);
    }
  });
});

describe("native all-requirements export", () => {
  it.each<ExportFormat>(["json", "csv", "md"])(
    "passes only the %s format, with no browser filters or run scope",
    async (format) => {
      const exporter = vi.fn().mockResolvedValue({ path: "/synthetic/requirements" });
      expect(await exportAllRequirements(format, exporter)).toEqual({
        status: "saved",
        path: "/synthetic/requirements",
      });
      expect(exporter).toHaveBeenCalledExactlyOnceWith({ format });
    },
  );

  it("reports native dialog cancellation, not a saved file", async () => {
    expect(await exportAllRequirements("csv", vi.fn().mockResolvedValue(null))).toEqual({
      status: "cancelled",
    });
  });

  it("surfaces errors without a false success", async () => {
    expect(
      await exportAllRequirements("md", vi.fn().mockRejectedValue(new Error("Disk is full"))),
    ).toEqual({ status: "error", message: "Disk is full" });
    expect(
      await exportAllRequirements("json", () => {
        throw new Error("Bridge unavailable");
      }),
    ).toEqual({ status: "error", message: "Bridge unavailable" });
    expect(await exportAllRequirements("json", vi.fn().mockRejectedValue(null))).toEqual({
      status: "error",
      message: "Could not export requirements.",
    });
  });
});
