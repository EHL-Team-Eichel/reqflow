import { describe, expect, it } from "vitest";
import { validateIds } from "./protocol";

describe("model response ID validation", () => {
  it("reports unknown and duplicate IDs by index without echoing model-supplied content", () => {
    const untrusted = "rec_synthetic private excerpt placed in an ID";
    for (const validate of [
      () => validateIds([{ id: untrusted }], ["rec_expected"]),
      () => validateIds([{ id: untrusted }, { id: untrusted }], [untrusted]),
    ]) {
      try {
        validate();
        throw new Error("Expected invalid assignments to fail");
      } catch (error) {
        expect((error as Error).message).toMatch(/assignment ID at response index \d/);
        expect((error as Error).message).not.toContain(untrusted);
      }
    }
  });
  it("reports missing coverage using only counts", () => {
    expect(() => validateIds([], ["rec_synthetic-private-data"])).toThrow(
      "missing assignments for 1 primary items",
    );
  });
});
