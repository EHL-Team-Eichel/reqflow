import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RequirementDetail } from "@reqflow/core/ipc";
import {
  fixtureFindings,
  fixtureRecords,
  fixtureRequirements,
  fixtureSources,
} from "@reqflow/core/fixtures";
import { describe, expect, it } from "vitest";
import { RequirementDetails, sourceLink } from "./RequirementDetails";

const requirement = fixtureRequirements.find((r) => r.id === "REQ-F70-EU-003")!;
const detail: RequirementDetail = {
  requirement,
  findings: fixtureFindings,
  sources: fixtureSources,
  records: fixtureRecords,
  versions: [requirement],
};
const render = (value = detail) =>
  renderToStaticMarkup(createElement(RequirementDetails, { detail: value }));

describe("full requirement detail", () => {
  it("retains the complete requirement, hard facts, acceptance criteria and scoring explanation", () => {
    const html = render();
    expect(html).toContain(requirement.description);
    expect(html).toContain(requirement.targets[0]!.acceptance);
    expect(html).toContain("Priority score");
    expect(html).toContain("Evidence level");
    expect(html).toContain(`${requirement.score!.total} / 100`);
    expect(html).toContain("Prioritization &amp; rationale");
    expect(html).toContain("Assumptions &amp; uncertainties");
    expect(html).toContain("Full version snapshot");
    expect(html).toContain("not a calibrated probability");
  });

  it("shows supporting and conflicting findings, verbatim excerpts, records and source metadata", () => {
    const html = render();
    const finding = fixtureFindings.find((f) => f.id === requirement.findingIds[0])!;
    expect(html).toContain(finding.statement.replaceAll("&", "&amp;").replaceAll('"', "&quot;"));
    expect(html).toContain("car-evidence-excerpt");
    expect(html).toContain("Original record");
    expect(html).toContain("Source directory");
    expect(html).toContain("reliability");
    expect(html).toContain("Supporting findings");
    expect(html).toContain("Conflicting findings");
  });

  it("explicitly identifies missing findings and sources instead of making up evidence", () => {
    const html = render({ ...detail, findings: [], sources: [], records: [] });
    expect(html).toContain(`Finding unavailable: ${requirement.findingIds[0]}`);
    expect(html).toContain(`Source unavailable: ${requirement.sourceIds[0]}`);
    expect(html).not.toContain("car-evidence-excerpt");
  });

  it("handles unscored requirements and empty measurable targets honestly", () => {
    const html = render({
      ...detail,
      requirement: { ...requirement, score: undefined, priority: undefined, targets: [] },
    });
    expect(html).toContain("Not scored");
    expect(html).toContain("Not prioritized");
    expect(html).toContain("No measurable targets defined yet.");
  });
});

describe("source links", () => {
  it("opens only valid http(s) URLs", () => {
    expect(sourceLink("https://example.com/review")).toBe("https://example.com/review");
    expect(sourceLink("http://example.com")).toBe("http://example.com/");
    for (const uri of [
      undefined,
      "",
      "file_upload",
      "file:///private/data",
      "javascript:alert(1)",
      "data:text/html,hello",
      "not a URL",
    ]) {
      expect(sourceLink(uri)).toBeNull();
    }
  });
});
