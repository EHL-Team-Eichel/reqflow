import { emptyPipelineData } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineNode } from "./node";
import { NodeRegistry } from "./registry";

const passThrough = defineNode({
  type: "analysis.pass_through",
  label: "Pass through",
  description: "Test node.",
  category: "analysis",
  consumes: [],
  produces: [],
  configSchema: z.object({ note: z.string().default("") }),
  run: async (input) => ({ status: "ok", data: input }),
});

describe("NodeRegistry", () => {
  it("registers, resolves and catalogs nodes with a JSON Schema config", async () => {
    const registry = new NodeRegistry([passThrough]);
    const def = registry.get("analysis.pass_through");
    await expect(def.run(emptyPipelineData(), {}, {} as never)).resolves.toMatchObject({
      status: "ok",
    });
    const [entry] = registry.catalog();
    expect(entry?.configJsonSchema).toMatchObject({ type: "object" });
  });

  it("rejects duplicate and malformed node types", () => {
    const registry = new NodeRegistry([passThrough]);
    expect(() => registry.register(passThrough)).toThrow(/already registered/);
    expect(() => registry.register({ ...passThrough, type: "BadType" })).toThrow(/must look like/);
    expect(() => registry.get("nope.missing")).toThrow(/Unknown node type/);
  });
});
