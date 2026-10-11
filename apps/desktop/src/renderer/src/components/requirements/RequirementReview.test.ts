import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALLOWED_DECISIONS, DecisionKind } from "@reqflow/core";
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

  it("renders the decisions allowed from the status, neutral selection, rationale and edit toggle", () => {
    const render = (requirement: (typeof fixtureRequirements)[number]) =>
      renderToStaticMarkup(
        createElement(RequirementReview, { requirement, onSaved: mocks.onSaved }),
      );
    const proposed = fixtureRequirements[0]!;
    for (const [status, actions] of Object.entries(ALLOWED_DECISIONS)) {
      const options = render({ ...proposed, status: status as typeof proposed.status });
      for (const action of DecisionKind.options) {
        expect(options.includes(`value="${action}"`), `${status}: ${action}`).toBe(
          (actions as readonly string[]).includes(action),
        );
      }
    }
    const html = render({ ...proposed, status: "proposed" });
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
    expect(html).toContain("re-check it against its linked evidence");
    expect(html).toContain("it is advice, not a human approval or new evidence");
    expect(html).toContain("stays Challenged until you decide");
    expect(html).toContain("No workflow resumes automatically.");
    expect(html).toContain(`Version ${fixtureRequirements[0]!.version}`);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(mocks.onSaved).not.toHaveBeenCalled();
  });
});
