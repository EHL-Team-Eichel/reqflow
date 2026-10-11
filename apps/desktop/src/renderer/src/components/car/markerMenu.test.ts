import { describe, expect, it } from "vitest";
import { CAR_PARTS } from "./parts";
import { PART_SUBCLASSES } from "./partMenu";
import {
  initialMarkerMenu,
  menuGroup,
  menuPartIds,
  toggleMarkerMenu,
  markerPresentation,
} from "./markerMenu";

describe("menu-driven car markers", () => {
  it("starts with every menu closed and no active markings", () => {
    const state = initialMarkerMenu();
    expect(state.expanded.size).toBe(0);
    expect(menuPartIds(state.active)).toEqual([]);
  });

  it("activates every part in an opened group, independent of requirement counts", () => {
    const state = toggleMarkerMenu(initialMarkerMenu(), "exterior");
    expect([...state.expanded]).toEqual(["exterior"]);
    expect([...menuPartIds(state.active)].sort()).toEqual(
      CAR_PARTS.filter((p) => p.group === "exterior")
        .map((p) => p.id)
        .sort(),
    );
  });

  it("narrows to a subclass and restores the parent when that subclass closes", () => {
    const state = toggleMarkerMenu(toggleMarkerMenu(initialMarkerMenu(), "exterior"), "doors");
    expect(state.active).toBe("doors");
    expect(menuPartIds(state.active)).toEqual(["front_doors", "rear_doors", "door_handles"]);
    expect(toggleMarkerMenu(state, "doors").active).toBe("exterior");
  });

  it("closing a parent also closes its children and deactivates their markers", () => {
    const state = toggleMarkerMenu(toggleMarkerMenu(initialMarkerMenu(), "exterior"), "doors");
    expect(toggleMarkerMenu(state, "exterior")).toEqual(initialMarkerMenu());
  });

  it("keeps the active class when closing a different section", () => {
    const state = toggleMarkerMenu(toggleMarkerMenu(initialMarkerMenu(), "exterior"), "seats");
    expect(toggleMarkerMenu(state, "exterior").active).toBe("seats");
    expect(menuGroup("seats")).toBe("interior");
    expect(menuGroup("power_chassis")).toBe("technology");
  });

  it("shows text for zero through eight markers and blue points for nine or more", () => {
    const ids = CAR_PARTS.slice(0, 9).map((p) => p.id);
    const eligible = new Set(ids);
    for (let size = 0; size <= 8; size++) {
      expect(markerPresentation(ids.slice(0, size), eligible).compact).toBe(false);
    }
    expect(markerPresentation(ids, eligible).compact).toBe(true);
  });

  it("uses eligible distinct part markers, not duplicated entries or unavailable anchors", () => {
    const ids = CAR_PARTS.slice(0, 9).map((p) => p.id);
    const eligible = new Set(ids.slice(0, 8));
    expect(markerPresentation([...ids, ...ids], eligible)).toEqual({
      partIds: ids.slice(0, 8),
      compact: false,
    });
  });

  it("resolves every subclass without changing classification or inventing parts", () => {
    for (const subclass of PART_SUBCLASSES) {
      expect(menuPartIds(subclass.id)).toEqual(subclass.partIds);
    }
    expect(() => menuPartIds("invalid")).toThrow("Unknown car menu: invalid");
  });
});
