import { createHash } from "node:crypto";
import { APIFY_ACTORS, type ResearchLimits } from "@reqflow/core";
import { ProviderError, type HttpOptions, type ProviderHttp } from "./provider";

const HOSTS = new Set([
  "api.firecrawl.dev",
  "api.tavily.com",
  "www.googleapis.com",
  "youtube.googleapis.com",
  "api.apify.com",
  "api.x.com",
  "api.twitter.com",
  "www.reddit.com",
  "oauth.reddit.com",
  "api.openalex.org",
  "ec.europa.eu",
]);
const RESPONSE_BYTE_LIMIT = 16 * 1024 * 1024;
export const APIFY_CLEANUP_REQUEST_LIMIT = 4;
export const APIFY_CLEANUP_TIMEOUT_MS = 5000;

/** The caller reserves planner calls in this same object before starting them. */
export interface RequestBudget {
  used: number;
}
export interface ProviderHttpOptions {
  limits: ResearchLimits;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  budget?: RequestBudget;
}
export interface ProviderHttpClient extends ProviderHttp {
  /** Included in requests, but excluded from the ordinary collection budget. */
  readonly cleanupRequests: number;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSecrets(value: string, secrets: readonly string[] = []): string {
  // Remove the entire authorization value before generic fields can consume only its scheme.
  let result = value
    .replace(
      /(\bauthorization\b[\s"']*[:=][\s"']*)(?:Bearer|Basic)\s+[^\s&,;"'}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, "[REDACTED]")
    .replace(
      /(\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|key|token)\b[\s"']*[:=][\s"']*)([^\s&,;"'}]+)/gi,
      "$1[REDACTED]",
    );
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[REDACTED]");
    // Percent escapes are case-insensitive, but literal characters in a secret are not.
    const encoded = encodeURIComponent(secret);
    for (const representation of new Set([encoded, encoded.replace(/%20/g, "+")])) {
      const pattern = representation
        .match(/%[0-9a-f]{2}|[^%]+|%/gi)!
        .map((part) =>
          /^%[0-9a-f]{2}$/i.test(part)
            ? part
                .split("")
                .map((character) =>
                  /[a-f]/i.test(character)
                    ? `[${character.toLowerCase()}${character.toUpperCase()}]`
                    : character,
                )
                .join("")
            : escapeRegex(part),
        )
        .join("");
      result = result.replace(new RegExp(pattern, "g"), "[REDACTED]");
    }
  }
  return result;
}

export function errorReport(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError(
    "unreachable",
    "Provider request failed; no sensitive response details retained.",
  );
}

function abortError(signal: AbortSignal): ProviderError {
  return new ProviderError(
    "cancelled",
    signal.reason?.name === "TimeoutError" ? "Research time limit reached." : "Research cancelled.",
  );
}

export async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Work may already have started, including a noncooperative transport's later rejection.
    void work.catch(() => {});
    throw abortError(signal);
  }
  let listener: () => void = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        listener = () => reject(abortError(signal));
        signal.addEventListener("abort", listener, { once: true });
        if (signal.aborted) listener();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Cancellation is best-effort cleanup, never a reason to leave the caller pending. */
function cancelBody(body: { cancel(): Promise<unknown> } | null | undefined): void {
  try {
    void body?.cancel().catch(() => {});
  } catch {
    /* Do not expose transport cleanup errors. */
  }
}

function endpoint(value: string): URL {
  try {
    const url = new URL(value);
    // URL.port normalizes an explicit :443 (or an empty port) away. Reject it in the authority too.
    const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      authority &&
      !authority.includes(":") &&
      HOSTS.has(url.hostname)
    )
      return url;
  } catch {
    /* Do not retain an invalid URL, which may contain credentials. */
  }
  throw new ProviderError(
    "permission_required",
    "Request endpoint is outside the fixed provider allowlist.",
  );
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      throw new ProviderError(
        "unsupported",
        "Cannot conservatively budget malformed provider request JSON.",
      );
    }
  }
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function positiveCount(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new ProviderError(
      "unsupported",
      "Cannot conservatively budget an invalid provider result count.",
    );
  return value;
}

export function createProviderHttp(options: ProviderHttpOptions): ProviderHttpClient {
  let requests = 0,
    cleanupRequests = 0,
    cleanupReservations = 0,
    credits = 0,
    active = 0;
  const budget = options.budget ?? { used: 0 };
  const cache = new Map<string, Promise<string>>();
  const apifyRuns = new Map<string, { authorizationHash: string; cleanupReserved: boolean }>();
  interface Waiter {
    signal: AbortSignal;
    abort(): void;
    resolve(): void;
    reject(error: ProviderError): void;
  }
  const waiting: Waiter[] = [];

  function acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError(signal));
    if (active < options.limits.concurrency && waiting.length === 0) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        abort() {
          const index = waiting.indexOf(waiter);
          if (index !== -1) waiting.splice(index, 1);
          signal.removeEventListener("abort", waiter.abort);
          reject(abortError(signal));
        },
      };
      waiting.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
    });
  }

  function release(): void {
    for (;;) {
      const waiter = waiting.shift();
      if (!waiter) {
        active--;
        return;
      }
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(abortError(waiter.signal));
        continue;
      }
      // Transfer the occupied slot atomically. A new caller cannot steal a queued caller's slot.
      waiter.resolve();
      return;
    }
  }

  function cost(url: URL, body: unknown): number {
    if (url.hostname === "api.firecrawl.dev") {
      if (/^\/v[12]\/search$/.test(url.pathname))
        return 2 * Math.ceil(positiveCount(bodyObject(body).limit, 10) / 10);
      if (/^\/v[12]\/scrape$/.test(url.pathname)) return options.limits.maxDocumentPages;
    }
    if (url.hostname === "api.tavily.com") {
      if (url.pathname === "/search") return 2;
      if (url.pathname === "/extract") {
        const urls = bodyObject(body).urls;
        if (urls !== undefined && !Array.isArray(urls))
          throw new ProviderError(
            "unsupported",
            "Cannot conservatively budget an invalid extraction URL list.",
          );
        return Math.max(2, Math.ceil((Array.isArray(urls) ? urls.length : 1) / 5) * 2);
      }
    }
    return 0;
  }

  function authorizationHash(opts: HttpOptions): string | undefined {
    try {
      const value = new Headers(opts.headers).get("authorization");
      return value ? createHash("sha256").update(value).digest("hex") : undefined;
    } catch {
      throw new ProviderError("invalid_credentials", "Provider authorization headers are invalid.");
    }
  }

  function rememberApifyRun(url: URL, opts: HttpOptions, text: string): void {
    if (url.hostname !== "api.apify.com" || opts.method !== "POST") return;
    const actor = /^\/v2\/actors\/([A-Za-z0-9_-]+~[A-Za-z0-9_-]+)\/runs$/.exec(url.pathname)?.[1];
    if (!actor || !APIFY_ACTORS.some((value) => value.replace("/", "~") === actor)) return;
    const hash = authorizationHash(opts);
    if (!hash) return;
    try {
      const id: unknown = JSON.parse(text)?.data?.id;
      if (typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) && !apifyRuns.has(id))
        apifyRuns.set(id, { authorizationHash: hash, cleanupReserved: false });
    } catch {
      /* A malformed response cannot grant cleanup permissions without a safe run identity. */
    }
  }

  function reserveCleanup(url: URL, opts: HttpOptions): boolean {
    if (
      url.hostname !== "api.apify.com" ||
      opts.method !== "POST" ||
      url.hash ||
      opts.body !== undefined
    )
      return false;
    const id = /^\/v2\/actor-runs\/([A-Za-z0-9_-]{1,128})\/abort$/.exec(url.pathname)?.[1];
    const run = id ? apifyRuns.get(id) : undefined;
    if (!run || run.authorizationHash !== authorizationHash(opts)) return false;
    if (
      [...url.searchParams].some(
        ([key, value]) => key !== "gracefully" || !["false", "true"].includes(value),
      )
    )
      return false;
    if (run.cleanupReserved || cleanupReservations >= APIFY_CLEANUP_REQUEST_LIMIT)
      throw new ProviderError(
        "limit_reached",
        "Reserved actor-cleanup request allowance exhausted.",
      );
    run.cleanupReserved = true;
    cleanupReservations++;
    return true;
  }

  async function readResponse(response: Response, signal: AbortSignal): Promise<string> {
    const oversized = new ProviderError("limit_reached", "Provider response exceeds 16 MiB.");
    if (Number(response.headers.get("content-length")) > RESPONSE_BYTE_LIMIT) {
      cancelBody(response.body);
      throw oversized;
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    try {
      reader = response.body?.getReader();
      if (!reader) return "";
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await withAbort(reader.read(), signal);
        if (done) break;
        size += value.byteLength;
        if (size > RESPONSE_BYTE_LIMIT) throw oversized;
        chunks.push(value);
      }
      complete = true;
      return Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      if (error === oversized) throw oversized;
      throw errorReport(undefined);
    } finally {
      if (reader) {
        if (!complete) cancelBody(reader);
        try {
          reader.releaseLock();
        } catch {
          /* Cleanup must not replace the sanitized failure. */
        }
      }
    }
  }

  async function perform(
    url: URL,
    opts: HttpOptions,
    signal: AbortSignal,
    cleanup: boolean,
  ): Promise<string> {
    const method = opts.method ?? "GET";
    try {
      new Headers(opts.headers);
    } catch {
      throw new ProviderError("invalid_credentials", "Provider request headers are invalid.");
    }
    let body: string | undefined;
    try {
      body =
        opts.body === undefined
          ? undefined
          : typeof opts.body === "string"
            ? opts.body
            : JSON.stringify(opts.body);
    } catch {
      throw errorReport(undefined);
    }
    const units = cleanup ? 0 : cost(url, body);
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw abortError(signal);
      if (!cleanup) {
        if (
          !Number.isSafeInteger(budget.used) ||
          budget.used < 0 ||
          budget.used >= options.limits.maxRequests
        )
          throw new ProviderError("limit_reached", "Shared request budget exhausted.");
        if (
          options.limits.maxProviderCredits !== undefined &&
          credits + units > options.limits.maxProviderCredits
        )
          throw new ProviderError(
            "limit_reached",
            "Conservative provider-credit budget exhausted.",
          );
        // No await between checking and reserving: planners and other HTTP clients share this counter.
        budget.used++;
        credits += units;
      } else cleanupRequests++;
      requests++;
      let response: Response;
      try {
        response = await withAbort(
          (options.fetchImpl ?? fetch)(url.href, {
            method,
            redirect: "error",
            signal,
            headers: {
              ...(typeof opts.body === "string" || opts.body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
              ...opts.headers,
            },
            body,
          }),
          signal,
        );
      } catch {
        if (signal.aborted) throw abortError(signal);
        if (method === "GET" && attempt < options.limits.retries) {
          await delay(250 * 2 ** attempt, signal);
          continue;
        }
        throw errorReport(undefined);
      }
      if (!response.ok) {
        const status = response.status;
        cancelBody(response.body);
        const retryAfter = response.headers.get("retry-after");
        const wait = retryAfter
          ? /^\d+(\.\d+)?$/.test(retryAfter)
            ? Number(retryAfter) * 1000
            : Math.max(0, Date.parse(retryAfter) - Date.now())
          : 250 * 2 ** attempt;
        if (
          method === "GET" &&
          (status === 429 || status >= 500) &&
          attempt < options.limits.retries &&
          Number.isFinite(wait) &&
          wait <= 30000
        ) {
          await delay(wait, signal);
          continue;
        }
        throw new ProviderError(
          status === 401
            ? "invalid_credentials"
            : status === 403
              ? "permission_required"
              : status === 429 || status === 402
                ? "rate_limited"
                : "unreachable",
          `Provider HTTP ${status}.`,
          status,
        );
      }
      const text = await readResponse(response, signal);
      rememberApifyRun(url, opts, text);
      return text;
    }
  }

  function cacheKey(url: URL, opts: HttpOptions): string | undefined {
    if (
      url.hostname !== "api.firecrawl.dev" ||
      !/^\/v[12]\/scrape$/.test(url.pathname) ||
      opts.method !== "POST"
    )
      return;
    // The map contains only SHA-256 keys, not URLs, bodies, or plaintext credentials.
    try {
      return createHash("sha256")
        .update(
          JSON.stringify([
            url.href,
            opts.method,
            opts.body,
            [...new Headers(opts.headers)].sort(([a], [b]) => a.localeCompare(b)),
          ]),
        )
        .digest("hex");
    } catch {
      throw errorReport(undefined);
    }
  }

  async function request(value: string, opts: HttpOptions = {}): Promise<string> {
    const url = endpoint(value);
    const cleanup = reserveCleanup(url, opts);
    const deadline = cleanup ? new AbortController() : undefined;
    const timer = deadline
      ? setTimeout(
          () => deadline.abort(new DOMException("Actor cleanup deadline reached.", "TimeoutError")),
          APIFY_CLEANUP_TIMEOUT_MS,
        )
      : undefined;
    const parentSignal = deadline?.signal ?? options.signal;
    const signal = opts.signal ? AbortSignal.any([parentSignal, opts.signal]) : parentSignal;
    const key = cacheKey(url, opts);
    try {
      if (key && cache.has(key)) return await withAbort(cache.get(key)!, signal);
      const work = (async () => {
        await acquire(signal);
        try {
          return await perform(url, opts, signal, cleanup);
        } finally {
          release();
        }
      })();
      if (key) {
        cache.set(key, work);
        void work.catch(() => {
          if (cache.get(key) === work) cache.delete(key);
        });
      }
      return await work;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    get requests() {
      return requests;
    },
    get cleanupRequests() {
      return cleanupRequests;
    },
    text: request,
    async json<T>(value: string, opts?: HttpOptions): Promise<T> {
      const text = await request(value, opts);
      try {
        return JSON.parse(text) as T;
      } catch {
        const key = cacheKey(endpoint(value), opts ?? {});
        if (key) cache.delete(key);
        throw new ProviderError("unreachable", "Provider returned malformed JSON.");
      }
    },
  };
}
