import { describe, expect, it } from "vitest";
import {
  autoGranularity,
  bucketLabel,
  bucketRange,
  bucketStart,
  formatDay,
  nextBucket,
  parseTime,
  timeColumnScore,
  timeRecognitionRate,
} from "./time";

const DAY = 86_400_000;
/** A UTC instant written out, so no expectation depends on the machine's time zone. */
const at = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);
const monthLabel = (t: number) => bucketLabel(t, "month");
const quarterLabel = (t: number) => bucketLabel(t, "quarter");
const weekLabel = (t: number) => bucketLabel(t, "week");

describe("parseTime: ISO dates and date-times", () => {
  it("reads them as UTC, with offsets converted", () => {
    expect(parseTime("2024-03-15")).toBe(at(2024, 3, 15));
    expect(parseTime("2024-03-15T10:20:00Z")).toBe(at(2024, 3, 15, 10, 20));
    expect(parseTime("2024-03-15 10:20")).toBe(at(2024, 3, 15, 10, 20));
    expect(parseTime("2024-03-15T10:20:00.250Z")).toBe(at(2024, 3, 15, 10, 20) + 250);
    expect(parseTime("2024/03/15")).toBe(at(2024, 3, 15));
    expect(parseTime("2024-03-15T10:20+02:00")).toBe(at(2024, 3, 15, 8, 20));
    expect(parseTime("2024-03-15T10:20-0530")).toBe(at(2024, 3, 15, 15, 50));
    expect(parseTime("2024-02-29")).toBe(at(2024, 2, 29));
  });

  it("gives the same UTC values whatever the machine's time zone", () => {
    expect(parseTime("2024-03-15 10:20")).toBe(Date.UTC(2024, 2, 15, 10, 20));
    expect(parseTime("15.03.2024")).toBe(Date.UTC(2024, 2, 15));
    expect(formatDay(parseTime("2024-03-15T23:30-05:00") as number)).toBe("2024-03-16");
  });
});

describe("parseTime: periods, weeks and quarters", () => {
  it("reads year-month as the first day of the month", () => {
    expect(parseTime("2024-03")).toBe(at(2024, 3, 1));
    expect(parseTime("2024/03")).toBe(at(2024, 3, 1));
    expect(parseTime("03/2024")).toBe(at(2024, 3, 1));
    expect(parseTime("3/2024")).toBe(at(2024, 3, 1));
  });

  it("reads ISO weeks as their Monday", () => {
    expect(parseTime("2024-W12")).toBe(at(2024, 3, 18));
    expect(parseTime("2020-W53")).toBe(at(2020, 12, 28));
    expect(parseTime("2021-W53")).toBeNull();
  });

  it("reads quarters as the first day of the quarter", () => {
    expect(parseTime("Q1 2024")).toBe(at(2024, 1, 1));
    expect(parseTime("2024 Q3")).toBe(at(2024, 7, 1));
    expect(parseTime("2024-Q4")).toBe(at(2024, 10, 1));
    expect(parseTime("Q2/2024")).toBe(at(2024, 4, 1));
    expect(parseTime("1. Quartal 2024")).toBe(at(2024, 1, 1));
  });

  it("reads a year alone from 1900 to 2100 as 1 January", () => {
    expect(parseTime("2024")).toBe(at(2024, 1, 1));
    expect(parseTime(2024)).toBe(at(2024, 1, 1));
    expect(parseTime("1900")).toBe(at(1900, 1, 1));
    expect(parseTime(2100)).toBe(at(2100, 1, 1));
  });
});

describe("parseTime: German and slash dates, month names", () => {
  it("reads day.month.year, with two-digit years", () => {
    expect(parseTime("15.03.2024")).toBe(at(2024, 3, 15));
    expect(parseTime("15.3.24")).toBe(at(2024, 3, 15));
    expect(parseTime("15.03.70")).toBe(at(1970, 3, 15));
    expect(parseTime("15.03.69")).toBe(at(2069, 3, 15));
  });

  it("reads a/b/yyyy by which number can be a month", () => {
    expect(parseTime("03/15/2024")).toBe(at(2024, 3, 15)); // 15 cannot be a month: month first
    expect(parseTime("15/03/2024")).toBe(at(2024, 3, 15)); // 15 cannot be a month: day first
    expect(parseTime("03/04/2024")).toBe(at(2024, 4, 3)); // both fit: day/month, European data
    expect(parseTime("15/15/2024")).toBeNull();
  });

  it("reads English and German month names, full or short", () => {
    expect(parseTime("Mar 2024")).toBe(at(2024, 3, 1));
    expect(parseTime("March 2024")).toBe(at(2024, 3, 1));
    expect(parseTime("März 2024")).toBe(at(2024, 3, 1));
    expect(parseTime("15 March 2024")).toBe(at(2024, 3, 15));
    expect(parseTime("March 15, 2024")).toBe(at(2024, 3, 15));
    expect(parseTime("15. März 2024")).toBe(at(2024, 3, 15));
  });
});

describe("parseTime: numbers, dates and lists", () => {
  it("reads Date objects by their instant", () => {
    expect(parseTime(new Date(at(2024, 3, 15, 10, 20)))).toBe(at(2024, 3, 15, 10, 20));
  });

  it("reads a list by its first entry", () => {
    expect(parseTime(["2024-03-15", "2030-01-01"])).toBe(at(2024, 3, 15));
    expect(parseTime([])).toBeNull();
  });

  it("reads Excel serial dates only when allowSerial is set", () => {
    expect(parseTime(45000, { allowSerial: true })).toBe(at(2023, 3, 15));
    expect(parseTime(45000.5, { allowSerial: true })).toBe(at(2023, 3, 15, 12));
    expect(parseTime(45000)).toBeNull();
    expect(parseTime(99999, { allowSerial: true })).toBeNull();
    expect(parseTime(99999)).toBeNull();
  });

  it("reads epoch seconds and milliseconds only when allowEpoch is set", () => {
    expect(parseTime(1_700_000_000_000, { allowEpoch: true })).toBe(1_700_000_000_000);
    expect(parseTime(1_700_000_000, { allowEpoch: true })).toBe(1_700_000_000_000);
    expect(parseTime(1_700_000_000_000)).toBeNull();
  });
});

describe("parseTime: rejections", () => {
  it("returns null for empty, unknown and impossible values", () => {
    const rejected: unknown[] = [
      "",
      "   ",
      "abc",
      "2024-13-01",
      "2024-02-30",
      "2023-02-29",
      "2024-03-15T25:00",
      "13/2024",
      "1800",
      "2101",
      1800,
      2101,
      null,
      undefined,
      Number.NaN,
      new Date("not a date"),
      {},
    ];
    for (const value of rejected) {
      expect(parseTime(value), String(value)).toBeNull();
    }
  });
});

describe("timeColumnScore and timeRecognitionRate", () => {
  it("scores time header names 1, and headers containing date or time 0.6", () => {
    const exact = [
      "Date",
      "Datum",
      "Created_At",
      "Feedback Date",
      "Erstellt am",
      "Eingangsdatum",
      "Quartal",
      "Jahr",
      "Woche",
      "Tag",
      "Zeitpunkt",
      "Monat",
      "Period",
    ];
    for (const header of exact) {
      expect(timeColumnScore(header), header).toBe(1);
    }
    expect(timeColumnScore("Submitted Date")).toBe(0.6);
    expect(timeColumnScore("Interview time")).toBe(0.6);
    expect(timeColumnScore("Zeit der Rückmeldung")).toBe(0.6);
    for (const header of ["Revenue", "Country", "Region", "Feedback text", "Engine Type"]) {
      expect(timeColumnScore(header), header).toBe(0);
    }
  });

  it("is the share of non-empty cells that parse; serial numbers count only for time headers", () => {
    const cells = ["2024-03-15", "15.03.2024", 45000, "not a date", "", null];
    expect(timeRecognitionRate("Date", cells)).toBeCloseTo(3 / 4);
    expect(timeRecognitionRate("Revenue", cells)).toBeCloseTo(2 / 4);
    expect(timeRecognitionRate("Date", [])).toBe(0);
    expect(timeRecognitionRate("Date", ["", null])).toBe(0);
  });
});

describe("autoGranularity", () => {
  it("chooses the bucket size from the span of the data", () => {
    const from = at(2024, 3, 15, 10, 20);
    expect(autoGranularity([])).toBe("month");
    expect(autoGranularity([Number.NaN])).toBe("month");
    expect(autoGranularity([from])).toBe("month");
    expect(autoGranularity([from, from])).toBe("month");
    expect(autoGranularity([from, from + 45 * DAY])).toBe("day");
    expect(autoGranularity([from, from + 46 * DAY])).toBe("week");
    expect(autoGranularity([from, from + 270 * DAY])).toBe("week");
    expect(autoGranularity([from, from + 271 * DAY])).toBe("month");
    expect(autoGranularity([from, at(2028, 3, 15, 10, 20)])).toBe("month"); // 4 years
    expect(autoGranularity([from, at(2028, 3, 16, 10, 20)])).toBe("quarter");
    expect(autoGranularity([from, at(2034, 3, 15, 10, 20)])).toBe("quarter"); // 10 years
    expect(autoGranularity([from, at(2034, 3, 16, 10, 20)])).toBe("year");
  });

  it("never goes finer than the precision of the data", () => {
    expect(autoGranularity([at(2024, 3, 1), at(2024, 4, 1)])).toBe("month"); // span says day
    expect(autoGranularity([at(2024, 1, 1), at(2024, 3, 1)])).toBe("month"); // span says week
    expect(autoGranularity([at(2018, 2, 1), at(2024, 2, 1)])).toBe("quarter");
    expect(autoGranularity([at(2020, 1, 1), at(2021, 1, 1), at(2022, 1, 1)])).toBe("year");
    expect(autoGranularity([at(2024, 1, 1)])).toBe("year");
    expect(autoGranularity([at(2024, 3, 1, 10, 20), at(2024, 4, 1, 9)])).toBe("month");
  });
});

describe("bucket starts, next buckets and labels", () => {
  it("starts each bucket at its UTC boundary", () => {
    const t = at(2024, 3, 15, 10, 20); // a Friday
    expect(bucketStart(t, "day")).toBe(at(2024, 3, 15));
    expect(bucketStart(t, "week")).toBe(at(2024, 3, 11)); // Monday
    expect(bucketStart(at(2024, 3, 17, 23, 59), "week")).toBe(at(2024, 3, 11)); // Sunday
    expect(bucketStart(t, "month")).toBe(at(2024, 3, 1));
    expect(bucketStart(at(2024, 5, 20), "quarter")).toBe(at(2024, 4, 1));
    expect(bucketStart(at(2024, 11, 30), "quarter")).toBe(at(2024, 10, 1));
    expect(bucketStart(at(2024, 7, 1), "year")).toBe(at(2024, 1, 1));
  });

  it("moves to the following bucket", () => {
    expect(nextBucket(at(2024, 2, 28, 12), "day")).toBe(at(2024, 2, 29));
    expect(nextBucket(at(2024, 3, 15), "week")).toBe(at(2024, 3, 18));
    expect(nextBucket(at(2024, 12, 15), "month")).toBe(at(2025, 1, 1));
    expect(nextBucket(at(2024, 11, 15), "quarter")).toBe(at(2025, 1, 1));
    expect(nextBucket(at(2024, 5, 15), "quarter")).toBe(at(2024, 7, 1));
    expect(nextBucket(at(2024, 6, 1), "year")).toBe(at(2025, 1, 1));
  });

  it("labels each granularity", () => {
    const t = at(2024, 3, 15, 10, 20);
    expect(bucketLabel(t, "day")).toBe("2024-03-15");
    expect(bucketLabel(t, "week")).toBe("2024-W11");
    expect(bucketLabel(t, "month")).toBe("Mar 2024");
    expect(bucketLabel(t, "quarter")).toBe("Q1 2024");
    expect(bucketLabel(t, "year")).toBe("2024");
    expect(quarterLabel(at(2024, 7, 1))).toBe("Q3 2024");
    expect(quarterLabel(at(2024, 10, 31))).toBe("Q4 2024");
  });

  it("uses the ISO week-year at the turn of the year", () => {
    expect(weekLabel(at(2021, 1, 3))).toBe("2020-W53");
    expect(weekLabel(at(2024, 12, 30))).toBe("2025-W01");
  });

  it("formats a day as 2024-03-05", () => {
    expect(formatDay(at(2024, 3, 5, 23, 59))).toBe("2024-03-05");
    expect(formatDay(at(2024, 12, 31))).toBe("2024-12-31");
  });
});

describe("bucketRange", () => {
  it("lists every bucket from min to max, including empty ones, across year boundaries", () => {
    expect(bucketRange(at(2023, 11, 15), at(2024, 2, 10), "month").map(monthLabel)).toEqual([
      "Nov 2023",
      "Dec 2023",
      "Jan 2024",
      "Feb 2024",
    ]);
    expect(bucketRange(at(2023, 12, 1), at(2024, 4, 1), "quarter").map(quarterLabel)).toEqual([
      "Q4 2023",
      "Q1 2024",
      "Q2 2024",
    ]);
    expect(bucketRange(at(2020, 12, 30), at(2021, 1, 6), "week").map(weekLabel)).toEqual([
      "2020-W53",
      "2021-W01",
    ]);
    expect(bucketRange(at(2020, 5, 1), at(2023, 1, 1), "year")).toEqual([
      at(2020, 1, 1),
      at(2021, 1, 1),
      at(2022, 1, 1),
      at(2023, 1, 1),
    ]);
    expect(bucketRange(at(2024, 2, 28), at(2024, 3, 1), "day")).toEqual([
      at(2024, 2, 28),
      at(2024, 2, 29),
      at(2024, 3, 1),
    ]);
    expect(bucketRange(at(2024, 3, 15, 10), at(2024, 3, 15, 12), "day")).toEqual([at(2024, 3, 15)]);
  });

  it("returns nothing for an inverted range and enforces the limit", () => {
    expect(bucketRange(at(2024, 3, 2), at(2024, 3, 1), "day")).toEqual([]);
    expect(bucketRange(0, 4 * DAY, "day", 5)).toHaveLength(5);
    expect(() => bucketRange(0, 5 * DAY, "day", 5)).toThrow(/more than 5 day buckets/);
    expect(bucketRange(0, 399 * DAY, "day")).toHaveLength(400);
    expect(() => bucketRange(0, 400 * DAY, "day")).toThrow();
    expect(() => bucketRange(at(2000, 1, 1), at(2024, 1, 1), "day")).toThrow();
    expect(() => bucketRange(Number.NaN, 0, "day")).toThrow();
  });
});
