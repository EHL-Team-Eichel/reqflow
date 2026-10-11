import { describe, expect, it } from "vitest";
import {
  NO_BOX,
  OTHER_KEY,
  TAU,
  angularSpans,
  arcPath,
  bandLayout,
  estimateTextWidth,
  finiteOrZero,
  fitLabel,
  foldOther,
  groupLayout,
  hoverAnchor,
  isActivationKey,
  labelsFit,
  ratio,
  topRoundedBarPath,
} from "./bars";

describe("band and group layout", () => {
  it("splits the width into equal bands with half the padding at each end", () => {
    expect(bandLayout(3, 300, 0.2)).toEqual({ step: 100, bandwidth: 80, start: 10 });
    const layout = bandLayout(4, 400, 0.3);
    const lastEnd = layout.start + 3 * layout.step + layout.bandwidth;
    expect(layout.start).toBeCloseTo(400 - lastEnd, 9);
  });

  it("returns empty geometry for no bands or no width", () => {
    expect(bandLayout(0, 300)).toEqual({ step: 0, bandwidth: 0, start: 0 });
    expect(bandLayout(3, 0)).toEqual({ step: 0, bandwidth: 0, start: 0 });
  });

  it("centres a group of bars in its band, with the gap between bars", () => {
    const layout = groupLayout(3, 60, 2, 24);
    expect(layout.barWidth).toBeCloseTo(56 / 3, 9);
    expect(layout.offsets[0]).toBeCloseTo(0, 9);
    expect(layout.offsets[1]).toBeCloseTo(56 / 3 + 2, 9);
    expect(layout.offsets[2]).toBeCloseTo(2 * (56 / 3 + 2), 9);
  });

  it("caps bar thickness so bars stay thin in a wide band", () => {
    const layout = groupLayout(2, 100, 2, 24);
    expect(layout.barWidth).toBe(24);
    expect(layout.offsets).toEqual([25, 51]);
  });
});

describe("arcPath", () => {
  it("draws a quarter ring from 12 to 3 o'clock, clockwise", () => {
    expect(arcPath(100, 100, 50, 40, 0, Math.PI / 2)).toBe(
      "M 100 50 A 50 50 0 0 1 150 100 L 140 100 A 40 40 0 0 0 100 60 Z",
    );
  });

  it("draws a pie slice when the inner radius is zero", () => {
    expect(arcPath(100, 100, 50, 0, 0, Math.PI / 2)).toBe(
      "M 100 100 L 100 50 A 50 50 0 0 1 150 100 Z",
    );
  });

  it("sets the large-arc flag for slices over a half turn", () => {
    expect(arcPath(0, 0, 10, 5, 0, (3 * Math.PI) / 2)).toContain("A 10 10 0 1 1");
  });

  it("draws a full ring as two half-rings so it still renders", () => {
    const ring = arcPath(100, 100, 50, 40, 0, TAU);
    expect(ring.match(/Z/g)).toHaveLength(2);
    expect(ring.match(/ A /g)).toHaveLength(4);
    expect(ring).toContain("M 100 50 A 50 50 0 0 1 100 150");
    expect(ring).toContain("M 100 150 A 50 50 0 0 1 100 50");
  });

  it("returns nothing for an empty or inverted span", () => {
    expect(arcPath(100, 100, 50, 40, 1, 1)).toBe("");
    expect(arcPath(100, 100, 50, 40, 2, 1)).toBe("");
  });
});

describe("angularSpans", () => {
  it("splits the turn in proportion, clockwise from 12 o'clock", () => {
    const spans = angularSpans([1, 0, 3]);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toEqual({ index: 0, start: 0, end: TAU / 4 });
    expect(spans[1]?.index).toBe(2);
    expect(spans[1]?.start).toBeCloseTo(TAU / 4, 9);
    expect(spans[1]?.end).toBe(TAU);
  });

  it("gives no spans when nothing is positive", () => {
    expect(angularSpans([0, 0])).toEqual([]);
    expect(angularSpans([])).toEqual([]);
    expect(angularSpans([Number.NaN, -2])).toEqual([]);
  });

  it("skips non-numeric values but keeps the rest", () => {
    expect(angularSpans([Number.NaN, 2])).toEqual([{ index: 1, start: 0, end: TAU }]);
  });
});

describe("topRoundedBarPath", () => {
  it("rounds the top corners only", () => {
    expect(topRoundedBarPath(0, 0, 20, 50, 4)).toBe(
      "M 0 50 L 0 4 A 4 4 0 0 1 4 0 L 16 0 A 4 4 0 0 1 20 4 L 20 50 Z",
    );
  });

  it("limits the radius to half the width", () => {
    expect(topRoundedBarPath(0, 0, 6, 20, 10)).toBe(
      "M 0 20 L 0 3 A 3 3 0 0 1 3 0 L 3 0 A 3 3 0 0 1 6 3 L 6 20 Z",
    );
  });

  it("draws a square bar when the radius is zero", () => {
    expect(topRoundedBarPath(0, 0, 10, 10, 0)).toBe("M 0 10 L 0 0 L 10 0 L 10 10 Z");
  });

  it("draws nothing for an empty bar", () => {
    expect(topRoundedBarPath(0, 0, 10, 0, 4)).toBe("");
    expect(topRoundedBarPath(0, 0, 0, 10, 4)).toBe("");
  });
});

describe("foldOther", () => {
  const items = [
    { key: "a", label: "A", value: 5 },
    { key: "b", label: "B", value: 9 },
    { key: "c", label: "C", value: 1 },
    { key: "d", label: "D", value: 3 },
  ];

  it("keeps the top items by value and sums the rest into Other (k)", () => {
    expect(foldOther(items, 2)).toEqual([
      { key: "b", label: "B", value: 9 },
      { key: "a", label: "A", value: 5 },
      { key: OTHER_KEY, label: "Other (2)", value: 4 },
    ]);
  });

  it("returns the items ranked and unfolded when they already fit", () => {
    expect(foldOther(items, 4).map((r) => r.key)).toEqual(["b", "a", "d", "c"]);
    expect(foldOther(items, 9)).toHaveLength(4);
  });

  it("sums the shares of the folded items when all of them have one", () => {
    const shared = [
      { key: "a", label: "A", value: 5, share: 0.5 },
      { key: "b", label: "B", value: 3, share: 0.3 },
      { key: "c", label: "C", value: 1, share: 0.1 },
      { key: "d", label: "D", value: 1, share: 0.1 },
    ];
    const other = foldOther(shared, 2).at(-1);
    expect(other?.key).toBe(OTHER_KEY);
    expect(other?.share).toBeCloseTo(0.2, 9);
  });

  it("leaves out the share when a folded item has none", () => {
    const other = foldOther(items, 1).at(-1);
    expect(other).not.toHaveProperty("share");
  });

  it("counts a missing or NaN value as zero", () => {
    const messy = [
      { key: "a", label: "A", value: 5 },
      { key: "b", label: "B", value: Number.NaN },
      { key: "c", label: "C", value: 1 },
    ];
    expect(foldOther(messy, 1).at(-1)).toEqual({ key: OTHER_KEY, label: "Other (2)", value: 1 });
  });
});

describe("label fitting", () => {
  it("estimates text width from the font size", () => {
    expect(estimateTextWidth("abc", 10)).toBeCloseTo(18, 9);
  });

  it("shortens a label with an ellipsis to fit", () => {
    expect(fitLabel("Infotainment & display", 40, 11)).toBe("Infot…");
    expect(fitLabel("Seats", 100, 11)).toBe("Seats");
    expect(fitLabel("Seats", 6, 11)).toBe("…");
  });

  it("checks that every label fits its slot", () => {
    expect(labelsFit(["Seats", "Mirror"], 60, 11)).toBe(true);
    expect(labelsFit(["Infotainment"], 60, 11)).toBe(false);
    expect(labelsFit([], 60, 11)).toBe(true);
  });
});

describe("small helpers", () => {
  it("clamps ratios to 0–1 and treats a missing scale as zero", () => {
    expect(ratio(5, 10)).toBe(0.5);
    expect(ratio(20, 10)).toBe(1);
    expect(ratio(-3, 10)).toBe(0);
    expect(ratio(Number.NaN, 10)).toBe(0);
    expect(ratio(5, 0)).toBe(0);
  });

  it("maps NaN and missing numbers to zero", () => {
    expect(finiteOrZero(undefined)).toBe(0);
    expect(finiteOrZero(Number.POSITIVE_INFINITY)).toBe(0);
    expect(finiteOrZero(7)).toBe(7);
  });

  it("places tooltips under the pointer, or centred on a focused element", () => {
    const container = { left: 100, top: 50, width: 400, height: 300 };
    const target = { left: 200, top: 80, width: 40, height: 20 };
    expect(hoverAnchor(container, target)).toEqual({ x: 120, y: 40 });
    expect(hoverAnchor(container, target, { x: 150, y: 70 })).toEqual({ x: 50, y: 20 });
    expect(hoverAnchor(NO_BOX, target)).toEqual({ x: 220, y: 90 });
  });

  it("treats Enter and Space as activation keys only", () => {
    expect(isActivationKey("Enter")).toBe(true);
    expect(isActivationKey(" ")).toBe(true);
    expect(isActivationKey("a")).toBe(false);
    expect(isActivationKey("Escape")).toBe(false);
  });
});
