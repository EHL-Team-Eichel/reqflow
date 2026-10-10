import { readFile, lstat, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  AuditEvent,
  PipelineData,
  ResearchDataset,
  Settings,
  Workflow,
  WorkflowRun,
} from "@reqflow/core";
import {
  assertJsonByteBudget,
  PERSISTED_JSON_MAX_BYTES,
  RESEARCH_DATASET_MAX_BYTES,
} from "@reqflow/blocks";
import { SqliteRunRepository, type LocalFileStore } from "@reqflow/db";
import { ResearchDatasetRepository } from "../../../../../packages/db/src/research";
import { ReqflowError } from "../dispatch";
import { getSettingsFilePath, saveSettings } from "../settings-storage";

const State = z.object({
  settings: Settings,
  workflows: z.array(Workflow),
  runs: z.array(WorkflowRun),
});
const RunId = z.string().regex(/^run_[A-Za-z0-9_-]{1,100}$/);
const WorkflowId = z.string().regex(/^wf_[A-Za-z0-9_-]{1,100}$/);
const FileInfo = z.object({
  id: z.string().regex(/^file_[A-Za-z0-9_-]{1,100}$/),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z
    .number()
    .int()
    .min(0)
    .max(64 * 1024 * 1024),
  importedAt: z.iso.datetime(),
  extension: z.enum([".csv", ".xlsx", ".txt", ".pdf", ".docx", ".pptx"]),
});
async function readOptional(path: string): Promise<unknown | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > PERSISTED_JSON_MAX_BYTES)
      throw new Error("Unsafe legacy artifact");
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ReqflowError(
      "storage_error",
      "Legacy Research data could not be read. Originals were left intact.",
    );
  }
}
async function atomicWrite(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

/** One-way additive migration. Current stores win conflicts; every legacy original stays intact. */
export async function migrateLegacyResearch(
  dir: string,
  db: DatabaseSync,
  files: LocalFileStore,
  datasets: ResearchDatasetRepository,
): Promise<void> {
  const marker = join(dir, "research-sqlite-migration-v1.json");
  const migrated = await readOptional(marker);
  if (migrated !== undefined) {
    if (
      !z.object({ version: z.literal(1), migratedAt: z.iso.datetime() }).safeParse(migrated).success
    )
      throw new ReqflowError(
        "storage_error",
        "Legacy Research migration marker failed validation.",
      );
    return;
  }
  const raw = await readOptional(join(dir, "app-state.json"));
  if (raw === undefined) return;
  try {
    const state = State.parse(raw);
    for (const workflow of state.workflows) WorkflowId.parse(workflow.id);
    for (const run of state.runs) {
      RunId.parse(run.id);
      WorkflowId.parse(run.workflowId);
    }
    const fileRaw = await readOptional(join(dir, "files.json"));
    const imports = fileRaw === undefined ? [] : z.array(FileInfo).parse(fileRaw);
    const runs = new SqliteRunRepository(db);
    const known = new Set((await runs.list()).map((run) => run.id));
    // Validate all preservable artifacts before modifying the destination.
    const artifacts = await Promise.all(
      state.runs.map(async (run) => {
        const outputs = await readOptional(join(dir, `${run.id}.outputs.json`));
        if (outputs !== undefined)
          z.record(z.string(), z.record(z.string(), PipelineData)).parse(outputs);
        const value = await readOptional(join(dir, `${run.id}.research.json`));
        const dataset = value === undefined ? undefined : ResearchDataset.parse(value);
        if (dataset) {
          if (dataset.runId !== run.id) throw new Error("mismatched run");
          assertJsonByteBudget(dataset, RESEARCH_DATASET_MAX_BYTES);
        }
        return {
          run,
          outputs: outputs as Record<string, Record<string, PipelineData>> | undefined,
          dataset,
        };
      }),
    );
    const auditRaw = await readOptional(join(dir, "audit.json"));
    const audit = auditRaw === undefined ? [] : z.array(AuditEvent).parse(auditRaw);
    for (const file of imports) {
      const { extension, ...info } = file;
      await files.importLegacyFile(join(dir, "uploads", `${file.id}${extension}`), info);
    }
    await mkdir(join(dir, "workflows"), { recursive: true, mode: 0o700 });
    for (const workflow of state.workflows) {
      const path = join(dir, "workflows", `${workflow.id}.json`);
      if (!existsSync(path)) await atomicWrite(path, workflow);
    }
    if (!existsSync(getSettingsFilePath(dir))) saveSettings(dir, state.settings);
    for (const { run: original, outputs, dataset } of artifacts) {
      if (known.has(original.id)) continue;
      // Import the original state faithfully; the main startup recovery handles
      // interrupted current and migrated runs identically, including their audit.
      const run = structuredClone(original);
      // Atomic per-run import. Retrying after interruption never skips partial artifacts.
      db.exec("SAVEPOINT legacy_research_run");
      try {
        await runs.create(run);
        datasets.saveSettings(run.id, state.settings);
        for (const [blockId, value] of Object.entries(outputs ?? {}))
          await runs.saveBlockOutput(run.id, blockId, value);
        if (dataset) datasets.save(run.id, "legacy", dataset, dataset);
        db.exec("RELEASE legacy_research_run");
      } catch (error) {
        db.exec("ROLLBACK TO legacy_research_run; RELEASE legacy_research_run");
        throw error;
      }
    }
    const insert = db.prepare(`INSERT OR IGNORE INTO audit_events
      (id, at, action, entity_type, entity_id, actor, changes, rationale, run_id, block_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const event of audit)
      insert.run(
        event.id,
        event.at,
        event.action,
        event.entityType,
        event.entityId,
        JSON.stringify(event.actor),
        JSON.stringify(event.changes),
        event.rationale ?? null,
        event.runId ?? null,
        event.blockId ?? null,
      );
    await atomicWrite(marker, { version: 1, migratedAt: new Date().toISOString() });
  } catch (error) {
    if (error instanceof ReqflowError) throw error;
    throw new ReqflowError(
      "storage_error",
      "Legacy Research migration failed validation or persistence. Originals were left intact.",
    );
  }
}
