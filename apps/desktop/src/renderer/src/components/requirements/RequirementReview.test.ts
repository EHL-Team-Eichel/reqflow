import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureRequirements } from "@reqflow/core/fixtures";
import { RequirementReview } from "./RequirementReview";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  edit: vi.fn(),
  decide: vi.fn(),
  onSaved: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: { requirements: mocks } }));

describe("human review markup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders all explicit decisions, neutral selection, rationale and edit toggle", () => {
    const html = renderToStaticMarkup(
      createElement(RequirementReview, {
        requirement: fixtureRequirements[0]!,
        onSaved: mocks.onSaved,
      }),
    );
    for (const action of ["approve", "reject", "defer", "challenge", "reopen"]) {
      expect(html).toContain(`value="${action}"`);
    }
    expect(html).toContain('<option value="" selected="">Choose an action</option>');
    expect(html).toContain("Edit content");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Rationale");
    expect(html).toContain("at least 3 characters after trimming whitespace");
    expect(html).toContain('type="submit"');
    expect(html).toMatch(/<button[^>]+type="submit"[^>]+disabled=""/);
    expect(html).not.toContain("Approval priority override");
  });

  it("states challenge and workflow limits without making automatic API calls", () => {
    const html = renderToStaticMarkup(
      createElement(RequirementReview, {
        requirement: { ...fixtureRequirements[0]!, status: "challenged" },
        onSaved: mocks.onSaved,
      }),
    );
    expect(html).toContain("Challenge requests a response from the configured AI");
    expect(html).toContain("not a human approval or verified new evidence");
    expect(html).toContain("No workflow resumes automatically.");
    expect(html).toContain(`Version ${fixtureRequirements[0]!.version}`);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(mocks.onSaved).not.toHaveBeenCalled();
  });
});
