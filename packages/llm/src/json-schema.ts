export type JsonSchema = Record<string, unknown>;

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Resolve local JSON pointers against the original document, including recursive root references. */
export function resolveSchema(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const seen = new Set<string>();
  while (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if ((ref !== "#" && !ref.startsWith("#/")) || seen.has(ref)) {
      throw new Error("Unsupported schema reference");
    }
    seen.add(ref);
    let target: unknown = root;
    for (const token of ref === "#" ? [] : ref.slice(2).split("/")) {
      const name = token.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isObject(target) || !Object.hasOwn(target, name)) {
        throw new Error("Unsupported schema reference");
      }
      target = target[name];
    }
    if (!isObject(target)) throw new Error("Unsupported schema reference");
    const { $ref: _, ...siblings } = schema;
    schema = { ...target, ...siblings };
  }
  return schema;
}

export function allowsNull(schema: JsonSchema, root: JsonSchema): boolean {
  schema = resolveSchema(schema, root);
  return (
    schema.type === "null" ||
    (Array.isArray(schema.type) && schema.type.includes("null")) ||
    schema.const === null ||
    (Array.isArray(schema.enum) && schema.enum.includes(null)) ||
    (Array.isArray(schema.anyOf) && schema.anyOf.some((branch) => allowsNull(branch, root))) ||
    (Array.isArray(schema.oneOf) && schema.oneOf.some((branch) => allowsNull(branch, root)))
  );
}

export const LOCAL_CONSTRAINTS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "propertyNames",
]);

export function scalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

export function addLocalConstraints(output: JsonSchema, constraints: string[]): void {
  if (constraints.length) {
    output.description = [
      output.description,
      `Local validation constraints: {${constraints.join(", ")}}.`,
    ]
      .filter(Boolean)
      .join(" ");
  }
}
