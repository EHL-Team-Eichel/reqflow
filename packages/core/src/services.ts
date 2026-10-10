import type { z } from "zod";
import type { AuditEvent, AuditEventInput } from "./audit";
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
  signal?: AbortSignal;
}

export interface LlmTextRequest {
  system?: string;
  prompt: string;
  tier?: ModelTier;
  signal?: AbortSignal;
}

export interface LlmClient {
  /** Structured output. MUST validate against `schema` and throw on invalid output — never return partial data. */
  generateObject<T>(req: LlmObjectRequest<T>): Promise<{ object: T; model: string }>;
  generateText(req: LlmTextRequest): Promise<{ text: string; model: string }>;
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
