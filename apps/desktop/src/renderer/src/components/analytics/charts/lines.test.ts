import { describe, expect, it } from "vitest";
import { areaPath, linearScale, linePath, nearestIndex, nudgeLabels, thinLabels } from "./lines";

/** Small seeded generator, so the property checks are repeatable. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe("linearScale", () => {
  it("maps the domain onto the range, inverted for the y axis", () => {
    const y = linearScale([0, 10], [200, 0]);
    expect(y(0)).toBe(200);
    expect(y(5)).toBe(100);
    expect(y(10)).toBe(0);
  });

  it("maps a degenerate domain to the middle of the range", () => {
    expect(linearScale([3, 3], [0, 10])(3)).toBe(5);
  });
});

describe("linePath", () => {
  it("draws a move, then line segments through the points", () => {
    expect(
      linePath([
        { x: 0, y: 0 },
        { x: 10, y: 5 },
        { x: 20.5, y: 7.25 },
      ]),
    ).toBe("M0 0L10 5L20.5 7.25");
  });

  it("lifts the pen at a gap instead of drawing across it", () => {
    expect(
      linePath([{ x: 0, y: 0 }, { x: 10, y: 5 }, null, { x: 20, y: 5 }, { x: 30, y: 10 }]),
    ).toBe("M0 0L10 5M20 5L30 10");
  });

  it("is empty without drawable points", () => {
    expect(linePath([])).toBe("");
    expect(linePath([null, null])).toBe("");
  });
});

describe("areaPath", () => {
  it("closes the area down to the base line", () => {
    expect(
      areaPath(
        [
          { x: 0, y: 10 },
          { x: 10, y: 5 },
        ],
        20,
      ),
    ).toBe("M0 20L0 10L10 5L10 20Z");
  });

  it("draws nothing for single points separated by gaps", () => {
    expect(areaPath([{ x: 0, y: 1 }, null, { x: 5, y: 1 }], 10)).toBe("");
  });
});

describe("nearestIndex", () => {
  const xs = [10, 20, 30];

  it("finds the closest value", () => {
    expect(nearestIndex(xs, 14)).toBe(0);
    expect(nearestIndex(xs, 16)).toBe(1);
    expect(nearestIndex(xs, 29)).toBe(2);
  });

  it("clamps outside the range and breaks ties towards the earlier index", () => {
    expect(nearestIndex(xs, -5)).toBe(0);
    expect(nearestIndex(xs, 100)).toBe(2);
    expect(nearestIndex(xs, 25)).toBe(1);
  });

  it("returns -1 without values or for a non-number", () => {
    expect(nearestIndex([], 5)).toBe(-1);
    expect(nearestIndex(xs, Number.NaN)).toBe(-1);
  });
});

describe("thinLabels", () => {
  it("keeps every label when there is room", () => {
    expect(thinLabels(5, 400, 50)).toEqual([0, 1, 2, 3, 4]);
  });

  it("thins to every k-th label and keeps the last one", () => {
    expect(thinLabels(24, 600, 56)).toEqual([0, 3, 6, 9, 12, 15, 18, 23]);
  });

  it("labels only the ends when nothing else fits", () => {
    expect(thinLabels(10, 90, 1000)).toEqual([0, 9]);
  });

  it("handles one point and no points", () => {
    expect(thinLabels(1, 100, 50)).toEqual([0]);
    expect(thinLabels(0, 100, 50)).toEqual([]);
  });

  it("keeps labels at least the minimum gap apart whenever that is possible", () => {
    for (let count = 2; count <= 80; count += 3) {
      for (const width of [150, 320, 800]) {
        for (const gap of [10, 40, 90]) {
          const picked = thinLabels(count, width, gap);
          expect(picked[0]).toBe(0);
          expect(picked[picked.length - 1]).toBe(count - 1);
          for (let k = 1; k < picked.length; k++) {
            expect(picked[k]!).toBeGreaterThan(picked[k - 1]!);
          }
          if (width >= gap) {
            const slot = width / (count - 1);
            for (let k = 1; k < picked.length; k++) {
              expect((picked[k]! - picked[k - 1]!) * slot).toBeGreaterThanOrEqual(gap - 1e-9);
            }
          }
        }
      }
    }
  });
});

describe("nudgeLabels", () => {
  it("spreads labels that start at the same spot", () => {
    expect(nudgeLabels([100, 100, 100], 14, 0, 300)).toEqual([100, 114, 128]);
  });

  it("pulls a stack back inside the bottom edge", () => {
    expect(nudgeLabels([290, 292, 295], 10, 0, 300)).toEqual([280, 290, 300]);
  });

  it("returns the labels in the order they were given", () => {
    expect(nudgeLabels([295, 290, 292], 10, 0, 300)).toEqual([300, 280, 290]);
  });

  it("stacks from the top edge when the labels cannot all fit", () => {
    expect(nudgeLabels([0, 0, 0, 0], 20, 0, 30)).toEqual([0, 20, 40, 60]);
  });

  it("keeps order, gaps and bounds for feasible inputs", () => {
    const rand = rng(7);
    for (let round = 0; round < 200; round++) {
      const count = 1 + Math.floor(rand() * 6);
      const min = 0;
      const max = 200;
      const gap = rand() * (max / count);
      const ys = Array.from({ length: count }, () => rand() * max);
      const out = nudgeLabels(ys, gap, min, max);
      const byWanted = out.map((v, i) => ({ v, y: ys[i]! })).sort((a, b) => a.y - b.y);
      for (let k = 0; k < count; k++) {
        expect(byWanted[k]!.v).toBeGreaterThanOrEqual(min - 1e-9);
        expect(byWanted[k]!.v).toBeLessThanOrEqual(max + 1e-9);
        if (k > 0) expect(byWanted[k]!.v - byWanted[k - 1]!.v).toBeGreaterThanOrEqual(gap - 1e-9);
      }
    }
  });
});
