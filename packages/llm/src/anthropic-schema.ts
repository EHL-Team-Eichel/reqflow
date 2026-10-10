type JsonSchema = Record<string, unknown>;

const FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);
const ANNOTATIONS = new Set([
  "type",
  "title",
  "description",
  "enum",
  "const",
  "default",
  "required",
]);
const LOCAL_CONSTRAINTS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "propertyNames",
]);

/**
 * Transport only the documented Anthropic subset. Original Zod validation remains authoritative.
 * Unsupported scalar/array constraints become descriptions, matching SDK transformation behavior.
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations
 */
export function anthropicSchema(original: JsonSchema): JsonSchema {
  const output: JsonSchema = {};
  const constraints: string[] = [];
  for (const [key, value] of Object.entries(original)) {
    if (key === "$schema") continue;
    if (
      LOCAL_CONSTRAINTS.has(key) ||
      (key === "minItems" && value !== 0 && value !== 1) ||
      (key === "format" && !FORMATS.has(value as string))
    ) {
      constraints.push(`${key}: ${JSON.stringify(value)}`);
    } else if (ANNOTATIONS.has(key) || key === "format" || key === "minItems") {
      if (
        key === "enum" &&
        (value as unknown[]).some(
          (item) => item !== null && !["string", "number", "boolean"].includes(typeof item),
        )
      ) {
        throw new Error("Anthropic structured outputs do not support complex enum values");
      }
      output[key] = value;
    } else if (key === "properties" || key === "$defs" || key === "definitions") {
      output[key] = Object.fromEntries(
        Object.entries(value as Record<string, JsonSchema>).map(([name, schema]) => [
          name,
          anthropicSchema(schema),
        ]),
      );
    } else if (key === "items") {
      output.items = anthropicSchema(value as JsonSchema);
    } else if (key === "anyOf" || key === "allOf") {
      const alternatives = value as JsonSchema[];
      if (key === "allOf" && alternatives.some((schema) => "$ref" in schema)) {
        throw new Error("Anthropic structured outputs do not support allOf with $ref");
      }
      output[key] = alternatives.map(anthropicSchema);
    } else if (key === "$ref") {
      if (typeof value !== "string" || !value.startsWith("#/")) {
        throw new Error("Anthropic structured outputs do not support external references");
      }
      output.$ref = value;
    } else if (key === "additionalProperties") {
      if (typeof value === "object") {
        throw new Error(
          "Anthropic structured outputs require explicit object properties; schema-valued additionalProperties is unsupported",
        );
      }
      output.additionalProperties = false;
    } else {
      throw new Error(`Unsupported Anthropic schema keyword ${key}`);
    }
  }
  if (
    output.type === "object" ||
    output.properties ||
    (Array.isArray(output.type) && output.type.includes("object"))
  ) {
    output.additionalProperties = false;
  }
  if (constraints.length) {
    output.description = [
      output.description,
      `Local validation constraints: {${constraints.join(", ")}}.`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return output;
}
