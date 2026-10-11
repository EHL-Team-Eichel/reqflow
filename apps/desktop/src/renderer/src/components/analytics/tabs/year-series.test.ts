import { describe, expect, it } from "vitest";
import type { YearSeriesPoint } from "../engine/types";
import { groupYearSeries, yearGroupName, yearStart } from "./year-series";

const point = (
  column: string,
  year: number,
  label: string,
  value: number,
  planned = false,
  input = 0,
): YearSeriesPoint => ({ column, year, label, country: label, input, value, planned });

describe("year series", () => {
  it("names groups without their year", () => {
    expect(yearGroupName("volume_2024")).toBe("volume");
    expect(yearGroupName("Sales 2030")).toBe("Sales");
    expect(yearGroupName("2025")).toBe("Value");
  });

  it("makes one line per row with only the years that are columns, dashed from the first plan", () => {
    const [group] = groupYearSeries(
      [
        point("volume_2024", 2024, "DE", 120),
        point("volume_2025", 2025, "DE", 130),
        point("volume_2030", 2030, "DE", 150, true),
        point("volume_2024", 2024, "FR", 80),
        point("volume_2030", 2030, "FR", 90, true),
      ],
      { labelOf: (p) => p.label, colorIndexOf: (_p, i) => i, inputs: 1, inputLabel: String },
    );
    expect(group!.name).toBe("volume");
    expect(group!.years).toEqual([2024, 2025, 2030]);
    expect(group!.irregular).toBe(true);
    expect(group!.dashedFrom).toBe(yearStart(2030));
    expect(group!.series.map((s) => [s.label, s.points.map((p) => p.value)])).toEqual([
      ["DE", [120, 130, 150]],
      ["FR", [80, 0, 90]],
    ]);
  });

  it("names the input when several inputs carry year columns", () => {
    const groups = groupYearSeries(
      [point("units 2024", 2024, "DE", 1, false, 0), point("units 2024", 2024, "DE", 2, false, 1)],
      {
        labelOf: (p) => p.label,
        colorIndexOf: (_p, i) => i,
        inputs: 2,
        inputLabel: (i) => ["A", "B"][i]!,
      },
    );
    expect(groups[0]!.series.map((s) => s.label)).toEqual(["DE · A", "DE · B"]);
    expect(groups[0]!.dashedFrom).toBeUndefined();
    expect(groups[0]!.irregular).toBe(false);
  });
});
