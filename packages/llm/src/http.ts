export class LlmHttpError extends Error {
  constructor(
    public status: number,
    public errorType: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "LlmHttpError";
  }
}

export class Limiter {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private maxParallel: number) {}

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw signal.reason;

    if (this.active >= this.maxParallel) {
      await new Promise<void>((resolve, reject) => {
        let listener: () => void;
        const fnWait = () => {
          signal?.removeEventListener("abort", listener);
          resolve();
        };
        listener = () => {
          const idx = this.queue.indexOf(fnWait);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
          }
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", listener, { once: true });
        this.queue.push(fnWait);
      });
    }

    if (signal?.aborted) throw signal.reason;

    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export async function postJson(
  url: string,
  init: {
    headers: Record<string, string>;
    body: unknown;
    signal?: AbortSignal;
    fetch: typeof fetch;
    timeoutMs: number;
    retries?: number;
    provider: string;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    random?: () => number;
  },
): Promise<{ status: number; json: unknown; headers: Headers }> {
  const retries = init.retries ?? 3;
  const sleepFn =
    init.sleep ??
    (async (ms: number, sig?: AbortSignal) => {
      return new Promise<void>((resolve, reject) => {
        if (sig?.aborted) return reject(sig.reason);
        const timer = setTimeout(() => {
          sig?.removeEventListener("abort", listener);
          resolve();
        }, ms);
        const listener = () => {
          clearTimeout(timer);
          reject(sig?.reason);
        };
        sig?.addEventListener("abort", listener, { once: true });
      });
    });
  const randomFn = init.random ?? Math.random;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (init.signal?.aborted) throw init.signal.reason;

    let res: Response;
    const timeoutSignal = AbortSignal.timeout(init.timeoutMs);
    const combinedSignal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;

    try {
      res = await Promise.race([
        init.fetch(url, {
          method: "POST",
          headers: init.headers,
          body: JSON.stringify(init.body),
          signal: combinedSignal,
        }),
        new Promise<Response>((_, reject) => {
          if (combinedSignal.aborted) {
            reject(combinedSignal.reason);
          } else {
            combinedSignal.addEventListener("abort", () => reject(combinedSignal.reason), {
              once: true,
            });
          }
        }),
      ]);
    } catch (err: any) {
      if (init.signal?.aborted && err.name === "AbortError") {
        throw init.signal.reason;
      }
      if (timeoutSignal.aborted && err.name === "TimeoutError" && !init.signal?.aborted) {
        if (attempt === retries) {
          throw new LlmHttpError(
            0,
            undefined,
            `${init.provider} did not answer within ${init.timeoutMs / 1000} s`,
          );
        }
        await sleepFn(getBackoff(attempt, randomFn, null), init.signal);
        continue;
      }
      if (init.signal?.aborted) {
        throw init.signal.reason;
      }
      // Network error. The original error is not passed on: it can name hosts or headers.
      if (attempt === retries) {
        throw new LlmHttpError(
          0,
          "network_error",
          `${init.provider} could not be reached (network error)`,
        );
      }
      await sleepFn(getBackoff(attempt, randomFn, null), init.signal);
      continue;
    }

    if (res.ok) {
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new LlmHttpError(
          res.status,
          "invalid_json",
          `${init.provider} sent an answer that isn't JSON`,
        );
      }
      return { status: res.status, json, headers: res.headers };
    }

    let errorType: string | undefined;
    let jsonBody: any;
    try {
      jsonBody = await res.json();
    } catch {
      // ignore
    }

    if (jsonBody?.error) {
      if (typeof jsonBody.error.type === "string") {
        errorType = jsonBody.error.type;
      } else if (typeof jsonBody.error.code === "string") {
        errorType = String(jsonBody.error.code);
      } else if (
        typeof jsonBody.error.status === "string" ||
        typeof jsonBody.error.status === "number"
      ) {
        errorType = String(jsonBody.error.status);
      }
    }

    const status = res.status;
    const isRetryable = [408, 409, 429, 500, 502, 503, 504, 529].includes(status);

    if (!isRetryable || attempt === retries) {
      let message = `${init.provider} request failed (HTTP ${status}`;
      if (errorType) {
        message += `, ${errorType}`;
      }
      message += `)`;
      throw new LlmHttpError(status, errorType, message);
    }

    const retryAfter = res.headers.get("retry-after");
    await sleepFn(getBackoff(attempt, randomFn, retryAfter), init.signal);
  }

  throw new Error("Unreachable");
}

function getBackoff(attempt: number, randomFn: () => number, retryAfter: string | null): number {
  if (retryAfter) {
    const asSec = parseInt(retryAfter, 10);
    if (!isNaN(asSec)) {
      return Math.min(asSec * 1000, 60000);
    }
    const asDate = Date.parse(retryAfter);
    if (!isNaN(asDate)) {
      const delay = asDate - Date.now();
      return Math.min(Math.max(0, delay), 60000);
    }
  }
  const base = 1000 * Math.pow(2, attempt);
  const jitter = base * 0.25 * (randomFn() * 2 - 1);
  return base + jitter;
}
