import { describe, expect, it } from "vitest";
import { CAR_PARTS } from "./parts";
import { menuCount, PART_SUBCLASSES, subclassParts } from "./partMenu";

describe("car parts submenu", () => {
  it("includes every detailed part exactly once, even without requirements", () => {
    const ids = PART_SUBCLASSES.flatMap((subclass) => subclass.partIds);
    expect([...ids].sort()).toEqual(CAR_PARTS.map((part) => part.id).sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps subclasses within their existing exterior, interior or technology section", () => {
    for (const subclass of PART_SUBCLASSES) {
      const parts = subclassParts(subclass);
      expect(parts.length).toBeGreaterThan(0);
      expect(parts.every((part) => part.group === subclass.group)).toBe(true);
    }
  });

  it("groups detailed door and seat parts beneath general subclasses", () => {
    expect(PART_SUBCLASSES.find((s) => s.id === "doors")?.partIds).toEqual([
      "front_doors",
      "rear_doors",
      "door_handles",
    ]);
    expect(PART_SUBCLASSES.find((s) => s.id === "seats")?.partIds).toEqual(
      expect.arrayContaining([
        "front_seats",
        "rear_seats",
        "driver_seat",
        "passenger_seat",
        "rear_left_seat",
        "rear_center_seat",
        "rear_right_seat",
        "headrests",
        "seat_belts",
      ]),
    );
  });

  it("totals only the descendant requirements and treats missing counts as zero", () => {
    const counts = new Map([
      ["front_doors", 2],
      ["door_handles", 3],
      ["front_seats", 7],
    ]);
    const doors = PART_SUBCLASSES.find((s) => s.id === "doors")!;
    expect(menuCount(doors.partIds, counts)).toBe(5);
    expect(menuCount(doors.partIds, new Map())).toBe(0);
  });

  it("reports invalid navigation IDs rather than silently omitting a part", () => {
    expect(() =>
      subclassParts({ id: "invalid", label: "Invalid", group: "exterior", partIds: ["missing"] }),
    ).toThrow("Unknown car part in invalid: missing");
  });
});
