import { expect, test } from "vitest";
import { layoutLineage } from "./layout";
import { type Lineage } from "@reqflow/core";

test("layoutLineage", () => {
  const mockBlock = (id: string) => ({ block: { id }, path: [], distance: 0 }) as any;

  const lineage: Lineage = {
    targetId: "t1",
    steps: [
      { ...mockBlock("t1"), distance: 0 },
      { ...mockBlock("s1"), distance: 1 },
      { ...mockBlock("s2"), distance: 1 },
      { ...mockBlock("s3"), distance: 2 },
    ],
    links: [],
  };

  const positions = layoutLineage(lineage);

  // target is right-most
  expect(positions["t1"]!.x).toBe(600);
  expect(positions["t1"]!.y).toBe(0);

  // distance 1 is middle
  expect(positions["s1"]!.x).toBe(300);
  expect(positions["s2"]!.x).toBe(300);

  // y spacing is 150, centered on 0 (2 elements -> -75, 75)
  expect(positions["s1"]!.y).toBe(-75);
  expect(positions["s2"]!.y).toBe(75);

  // distance 2 is left
  expect(positions["s3"]!.x).toBe(0);
  expect(positions["s3"]!.y).toBe(0);

  // no two steps share a position
  const posStrings = Object.values(positions).map((p) => `${p.x},${p.y}`);
  expect(new Set(posStrings).size).toBe(4);
});
