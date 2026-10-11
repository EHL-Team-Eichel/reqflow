import {
  SCORE_FACTOR_LABELS,
  ScoreFactor,
  type Actor,
  type EvidenceRef,
  type Finding,
  type Requirement,
  type RequirementDetail,
  type ScoreFlag,
  type Source,
} from "@reqflow/core";

/** A requirement with what it links to, as `SqliteRequirementRepository.get` loads it. */
export type RequirementExport = Pick<
  RequirementDetail,
  "requirement" | "findings" | "sources" | "records"
>;

const FLAG_LABELS: Record<ScoreFlag, string> = {
  high_score_weak_evidence: "High score on weak evidence (C/D)",
};
const NOT_FOUND = "(not found in the database)";
const LIST = " | ";

/** Splits the detail into what the exports show: supporting vs conflicting findings, sources. */
function resolve(item: RequirementExport) {
  const r = item.requirement;
  const findingById = new Map(item.findings.map((f) => [f.id, f]));
  const sourceById = new Map(item.sources.map((s) => [s.id, s]));
  const recordById = new Map(item.records.map((rec) => [rec.id, rec]));
  const pick = (ids: string[]) => ids.flatMap((id) => findingById.get(id) ?? []);
  // The requirement's own sources first, then any other source its findings cite.
  const sourceIds = [...new Set([...r.sourceIds, ...item.sources.map((s) => s.id)])];
  return {
    findings: pick(r.findingIds),
    conflictingFindings: pick(r.conflictingFindingIds),
    sourceIds,
    sources: sourceIds.flatMap((id) => sourceById.get(id) ?? []),
    findingLine: (id: string) => {
      const f = findingById.get(id);
      return `${id}: ${f ? f.statement : NOT_FOUND}`;
    },
    sourceLine: (id: string) => {
      const s = sourceById.get(id);
      return `${id}: ${s ? describeSource(s) : NOT_FOUND}`;
    },
    excerpt: (e: EvidenceRef) => {
      const title = sourceById.get(e.sourceId)?.title ?? e.sourceId;
      const locator = e.locator ?? (e.recordId ? recordById.get(e.recordId)?.locator : undefined);
      return `"${e.excerpt}" — ${title}${locator ? `, ${locator}` : ""}`;
    },
  };
}

function describeSource(s: Source): string {
  const details = [s.kind, s.reliability ?? "reliability not assessed", s.uri].filter(Boolean);
  return `${s.title} (${details.join(", ")})`;
}

function describeActor(actor: Actor): string {
  if (actor.type === "human") return actor.role ? `${actor.name} (${actor.role})` : actor.name;
  if (actor.type === "ai") return `AI ${actor.component} (${actor.model})`;
  return `System ${actor.component}`;
}

function scoreBreakdown(r: Requirement): string[] {
  if (!r.score) return [];
  return ScoreFactor.options.map((f) => {
    const s = r.score!.factors[f];
    return `${SCORE_FACTOR_LABELS[f]} ${s.value}/5 × ${s.weight} — ${s.note}`;
  });
}

const flags = (r: Requirement) => (r.score?.flags ?? []).map((f) => FLAG_LABELS[f]);
const confidence = (r: Requirement) =>
  r.confidence ? `${r.confidence.value.toFixed(2)} (${r.confidence.level})` : "";
const target = (t: Requirement["targets"][number]) =>
  `${t.metric}: ${t.target} (acceptance: ${t.acceptance})`;

/**
 * Spreadsheet apps run a cell that starts like a formula. A leading ' keeps it text (mirrors the
 * research exporter's `safeSpreadsheetText`, which this package can't import).
 */
function spreadsheetSafe(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  return /^(?:[\t\r]|[\s\u0000-\u001f]*[=+@-])/.test(text) ? `'${text}` : text;
}

function csvCell(value: unknown): string {
  return `"${spreadsheetSafe(value).replaceAll('"', '""')}"`;
}

/** `{ generatedAt, count, requirements: [{ ...requirement, findings, conflictingFindings, sources }] }` */
export function formatRequirementsJson(
  items: RequirementExport[],
  generatedAt = new Date().toISOString(),
): string {
  const requirements = items.map((item) => {
    const { findings, conflictingFindings, sources } = resolve(item);
    return { ...item.requirement, findings, conflictingFindings, sources };
  });
  return JSON.stringify({ generatedAt, count: items.length, requirements }, null, 2);
}

const CSV_HEADERS = [
  "ID",
  "Version",
  "Title",
  "Description",
  "Category",
  "Status",
  "Priority",
  "Priority rationale",
  "Score",
  "Suggested priority",
  "Score breakdown",
  "Flags",
  "Evidence level",
  "Confidence",
  "Kano",
  "Input rank",
  "Targets",
  "Assumptions",
  "Uncertainties",
  "Findings",
  "Conflicting findings",
  "Sources",
  "Evidence excerpts",
  "Created by",
  "Created at",
  "Updated at",
  "Run",
];

/** One row per requirement with everything it holds; every cell is quoted and formula-safe. */
export function formatRequirementsCsv(items: RequirementExport[]): string {
  const rows = [CSV_HEADERS.join(",")];
  for (const item of items) {
    const r = item.requirement;
    const x = resolve(item);
    const values: unknown[] = [
      r.id,
      r.version,
      r.title,
      r.description,
      r.category,
      r.status,
      r.priority,
      r.priorityRationale,
      r.score?.total,
      r.score?.suggestedPriority,
      scoreBreakdown(r).join(LIST),
      flags(r).join(LIST),
      r.evidenceLevel,
      confidence(r),
      r.kano,
      r.inputRank,
      r.targets.map(target).join(LIST),
      r.assumptions.join(LIST),
      r.uncertainties.join(LIST),
      r.findingIds.map(x.findingLine).join(LIST),
      r.conflictingFindingIds.map(x.findingLine).join(LIST),
      x.sourceIds.map(x.sourceLine).join(LIST),
      x.findings.flatMap((f) => f.evidence.map(x.excerpt)).join(LIST),
      describeActor(r.createdBy),
      r.createdAt,
      r.updatedAt,
      r.runId,
    ];
    rows.push(values.map(csvCell).join(","));
  }
  return rows.join("\n");
}

/** Keeps a value on one Markdown table row. */
const tableCell = (value: unknown) =>
  value === undefined || value === null || value === ""
    ? "-"
    : String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
/** Keeps a value on one Markdown list line. */
const inline = (value: string) => value.replace(/\r?\n/g, " ");
const quote = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => `  > ${line}`)
    .join("\n");

function findingSection(
  heading: string,
  ids: string[],
  item: RequirementExport,
  x: ReturnType<typeof resolve>,
): string[] {
  if (!ids.length) return [];
  const lines = [`**${heading}:**`, ""];
  for (const id of ids) {
    const f = item.findings.find((candidate) => candidate.id === id);
    if (!f) {
      lines.push(`- **${id}** ${NOT_FOUND}`);
      continue;
    }
    lines.push(`- **${f.id}** (${f.kind}, ${f.mentions} mentions): ${inline(f.statement)}`);
    for (const e of f.evidence) lines.push(quote(x.excerpt(e)));
  }
  lines.push("");
  return lines;
}

const bulletList = (heading: string, values: string[]) =>
  values.length ? [`**${heading}:**`, "", ...values.map((v) => `- ${inline(v)}`), ""] : [];

export function formatRequirementsMarkdown(
  items: RequirementExport[],
  title = "BMW Vehicle Requirements Specification",
  generatedAt = new Date().toISOString(),
): string {
  const lines: string[] = [
    `# ${title}`,
    "",
    `Generated: ${generatedAt}`,
    `Total requirements: ${items.length}`,
    "",
    "## Summary",
    "",
    "| ID | Title | Category | Status | Priority | Score | Evidence | Confidence |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const { requirement: r } of items) {
    lines.push(
      `| **${r.id}** | ${[r.title, r.category, r.status, r.priority, r.score?.total, r.evidenceLevel, confidence(r)].map(tableCell).join(" | ")} |`,
    );
  }
  lines.push("", "## Requirements", "");

  for (const item of items) {
    const r = item.requirement;
    const x = resolve(item);
    lines.push(`### ${r.id}: ${inline(r.title)}`, "");
    lines.push(`- **Version:** ${r.version}`);
    lines.push(`- **Status:** ${r.status}`);
    lines.push(`- **Category:** ${r.category}`);
    lines.push(
      `- **Priority:** ${r.priority ?? "unassigned"}${r.score ? ` (suggested by the score: ${r.score.suggestedPriority})` : ""}`,
    );
    if (r.priorityRationale) lines.push(`- **Priority rationale:** ${inline(r.priorityRationale)}`);
    lines.push(
      `- **Score:** ${r.score ? `${r.score.total} / 100 (${r.score.method})` : "not scored"}`,
    );
    if (flags(r).length) lines.push(`- **Flags:** ${flags(r).join(", ")}`);
    lines.push(`- **Evidence level:** ${r.evidenceLevel}`);
    lines.push(`- **Confidence:** ${confidence(r) || "not rated"}`);
    if (r.kano) lines.push(`- **Kano:** ${r.kano}`);
    if (r.inputRank !== undefined) lines.push(`- **Input rank:** ${r.inputRank}`);
    lines.push(`- **Created by:** ${describeActor(r.createdBy)} at ${r.createdAt}`);
    lines.push(`- **Updated at:** ${r.updatedAt}`);
    if (r.runId) lines.push(`- **Run:** ${r.runId}`);
    lines.push("", "**Description:**", "", r.description, "");

    if (r.score) {
      lines.push(
        "**Score breakdown:**",
        "",
        "| Factor | Value | Weight | Note |",
        "|---|---|---|---|",
      );
      for (const f of ScoreFactor.options) {
        const s = r.score.factors[f];
        lines.push(
          `| ${[SCORE_FACTOR_LABELS[f], `${s.value}/5`, s.weight, s.note].map(tableCell).join(" | ")} |`,
        );
      }
      lines.push("");
    }
    lines.push(...bulletList("Measurable targets", r.targets.map(target)));
    lines.push(...bulletList("Assumptions", r.assumptions));
    lines.push(...bulletList("Uncertainties", r.uncertainties));
    lines.push(...findingSection("Supporting findings", r.findingIds, item, x));
    lines.push(...findingSection("Conflicting findings", r.conflictingFindingIds, item, x));
    lines.push(...bulletList("Sources", x.sourceIds.map(x.sourceLine)));
    lines.push("---", "");
  }
  return lines.join("\n");
}
