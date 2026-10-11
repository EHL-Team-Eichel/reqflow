import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureRequirements } from "@reqflow/core/fixtures";
import { describe, expect, it } from "vitest";
import { classifyRequirement } from "../car/classify";
import { RequirementCard } from "./RequirementCard";

const climate = fixtureRequirements.find((r) => r.id === "REQ-F70-EU-003")!;
const render = (requirement = climate) =>
  renderToStaticMarkup(
    createElement(RequirementCard, {
      item: { requirement, assignment: classifyRequirement(requirement) },
      onOpen: () => {},
    }),
  );

describe("compact requirement cards", () => {
  it("keeps agent confidence and input rank distinct from part-placement confidence", () => {
    const html = render({
      ...climate,
      inputRank: 2,
      confidence: {
        value: 0.62,
        level: "medium",
        method: "synthetic@1",
        signals: [
          { key: "support", label: "Evidence support", value: 0.62, weight: 1, by: "synthetic" },
        ],
      },
    });
    expect(html).toContain("part confidence");
    expect(html).toContain("Agent confidence 62%");
    expect(html).toContain("from 2. Priority");
    expect(html).toContain('data-testid="car-requirement-part-confidence"');
    expect(html).toContain('data-testid="car-requirement-confidence"');
  });
  it("shows a clickable short requirement, hard facts, percentage, priority and status", () => {
    const html = render();
    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("View workflow, details and sources");
    expect(html).toContain("Workflow &amp; sources →");
    expect(html).toContain(climate.title);
    expect(html).toContain(climate.targets[0]!.target);
    expect(html).toContain(`${classifyRequirement(climate).confidencePercent}%`);
    expect(html).toContain("Should");
    expect(html).toContain("Challenged");
    expect(html).toContain("part confidence");
  });

  it("keeps full descriptions, category, score, evidence grades and classifier prose out of the overview", () => {
    const html = render();
    expect(html).not.toContain(climate.description);
    expect(html).not.toContain("Usability &amp; controls");
    expect(html).not.toContain("Evidence B");
    expect(html).not.toContain("Auto-classified");
    expect(html).not.toContain("Could also be");
    expect(html).not.toContain("Named in");
    expect(html).not.toContain("Priority score");
  });

  it("bounds long requirement summaries to two targets and signals the remaining targets", () => {
    const html = render({
      ...climate,
      targets: [1, 2, 3, 4].map((n) => ({
        metric: `Metric ${n}`,
        target: `Target ${n}`,
        acceptance: `Check ${n}`,
      })),
    });
    expect(html.match(/data-testid="car-requirement-target"/g)).toHaveLength(2);
    expect(html).toContain("Target 1");
    expect(html).toContain("Target 2");
    expect(html).not.toContain("Target 3");
    expect(html).toContain("+2 more targets");
  });

  it("falls back to a clamped description when measurable targets are not available", () => {
    const html = render({ ...climate, targets: [] });
    expect(html).toContain(climate.description);
    expect(html).toContain("line-clamp-2");
  });

  it("retains vital weak-evidence, conflict and low-placement-confidence warnings", () => {
    const html = render({
      ...climate,
      title: "A useful improvement",
      description: "Customers want an improvement.",
      category: "variants_packages",
      targets: [],
      evidenceLevel: "D",
      conflictingFindingIds: ["fnd_conflict"],
    });
    expect(html).toContain("Assumption-led");
    expect(html).toContain("Conflicting evidence");
    expect(html).toContain("Check placement");
    expect(html).toContain("0%");
  });
});
