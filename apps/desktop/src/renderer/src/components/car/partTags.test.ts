import { describe, expect, it } from "vitest";
import { CAR_PARTS, WHOLE_CAR } from "./parts";
import { partTag } from "./partTags";

describe("car point tags", () => {
  it.each([...CAR_PARTS, WHOLE_CAR])("keeps $id to a small, readable tag", (part) => {
    const tag = partTag(part.id);
    expect(tag.length).toBeGreaterThan(0);
    expect(tag.length).toBeLessThanOrEqual(16);
    expect(tag.split(/\s+/).length).toBeLessThanOrEqual(2);
    expect(tag).not.toMatch(/[&,.:]/);
  });

  it("simplifies the point without changing the detailed review name", () => {
    expect(partTag("kidney_grille")).toBe("Grille");
    expect(partTag("rear_seats")).toBe("Rear seats");
    expect(partTag("curved_display")).toBe("Display");
    expect(CAR_PARTS.find((part) => part.id === "kidney_grille")?.label).toBe(
      "Kidney grille & front design",
    );
  });

  it("uses a safe fallback for unknown points", () => {
    expect(partTag("unknown")).toBe("Part");
  });
});
