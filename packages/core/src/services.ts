import type { z } from "zod";
import type { AuditEvent, AuditEventInput } from "./audit";
import type { WriterRole } from "./reasoning";
import type { ApiProvider, ReasoningEffort } from "./settings";
import type { ResearchRequest, ResearchDataset } from "./research";

export interface ResearchCollector {
  collect(
    request: ResearchRequest,
    context: {
      runId: string;
      signal: AbortSignal;
      log(message: string): void;
      progress(fraction: number, message?: string): void;
      planQueries?: boolean;
    },
  ): Promise<ResearchDataset>;
}

/**
 * Service interfaces handed to blocks via BlockContext (@reqflow/engine). Implementations live
 * elsewhere (llm → @reqflow/llm, audit/files → @reqflow/db, web search → blocks/research) and are
 * wired together in the Electron main process (apps/desktop/src/main). Blocks never read env vars or the DB directly.
 */

export type ModelTier = "default" | "fast";

export interface LlmObjectRequest<T> {
  system?: string;
  prompt: string;
  schema: z.ZodType<T>;
  tier?: ModelTier; // default: "default"
  /** Reasoning models: how hard to think first. Default: the setup's own effort. */
  effort?: ReasoningEffort;
  maxTokens?: number; // cap on the answer (thinking excluded); default: provider-specific
  signal?: AbortSignal;
}

export interface LlmTextRequest {
  system?: string;
  prompt: string;
  tier?: ModelTier;
  effort?: ReasoningEffort;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Token counts reported by the provider, for the run's totals. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * How often a failed AI API call is retried before its error reaches the user (so up to 11
 * attempts). Only failures that can heal are retried: network errors, timeouts, rate limits and
 * server errors. A wrong key, a bad request or an unknown model fails at once.
 */
export const AI_RETRIES = 10;

export interface LlmClient {
  /**
   * Structured output. MUST validate against `schema` and throw on invalid output — never return
   * partial data. `thinking`: the provider's own summary of its reasoning, when it gives one.
   */
  generateObject<T>(
    req: LlmObjectRequest<T>,
  ): Promise<{ object: T; model: string; usage?: LlmUsage; thinking?: string }>;
  generateText(
    req: LlmTextRequest,
  ): Promise<{ text: string; model: string; usage?: LlmUsage; thinking?: string }>;
}

/**
 * "System 1" decisions: typed questions about one piece of text (the state), each answered with
 * probabilities instead of prose. TypeSafe's Jev answers them natively; an LLM can answer the same
 * questions (less well calibrated). Questions are independent of each other.
 */
export type DecisionQuestion =
  | { type: "noul"; instructions: string } // a statement → probability that it is true
  | { type: "score"; instructions: string; criteria: string[] } // 2–10 ordered levels, lowest first
  | { type: "choice"; instructions: string; criteria: Record<string, string> }; // option → description

export type DecisionAnswer =
  | { type: "noul"; value: number } // 0–1
  | { type: "score"; score: number; probabilities: number[]; confidence: number } // score: 0 … levels − 1
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    };

export interface DecisionRequest {
  state: string;
  questions: Record<string, DecisionQuestion>;
  signal?: AbortSignal;
}

export interface DecisionClient {
  /** MUST answer every question with the matching type, or throw. */
  decide(
    req: DecisionRequest,
  ): Promise<{ answers: Record<string, DecisionAnswer>; model: string; usage?: LlmUsage }>;
}

/** Which API an agent role runs on (Settings → AI → Agents), for logs and the thought-process view. */
export interface AgentModel {
  setupId: string; // "default" or an ApiSetup id
  setupName: string;
  provider: ApiProvider;
  model: string; // quality model
  fastModel: string; // bulk model
  maxParallel: number;
}

/** The Add to Car agents' access to AI, resolved per role from Settings. Wired in the main process. */
export interface AgentServices {
  /**
   * The model an agent role writes with. Throws a readable error when it can't be used
   * (no API key, a judge-only provider). provider "mock" means: run offline, no AI.
   */
  writer(role: WriterRole): Promise<{ info: AgentModel; llm: LlmClient }>;
  /** The judge: TypeSafe Jev when configured, else an LLM answering the same typed questions. */
  judge(): Promise<{ info: AgentModel; decisions: DecisionClient }>;
}

export interface AuditLogger {
  /** Append-only. Assigns id + timestamp and persists before resolving. */
  record(event: AuditEventInput): Promise<AuditEvent>;
}

export interface StoredFile {
  id: string; // "file_…"
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface FileStore {
  /** Throws if the file does not exist. */
  get(fileId: string): Promise<StoredFile>;
}

export interface WebSearchResult {
  url: string;
  title: string;
  snippet: string;
  publishedAt?: string; // ISO date if known
}

export interface WebSearch {
  search(
    query: string,
    opts?: { maxResults?: number; signal?: AbortSignal },
  ): Promise<WebSearchResult[]>;
}
