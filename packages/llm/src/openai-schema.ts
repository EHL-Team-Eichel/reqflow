import {
  addLocalConstraints,
  allowsNull,
  isObject,
  LOCAL_CONSTRAINTS,
  resolveSchema,
  scalar,
  type JsonSchema,
} from "./json-schema";

/** Strict wire schema and schema-aware decoding; neither replaces original Zod validation. */
export function openaiSchema(original: JsonSchema) {
  const wrapped =
    original.type !== "object" || Array.isArray(original.anyOf) || Array.isArray(original.oneOf);
  function adapt(schema: JsonSchema): JsonSchema {
    if (!isObject(schema)) throw new Error("Unsupported OpenAI schema");
    const output: JsonSchema = {};
    const constraints: string[] = [];
    const object =
      schema.type === "object" ||
      isObject(schema.properties) ||
      (Array.isArray(schema.type) && schema.type.includes("object"));
    if (
      object &&
      schema.additionalProperties !== undefined &&
      schema.additionalProperties !== false
    ) {
      // Records/passthrough objects cannot faithfully meet the strict explicit-property contract.
      throw new Error("Unsupported OpenAI object schema");
    }
    for (const [key, value] of Object.entries(schema)) {
      if (
        key === "$schema" ||
        key === "default" ||
        key === "required" ||
        key === "additionalProperties"
      )
        continue;
      if (LOCAL_CONSTRAINTS.has(key)) {
        constraints.push(`${key}: ${JSON.stringify(value)}`);
      } else if (key === "type" || key === "title" || key === "description") {
        output[key] = value;
      } else if (key === "const" || key === "enum") {
        const values = key === "const" ? [value] : value;
        if (!Array.isArray(values) || !values.length || !values.every(scalar))
          throw new Error("Unsupported OpenAI enum");
        output.enum = values;
      } else if (key === "properties") {
        const required = new Set(schema.required as string[] | undefined);
        output.properties = Object.fromEntries(
          Object.entries(value as Record<string, JsonSchema>).map(([name, child]) => {
            const adapted = adapt(child);
            return [
              name,
              !required.has(name) && !allowsNull(child, original)
                ? { anyOf: [adapted, { type: "null" }] }
                : adapted,
            ];
          }),
        );
      } else if (key === "$defs" || key === "definitions") {
        output.$defs = Object.fromEntries(
          Object.entries(value as Record<string, JsonSchema>).map(([name, child]) => [
            name,
            adapt(child),
          ]),
        );
      } else if (key === "items") {
        output.items = adapt(value as JsonSchema);
      } else if (key === "anyOf" || key === "oneOf") {
        output.anyOf = (value as JsonSchema[]).map(adapt);
      } else if (key === "$ref") {
        // Validate now so unsupported/unresolved references never trigger HTTP.
        resolveSchema(schema, original);
        let ref = (value as string).replace(/^#\/definitions\//, "#/$defs/");
        if (wrapped && ref !== "#/$defs" && !ref.startsWith("#/$defs/")) {
          ref = ref === "#" ? "#/properties/result" : `#/properties/result/${ref.slice(2)}`;
        }
        output.$ref = ref;
      } else {
        throw new Error("Unsupported OpenAI schema keyword");
      }
    }
    if (object) {
      output.properties ??= {};
      output.required = Object.keys(output.properties as JsonSchema);
      output.additionalProperties = false;
    }
    if (!output.type && !output.$ref && !output.anyOf && !output.enum)
      throw new Error("Unsupported OpenAI schema type");
    addLocalConstraints(output, constraints);
    return output;
  }

  const adapted = adapt(original);
  const { $defs, ...inner } = adapted;
  const schema = wrapped
    ? {
        type: "object",
        properties: { result: inner },
        required: ["result"],
        additionalProperties: false,
        ...($defs ? { $defs } : {}),
      }
    : adapted;

  return {
    schema,
    *values(raw: unknown): Generator<unknown> {
      if (wrapped) {
        if (!isObject(raw) || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, "result")) {
          throw new Error("Invalid structured response envelope");
        }
        raw = raw.result;
      }
      // Prefer the untouched value. In ambiguous unions, legitimate nullable values remain null.
      yield raw;
      yield* normalize(original, raw, original);
    },
  };
}

/** Shape matching selects union branches without relaxing original bounds or refinements. */
function matches(schema: JsonSchema, value: unknown, root: JsonSchema): boolean {
  schema = resolveSchema(schema, root);
  if (schema.anyOf || schema.oneOf)
    return ((schema.anyOf ?? schema.oneOf) as JsonSchema[]).some((branch) =>
      matches(branch, value, root),
    );
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (
    schema.type &&
    !types.some((type) =>
      type === "null"
        ? value === null
        : type === "object"
          ? isObject(value)
          : type === "array"
            ? Array.isArray(value)
            : type === "integer"
              ? Number.isInteger(value)
              : typeof value === type,
    )
  )
    return false;
  if (isObject(value) && schema.properties) {
    const properties = schema.properties as Record<string, JsonSchema>;
    const required = new Set(schema.required as string[] | undefined);
    if ([...required].some((name) => !Object.hasOwn(value, name))) return false;
    return Object.entries(value).every(([name, child]) => {
      if (!Object.hasOwn(properties, name)) return schema.additionalProperties !== false;
      return (
        (child === null && !required.has(name) && !allowsNull(properties[name]!, root)) ||
        matches(properties[name]!, child, root)
      );
    });
  }
  if (Array.isArray(value) && schema.items)
    return value.every((child) => matches(schema.items as JsonSchema, child, root));
  return true;
}

/** Lazy products avoid an eager explosion for arrays of unions; caller caps validation attempts. */
function* combinations<T>(
  items: T[],
  choices: (item: T) => Generator<unknown>,
): Generator<unknown[]> {
  if (!items.length) {
    yield [];
    return;
  }
  const iterators: (Generator<unknown> | undefined)[] = [];
  const values: unknown[] = [];
  let index = 0;
  while (index >= 0) {
    const iterator = (iterators[index] ??= choices(items[index]!));
    const next = iterator.next();
    if (next.done) {
      iterators[index] = undefined;
      index--;
    } else {
      values[index] = next.value;
      if (index === items.length - 1) yield values.slice();
      else {
        index++;
        iterators[index] = undefined;
      }
    }
  }
}

function* normalize(schema: JsonSchema, value: unknown, root: JsonSchema): Generator<unknown> {
  schema = resolveSchema(schema, root);
  if (Array.isArray(schema.anyOf ?? schema.oneOf)) {
    const seen = new Set<string>();
    for (const branch of (schema.anyOf ?? schema.oneOf) as JsonSchema[]) {
      if (!matches(branch, value, root)) continue;
      for (const candidate of normalize(branch, value, root)) {
        const key = JSON.stringify(candidate);
        if (!seen.has(key)) {
          seen.add(key);
          yield candidate;
        }
      }
    }
  } else if (isObject(value) && schema.properties) {
    const properties = schema.properties as Record<string, JsonSchema>;
    const required = new Set(schema.required as string[] | undefined);
    const entries = Object.entries(value).filter(
      ([name, child]) =>
        !(
          child === null &&
          Object.hasOwn(properties, name) &&
          !required.has(name) &&
          !allowsNull(properties[name]!, root)
        ),
    );
    for (const children of combinations(entries, function* ([name, child]) {
      if (Object.hasOwn(properties, name)) yield* normalize(properties[name]!, child, root);
      else yield child;
    })) {
      yield Object.fromEntries(entries.map(([name], index) => [name, children[index]]));
    }
  } else if (Array.isArray(value) && schema.items) {
    yield* combinations(value, (child) => normalize(schema.items as JsonSchema, child, root));
  } else {
    yield value;
  }
}
