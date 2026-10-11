import { inMarket, type Finding, type ProductScope } from "@reqflow/core";
import { parseNumber } from "./columns";
import { categoryFor } from "./findings";
import { shortHash, textOf, type Ingested } from "./records";
import { cellText, type Table } from "./table";

const VEHICLE_CODE_RE = /\b[A-Z]\d{2,3}\b/;
const PAREN_MARKET_RE = /\(([^)]+)\)\s*$/;

interface VehicleColumn {
  index: number;
  header: string;
  code: string;
  market?: string;
}

function parseColumnMarket(header: string, sheetName?: string): string | undefined {
  const parenMatch = PAREN_MARKET_RE.exec(header);
  if (parenMatch) {
    const label = parenMatch[1]!.trim();
    if (/^(eu|europe)$/i.test(label)) return "EU";
    if (/^(cn|china)$/i.test(label)) return "CN";
    if (/^(us|usa|united states)$/i.test(label)) return "US";
    if (/^[A-Za-z]{2,3}$/.test(label)) return label.toUpperCase();
    return undefined;
  }
  if (!sheetName) return undefined;
  const tokens = sheetName
    .split(/[\s_\-]+/)
    .map((t) => t.toUpperCase())
    .filter((t) => t === "EU" || t === "CN" || t === "US");
  return tokens.length === 1 ? tokens[0] : undefined;
}

/**
 * Deterministic comparison findings for customer study reports.
 * Compares scope.vehicleCode against other vehicles in the same market.
 */
export function customerStudyFindings(
  table: Table,
  ingested: Ingested,
  scope: ProductScope,
  sheetName?: string,
): { findings: Finding[]; notes: string[] } {
  const notes: string[] = [];
  const sheet = sheetName ?? "";

  // Identify numeric columns whose header contains a vehicle code as a word
  const vehicleCols: VehicleColumn[] = [];
  table.header.forEach((header, j) => {
    const codeMatch = VEHICLE_CODE_RE.exec(header);
    if (!codeMatch) return;
    const isNumericCol = table.rows.some((r) => parseNumber(r.cells[j]) !== null);
    if (!isNumericCol) return;
    const market = parseColumnMarket(header, sheetName);
    vehicleCols.push({
      index: j,
      header,
      code: codeMatch[0],
      market,
    });
  });

  const target = vehicleCols.find(
    (c) => c.code === scope.vehicleCode && inMarket(c.market, scope.market) === true,
  );
  if (!target) {
    notes.push(
      `Customer study "${sheet}": no ${scope.vehicleCode} column for ${scope.market}, so no comparison.`,
    );
    return { findings: [], notes };
  }

  const comparators = vehicleCols.filter(
    (c) => c.index !== target.index && inMarket(c.market, scope.market) === true,
  );
  if (comparators.length === 0) {
    notes.push(`Customer study "${sheet}": no other model in ${scope.market} to compare with.`);
    return { findings: [], notes };
  }

  // Determine scale
  const relevantCols = [target, ...comparators];
  const allNums: number[] = [];
  for (const row of table.rows) {
    for (const col of relevantCols) {
      const n = parseNumber(row.cells[col.index]);
      if (n !== null) allNums.push(n);
    }
  }

  // 0–1 are shares, 0–100 with something above 10 are percentages; anything else (e.g. a 1–10
  // rating) is compared relative to the other models.
  const isFractions = allNums.length > 0 && allNums.every((n) => n >= 0 && n <= 1);
  const isPoints =
    !isFractions && allNums.some((n) => n > 10) && allNums.every((n) => n >= 0 && n <= 100);

  const sectionCol = table.header.indexOf("Section");
  const labelCol = table.header.indexOf("Label");

  const findings: Finding[] = [];
  let comparedFiguresCount = 0;
  let gapCount = 0;

  table.rows.forEach((row, i) => {
    const record = ingested.recordOfRow[i];
    if (!record) return;

    const targetNum = parseNumber(row.cells[target.index]);
    if (targetNum === null) return;

    const validComps = comparators
      .map((c) => ({ code: c.code, num: parseNumber(row.cells[c.index]) }))
      .filter((c): c is { code: string; num: number } => c.num !== null);
    if (validComps.length === 0) return;

    comparedFiguresCount++;

    let targetVal: number;
    let compMean: number;
    let gap: number;
    let emitFinding = false;

    if (isFractions) {
      targetVal = targetNum * 100;
      const compPcts = validComps.map((c) => c.num * 100);
      compMean = compPcts.reduce((sum, v) => sum + v, 0) / compPcts.length;
      gap = targetVal - compMean;
      emitFinding = Math.abs(gap) >= 10;
    } else if (isPoints) {
      targetVal = targetNum;
      compMean = validComps.reduce((sum, c) => sum + c.num, 0) / validComps.length;
      gap = targetVal - compMean;
      emitFinding = Math.abs(gap) >= 10;
    } else {
      // Relative scale
      targetVal = targetNum;
      compMean = validComps.reduce((sum, c) => sum + c.num, 0) / validComps.length;
      gap = targetVal - compMean;
      emitFinding = compMean !== 0 && Math.abs(gap) >= 0.1 * Math.abs(compMean);
    }

    if (!emitFinding) return;
    gapCount++;

    // Percentages differ in points; any other scale (e.g. a 1–10 mean) in percent of the others.
    const size =
      isFractions || isPoints
        ? `${Math.round(Math.abs(gap))} points`
        : `${Math.round((100 * Math.abs(gap)) / Math.abs(compMean))} %`;
    const direction = gap > 0 ? "above" : "below";
    const compCodes = [...new Set(validComps.map((c) => c.code))];
    const compPhrase =
      compCodes.length === 1
        ? compCodes[0]!
        : compCodes.length === 2
          ? `${compCodes[0]} and ${compCodes[1]}`
          : `${compCodes.slice(0, -1).join(", ")} and ${compCodes.at(-1)}`;

    const section = sectionCol !== -1 ? cellText(row.cells[sectionCol] ?? null).trim() : "";
    const label =
      labelCol !== -1
        ? cellText(row.cells[labelCol] ?? null).trim()
        : sectionCol === -1
          ? cellText(row.cells[0] ?? null).trim()
          : "";

    let topic = section && label ? `${section} – ${label}` : section || label || "Overall";

    const tRounded = isFractions || isPoints ? Math.round(targetVal) : +targetVal.toFixed(2);
    const cRounded = isFractions || isPoints ? Math.round(compMean) : +compMean.toFixed(2);

    let statement = `Customer study: ${scope.vehicleCode} is ${size} ${direction} ${compPhrase} on "${topic}" in ${scope.market} (${tRounded} vs ${cRounded}).`;
    if (statement.length > 300) {
      const maxTopicLen = Math.max(10, 300 - (statement.length - topic.length) - 3);
      topic = `${topic.slice(0, maxTopicLen)}...`;
      statement = `Customer study: ${scope.vehicleCode} is ${size} ${direction} ${compPhrase} on "${topic}" in ${scope.market} (${tRounded} vs ${cRounded}).`;
    }

    const category = categoryFor(section, label || section);
    const excerpt = `${table.header[target.index]}: ${textOf(row.cells[target.index]!)}`;

    findings.push({
      id: `fnd_${shortHash(`${ingested.source.id}|study|${row.line}`)}`,
      kind: "usage_pattern",
      statement,
      category,
      evidence: [
        {
          sourceId: record.sourceId,
          recordId: record.id,
          excerpt,
          ...(record.locator ? { locator: record.locator } : {}),
        },
      ],
      mentions: 1,
      markets: [scope.market],
      confidence: 1,
      inScope: true,
    });
  });

  const allCompCodes = [...new Set(comparators.map((c) => c.code))];
  notes.push(
    `Customer study "${sheet}": compared ${scope.vehicleCode} with ${allCompCodes.join(", ")} in ${scope.market} on ${comparedFiguresCount} figure${comparedFiguresCount === 1 ? "" : "s"}; ${gapCount} differ${gapCount === 1 ? "s" : ""} by ≥ 10 ${isFractions || isPoints ? "points" : "%"}.`,
  );

  return { findings, notes };
}
