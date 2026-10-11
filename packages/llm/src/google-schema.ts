import {
  addLocalConstraints,
  isObject,
  LOCAL_CONSTRAINTS,
  resolveSchema,
  scalar,
  type JsonSchema,
} from "./json-schema";

const SUPPORTED = new Set([
  "type",
  "title",
  "description",
  "required",
  "format",
  "minimum",
  "maximum",
  "minItems",
]);

/**
 * Gemini's responseJsonSchema subset. Unsupported constraints stay enforced locally (the caller's
 * Zod schema validates every answer) and are named in the description. `maxItems` is one of them:
 * gemini-3.8-flash answers "Request contains an invalid argument" (HTTP 400) to array caps such as
 * the PDF extractor's 100 items or the AI Splitter's catalogs, while `minItems` is accepted.
 */
export function googleSchema(original: JsonSchema): JsonSchema {
  function adapt(schema: JsonSchema): JsonSchema {
    if (!isObject(schema)) throw new Error("Unsupported Google schema");
    const output: JsonSchema = {};
    const constraints: string[] = [];
    for (const [key, value] of Object.entries(schema)) {
      if (key === "$schema" || key === "default") continue;
      if (SUPPORTED.has(key)) output[key] = value;
      else if (LOCAL_CONSTRAINTS.has(key)) constraints.push(`${key}: ${JSON.stringify(value)}`);
      else if (key === "const" || key === "enum") {
        const values = key === "const" ? [value] : value;
        if (!Array.isArray(values) || !values.length || !values.every(scalar))
          throw new Error("Unsupported Google enum");
        output.enum = values;
      } else if (key === "properties" || key === "$defs" || key === "definitions") {
        output[key === "definitions" ? "$defs" : key] = Object.fromEntries(
          Object.entries(value as Record<string, JsonSchema>).map(([name, child]) => [
            name,
            adapt(child),
          ]),
        );
      } else if (key === "items" || key === "additionalProperties") {
        output[key] = typeof value === "boolean" ? value : adapt(value as JsonSchema);
      } else if (key === "anyOf" || key === "oneOf" || key === "prefixItems") {
        output[key === "oneOf" ? "anyOf" : key] = (value as JsonSchema[]).map(adapt);
      } else if (key === "$ref") {
        resolveSchema(schema, original);
        output.$ref = (value as string).replace(/^#\/definitions\//, "#/$defs/");
      } else throw new Error("Unsupported Google schema keyword");
    }
    if (!output.type && !output.$ref && !output.anyOf && !output.enum)
      throw new Error("Unsupported Google schema type");
    addLocalConstraints(output, constraints);
    return output;
  }
  return adapt(original);
}
