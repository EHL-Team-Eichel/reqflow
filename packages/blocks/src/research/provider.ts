import type {
  CollectedItem,
  CollectionStatus,
  ConnectionReport,
  ResearchAgentId,
  ResearchLimits,
  ResearchProviderConfig,
  ResearchProviderId,
  ResearchScope,
  SecretName,
} from "@reqflow/core";

export interface HttpOptions {
  method?: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  retryPost?: boolean;
}
export interface ProviderHttp {
  json<T = unknown>(url: string, options?: HttpOptions): Promise<T>;
  text(url: string, options?: HttpOptions): Promise<string>;
  readonly requests: number;
}
export interface CollectionRequest {
  agentId: ResearchAgentId;
  scope: ResearchScope;
  queries: string[];
}
export interface ProviderContext {
  http: ProviderHttp;
  credentials: Readonly<Partial<Record<SecretName, string>>>;
  config: ResearchProviderConfig;
  limits: ResearchLimits;
  signal: AbortSignal;
  log(message: string): void;
  now(): string;
  documents?: {
    read(fileId: string, maxPages: number, signal: AbortSignal): Promise<CollectedItem[]>;
    available(): Promise<ConnectionReport>;
  };
}
export interface CollectionOutcome {
  items: CollectedItem[];
  status: CollectionStatus;
  limitations: string[];
}
export interface ProviderAdapter {
  id: ResearchProviderId;
  collect(request: CollectionRequest, ctx: ProviderContext): Promise<CollectionOutcome>;
  test(ctx: ProviderContext): Promise<ConnectionReport>;
}
export class ProviderError extends Error {
  constructor(
    readonly code:
      | "invalid_credentials"
      | "permission_required"
      | "rate_limited"
      | "unreachable"
      | "unsupported"
      | "limit_reached"
      | "cancelled",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
