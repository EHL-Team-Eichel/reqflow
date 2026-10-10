import { Buffer } from "node:buffer";
import { types } from "node:util";
import { ProviderError } from "./provider";

export const RESEARCH_DATASET_MAX_BYTES = 16 * 1024 * 1024;
export const PERSISTED_JSON_MAX_BYTES = 64 * 1024 * 1024;
const MAX_JSON_DEPTH = 100;

function fail(message: string): never {
  // Never include a property name, source value, or serialization exception in this error.
  throw new ProviderError("limit_reached", message);
}

/**
 * Count compact JSON's UTF-8 bytes without constructing its serialized string.
 * An optional ceiling stops traversal as soon as the budget is exceeded.
 * Accept only inert JSON data: no proxies, accessors, custom prototypes, or toJSON hooks.
 * Object undefined properties are omitted; array holes/undefined become null.
 */
export function jsonByteSize(value: unknown, maxBytes = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    fail("JSON byte budget must be a nonnegative safe integer.");

  let bytes = 0;
  const active = new WeakSet<object>();
  const strings = new Map<string, number>();
  const add = (count: number) => {
    if (count > maxBytes - bytes) fail("Raw JSON byte budget exceeded.");
    bytes += count;
  };
  const quotedString = (text: string) => {
    const cached = strings.get(text);
    if (cached !== undefined) {
      add(cached);
      return;
    }
    const start = bytes;
    add(2 + Buffer.byteLength(text, "utf8"));
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 0x22 || code === 0x5c) add(1);
      else if (code < 0x20)
        add(code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 1 : 5);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) index++;
        else add(3); // UTF-8 replacement is 3 bytes; JSON's escaped lone surrogate is 6.
      } else if (code >= 0xdc00 && code <= 0xdfff) add(3);
    }
    strings.set(text, bytes - start);
  };
  const visit = (current: unknown, depth: number): void => {
    if (current === null) {
      add(4);
      return;
    }
    switch (typeof current) {
      case "string":
        quotedString(current);
        return;
      case "boolean":
        add(current ? 4 : 5);
        return;
      case "number":
        add(Number.isFinite(current) ? String(current).length : 4);
        return;
      case "object":
        break;
      default:
        fail("JSON byte budget requires supported JSON data.");
    }

    if (depth >= MAX_JSON_DEPTH) fail("JSON byte budget nesting depth limit exceeded.");
    if (types.isProxy(current)) fail("JSON byte budget does not support executable data.");
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype))
      fail("JSON byte budget requires plain objects and arrays.");
    for (const owner of [current, prototype, array ? Object.prototype : null]) {
      if (!owner) continue;
      const hook = Object.getOwnPropertyDescriptor(owner, "toJSON");
      if (hook && (!("value" in hook) || typeof hook.value === "function"))
        fail("JSON byte budget does not support executable data.");
    }
    if (active.has(current)) fail("JSON byte budget does not support cyclic data.");
    active.add(current);
    if (array) {
      // Charge all punctuation first. Huge sparse arrays fail before slot iteration.
      add(2 + Math.max(0, current.length - 1));
      for (let index = 0; index < current.length; index++) {
        let descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        // JSON also reads inherited indexed values for holes. Inspect descriptors, never
        // execute getters, so a polluted prototype cannot make this count too small.
        if (!descriptor && prototype !== null)
          descriptor =
            Object.getOwnPropertyDescriptor(prototype, String(index)) ??
            Object.getOwnPropertyDescriptor(Object.prototype, String(index));
        if (descriptor && !("value" in descriptor))
          fail("JSON byte budget does not support executable data.");
        if (!descriptor || descriptor.value === undefined) add(4);
        else visit(descriptor.value, depth + 1);
      }
    } else {
      add(2);
      let first = true;
      for (const key of Object.keys(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
        if (!("value" in descriptor)) fail("JSON byte budget does not support executable data.");
        if (descriptor.value === undefined) continue;
        if (!first) add(1);
        first = false;
        quotedString(key);
        add(1);
        visit(descriptor.value, depth + 1);
      }
    }
    active.delete(current);
  };
  visit(value, 0);
  return bytes;
}

export function assertJsonByteBudget(value: unknown, maxBytes: number): void {
  jsonByteSize(value, maxBytes);
}
