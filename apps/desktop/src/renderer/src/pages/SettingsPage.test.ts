/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");

describe("Settings model navigation", () => {
  it("removes the duplicate Model entry and page", () => {
    expect(page).not.toContain('id: "model"');
    expect(page).not.toContain('case "model":');
    expect(page).not.toContain("ModelSection");
  });

  it("retains Model switcher navigation and content", () => {
    expect(page).toContain('id: "model-switcher"');
    expect(page).toContain('label: "Model switcher"');
    expect(page).toContain('case "model-switcher":');
    expect(page).toContain("content = <ModelSwitcherSection />;");
  });
});
