import { describe, expect, it } from "vitest";
import { z } from "zod";
import { googleSchema } from "./google-schema";
import type { JsonSchema } from "./json-schema";
import { openaiSchema } from "./openai-schema";

describe("provider-specific schema adapters", () => {
  it("adapts shared definitions and removes only optional nonnullable fields through references", () => {
    const child = z
      .strictObject({ missing: z.string().optional(), keep: z.string().nullable().optional() })
      .meta({ id: "test-shared-child" });
    const original = z.strictObject({ a: child, b: child.optional() });
    const json = z.toJSONSchema(original);
    const before = JSON.stringify(json);
    const adapted = openaiSchema(json);
    expect(adapted.schema).toMatchObject({
      properties: {
        a: { $ref: "#/$defs/test-shared-child" },
        b: { anyOf: [{ $ref: "#/$defs/test-shared-child" }, { type: "null" }] },
      },
      required: ["a", "b"],
      $defs: {
        "test-shared-child": { required: ["missing", "keep"], additionalProperties: false },
      },
    });
    const candidates = [...adapted.values({ a: { missing: null, keep: null }, b: null })];
    expect(candidates).toContainEqual({ a: { keep: null } });
    expect(JSON.stringify(json)).toBe(before);
  });

  it("handles recursive root refs without changing nullable/required values", () => {
    interface Tree {
      optional?: string;
      required: string | null;
      children: Tree[];
    }
    const tree: z.ZodType<Tree> = z.lazy(() =>
      z.strictObject({
        optional: z.string().optional(),
        required: z.string().nullable(),
        children: z.array(tree),
      }),
    );
    const adapted = openaiSchema(z.toJSONSchema(tree));
    expect(adapted.schema).toMatchObject({ properties: { children: { items: { $ref: "#" } } } });
    const raw = {
      optional: null,
      required: null,
      children: [{ optional: null, required: "keep", children: [] }],
    };
    const normalized = [...adapted.values(raw)].find((value) => tree.safeParse(value).success);
    expect(normalized).toEqual({ required: null, children: [{ required: "keep", children: [] }] });
    expect(raw.optional).toBeNull();
  });

  it("hoists recursive defs when enveloping an array root", () => {
    interface Tree {
      optional?: string;
      children: Tree[];
    }
    const tree: z.ZodType<Tree> = z.lazy(() =>
      z.strictObject({ optional: z.string().optional(), children: z.array(tree) }),
    );
    const original = z.array(tree);
    const adapted = openaiSchema(z.toJSONSchema(original));
    const wire = adapted.schema as JsonSchema;
    expect(wire.$defs).toBeDefined();
    expect((wire.properties as Record<string, JsonSchema>).result!.$defs).toBeUndefined();
    const normalized = [
      ...adapted.values({
        result: [{ optional: null, children: [{ optional: null, children: [] }] }],
      }),
    ].find((value) => original.safeParse(value).success);
    expect(normalized).toEqual([{ children: [{ children: [] }] }]);
  });

  it("rewrites recursive root pointers inside a union envelope", () => {
    const json: JsonSchema = {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: { child: { $ref: "#" } },
          required: ["child"],
          additionalProperties: false,
        },
      ],
    };
    expect(openaiSchema(json).schema).toMatchObject({
      properties: {
        result: {
          anyOf: [
            { type: "string" },
            { type: "object", properties: { child: { $ref: "#/properties/result" } } },
          ],
        },
      },
    });
  });

  it("preserves genuinely nullable reference fields", () => {
    const json: JsonSchema = {
      type: "object",
      properties: {
        nullable: { $ref: "#/$defs/nullable" },
        nonnullable: { $ref: "#/$defs/nonnullable" },
      },
      $defs: {
        nullable: { anyOf: [{ type: "string" }, { type: "null" }] },
        nonnullable: { type: "string" },
      },
      additionalProperties: false,
    };
    const adapted = openaiSchema(json);
    expect([...adapted.values({ nullable: null, nonnullable: null })]).toContainEqual({
      nullable: null,
    });
    expect(adapted.schema).toMatchObject({
      properties: { nullable: { $ref: "#/$defs/nullable" } },
    });
  });

  it("keeps union alternatives available for original Zod refinements", () => {
    const union = z.union([
      z
        .strictObject({ x: z.string().optional(), y: z.string().nullable().optional() })
        .refine(() => false),
      z.strictObject({ x: z.string().nullable().optional(), y: z.string().optional() }),
    ]);
    const original = z.strictObject({ item: union, outer: z.string().optional() });
    const raw = { item: { x: null, y: null }, outer: null };
    const normalized = [...openaiSchema(z.toJSONSchema(original)).values(raw)].find(
      (value) => original.safeParse(value).success,
    );
    expect(normalized).toEqual({ item: { x: null } });
  });

  it.each(["openai", "google"] as const)(
    "rejects unsupported structural schemas for %s",
    (provider) => {
      const adapt = provider === "openai" ? openaiSchema : googleSchema;
      for (const json of [
        { allOf: [{ type: "string" }, { type: "number" }] },
        { $ref: "https://example.test/schema" },
        { $ref: "#/$defs/missing" },
        { type: "string", enum: [{ complex: true }] },
        {},
      ])
        expect(() => adapt(json)).toThrow();
    },
  );

  it("converts legacy definitions refs without changing normalization pointers", () => {
    const json: JsonSchema = {
      type: "object",
      properties: { value: { $ref: "#/definitions/value" } },
      definitions: { value: { type: "string" } },
      additionalProperties: false,
    };
    const adapted = openaiSchema(json);
    expect(adapted.schema).toMatchObject({
      properties: { value: { anyOf: [{ $ref: "#/$defs/value" }, { type: "null" }] } },
      $defs: { value: { type: "string" } },
    });
    expect([...adapted.values({ value: null })]).toContainEqual({});
    expect(googleSchema(json)).toMatchObject({
      properties: { value: { $ref: "#/$defs/value" } },
      $defs: { value: { type: "string" } },
    });
  });

  it("Google retains supported bounds, keeps array caps local, and adapts const/unions without optional null rewriting", () => {
    const original = z.strictObject({
      value: z
        .string()
        .min(3)
        .max(8)
        .regex(/^hello/),
      count: z.number().min(1).max(3),
      rows: z.array(z.string()).min(2).max(4),
      choice: z
        .discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("a") }),
          z.strictObject({ kind: z.literal("b") }),
        ])
        .optional(),
    });
    const adapted = googleSchema(z.toJSONSchema(original));
    expect(adapted).toMatchObject({
      required: ["value", "count", "rows"],
      properties: {
        value: { type: "string", description: expect.stringContaining("minLength: 3") },
        count: { minimum: 1, maximum: 3 },
        rows: { minItems: 2, description: expect.stringContaining("maxItems: 4") },
        choice: {
          anyOf: [
            { properties: { kind: { enum: ["a"] } } },
            { properties: { kind: { enum: ["b"] } } },
          ],
        },
      },
    });
    expect((adapted.properties as Record<string, JsonSchema>).value!.minLength).toBeUndefined();
    // Gemini rejects array caps with HTTP 400; they are checked locally instead.
    expect((adapted.properties as Record<string, JsonSchema>).rows!.maxItems).toBeUndefined();
  });

  it("Google preserves supported schema-valued additionalProperties for records", () => {
    const original = z.record(z.string().min(2), z.number().min(1));
    expect(googleSchema(z.toJSONSchema(original))).toMatchObject({
      type: "object",
      additionalProperties: { type: "number", minimum: 1 },
      description: expect.stringContaining("propertyNames"),
    });
    expect(() => openaiSchema(z.toJSONSchema(original))).toThrow();
  });
});
