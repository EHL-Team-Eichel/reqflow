import { beforeEach, describe, expect, it } from "vitest";
import { emptyPipelineData, type Requirement } from "@reqflow/core";
import {
  fixtureFindings,
  fixtureRecords,
  fixtureRequirements,
  fixtureSources,
} from "@reqflow/core/fixtures";
import { createDatabase } from "./db";
import {
  formatRequirementsCsv,
  formatRequirementsJson,
  formatRequirementsMarkdown,
  type RequirementExport,
} from "./formatters";
import { SqliteRequirementRepository } from "./requirements";

// Synthetic data only: fixture requirements, re-numbered, with formula-like text planted.
const conflicted: Requirement = {
  ...fixtureRequirements[1]!, // fnd_grille_complaint, conflicting fnd_grille_praise
  id: "REQ-F70-EU-981",
  title: "=1+1 synthetic title",
  description: " =SUM(A1) synthetic description",
  priorityRationale: "\tTabbed synthetic rationale",
  assumptions: ["+synthetic assumption", "second synthetic assumption"],
  uncertainties: ["-synthetic uncertainty", "@synthetic mention"],
  targets: [{ metric: "\rCR synthetic metric", target: "≥ 70 %", acceptance: "Clinic" }],
  confidence: {
    value: 0.82,
    level: "high",
    signals: [{ key: "support", label: "Support", value: 0.9, weight: 1, by: "deterministic" }],
    method: "agent-confidence@1",
  },
  inputRank: 2,
};
const plain: Requirement = {
  ...fixtureRequirements[2]!, // fnd_menus, fnd_ui_trend
  id: "REQ-F70-EU-982",
  version: 1,
  title: "Climate | controls synthetic",
  findingIds: [...fixtureRequirements[2]!.findingIds, "fnd_synthetic_missing"],
};
const finding = (id: string) => fixtureFindings.find((f) => f.id === id)!;
const source = (id: string) => fixtureSources.find((s) => s.id === id)!;

let items: RequirementExport[];

beforeEach(async () => {
  const repo = new SqliteRequirementRepository(createDatabase(":memory:"));
  await repo.savePipelineData({
    ...emptyPipelineData(),
    requirements: [conflicted, plain],
    sources: fixtureSources,
    records: fixtureRecords,
    findings: fixtureFindings,
  });
  items = [await repo.get(conflicted.id), await repo.get(plain.id)];
});

/** RFC 4180 reader, enough for the exporter's always-quoted cells. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') ((cell += '"'), i++);
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(cell), (cell = ""));
    else if (c === "\n") (row.push(cell), rows.push(row), (row = []), (cell = ""));
    else cell += c;
  }
  row.push(cell);
  rows.push(row);
  const [header, ...body] = rows;
  for (const r of body) expect(r).toHaveLength(header!.length);
  return body.map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i]!])));
}

describe("formatRequirementsCsv", () => {
  it("writes one row per requirement with every field the briefing asks for", () => {
    const csv = formatRequirementsCsv(items);
    expect(csv.split("\n")[0]).toBe(
      "ID,Version,Title,Description,Category,Status,Priority,Priority rationale,Score," +
        "Suggested priority,Score breakdown,Flags,Evidence level,Confidence,Kano,Input rank," +
        "Targets,Assumptions,Uncertainties,Findings,Conflicting findings,Sources," +
        "Evidence excerpts,Created by,Created at,Updated at,Run",
    );
    const [row, second] = parseCsv(csv);
    expect(row).toMatchObject({
      ID: conflicted.id,
      Version: "1",
      Category: conflicted.category,
      Status: conflicted.status,
      Priority: conflicted.priority,
      Score: String(conflicted.score!.total),
      "Suggested priority": conflicted.score!.suggestedPriority,
      "Evidence level": "C",
      Confidence: "0.82 (high)",
      Kano: conflicted.kano,
      "Input rank": "2",
      "Created by": "AI ai_splitter (claude-opus-5-5)",
      "Created at": conflicted.createdAt,
      "Updated at": conflicted.updatedAt,
      Run: conflicted.runId,
    });
    const { customer_impact } = conflicted.score!.factors;
    expect(row!["Score breakdown"]!.split(" | ")).toHaveLength(6);
    expect(row!["Score breakdown"]).toContain(
      `Customer impact ${customer_impact.value}/5 × ${customer_impact.weight} — ${customer_impact.note}`,
    );
    const complaint = finding("fnd_grille_complaint");
    const praise = finding("fnd_grille_praise");
    expect(row!.Findings).toBe(`fnd_grille_complaint: ${complaint.statement}`);
    expect(row!["Conflicting findings"]).toBe(`fnd_grille_praise: ${praise.statement}`);
    const feedback = source("src_feedback01");
    expect(row!.Sources).toContain(`src_feedback01: ${feedback.title} (${feedback.kind}`);
    // Supporting evidence, verbatim, with its source; the conflicting quote has its own column.
    for (const e of complaint.evidence)
      expect(row!["Evidence excerpts"]).toContain(`"${e.excerpt}" — ${source(e.sourceId).title}`);
    for (const e of praise.evidence) expect(row!["Evidence excerpts"]).not.toContain(e.excerpt);

    expect(second!.Findings).toContain("fnd_synthetic_missing: (not found in the database)");
    expect(second!.Sources!.split(" | ").map((s) => s.split(":")[0])).toEqual(
      expect.arrayContaining(plain.sourceIds),
    );
  });

  it("keeps cells that start like a spreadsheet formula as text", () => {
    const [row, second] = parseCsv(formatRequirementsCsv(items));
    expect(row!.Title).toBe("'=1+1 synthetic title");
    expect(row!.Description).toBe("' =SUM(A1) synthetic description");
    expect(row!["Priority rationale"]).toBe("'\tTabbed synthetic rationale");
    expect(row!.Assumptions).toBe("'+synthetic assumption | second synthetic assumption");
    expect(row!.Uncertainties).toBe("'-synthetic uncertainty | @synthetic mention");
    expect(row!.Targets).toBe("'\rCR synthetic metric: ≥ 70 % (acceptance: Clinic)");
    expect(second!.Title).toBe("Climate | controls synthetic");
    expect(second!.ID).toBe(plain.id);
  });

  it("writes only the header for no requirements", () => {
    expect(formatRequirementsCsv([]).split("\n")).toHaveLength(1);
  });
});

describe("formatRequirementsMarkdown", () => {
  it("has the summary table and a full section per requirement", () => {
    const md = formatRequirementsMarkdown(items, "Synthetic export", "2026-10-11T08:00:00.000Z");
    expect(md).toContain("# Synthetic export\n\nGenerated: 2026-10-11T08:00:00.000Z");
    expect(md).toContain(
      "| ID | Title | Category | Status | Priority | Score | Evidence | Confidence |",
    );
    expect(md).toContain(`| **${plain.id}** | Climate \\| controls synthetic |`);
    const section = md.slice(md.indexOf(`### ${conflicted.id}`), md.indexOf(`### ${plain.id}`));
    for (const text of [
      "- **Version:** 1",
      `- **Priority:** ${conflicted.priority} (suggested by the score: ${conflicted.score!.suggestedPriority})`,
      "- **Confidence:** 0.82 (high)",
      "- **Input rank:** 2",
      "**Score breakdown:**",
      "**Measurable targets:**",
      "**Assumptions:**",
      "**Uncertainties:**",
      "**Supporting findings:**",
      "**Conflicting findings:**",
      "**Sources:**",
      `- **fnd_grille_praise** (${finding("fnd_grille_praise").kind}`,
    ])
      expect(section).toContain(text);
    // Findings come with their verbatim excerpts as quotes.
    for (const e of finding("fnd_grille_praise").evidence)
      expect(section).toContain(`  > "${e.excerpt}" — ${source(e.sourceId).title}`);
    expect(md).toContain("- **fnd_synthetic_missing** (not found in the database)");
  });
});

describe("formatRequirementsJson", () => {
  it("wraps each requirement with its findings, conflicting findings and sources", () => {
    const json = JSON.parse(formatRequirementsJson(items, "2026-10-11T08:00:00.000Z"));
    expect(json).toMatchObject({ generatedAt: "2026-10-11T08:00:00.000Z", count: 2 });
    const [first, second] = json.requirements;
    expect(first).toMatchObject({ ...conflicted, confidence: conflicted.confidence });
    expect(first.findings).toEqual([finding("fnd_grille_complaint")]);
    expect(first.conflictingFindings).toEqual([finding("fnd_grille_praise")]);
    expect(first.sources).toEqual([source("src_feedback01")]);
    expect(second.findings.map((f: { id: string }) => f.id)).toEqual(
      fixtureRequirements[2]!.findingIds,
    );
    expect(second.findingIds).toContain("fnd_synthetic_missing");
  });
});
