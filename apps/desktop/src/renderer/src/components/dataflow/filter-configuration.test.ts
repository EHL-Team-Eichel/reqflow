import { createBlock } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { applyFilterPreset, filterBypassed } from "./filter-configuration";

describe("AI Filter configuration", () => {
  it("preserves custom edits and changes only the four guidance fields on explicit apply", () => {
    const params = {
      criterion: "Edited criterion",
      include: "Edited include",
      exclude: "Edited exclude",
      examples: "Edited examples",
      fields: "text, custom",
      model: "default",
      minConfidence: 0.6,
      keepUnsure: false,
    };
    expect(applyFilterPreset(params, "custom")).toEqual(params);
    for (const preset of ["customer-facing", "all-relevant"] as const) {
      const next = applyFilterPreset(params, preset);
      for (const key of ["fields", "model", "minConfidence", "keepUnsure"])
        expect(next[key]).toEqual(params[key as keyof typeof params]);
      for (const key of ["criterion", "include", "exclude", "examples"])
        expect(next[key]).not.toEqual(params[key as keyof typeof params]);
    }
    expect(params.criterion).toBe("Edited criterion");
  });

  it("only bypasses for an edge or a non-boundary inner child", () => {
    const block = createBlock("ai_filter", { id: "filter", position: { x: 0, y: 0 } });
    expect(filterBypassed(block)).toBe(false);
    expect(
      filterBypassed({
        ...block,
        inner: {
          blocks: block.inner!.blocks,
          edges: [
            { id: "edge", source: "input", sourcePort: "out", target: "output", targetPort: "in" },
          ],
        },
      }),
    ).toBe(true);
    expect(
      filterBypassed({
        ...block,
        inner: {
          blocks: [
            ...block.inner!.blocks,
            createBlock("hil", { id: "child", position: { x: 0, y: 0 } }),
          ],
          edges: [],
        },
      }),
    ).toBe(true);
  });
});
