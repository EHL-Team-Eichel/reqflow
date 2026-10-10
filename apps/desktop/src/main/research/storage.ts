import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Settings,
  DEFAULT_SETTINGS,
  Workflow,
  WorkflowRun,
  ResearchDataset,
  AuditEvent,
  PipelineData,
} from "@reqflow/core";
import { ReqflowError } from "../dispatch";
import { assertJsonByteBudget, PERSISTED_JSON_MAX_BYTES } from "@reqflow/blocks";

const State = z.object({
  settings: Settings,
  workflows: z.array(Workflow),
  runs: z.array(WorkflowRun),
});
export class ResearchStore {
  state: z.infer<typeof State> = {
    settings: structuredClone(DEFAULT_SETTINGS),
    workflows: [],
    runs: [],
  };
  private queue: Promise<unknown> = Promise.resolve();
  private auditQueue: Promise<unknown> = Promise.resolve();
  constructor(readonly dir: string) {}
  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      this.state = State.parse(
        JSON.parse(await readFile(join(this.dir, "app-state.json"), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ReqflowError(
          "storage_error",
          "App state could not be read or failed validation.",
        );
    }
    for (const run of this.state.runs)
      if (run.status === "running" || run.status === "queued") {
        run.status = "failed";
        run.error =
          "App stopped before run finished; preserved research results remain exportable.";
        run.finishedAt = new Date().toISOString();
      }
    await this.saveState();
  }
  async write(name: string, value: unknown): Promise<void> {
    try {
      assertJsonByteBudget(value, PERSISTED_JSON_MAX_BYTES);
    } catch {
      throw new ReqflowError(
        "storage_limit",
        "Local JSON exceeds the 64 MiB raw-data budget or is not supported JSON data. Existing stored originals remain available.",
      );
    }
    const serialized = JSON.stringify(value);
    const operation = this.queue.then(async () => {
      const temp = join(this.dir, `.write-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, serialized, { mode: 0o600 });
        await rename(temp, join(this.dir, name));
      } finally {
        await rm(temp, { force: true });
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  saveState(): Promise<void> {
    return this.write("app-state.json", structuredClone(State.parse(this.state)));
  }
  async dataset(runId: string): Promise<ResearchDataset> {
    return this.read(`${validRun(runId)}.research.json`, ResearchDataset);
  }
  async outputs(runId: string): Promise<Record<string, Record<string, PipelineData>>> {
    // Parse for validity but keep ResearchRecord's additional provenance properties intact.
    const raw = await this.read(`${validRun(runId)}.outputs.json`, z.unknown());
    try {
      z.record(z.string(), z.record(z.string(), PipelineData)).parse(raw);
    } catch {
      throw new ReqflowError("storage_error", "Stored block outputs failed validation.");
    }
    return raw as Record<string, Record<string, PipelineData>>;
  }
  async read<T>(name: string, schema: z.ZodType<T>): Promise<T> {
    try {
      return schema.parse(JSON.parse(await readFile(join(this.dir, name), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new ReqflowError("not_found", "Requested local data is not available.");
      throw new ReqflowError(
        "storage_error",
        "Stored local data could not be read or failed validation.",
      );
    }
  }
  async audit(event: AuditEvent): Promise<void> {
    const validated = AuditEvent.parse(event);
    const operation = this.auditQueue.then(async () => {
      let existing: AuditEvent[] = [];
      try {
        existing = await this.read("audit.json", z.array(AuditEvent));
      } catch (error) {
        if (!(error instanceof ReqflowError) || error.code !== "not_found") throw error;
      }
      await this.write("audit.json", [...existing, validated]);
    });
    this.auditQueue = operation.catch(() => {});
    await operation;
  }
}
export function validRun(value: string): string {
  return z
    .string()
    .regex(/^run_[A-Za-z0-9_-]+$/)
    .parse(value);
}
