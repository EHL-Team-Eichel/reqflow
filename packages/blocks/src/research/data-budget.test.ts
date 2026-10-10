import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "./provider";
import {
  assertJsonByteBudget,
  jsonByteSize,
  PERSISTED_JSON_MAX_BYTES,
  RESEARCH_DATASET_MAX_BYTES,
} from "./data-budget";

describe("JSON byte budgets", () => {
  it("defines bounded collection and persisted JSON limits", () => {
    expect(RESEARCH_DATASET_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(PERSISTED_JSON_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it.each([
    null,
    true,
    false,
    0,
    -0,
    -123.456,
    1e30,
    Number.MIN_VALUE,
    Infinity,
    -Infinity,
    NaN,
    "",
    'quoted " and backslash \\ /',
    "中文 — café 😀\u2028\u2029",
    "\ud800a\udfff\ud800\udfff",
    String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)),
    [],
    {},
    [null, undefined, , false, { omitted: undefined, kept: "yes" }],
    { 'escaped\n"key': [1, "二"], nested: { value: true }, omitted: undefined },
    Object.assign(Object.create(null), { value: "plain JSON" }),
  ])("counts exact UTF-8 JSON bytes for case %#", (value) => {
    const expected = Buffer.byteLength(JSON.stringify(value), "utf8");
    expect(jsonByteSize(value)).toBe(expected);
    expect(() => assertJsonByteBudget(value, expected)).not.toThrow();
    expect(() => assertJsonByteBudget(value, expected - 1)).toThrow(ProviderError);
  });

  it("counts shared references each time rather than deduplicating their serialized bytes", () => {
    const shared = { headers: ["synthetic header"], nested: { value: 7 } };
    const value = { metadata: shared, fields: { original: shared }, records: [shared, shared] };
    expect(jsonByteSize(value)).toBe(Buffer.byteLength(JSON.stringify(value)));
  });

  it("ignores non-enumerable and symbol properties just like JSON", () => {
    const value = { kept: "yes", [Symbol("ignored")]: "not serialized" };
    Object.defineProperty(value, "hidden", { value: "not serialized" });
    expect(jsonByteSize(value)).toBe(Buffer.byteLength(JSON.stringify(value)));
  });

  it("rejects an amplified dataset without building its JSON string", () => {
    const header = "synthetic header ".padEnd(3 * 1024 * 1024, "H");
    const original = { [header]: header };
    const record = { metadata: original, fields: { original } };
    const value = Array.from({ length: 50 }, () => record);
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(() => assertJsonByteBudget(value, RESEARCH_DATASET_MAX_BYTES)).toThrow(
        expect.objectContaining({ code: "limit_reached" }),
      );
      expect(() => jsonByteSize(value, RESEARCH_DATASET_MAX_BYTES)).toThrow(ProviderError);
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it("stops on a sparse array's minimum size instead of visiting every slot", () => {
    expect(() => assertJsonByteBudget(new Array(1_000_000_000), 1024)).toThrow(ProviderError);
  });

  it("counts inherited array slots without calling inherited accessors", () => {
    const getter = vi.fn(() => "private");
    Object.defineProperty(Array.prototype, "10000", {
      configurable: true,
      writable: true,
      value: "inherited",
    });
    try {
      const value = new Array(10001);
      expect(jsonByteSize(value)).toBe(Buffer.byteLength(JSON.stringify(value)));
      Object.defineProperty(Array.prototype, "10000", { configurable: true, get: getter });
      expect(() => assertJsonByteBudget(value, 128 * 1024)).toThrow(ProviderError);
      expect(getter).not.toHaveBeenCalled();
    } finally {
      delete Array.prototype[10000];
    }
  });

  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid budget %s with a sanitized limit error",
    (budget) => {
      expect(() => assertJsonByteBudget(null, budget)).toThrow(
        expect.objectContaining({ code: "limit_reached" }),
      );
    },
  );

  it("allows at most 100 nested containers", () => {
    let value: unknown = null;
    for (let depth = 0; depth < 100; depth++) value = [value];
    expect(jsonByteSize(value)).toBe(204);
    expect(() => assertJsonByteBudget([value], 1024)).toThrow(/depth/i);
  });

  it("rejects cycles without exposing property names or raw values", () => {
    const value: Record<string, unknown> = { SYNTHETIC_PRIVATE_VALUE: "not for logs" };
    value.self = value;
    expect(() => assertJsonByteBudget(value, 1024)).toThrow(
      expect.objectContaining({ code: "limit_reached" }),
    );
    try {
      jsonByteSize(value);
    } catch (error) {
      expect(String(error)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
      expect(String(error)).not.toContain("not for logs");
    }
  });

  it.each([undefined, 1n, Symbol("private"), () => "private", new Date(), new Map(), /private/])(
    "rejects non-JSON values for case %#",
    (value) => {
      expect(() => assertJsonByteBudget(value, 1024)).toThrow(ProviderError);
    },
  );

  it("never invokes toJSON, getters, functions, or proxy traps", () => {
    const call = vi.fn(() => "synthetic private value");
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: call });
    const hiddenToJSON = Object.defineProperty({}, "toJSON", { value: call });
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          call();
          return null;
        },
        ownKeys() {
          call();
          return [];
        },
      },
    );
    for (const value of [{ toJSON: call }, hiddenToJSON, accessor, { value: call }, proxy])
      expect(() => assertJsonByteBudget(value, 1024)).toThrow(ProviderError);
    expect(call).not.toHaveBeenCalled();
  });
});
