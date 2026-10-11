import React, { createElement, type ButtonHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureRequirements } from "@reqflow/core/fixtures";
import { RequirementBrowser, type RequirementBrowserProps } from "./RequirementBrowser";
import * as browser from "./requirement-browser";

vi.mock("../../lib/api", () => ({ api: { exports: { requirements: vi.fn() } } }));
vi.mock("../ui/Button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) =>
    createElement("button", { type: "button", ...props }),
}));

const render = (props: Partial<RequirementBrowserProps> = {}) =>
  renderToStaticMarkup(
    createElement(RequirementBrowser, {
      requirements: fixtureRequirements,
      loading: false,
      error: null,
      onReload: async () => {},
      onOpen: () => {},
      ...props,
    }),
  );

afterEach(() => vi.restoreAllMocks());

describe("requirements browser panel", () => {
  it("labels compact controls, exposes testids and scrolls results separately", () => {
    const html = render();
    for (const name of ["query", "category", "status", "evidence", "sort", "export-format"])
      expect(html).toContain(`data-testid="requirement-browser-${name}"`);
    for (const label of [
      "Search requirements",
      "Category",
      "Status",
      "Evidence",
      "Sort within priority",
      "Export format",
    ])
      expect(html).toContain(label);
    expect(html.match(/<label for=/g)).toHaveLength(6);
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain(`${fixtureRequirements.length} of ${fixtureRequirements.length} shown`);
  });

  it("renders all priority groups and reuses compact cards without mounting dialogs or 3D", () => {
    const html = render({ requirements: [{ ...fixtureRequirements[0]!, priority: undefined }] });
    for (const band of ["must", "should", "could", "wont", "unprioritized"])
      expect(html).toContain(`data-testid="requirement-browser-group-${band}"`);
    expect(html).toContain('data-testid="car-requirement"');
    expect(html).toContain("part confidence");
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("<canvas");
  });

  it("shows loading rather than an empty-store or no-match claim", () => {
    const html = render({ requirements: [], loading: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-testid="requirement-browser-loading"');
    expect(html).not.toContain('data-testid="requirement-browser-empty"');
    expect(html).not.toContain('data-testid="requirement-browser-no-matches"');
  });

  it("shows load errors and retry without pretending the store is empty", () => {
    const html = render({ requirements: [], error: "Bridge unavailable" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Bridge unavailable");
    expect(html).toContain('data-testid="requirement-browser-retry"');
    expect(html).not.toContain('data-testid="requirement-browser-empty"');
    expect(render({ error: "Refresh failed" })).toContain(
      "Showing previously loaded requirements.",
    );
  });

  it("distinguishes no stored requirements from no matches and offers filter reset", () => {
    expect(render({ requirements: [] })).toContain('data-testid="requirement-browser-empty"');
    const empty = browser.filterAndGroupRequirements([]);
    vi.spyOn(browser, "filterAndGroupRequirements").mockReturnValue(empty);
    const html = render();
    expect(html).toContain('data-testid="requirement-browser-no-matches"');
    expect(html).not.toContain('data-testid="requirement-browser-empty"');
    expect(html).toContain('data-testid="requirement-browser-clear"');
  });

  it("discloses all-stored scope, offers all three formats, and does not claim success before exporting", () => {
    const html = render();
    expect(html).toContain("all stored requirements, not just the filtered results");
    expect(html).toContain("native save dialog");
    for (const format of ["json", "csv", "md"]) expect(html).toContain(`value="${format}"`);
    expect(html).toContain("Export all");
    expect(html).not.toContain('data-testid="requirement-browser-export-saved"');
  });
});
