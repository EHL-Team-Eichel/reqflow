import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveDialogOptions, SaveDialogReturnValue } from "electron";
import { emptyPipelineData, type Requirement } from "@reqflow/core";
import {
  fixtureFindings,
  fixtureRecords,
  fixtureRequirements,
  fixtureSources,
} from "@reqflow/core/fixtures";
import { createDatabase, createFileStore, SqliteRequirementRepository } from "@reqflow/db";
import { createHandlers } from "./handlers";
import { SecretsStore } from "./secrets";

// Synthetic data only: fixture requirements with their fixture evidence.
const conflicted: Requirement = {
  ...fixtureRequirements[1]!,
  id: "REQ-F70-EU-991",
  title: "@synthetic formula-like title",
  runId: "run_synthetic_a",
};
const other: Requirement = {
  ...fixtureRequirements[0]!,
  id: "REQ-F70-EU-992",
  runId: "run_synthetic_b",
};

let dir: string;
let handlers: ReturnType<typeof createHandlers>;
let saveDialog: ReturnType<typeof vi.fn<(o: SaveDialogOptions) => Promise<SaveDialogReturnValue>>>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "reqflow-synthetic-export-"));
  saveDialog = vi.fn(async (opts: SaveDialogOptions) => ({
    canceled: false,
    filePath: join(dir, opts.defaultPath!),
  }));
  handlers = createHandlers({
    dataDir: dir,
    dbPath: join(dir, "test.db"),
    files: createFileStore(join(dir, "uploads")),
    pickFile: async () => null,
    saveDialog,
    secretsStore: new SecretsStore(dir, {
      environment: {},
      secureStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`synthetic:${value}`),
        decryptString: (value) => value.toString().slice("synthetic:".length),
      },
    }),
    appInfo: () => ({ version: "synthetic", platform: "darwin", dataDir: dir, isPackaged: false }),
  });
  await handlers.app.info();
  const db = createDatabase(join(dir, "test.db"));
  await new SqliteRequirementRepository(db).savePipelineData({
    ...emptyPipelineData(),
    requirements: [conflicted, other],
    sources: fixtureSources,
    records: fixtureRecords,
    findings: fixtureFindings,
  });
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const exported = async (format: "csv" | "md" | "json", runId?: string) => {
  const result = await handlers.exports.requirements({ format, runId });
  expect(result).not.toBeNull();
  return readFileSync(result!.path, "utf8");
};

describe("exports.requirements", () => {
  it("exports JSON with each requirement's findings, conflicting findings and sources", async () => {
    const json = JSON.parse(await exported("json"));
    expect(json.count).toBe(2);
    expect(json.requirements.map((r: Requirement) => r.id)).toEqual([conflicted.id, other.id]);
    const [first] = json.requirements;
    expect(first.findings.map((f: { id: string }) => f.id)).toEqual(conflicted.findingIds);
    expect(first.conflictingFindings.map((f: { id: string }) => f.id)).toEqual([
      "fnd_grille_praise",
    ]);
    expect(first.conflictingFindings[0].evidence[0].excerpt).toBe(
      fixtureFindings.find((f) => f.id === "fnd_grille_praise")!.evidence[0]!.excerpt,
    );
    expect(first.sources.map((s: { id: string }) => s.id)).toEqual(["src_feedback01"]);
  });

  it("exports CSV and Markdown with evidence, formula-safe, filtered by run", async () => {
    const csv = await exported("csv", "run_synthetic_a");
    const lines = csv.split("\n");
    expect(lines[0]).toMatch(/^ID,Version,Title,Description,/);
    expect(csv).toContain(`"${conflicted.id}","1","'@synthetic formula-like title"`);
    expect(csv).toContain("fnd_grille_praise: ");
    expect(csv).not.toContain(other.id);

    const md = await exported("md");
    expect(md).toContain(`### ${conflicted.id}: @synthetic formula-like title`);
    expect(md).toContain("**Conflicting findings:**");
    expect(md).toContain(`### ${other.id}:`);

    const events = await handlers.audit.list({ action: "export.created" });
    expect(events.map((e) => e.rationale)).toEqual([
      "Exported 1 requirements as csv",
      "Exported 2 requirements as md",
    ]);
    expect(events[0]).toMatchObject({
      runId: "run_synthetic_a",
      entityId: "bmw_requirements_run_synthetic_a.csv",
    });
  });

  it("writes nothing and audits nothing when the save dialog is cancelled", async () => {
    saveDialog.mockResolvedValueOnce({ canceled: true, filePath: "" });
    expect(await handlers.exports.requirements({ format: "json" })).toBeNull();
    expect(await handlers.audit.list({ action: "export.created" })).toEqual([]);
  });
});
