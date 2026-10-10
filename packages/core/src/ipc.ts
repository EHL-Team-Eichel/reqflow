/**
 * The contract between the desktop UI (renderer) and the main process.
 * Renderer code calls `api.<namespace>.<method>(…)` (apps/desktop/src/renderer/src/lib/api.ts);
 * main implements `ReqflowHandlers` (apps/desktop/src/main). Arguments and results must be
 * structured-cloneable (plain data — no class instances, functions or Zod schemas).
 *
 * Type-only imports keep this module free of runtime deps, so the sandboxed preload can import it.
 */
import type { ApiError, RequirementDecision, RequirementEdit } from "./api";
import type { Actor, AuditAction, AuditEntityType, AuditEvent } from "./audit";
import type { PaletteBlockKind } from "./blocks";
import type { RequirementCategory } from "./category";
import type { Finding } from "./finding";
import type { PipelineData } from "./pipeline";
import type { DecisionStatus, EvidenceLevel, Requirement } from "./requirement";
import type { ReasoningTrace } from "./reasoning";
import type { Priority } from "./scoring";
import type { ProductScope } from "./scope";
import type { Settings } from "./settings";
import type { Source, SourceRecord } from "./source";
import type { Workflow, WorkflowRun, WorkflowTemplate } from "./workflow";

export interface AppInfo {
  version: string;
  platform: string; // process.platform: "darwin" | "win32" | "linux"
  dataDir: string; // where the database and imported files live
  isPackaged: boolean;
}

/** Create (no id) or update (with id) a workflow; main assigns id, version and timestamps. */
export type WorkflowSave = Pick<Workflow, "name" | "scope" | "blocks" | "edges"> & {
  id?: string;
  description?: string;
};

/** A dataset copied into the app's data directory by `files.import()`. */
export interface StoredFileInfo {
  id: string; // "file_…" — stored as `{ fileId, name }` in a Raw block's `file` param
  name: string;
  mimeType: string;
  sizeBytes: number;
  importedAt: string; // ISO datetime
}

/** Run one block that has no inputs (e.g. Raw) on its own, outside a flow run, to check its data. */
export interface BlockPreviewRequest {
  kind: PaletteBlockKind;
  params: Record<string, unknown>;
  scope: ProductScope; // the global vehicle and market (Settings), for params set to "From Settings"
}
export interface BlockPreview {
  outputs: Record<string, PipelineData>; // per output port id
  logs: string[]; // what the block reported: skipped rows, assumptions, counts
}

export interface RequirementFilter {
  runId?: string;
  status?: DecisionStatus[];
  category?: RequirementCategory[];
  priority?: Priority[];
  evidenceLevel?: EvidenceLevel[];
}

/** Everything the requirement detail page needs, already expanded. */
export interface RequirementDetail {
  requirement: Requirement; // current version
  findings: Finding[]; // supporting + conflicting
  sources: Source[];
  records: SourceRecord[]; // records cited by the findings' evidence
  versions: Requirement[]; // all versions, ascending
}

export interface AuditFilter {
  entityId?: string;
  entityType?: AuditEntityType;
  actorType?: Actor["type"];
  action?: AuditAction;
  runId?: string;
  limit?: number;
}

export type ExportFormat = "json" | "csv" | "md";

/**
 * API keys never cross into the renderer; it only learns whether one is configured.
 * `setup:<id>` is the key of an API setup (Settings → AI → API setups).
 */
export type FixedSecretName = "anthropic_api_key" | "tavily_api_key";
export type SetupSecretName = `setup:${string}`;
export type SecretName = FixedSecretName | SetupSecretName;
export const SETUP_SECRET_PATTERN = /^setup:[a-z0-9][a-z0-9-]{0,39}$/;
export interface SecretState {
  configured: boolean;
  source: "keychain" | "env" | null;
}
export type SecretStatus = Record<FixedSecretName, SecretState> & {
  /** Per API setup id. Setups without a stored key are listed as not configured. */
  setups: Record<string, SecretState>;
};

/** `settings.testSetup`: one tiny request through an API setup, to check the key and model. */
export type SetupTestResult =
  | { ok: true; model: string; ms: number; message: string }
  | { ok: false; ms: number; message: string };

export interface ReqflowApi {
  app: { info(): Promise<AppInfo> };
  templates: { list(): Promise<WorkflowTemplate[]> };
  blocks: {
    /** Fails with `invalid_input` for blocks that have inputs, `not_implemented` for unbuilt ones. */
    preview(request: BlockPreviewRequest): Promise<BlockPreview>;
  };
  workflows: {
    list(): Promise<Workflow[]>;
    get(id: string): Promise<Workflow>;
    save(input: WorkflowSave): Promise<Workflow>;
    remove(id: string): Promise<void>;
  };
  files: {
    /** Opens the native file dialog and copies the chosen file into the data dir. null = cancelled. */
    import(): Promise<StoredFileInfo | null>;
  };
  runs: {
    start(workflowId: string): Promise<WorkflowRun>;
    get(runId: string): Promise<WorkflowRun>;
    list(workflowId?: string): Promise<WorkflowRun[]>;
    /** What one block emitted, per output port id. */
    blockOutput(runId: string, blockId: string): Promise<Record<string, PipelineData>>;
    resume(runId: string): Promise<WorkflowRun>;
    cancel(runId: string): Promise<WorkflowRun>;
    /** Pushed by main on every status/progress change. Returns an unsubscribe function. */
    onUpdate(listener: (run: WorkflowRun) => void): () => void;
  };
  requirements: {
    list(filter?: RequirementFilter): Promise<Requirement[]>;
    get(id: string): Promise<RequirementDetail>;
    edit(id: string, edit: RequirementEdit): Promise<Requirement>;
    decide(id: string, decision: RequirementDecision): Promise<Requirement>;
    /**
     * Removes every requirement (all versions). The audit trail keeps one `requirement.deleted`
     * event per requirement, and their ids are never handed out again.
     */
    reset(): Promise<{ removed: number }>;
  };
  audit: { list(filter?: AuditFilter): Promise<AuditEvent[]> };
  settings: {
    get(): Promise<Settings>;
    save(settings: Settings): Promise<Settings>;
    secrets(): Promise<SecretStatus>;
    /** Stores the key encrypted with the OS keychain (Electron safeStorage); null deletes it. */
    setSecret(name: SecretName, value: string | null): Promise<SecretStatus>;
    /** Sends one tiny request through a saved API setup. Never throws for API errors. */
    testSetup(setupId: string): Promise<SetupTestResult>;
  };
  /** The Add to Car agents' thought process (see reasoning.ts). null = no agent run recorded. */
  reasoning: {
    forRun(runId: string, blockId: string): Promise<ReasoningTrace | null>;
    /** The latest run of this workflow in which the block ran its agents. */
    latest(workflowId: string, blockId: string): Promise<ReasoningTrace | null>;
    /** The trace that proposed this requirement (older requirements have none). */
    forRequirement(requirementId: string): Promise<ReasoningTrace | null>;
  };
  exports: {
    /** Opens the native save dialog and writes the requirement list. null = cancelled. */
    requirements(opts: { runId?: string; format: ExportFormat }): Promise<{ path: string } | null>;
  };
}

type InvokeKeys<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => Promise<unknown> ? K : never;
}[keyof T];

/** What main must implement: every request/response method (event subscriptions excluded). */
export type ReqflowHandlers = {
  [N in keyof ReqflowApi]: Pick<ReqflowApi[N], InvokeKeys<ReqflowApi[N]>>;
};

/** Every request/response method, by namespace. Preload allow-lists exactly these channels. */
export const IPC_INVOKE_METHODS = {
  app: ["info"],
  templates: ["list"],
  blocks: ["preview"],
  workflows: ["list", "get", "save", "remove"],
  files: ["import"],
  runs: ["start", "get", "list", "blockOutput", "resume", "cancel"],
  requirements: ["list", "get", "edit", "decide", "reset"],
  audit: ["list"],
  settings: ["get", "save", "secrets", "setSecret", "testSetup"],
  reasoning: ["forRun", "latest", "forRequirement"],
  exports: ["requirements"],
} as const satisfies { [N in keyof ReqflowApi]: readonly InvokeKeys<ReqflowApi[N]>[] };

// Compile-time guard: adding a method to ReqflowApi without listing it above is a type error.
type Listed = { [N in keyof ReqflowApi]: (typeof IPC_INVOKE_METHODS)[N][number] };
type Unlisted = {
  [N in keyof ReqflowApi]: Exclude<InvokeKeys<ReqflowApi[N]>, Listed[N]>;
}[keyof ReqflowApi];
export const IPC_METHODS_COMPLETE: [Unlisted] extends [never] ? true : Unlisted = true;

export type IpcNamespace = keyof typeof IPC_INVOKE_METHODS;

export function ipcChannel(namespace: string, method: string): string {
  return `reqflow:${namespace}.${method}`;
}

export const IPC_INVOKE_CHANNELS: ReadonlySet<string> = new Set(
  Object.entries(IPC_INVOKE_METHODS).flatMap(([ns, methods]) =>
    methods.map((m) => ipcChannel(ns, m)),
  ),
);

/** main → renderer push events. */
export const IPC_EVENTS = { runUpdate: "reqflow:event.run-update" } as const;

/** Every invoke resolves to this; the renderer client turns `ok: false` into a thrown ReqflowError. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: ApiError["error"] };

/** The only object the preload exposes on `window.reqflowBridge`. */
export interface ReqflowBridge {
  invoke(channel: string, ...args: unknown[]): Promise<IpcResult<unknown>>;
  onRunUpdate(listener: (run: WorkflowRun) => void): () => void;
}
