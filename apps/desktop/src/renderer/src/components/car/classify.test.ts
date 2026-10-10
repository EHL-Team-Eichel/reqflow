import type { Requirement } from "@reqflow/core";
import { fixtureRequirements } from "@reqflow/core/fixtures";
import { describe, expect, it } from "vitest";
import { classifyRequirement, groupByPart } from "./classify";
import { CAR_PARTS, WHOLE_CAR } from "./parts";

const req = (
  title: string,
  description = title,
  category: Requirement["category"] = "comfort",
): Pick<Requirement, "title" | "description" | "category" | "targets"> => ({
  title,
  description,
  category,
  targets: [],
});

describe("classifyRequirement", () => {
  it("places the fixture requirements on the parts they are about", () => {
    const parts = Object.fromEntries(
      fixtureRequirements.map((r) => [r.id, classifyRequirement(r).partId]),
    );
    expect(parts).toEqual({
      "REQ-F70-EU-001": "rear_seats",
      "REQ-F70-EU-002": "kidney_grille",
      "REQ-F70-EU-003": "climate",
      "REQ-F70-EU-004": "charging_port",
      "REQ-F70-EU-005": "front_seats",
    });
  });

  it("explains itself with the words that decided", () => {
    const a = classifyRequirement(req("Ventilated front seats", "Front seats keep you cool."));
    expect(a.partId).toBe("front_seats");
    expect(a.confidence).toBe("high");
    expect(a.matches.map((m) => m.term)).toContain("front seats");
    expect(a.reason).toMatch(/title/);
  });

  it("lets the longest match win: 'rear seats' never counts for the front seats", () => {
    const a = classifyRequirement(req("More legroom on the rear seats"));
    expect(a.partId).toBe("rear_seats");
    expect(a.alternatives.find((x) => x.partId === "front_seats")).toBeUndefined();
  });

  it("weights the title over the description", () => {
    const a = classifyRequirement(
      req("Sharper head-up display", "As readable as the central screen."),
    );
    expect(a.partId).toBe("hud");
  });

  it("matches German words with umlauts", () => {
    expect(classifyRequirement(req("Sitzlüftung serienmäßig")).partId).toBe("front_seats");
    expect(classifyRequirement(req("Mehr Beinfreiheit hinten")).partId).toBe("rear_seats");
  });

  it("falls back to an unambiguous category with low confidence", () => {
    const a = classifyRequirement(
      req("Feels special", "Customers want it to feel special.", "infotainment_digital"),
    );
    expect(a).toMatchObject({ partId: "curved_display", confidence: "low", matches: [] });
  });

  it("never guesses: no words and an ambiguous category → whole car", () => {
    const a = classifyRequirement(
      req("Sensible package bundles", "Fewer bundles.", "variants_packages"),
    );
    expect(a).toMatchObject({ partId: WHOLE_CAR.id, confidence: "low" });
  });

  it("marks a tie as low confidence and lets the category decide", () => {
    const a = classifyRequirement(req("Seats and screens", "x", "infotainment_digital"));
    expect(a.confidence).toBe("low");
    expect(a.partId).toBe("curved_display");
    expect(a.reason).toMatch(/category decided/);
  });

  it("groups a list by part and keeps every requirement", () => {
    const groups = groupByPart(fixtureRequirements);
    const total = [...groups.values()].reduce((n, list) => n + list.length, 0);
    expect(total).toBe(fixtureRequirements.length);
  });

  it("every part keyword compiles and parts have unique ids", () => {
    expect(new Set(CAR_PARTS.map((p) => p.id)).size).toBe(CAR_PARTS.length);
    for (const part of CAR_PARTS) {
      for (const k of part.keywords) expect(() => new RegExp(k, "iu")).not.toThrow();
    }
  });
});
