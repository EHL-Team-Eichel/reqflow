import { emptyPipelineData } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { defineBlock } from "./block";
import { BlockRegistry } from "./registry";

const passThroughHil = defineBlock({
  kind: "hil",
  run: async (inputs) => ({ status: "ok", outputs: { out: inputs.in ?? emptyPipelineData() } }),
});

describe("BlockRegistry", () => {
  it("registers and resolves implementations by kind", async () => {
    const registry = new BlockRegistry([passThroughHil]);
    const result = await registry.get("hil").run({}, {}, {} as never);
    expect(result).toMatchObject({ status: "ok", outputs: { out: emptyPipelineData() } });
    expect(registry.missing()).not.toContain("hil");
    expect(registry.missing()).not.toContain("custom");
  });

  it("rejects duplicates, unknown kinds and sub-flow-only kinds", () => {
    const registry = new BlockRegistry([passThroughHil]);
    expect(() => registry.register(passThroughHil)).toThrow(/already registered/);
    expect(() => registry.register({ ...passThroughHil, kind: "nope" as never })).toThrow(
      /Unknown block kind/,
    );
    expect(() => registry.register({ ...passThroughHil, kind: "custom" })).toThrow(
      /inner workplace/,
    );
    expect(() => registry.get("raw")).toThrow(/no implementation yet/);
  });
});
