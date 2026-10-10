import { PALETTE_BLOCK_KINDS, validateGraph } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { allBlockImplementations, BMW_DEFAULT_TEMPLATE, createBlockRegistry } from "./index";

describe("blocks package", () => {
  it("registers only known block kinds, without duplicates", () => {
    for (const impl of allBlockImplementations) expect(PALETTE_BLOCK_KINDS).toContain(impl.kind);
    expect(() => createBlockRegistry()).not.toThrow();
  });

  it("default template is a valid workflow", () => {
    expect(validateGraph(BMW_DEFAULT_TEMPLATE.graph)).toEqual([]);
    const kinds = new Set(BMW_DEFAULT_TEMPLATE.graph.blocks.map((b) => b.kind));
    for (const kind of ["raw", "research", "ai_filter", "ai_splitter", "hil", "add_to_car"]) {
      expect(kinds).toContain(kind);
    }
  });
});
