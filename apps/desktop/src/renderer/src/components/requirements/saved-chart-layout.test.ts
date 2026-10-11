import { describe, expect, it } from "vitest";
import { createBlock, type Lineage } from "@reqflow/core";
import { savedLineageLayout } from "./saved-chart-layout";

describe("saved option lineage layout", () => {
  it("keeps source-to-target order readable in a narrow overview", () => {
    const lineage: Lineage = {
      targetId: "car",
      links: [],
      steps: [0, 1, 2].map((distance) => ({
        block: createBlock(distance === 0 ? "add_to_car" : "raw", {
          id: distance === 0 ? "car" : `upstream${distance}`,
          position: { x: 0, y: 0 },
        }),
        path: [],
        distance,
      })),
    };
    const before = structuredClone(lineage);
    const layout = savedLineageLayout(lineage);
    expect(layout.car!.y).toBeGreaterThan(layout.upstream1!.y);
    expect(layout.upstream1!.y).toBeGreaterThan(layout.upstream2!.y);
    expect(new Set(Object.values(layout).map((point) => point.x)).size).toBe(1);
    expect(lineage).toEqual(before);
  });

  it("separates parallel source branches without overlapping step cards", () => {
    const lineage: Lineage = {
      targetId: "car",
      links: [],
      steps: ["car", "sourceA", "sourceB"].map((id) => ({
        block: createBlock(id === "car" ? "add_to_car" : "raw", { id, position: { x: 0, y: 0 } }),
        path: [],
        distance: id === "car" ? 0 : 1,
      })),
    };
    const layout = savedLineageLayout(lineage);
    expect(layout.sourceA!.y).toBe(layout.sourceB!.y);
    expect(Math.abs(layout.sourceA!.x - layout.sourceB!.x)).toBeGreaterThanOrEqual(300);
  });
});
