import { BLOCK_SPECS, PALETTE_BLOCK_KINDS } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { minimapColor } from "./minimap";

describe("workflow minimap colors", () => {
  it.each(PALETTE_BLOCK_KINDS)("uses the established group token for %s", (kind) => {
    expect(minimapColor(kind)).toBe(`var(--color-group-${BLOCK_SPECS[kind].group})`);
  });

  it("keeps fixed boundaries visually neutral", () => {
    expect(minimapColor("block_input")).toBe("var(--color-muted)");
    expect(minimapColor("block_output")).toBe("var(--color-muted)");
  });
});
