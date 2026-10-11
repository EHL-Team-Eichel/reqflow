/**
 * Finding the meaning of columns by their header. BMW's exact formats aren't known yet, so each role
 * has English and German synonyms; matching ignores case, spaces, dashes and underscores.
 * Extend the lists when the real data arrives (WS5).
 */
export const COLUMN_SYNONYMS = {
  text: [
    "comment",
    "customerfeedback",
    "customercomment",
    "feedbacktext",
    "commenttext",
    "comments",
    "feedback",
    "verbatim",
    "text",
    "remark",
    "answer",
    "response",
    "freetext",
    "kommentar",
    "freitext",
    "anmerkung",
    "antwort",
    "bemerkung",
  ],
  id: ["id", "feedbackid", "commentid", "responseid", "caseid", "ticketid", "verbatimid"],
  market: ["market", "country", "region", "markt", "land", "marketcode", "countrycode"],
  language: ["language", "lang", "locale", "sprache"],
  model: ["model", "series", "vehicle", "modell", "baureihe"],
  derivative: ["derivative", "variant", "body", "bodystyle", "derivat", "karosserie"],
  option: [
    "option",
    "optionname",
    "equipment",
    "feature",
    "optionaltext",
    "ausstattung",
    "sonderausstattung",
    "sa",
  ],
  category: ["category", "area", "kategorie", "bereich"],
  takeRate: [
    "takerate",
    "takeratepct",
    "takeratepercent",
    "rate",
    "share",
    "einbaurate",
    "einbauquote",
    "quote",
  ],
  units: [
    "units",
    "volume",
    "sales",
    "quantity",
    "deliveries",
    "stueckzahl",
    "stückzahl",
    "menge",
    "absatz",
    "zulassungen",
  ],
  period: [
    "period",
    "year",
    "quarter",
    "month",
    "date",
    "jahr",
    "quartal",
    "monat",
    "zeitraum",
    "modelyear",
  ],
} as const;

export type ColumnRole = keyof typeof COLUMN_SYNONYMS;

export type ColumnMapping = Partial<Record<ColumnRole, number>>;

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-./%()]+/g, "");

/**
 * Parses user column mapping syntax: `role=Header; role=Header` (separators: `;`, `,`, or newlines).
 * Roles must be one of the keys in COLUMN_SYNONYMS.
 * Headers are matched case-insensitively using the same normalization as synonyms.
 */
export function parseColumnMapping(
  spec: string,
  header: readonly string[],
): { mapping: ColumnMapping; notes: string[] } {
  const trimmed = spec.trim();
  if (!trimmed) return { mapping: {}, notes: [] };

  const validRoles = Object.keys(COLUMN_SYNONYMS) as ColumnRole[];
  const mapping: ColumnMapping = {};
  const notes: string[] = [];
  const mappedRoles = new Set<ColumnRole>();

  const entries = trimmed
    .split(/[;\n,]+/)
    .map((e) => e.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      throw new Error(`Column mapping: malformed pair "${entry}". Expected role=Header.`);
    }
    const roleStr = entry.slice(0, eq).trim();
    const headerStr = entry.slice(eq + 1).trim();
    if (!roleStr || !headerStr) {
      throw new Error(`Column mapping: malformed pair "${entry}". Expected role=Header.`);
    }

    const role = validRoles.find((r) => r.toLowerCase() === roleStr.toLowerCase());
    if (!role) {
      throw new Error(
        `Column mapping: unknown role "${roleStr}". Roles: ${validRoles.join(", ")}.`,
      );
    }

    if (mappedRoles.has(role)) {
      throw new Error(`Column mapping: role "${roleStr}" mapped twice.`);
    }
    mappedRoles.add(role);

    const normTarget = norm(headerStr);
    const colIndex = header.findIndex((h) => norm(h) === normTarget);
    if (colIndex === -1) {
      throw new Error(
        `Column mapping: no column "${headerStr}" in this sheet. Columns: ${header.map((h) => `"${h}"`).join(", ")}.`,
      );
    }

    mapping[role] = colIndex;
    notes.push(`Column mapping: ${role} = "${header[colIndex]}".`);
  }

  return { mapping, notes };
}

/** Every column that could have `role`: explicit mapping wins, then exact synonym matches, then prefix matches. */
export function findColumns(
  header: readonly string[],
  role: ColumnRole,
  mapping?: ColumnMapping,
): number[] {
  if (mapping?.[role] !== undefined) {
    return [mapping[role]!];
  }
  const names = header.map(norm);
  const synonyms: readonly string[] = COLUMN_SYNONYMS[role];
  const exact = names.flatMap((n, i) => (synonyms.includes(n) ? [i] : []));
  const prefix = names.flatMap((n, i) =>
    !exact.includes(i) && synonyms.some((s) => s.length >= 4 && n.startsWith(s)) ? [i] : [],
  );
  return [...exact, ...prefix];
}

/** Index of the column for `role`, or -1. Explicit mapping wins over synonym detection. */
export function findColumn(
  header: readonly string[],
  role: ColumnRole,
  mapping?: ColumnMapping,
): number {
  return findColumns(header, role, mapping)[0] ?? -1;
}

/**
 * Parses numbers as they appear in exports: 84, "84%", "84,5 %", "1.234" (German thousands),
 * "1,234.5". Returns null when it isn't a number.
 */
export function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  let s = value.replace(/[%\s ]/g, "");
  if (!s) return null;
  // Thousands separators only when the number doesn't start with 0 ("0,845" is a German decimal).
  if (/^-?[1-9]\d{0,2}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^-?[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const n = Number(s);
  return /^-?\d*\.?\d+$/.test(s) && Number.isFinite(n) ? n : null;
}
