import type { Granularity } from "./types";

/**
 * Time handling for the analytics engine. Every timestamp is UTC epoch milliseconds and every
 * calculation reads UTC fields, so results never depend on the machine's time zone.
 */

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const YEAR_DAYS = 365.25;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
/** Granularities from finest to coarsest. */
const ORDER: readonly Granularity[] = ["day", "week", "month", "quarter", "year"];

/** UTC midnight of a day. Month is 0-based and overflow rolls over, as with Date.UTC. */
function utc(year: number, month: number, day: number): number {
  if (year >= 100 && year <= 9999) return Date.UTC(year, month, day);
  const d = new Date(0);
  d.setUTCFullYear(year, month, day);
  return d.getTime();
}

/** UTC midnight of a calendar day that exists (2024-02-30 does not); month is 1-based. */
function calendarDay(year: number, month: number, day: number): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const t = utc(year, month - 1, day);
  const d = new Date(t);
  const exists =
    d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  return exists ? t : null;
}

/** A time of day added to a UTC midnight; null when a clock field is out of range. */
function clock(midnight: number, hour: number, minute: number, second: number, ms: number) {
  if (hour > 23 || minute > 59 || second > 59) return null;
  return midnight + ((hour * 60 + minute) * 60 + second) * 1000 + ms;
}

/** The timestamp when it lies inside the range JavaScript dates support, else null. */
function validMs(ms: number): number | null {
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? ms : null;
}

/** Lowercase, no diacritics, ß as ss, dots and commas as spaces, single spaces. */
function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Month names in English and German, full and short, in folded spelling. */
const MONTH_WORDS: readonly (readonly [number, readonly string[]])[] = [
  [1, ["january", "jan", "januar"]],
  [2, ["february", "feb", "februar"]],
  [3, ["march", "mar", "marz", "maerz"]],
  [4, ["april", "apr"]],
  [5, ["may", "mai"]],
  [6, ["june", "jun", "juni"]],
  [7, ["july", "jul", "juli"]],
  [8, ["august", "aug"]],
  [9, ["september", "sep", "sept"]],
  [10, ["october", "oct", "oktober", "okt"]],
  [11, ["november", "nov"]],
  [12, ["december", "dec", "dezember", "dez"]],
];
const MONTHS = new Map<string, number>();
for (const [month, words] of MONTH_WORDS) {
  for (const word of words) MONTHS.set(word, month);
}

/** "Mar 2024", "March 2024", "März 2024", "15 March 2024", "15. März 2024", "March 15, 2024". */
function parseNamedMonth(folded: string): number | null {
  const parts = folded.split(" ");
  if (parts.length === 2) {
    const month = MONTHS.get(parts[0] ?? "");
    const year = parts[1] ?? "";
    return month !== undefined && /^\d{4}$/.test(year) ? calendarDay(Number(year), month, 1) : null;
  }
  if (parts.length === 3) {
    const [first = "", second = "", year = ""] = parts;
    if (!/^\d{4}$/.test(year)) return null;
    const byFirst = MONTHS.get(first);
    const bySecond = MONTHS.get(second);
    if (bySecond !== undefined && /^\d{1,2}$/.test(first)) {
      return calendarDay(Number(year), bySecond, Number(first));
    }
    if (byFirst !== undefined && /^\d{1,2}$/.test(second)) {
      return calendarDay(Number(year), byFirst, Number(second));
    }
  }
  return null;
}

/** Monday 00:00 UTC of an ISO week, or null when that week does not exist in the year. */
function isoWeekStart(year: number, week: number): number | null {
  const jan4 = utc(year, 0, 4);
  const monday1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  const start = monday1 + (week - 1) * WEEK_MS;
  const back = isoWeek(start);
  return back.year === year && back.week === week ? start : null;
}

/** ISO week-year and week number of the day containing t. */
function isoWeek(t: number): { year: number; week: number } {
  const d = new Date(t);
  const dayOfWeek = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dayOfWeek + 3);
  const year = new Date(thursday).getUTCFullYear();
  return { year, week: Math.floor((thursday - utc(year, 0, 1)) / WEEK_MS) + 1 };
}

/** The fraction of a second in a timestamp, as milliseconds (extra digits are dropped). */
function fractionMs(fraction: string | undefined): number {
  return fraction ? Number(fraction.slice(0, 3).padEnd(3, "0")) : 0;
}

/** Offset of "Z", "+02:00", "-0530" or "+02" in milliseconds, to subtract from local clock time. */
function offsetMs(offset: string | undefined): number {
  if (offset === undefined || offset.toUpperCase() === "Z") return 0;
  const sign = offset.startsWith("-") ? -1 : 1;
  const digits = offset.slice(1).replace(":", "");
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || "0")) * 60_000;
}

const ISO_DATE =
  /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-](?:[01]\d|2[0-3])(?::?[0-5]\d)?)?)?$/i;

/** Parses one trimmed text cell; the accepted forms are listed on parseTime. */
function parseText(text: string): number | null {
  if (text === "") return null;

  // 2024-03-15, 2024/03/15, 2024-03-15 10:20, 2024-03-15T10:20:00.5Z, 2024-03-15T10:20+02:00
  const iso = ISO_DATE.exec(text);
  if (iso) {
    const day = calendarDay(Number(iso[1]), Number(iso[3]), Number(iso[4]));
    if (day === null || iso[5] === undefined) return day;
    const at = clock(day, Number(iso[5]), Number(iso[6]), Number(iso[7] ?? 0), fractionMs(iso[8]));
    return at === null ? null : at - offsetMs(iso[9]);
  }

  // 2024-03, 2024/03: first of the month
  const yearMonth = /^(\d{4})[-/](\d{1,2})$/.exec(text);
  if (yearMonth) return calendarDay(Number(yearMonth[1]), Number(yearMonth[2]), 1);

  // 2024-W12: Monday of that ISO week
  const week = /^(\d{4})-?W(\d{1,2})$/i.exec(text);
  if (week) return isoWeekStart(Number(week[1]), Number(week[2]));

  // Q1 2024, Q1/2024, 2024 Q1, 2024-Q1, 1. Quartal 2024: first day of the quarter
  const quarterFirst = /^Q([1-4])[\s/-]*(\d{4})$/i.exec(text);
  if (quarterFirst) {
    return calendarDay(Number(quarterFirst[2]), (Number(quarterFirst[1]) - 1) * 3 + 1, 1);
  }
  const quarterLast = /^(\d{4})[\s/-]*Q([1-4])$/i.exec(text);
  if (quarterLast) {
    return calendarDay(Number(quarterLast[1]), (Number(quarterLast[2]) - 1) * 3 + 1, 1);
  }
  const quarterGerman = /^([1-4])\.?\s*Quartal\s+(\d{4})$/i.exec(text);
  if (quarterGerman) {
    return calendarDay(Number(quarterGerman[2]), (Number(quarterGerman[1]) - 1) * 3 + 1, 1);
  }

  // 03/2024, 3/2024: month and year
  const monthYear = /^(\d{1,2})\/(\d{4})$/.exec(text);
  if (monthYear) return calendarDay(Number(monthYear[2]), Number(monthYear[1]), 1);

  // a/b/yyyy: a second number above 12 can only be the day (US), otherwise day/month (European)
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = Number(slash[3]);
    const monthFirst = second > 12 && first <= 12;
    return monthFirst ? calendarDay(year, first, second) : calendarDay(year, second, first);
  }

  // 15.03.2024, 15.3.24: German day.month.year; two-digit years 00-69 are 2000s, 70-99 1900s
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})$/.exec(text);
  if (dotted) {
    const digits = dotted[3] ?? "";
    const year =
      digits.length === 2 ? (Number(digits) <= 69 ? 2000 : 1900) + Number(digits) : Number(digits);
    return calendarDay(year, Number(dotted[2]), Number(dotted[1]));
  }

  // 2024 alone: January 1st of a year from 1900 to 2100
  if (/^\d{4}$/.test(text)) {
    const year = Number(text);
    return year >= 1900 && year <= 2100 ? calendarDay(year, 1, 1) : null;
  }

  return parseNamedMonth(foldText(text));
}

/** Numbers: a whole year, and when allowed an Excel serial date or an epoch timestamp. */
function parseNumber(
  value: number,
  opts: { allowSerial?: boolean; allowEpoch?: boolean },
): number | null {
  if (!Number.isFinite(value)) return null;
  if (Number.isInteger(value) && value >= 1900 && value <= 2100) return utc(value, 0, 1);
  if (opts.allowSerial && value >= 20000 && value <= 80000) {
    return validMs(Math.round(EXCEL_EPOCH + value * DAY_MS));
  }
  if (opts.allowEpoch) {
    if (value > 1e11) return validMs(Math.round(value));
    if (value >= 1e9) return validMs(Math.round(value * 1000));
  }
  return null;
}

/**
 * Parses one cell into a UTC timestamp, or null. Accepts Date objects, ISO dates and date-times,
 * year-month, ISO weeks, quarters, month/year, dd.mm.yyyy and English or German month names.
 * Numbers are years 1900–2100, and with the options also Excel serials and epoch time. A list
 * value is read by its first entry. Impossible dates such as 2024-02-30 give null.
 */
export function parseTime(
  value: unknown,
  opts: { allowSerial?: boolean; allowEpoch?: boolean } = {},
): number | null {
  if (value instanceof Date) return validMs(value.getTime());
  if (typeof value === "string") return parseText(value.trim());
  if (typeof value === "number") return parseNumber(value, opts);
  if (Array.isArray(value)) return value.length > 0 ? parseTime(value[0], opts) : null;
  return null;
}

/** Header names that name a time column once normalised (lowercase, no spaces, "_" or "-"). */
const TIME_HEADERS = new Set([
  "date",
  "datum",
  "time",
  "timestamp",
  "createdat",
  "created",
  "createddate",
  "submitted",
  "submittedat",
  "submissiondate",
  "feedbackdate",
  "surveydate",
  "responsedate",
  "period",
  "month",
  "monat",
  "quarter",
  "quartal",
  "year",
  "jahr",
  "week",
  "woche",
  "day",
  "tag",
  "zeitpunkt",
  "zeitraum",
  "erstelltam",
  "eingangsdatum",
]);

/**
 * How likely a column header is a time column: 1 for an exact synonym, 0.6 when "date", "datum",
 * "time" or "zeit" occurs in it, else 0.
 */
export function timeColumnScore(header: string): number {
  const key = header.toLowerCase().replace(/[\s_-]/g, "");
  if (TIME_HEADERS.has(key)) return 1;
  return /date|datum|time|zeit/.test(key) ? 0.6 : 0;
}

/** Empty cells: null, undefined, blank text or an empty list. */
function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  return Array.isArray(value) && value.length === 0;
}

/**
 * Share (0–1) of the non-empty values that parseTime accepts. Excel serial dates count when the
 * header scores at least 0.6 as a time column.
 */
export function timeRecognitionRate(header: string, values: readonly unknown[]): number {
  const opts = { allowSerial: timeColumnScore(header) >= 0.6 };
  let total = 0;
  let recognised = 0;
  for (const value of values) {
    if (isBlank(value)) continue;
    total += 1;
    if (parseTime(value, opts) !== null) recognised += 1;
  }
  return total === 0 ? 0 : recognised / total;
}

/** UTC midnight is an exact multiple of a day, because the epoch itself is UTC midnight. */
function isMidnightUtc(t: number): boolean {
  return t % DAY_MS === 0;
}

/** 1 January 00:00 UTC. */
function isStartOfYear(t: number): boolean {
  return isMidnightUtc(t) && new Date(t).getUTCMonth() === 0 && new Date(t).getUTCDate() === 1;
}

/** A date on the 1st of a month (UTC); the time of day does not make the data finer. */
function isFirstOfMonth(t: number): boolean {
  return new Date(t).getUTCDate() === 1;
}

/**
 * Picks the bucket size from the span of the data: up to 45 days day, up to 270 days week, up to
 * four years month, up to ten years quarter, longer year. One instant or no data gives month. The
 * precision of the data caps it: when every timestamp is 1 January 00:00 UTC the result is year,
 * and when every one is the 1st of a month the result is month or coarser.
 */
export function autoGranularity(times: readonly number[]): Granularity {
  const valid = times.filter((t) => Number.isFinite(t));
  if (valid.length === 0) return "month";
  let min = Infinity;
  let max = -Infinity;
  for (const t of valid) {
    if (t < min) min = t;
    if (t > max) max = t;
  }
  let g: Granularity = "month";
  if (max > min) {
    const days = (max - min) / DAY_MS;
    if (days <= 45) g = "day";
    else if (days <= 270) g = "week";
    else if (days <= 4 * YEAR_DAYS) g = "month";
    else if (days <= 10 * YEAR_DAYS) g = "quarter";
    else g = "year";
  }
  if (valid.every(isStartOfYear)) return "year";
  if (valid.every(isFirstOfMonth) && ORDER.indexOf(g) < ORDER.indexOf("month")) g = "month";
  return g;
}

/**
 * Start of the bucket containing t: day 00:00 UTC, ISO week from its Monday, 1st of the month,
 * 1st of the quarter (Jan, Apr, Jul, Oct) or 1 January.
 */
export function bucketStart(t: number, g: Granularity): number {
  const d = new Date(t);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  switch (g) {
    case "day":
      return utc(year, month, day);
    case "week":
      return utc(year, month, day - ((d.getUTCDay() + 6) % 7));
    case "month":
      return utc(year, month, 1);
    case "quarter":
      return utc(year, Math.floor(month / 3) * 3, 1);
    case "year":
      return utc(year, 0, 1);
  }
}

/** Start of the bucket after the one containing t. */
export function nextBucket(t: number, g: Granularity): number {
  const start = bucketStart(t, g);
  const d = new Date(start);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  switch (g) {
    case "day":
      return start + DAY_MS;
    case "week":
      return start + WEEK_MS;
    case "month":
      return utc(year, month + 1, 1);
    case "quarter":
      return utc(year, month + 3, 1);
    case "year":
      return utc(year + 1, 0, 1);
  }
}

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Label of the bucket containing t: "2024-03-15", "2024-W11", "Mar 2024", "Q1 2024" or "2024". */
export function bucketLabel(t: number, g: Granularity): string {
  const d = new Date(t);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  switch (g) {
    case "day":
      return formatDay(t);
    case "week": {
      const iso = isoWeek(t);
      return `${iso.year}-W${pad2(iso.week)}`;
    }
    case "month":
      return `${MONTH_SHORT[month] ?? ""} ${year}`;
    case "quarter":
      return `Q${Math.floor(month / 3) + 1} ${year}`;
    case "year":
      return String(year);
  }
}

/**
 * Every bucket start from the bucket of min through the bucket of max, inclusive, so empty
 * buckets show as 0. Throws when more than `limit` buckets are needed; min > max gives [].
 */
export function bucketRange(min: number, max: number, g: Granularity, limit = 400): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error("bucketRange needs finite timestamps");
  }
  if (min > max) return [];
  const last = bucketStart(max, g);
  const buckets: number[] = [];
  for (let start = bucketStart(min, g); start <= last; start = nextBucket(start, g)) {
    if (buckets.length >= limit) {
      throw new Error(
        `The range needs more than ${limit} ${g} buckets; narrow it or use a coarser granularity`,
      );
    }
    buckets.push(start);
  }
  return buckets;
}

/** "2024-03-15" for a timestamp, in UTC. */
export function formatDay(t: number): string {
  const d = new Date(t);
  const year = String(d.getUTCFullYear()).padStart(4, "0");
  return `${year}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
