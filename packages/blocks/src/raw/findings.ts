import {
  CATEGORY_LABELS,
  RequirementCategory,
  type Finding,
  type ProductScope,
  type SourceRecord,
} from "@reqflow/core";
import { findColumn, parseNumber, type ColumnMapping } from "./columns";
import type { Ingested, RawDataset } from "./records";
import { marketColumn, parseMarketCode, shortHash } from "./records";
import { customerStudyFindings } from "./study";
import { cellText, listRows, type Table } from "./table";

/** A take rate at or above this means most buyers choose it: a basic expectation (Kano "basic"). */
export const BASIC_EXPECTATION_MIN_PCT = 70;
/** A take rate at or below this means few buyers value the option as offered. */
export const RARELY_CHOSEN_MAX_PCT = 15;
/** Sales changes smaller than this (in %) between the first and last period are not reported. */
export const VOLUME_CHANGE_MIN_PCT = 10;

/** Keyword → category for equipment names (English and German). First match wins, packages first. */
const CATEGORY_KEYWORDS: [RequirementCategory, RegExp][] = [
  ["variants_packages", /package|paket|\bpack\b/i],
  ["range_charging", /charg|battery|range|lade|wallbox/i],
  [
    "driver_assistance",
    /assist|parking|park|camera|kamera|cruise|lane|head-?up|driving assistant/i,
  ],
  [
    "infotainment_digital",
    /navigation|navi|display|audio|sound|harman|bowers|wilkins|carplay|android|connected|app\b|infotainment|entertainment|wi-?fi|internet/i,
  ],
  [
    "comfort",
    /seat|sitz|heat|heiz|ventilat|massage|climate|klima|comfort|komfort|sun ?blind|rollo/i,
  ],
  [
    "interior_quality",
    /leather|leder|trim|ambient|ambiente|interior|innen|glass ?controls|crafted/i,
  ],
  [
    "exterior_design",
    /paint|lack|wheel|rim|felge|light|laser|licht|shadow ?line|exterior|m sport/i,
  ],
  [
    "space_practicality",
    /tow|trailer|anhänger|roof ?rail|dachreling|through-?load|durchlade|storage|cargo|load/i,
  ],
  ["usability_controls", /gesture|voice|sprach|comfort access|key|schlüssel|controller|button/i],
  ["driving_experience", /suspension|fahrwerk|steering|lenkung|chassis|adaptive|sport/i],
];

export function categoryFor(categoryCell: string, name: string): RequirementCategory {
  const fromCell = categoryCell.trim().toLowerCase();
  if (fromCell) {
    const direct = RequirementCategory.safeParse(fromCell.replace(/[\s&-]+/g, "_"));
    if (direct.success) return direct.data;
    const byLabel = Object.entries(CATEGORY_LABELS).find(([, label]) =>
      label.toLowerCase().startsWith(fromCell),
    );
    if (byLabel) return byLabel[0] as RequirementCategory;
  }
  return CATEGORY_KEYWORDS.find(([, re]) => re.test(name))?.[0] ?? "variants_packages";
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-US");
const excerptOf = (r: SourceRecord) => r.text.slice(0, 1000); // verbatim: a prefix of the record text

function finding(
  ingested: Ingested,
  key: string,
  statement: string,
  category: RequirementCategory,
  records: SourceRecord[],
  markets: string[],
): Finding {
  return {
    id: `fnd_${shortHash(`${ingested.source.id}|${key}`)}`,
    kind: "usage_pattern",
    statement,
    category,
    evidence: records.map((r) => ({
      sourceId: r.sourceId,
      recordId: r.id,
      excerpt: excerptOf(r),
      ...(r.locator ? { locator: r.locator } : {}),
    })),
    mentions: records.length,
    markets: [...new Set(markets)],
    confidence: 1, // deterministic rule on BMW's own numbers
    inScope: true,
  };
}

/**
 * Deterministic usage findings from structured BMW data (no AI):
 * - equipment data: options with a very high or very low take rate,
 * - sales volumes: markets or derivatives whose volume rose or fell clearly between the first and
 *   last period (one row per period, or one column per period like "volume_2024"). Periods after
 *   the year the data was read are plan figures and worded as such.
 * - customer study: comparison between target vehicle and comparators in the same market.
 * Every finding cites the rows it rests on.
 */
export function usageFindings(
  dataset: RawDataset,
  table: Table,
  ingested: Ingested,
  scope: ProductScope,
  mapping?: ColumnMapping,
  sheet?: string,
): { findings: Finding[]; notes: string[] } {
  if (dataset === "equipment_data") return takeRateFindings(table, ingested, scope, mapping);
  if (dataset === "sales_volume") return volumeFindings(table, ingested, scope, mapping);
  if (dataset === "customer_study") return customerStudyFindings(table, ingested, scope, sheet);
  return { findings: [], notes: [] };
}

function takeRateFindings(
  table: Table,
  ingested: Ingested,
  scope: ProductScope,
  mapping?: ColumnMapping,
) {
  const notes: string[] = [];
  const optionCol = findColumn(table.header, "option", mapping);
  const rateCol = findColumn(table.header, "takeRate", mapping);
  if (optionCol === -1 || rateCol === -1) {
    notes.push(
      `No ${optionCol === -1 ? "option" : "take-rate"} column found, so no take-rate findings were derived.`,
    );
    return { findings: [], notes };
  }
  const marketCol = marketColumn(table, mapping);
  const modelCol = findColumn(table.header, "model", mapping);
  const derivativeCol = findColumn(table.header, "derivative", mapping);
  const categoryCol = findColumn(table.header, "category", mapping);

  const parsed = table.rows.map((row) => parseNumber(row.cells[rateCol]));
  const valid = parsed.filter((n): n is number => n !== null);
  const asFraction = valid.length > 0 && valid.every((n) => n >= 0 && n <= 1);
  if (asFraction) notes.push("Take rates look like fractions (0–1); read them as percentages.");

  const bad: number[] = [];
  const findings: Finding[] = [];
  table.rows.forEach((row, i) => {
    const value = parsed[i];
    const record = ingested.recordOfRow[i];
    if (!record) return; // row was skipped earlier (already reported)
    if (value === null || value === undefined) {
      bad.push(row.line);
      return;
    }
    const pct = asFraction ? value * 100 : value;
    if (pct < 0 || pct > 100) {
      bad.push(row.line);
      return;
    }
    const option = cellText(row.cells[optionCol] ?? null);
    if (!option) return;
    const market =
      record.market ??
      (marketCol !== -1 ? parseMarketCode(cellText(row.cells[marketCol] ?? null)) : undefined);
    const context = [
      market,
      modelCol !== -1 ? cellText(row.cells[modelCol] ?? null) : "",
      derivativeCol !== -1 ? cellText(row.cells[derivativeCol] ?? null) : "",
    ]
      .filter(Boolean)
      .join(" ");
    const where = context ? ` (${context})` : "";
    const category = categoryFor(
      categoryCol !== -1 ? cellText(row.cells[categoryCol] ?? null) : "",
      option,
    );
    const markets = market ? [market] : [];
    if (pct >= BASIC_EXPECTATION_MIN_PCT) {
      findings.push(
        finding(
          ingested,
          `take-high|${row.line}`,
          `Take rate of "${option}" is ${fmt(pct)}%${where}: most buyers choose it, so customers expect it as standard.`,
          category,
          [record],
          markets,
        ),
      );
    } else if (pct <= RARELY_CHOSEN_MAX_PCT) {
      findings.push(
        finding(
          ingested,
          `take-low|${row.line}`,
          `Take rate of "${option}" is only ${fmt(pct)}%${where}: few buyers choose it as offered.`,
          category,
          [record],
          markets,
        ),
      );
    }
  });
  if (bad.length)
    notes.push(`Take rate missing or not a percentage in ${listRows(bad)}; no finding for those.`);
  return { findings, notes };
}

/** A period in a column name: "volume_2024" → "2024", "Absatz 2025 Q1" → "2025 Q1". */
const PERIOD_IN_NAME = /(?:19|20)\d{2}(?:\s*[-_/ ]\s*(?:Q[1-4]|H[12]))?/i;

type Point = { period: string; units: number; record: SourceRecord };
type Series = { label: string; market?: string; points: Point[] };

function volumeFindings(
  table: Table,
  ingested: Ingested,
  scope: ProductScope,
  mapping?: ColumnMapping,
) {
  const notes: string[] = [];
  const marketCol = marketColumn(table, mapping);
  const groupCols = (["market", "model", "derivative"] as const)
    .map((role) => findColumn(table.header, role, mapping))
    .filter((c) => c !== -1);
  const labelOf = (row: Table["rows"][number]) =>
    groupCols
      .map((c) => cellText(row.cells[c] ?? null))
      .filter(Boolean)
      .join(" ") || "all sales";
  const marketOf = (row: Table["rows"][number], record?: SourceRecord) =>
    record?.market ??
    (marketCol !== -1 ? parseMarketCode(cellText(row.cells[marketCol] ?? null)) : undefined);

  // Wide: one column per period with numbers in it ("volume_2024", "volume_2025", …).
  const periodCols = table.header.flatMap((h, j) => {
    const period = PERIOD_IN_NAME.exec(h)?.[0];
    const numeric = table.rows.filter((r) => parseNumber(r.cells[j]) !== null).length;
    return period && numeric * 2 >= table.rows.length ? [{ col: j, period }] : [];
  });

  const series = new Map<string, Series>();
  const bad: number[] = [];
  if (periodCols.length >= 2) {
    notes.push(
      `Read one column per period (${periodCols.map((p) => table.header[p.col]).join(", ")}).`,
    );
    table.rows.forEach((row, i) => {
      const record = ingested.recordOfRow[i];
      if (!record) return; // skipped earlier (already reported)
      const points: Point[] = [];
      for (const { col, period } of periodCols) {
        const units = parseNumber(row.cells[col]);
        if (units === null || units < 0) bad.push(row.line);
        else points.push({ period, units, record });
      }
      const label = labelOf(row);
      series.set(label, { label, market: marketOf(row, record), points });
    });
  } else {
    const unitsCol = findColumn(table.header, "units", mapping);
    const periodCol = findColumn(table.header, "period", mapping);
    if (unitsCol === -1 || periodCol === -1) {
      notes.push(
        `No ${unitsCol === -1 ? "units" : "period"} column found, so no sales findings were derived.`,
      );
      return { findings: [], notes };
    }
    table.rows.forEach((row, i) => {
      const record = ingested.recordOfRow[i];
      if (!record) return; // skipped earlier (already reported), e.g. another market
      const units = parseNumber(row.cells[unitsCol]);
      const period = cellText(row.cells[periodCol] ?? null);
      if (units === null || units < 0 || !period) {
        bad.push(row.line);
        return;
      }
      const label = labelOf(row);
      const s = series.get(label) ?? { label, market: marketOf(row, record), points: [] };
      s.points.push({ period, units, record });
      series.set(label, s);
    });
  }
  if (bad.length)
    notes.push(
      `Units or period missing in ${listRows([...new Set(bad)])}; left out of the sales trend.`,
    );

  const readYear = Number(ingested.source.retrievedAt.slice(0, 4));
  const isPlan = (period: string) => Number(/(?:19|20)\d{2}/.exec(period)?.[0]) > readYear;
  const findings: Finding[] = [];
  const byPeriod = (a: Point, b: Point) =>
    a.period.localeCompare(b.period, "en", { numeric: true });
  for (const g of series.values()) {
    const points = [...g.points].sort(byPeriod);
    const first = points[0];
    const last = points.at(-1);
    if (!first || !last || points.length < 2 || first.period === last.period) continue;
    if (points.every((p) => p.units === 0)) {
      notes.push(`${g.label}: no sales in any period (${first.period} to ${last.period}).`);
      continue;
    }
    if (first.units === 0) {
      notes.push(
        `${g.label}: no sales in ${first.period}, so no growth rate (${fmt(last.units)} units in ${last.period}).`,
      );
      continue;
    }
    const change = ((last.units - first.units) / first.units) * 100;
    if (Math.abs(change) < VOLUME_CHANGE_MIN_PCT) continue;
    const plan = isPlan(last.period);
    const verb = plan
      ? change > 0
        ? "are planned to rise"
        : "are planned to fall"
      : change > 0
        ? "rose"
        : "fell";
    const records = first.record === last.record ? [first.record] : [first.record, last.record];
    findings.push(
      finding(
        ingested,
        `volume|${g.label}`,
        `Sales of ${g.label} ${verb} ${fmt(Math.abs(change))}% from ${first.period} to ${last.period} (${fmt(first.units)} → ${fmt(last.units)} units${plan ? `; ${last.period} is a plan figure` : ""}).`,
        "variants_packages",
        records,
        g.market ? [g.market] : [],
      ),
    );
  }
  return { findings, notes };
}
