import type { Requirement } from "@reqflow/core";

export function formatRequirementsJson(requirements: Requirement[]): string {
  return JSON.stringify(requirements, null, 2);
}

function escapeCsvCell(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return '""';
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return `"${str}"`;
}

export function formatRequirementsCsv(requirements: Requirement[]): string {
  const headers = [
    "ID",
    "Title",
    "Category",
    "Priority",
    "Score",
    "Evidence Level",
    "Status",
    "Description",
    "Targets",
    "Assumptions",
    "Uncertainties",
    "Created At",
  ];

  const rows: string[] = [headers.join(",")];

  for (const req of requirements) {
    const targetsStr = req.targets
      .map((t) => `${t.metric}: ${t.target} (${t.acceptance})`)
      .join("; ");
    const assumptionsStr = req.assumptions.join("; ");
    const uncertaintiesStr = req.uncertainties.join("; ");

    rows.push(
      [
        escapeCsvCell(req.id),
        escapeCsvCell(req.title),
        escapeCsvCell(req.category),
        escapeCsvCell(req.priority ?? ""),
        escapeCsvCell(req.score?.total !== undefined ? Math.round(req.score.total) : ""),
        escapeCsvCell(req.evidenceLevel),
        escapeCsvCell(req.status),
        escapeCsvCell(req.description),
        escapeCsvCell(targetsStr),
        escapeCsvCell(assumptionsStr),
        escapeCsvCell(uncertaintiesStr),
        escapeCsvCell(req.createdAt),
      ].join(","),
    );
  }

  return rows.join("\n");
}

export function formatRequirementsMarkdown(
  requirements: Requirement[],
  title = "BMW Vehicle Requirements Specification",
): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total Requirements: ${requirements.length}`);
  lines.push("");

  lines.push("## Summary Table");
  lines.push("");
  lines.push("| ID | Title | Category | Priority | Score | Evidence | Status |");
  lines.push("|---|---|---|---|---|---|---|");

  for (const req of requirements) {
    const scoreVal = req.score ? `${Math.round(req.score.total)}` : "-";
    lines.push(
      `| **${req.id}** | ${req.title} | ${req.category} | ${req.priority ?? "-"} | ${scoreVal} | ${req.evidenceLevel} | \`${req.status}\` |`,
    );
  }

  lines.push("");
  lines.push("## Detailed Requirements");
  lines.push("");

  for (const req of requirements) {
    lines.push(`### ${req.id}: ${req.title}`);
    lines.push("");
    lines.push(`- **Category:** ${req.category}`);
    lines.push(`- **Status:** ${req.status}`);
    lines.push(`- **Priority:** ${req.priority ?? "Unassigned"}`);
    if (req.score) {
      lines.push(
        `- **Score:** ${Math.round(req.score.total)} / 100 (Suggested: ${req.score.suggestedPriority})`,
      );
      if (req.priorityRationale) {
        lines.push(`- **Priority Rationale:** ${req.priorityRationale}`);
      }
    }
    lines.push(`- **Evidence Level:** ${req.evidenceLevel}`);
    lines.push("");
    lines.push(`**Description:**  \n${req.description}`);
    lines.push("");

    if (req.targets.length > 0) {
      lines.push("**Measurable Targets:**");
      for (const t of req.targets) {
        lines.push(`- *${t.metric}:* ${t.target} *(Acceptance: ${t.acceptance})*`);
      }
      lines.push("");
    }

    if (req.assumptions.length > 0) {
      lines.push("**Assumptions:**");
      for (const a of req.assumptions) {
        lines.push(`- ${a}`);
      }
      lines.push("");
    }

    if (req.uncertainties.length > 0) {
      lines.push("**Uncertainties:**");
      for (const u of req.uncertainties) {
        lines.push(`- ${u}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}
