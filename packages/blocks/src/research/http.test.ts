import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchLimits, ResearchProviderConfig, ResearchScope } from "@reqflow/core";
import {
  createProviderHttp,
  errorReport,
  redactSecrets,
  withAbort,
  type RequestBudget,
} from "./http";
import { ProviderError } from "./provider";
import { createApifyAdapter } from "./providers/apify";

const endpoint = "https://api.openalex.org/works";
const scrapeEndpoint = "https://api.firecrawl.dev/v2/scrape";
const responseByteLimit = 16 * 1024 * 1024;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function client(
  fetchImpl = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response('{"synthetic":true}')),
  limits: Partial<ResearchLimits> = {},
  signal = new AbortController().signal,
) {
  return {
    fetchImpl,
    http: createProviderHttp({
      fetchImpl,
      limits: ResearchLimits.parse({ retries: 0, ...limits }),
      signal,
    }),
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Live network is forbidden in research HTTP tests.");
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fixed provider endpoint policy", () => {
  it.each([
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
  ])("accepts only the explicit HTTPS host %s", async (host) => {
    const { http, fetchImpl } = client();

    expect(await http.json(`https://${host}/synthetic`)).toEqual({ synthetic: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    "http://api.openalex.org/works",
    "file:///synthetic.json",
    "https://127.0.0.1/works",
    "https://[::1]/works",
    "https://localhost/works",
    "https://api.openalex.org.evil.example/works",
    "https://sub.api.openalex.org/works",
    "https://evil.example/?next=https://api.openalex.org",
    "https://api.openalex.org:8443/works",
    "https://api.openalex.org:443/works",
    "https://api.openalex.org:/works",
    "https://synthetic-user:synthetic-password@api.openalex.org/works",
    "https://api.openaIex.org/works",
    "https://api.openalex.org./works",
  ])("rejects an endpoint outside the strict allowlist before any request: %s", async (url) => {
    const { http, fetchImpl } = client();

    await expect(http.text(url)).rejects.toMatchObject({ code: "permission_required" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(http.requests).toBe(0);
  });

  it("does not follow HTTP redirects into unapproved hosts", async () => {
    const { http, fetchImpl } = client(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("", { status: 302, headers: { Location: "https://evil.example/private" } }),
        ),
    );

    await expect(http.text(endpoint)).rejects.toMatchObject({ code: "unreachable", status: 302 });
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed URLs without retaining their credential-like content", async () => {
    const { http, fetchImpl } = client();

    const error = await http
      .text("synthetic-invalid-url?key=synthetic-private")
      .catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "permission_required" });
    expect(String(error)).not.toContain("synthetic-private");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes synthetic authentication and JSON only to the approved injected transport", async () => {
    const { http, fetchImpl } = client();
    const signal = new AbortController().signal;

    await http.json(endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-only" },
      body: { query: "synthetic" },
      signal,
    });

    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect(options).toMatchObject({
      method: "POST",
      body: '{"query":"synthetic"}',
      headers: { Authorization: "Bearer synthetic-only", "Content-Type": "application/json" },
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("credential-safe failures", () => {
  it("removes raw and URL-encoded secrets while preserving nonsensitive text", () => {
    const secret = "synthetic/private+key";

    const output = redactSecrets(
      `Original context: ${secret}, ${encodeURIComponent(secret)}; safe tail.`,
      [secret, "", "synthetic"],
    );

    expect(output).toBe("Original context: [REDACTED], [REDACTED]; safe tail.");
  });

  it.each([
    "Authorization: Bearer synthetic-key",
    '"Authorization": "Bearer synthetic-key"',
    "authorization=Basic c3ludGhldGljOnRlc3Q=",
    "https://api.example.org/?api_key=synthetic-value&next=safe",
    "access-token: synthetic-value",
    '"client_secret": "synthetic-value"',
    "refresh_token=synthetic-value",
    "key=synthetic-value",
  ])("redacts recognized auth/query fields without an explicit secret list: %s", (input) => {
    expect(redactSecrets(input)).not.toMatch(/synthetic-key|synthetic-value|c3ludGhldGljOnRlc3Q=/);
  });

  it("does not expose a URL, header, or raw network exception containing credentials", async () => {
    const syntheticSecret = "synthetic-private-only";
    const url = `https://www.googleapis.com/youtube/v3/search?key=${syntheticSecret}`;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError(`Failed ${url}; Authorization: Bearer ${syntheticSecret}`));
    const { http } = client(fetchImpl);

    const error = await http
      .json(url, { headers: { Authorization: `Bearer ${syntheticSecret}` } })
      .catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "unreachable" });
    expect(String(error)).not.toContain(syntheticSecret);
    expect(String(error)).not.toContain(url);
  });

  it("rejects invalid authentication headers without exposing their values or dispatching", async () => {
    const { http, fetchImpl } = client();

    const error = await http
      .text(endpoint, {
        headers: { Authorization: "Bearer synthetic-private\nInjected: synthetic-private" },
      })
      .catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "invalid_credentials" });
    expect(String(error)).not.toContain("synthetic-private");
    expect(http.requests).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports unknown failures safely without treating them as successful data", () => {
    const error = errorReport(new Error("Synthetic private URL/token and original response"));

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe("unreachable");
    expect(error.message).not.toContain("Synthetic private");
  });

  it("redacts authorization before key/value fields without consuming only the scheme", () => {
    expect(
      redactSecrets("Authorization: Bearer synthetic-key; key=synthetic-value; safe tail."),
    ).toBe("Authorization: [REDACTED]; key=[REDACTED]; safe tail.");
  });

  it("redacts known secrets in lowercase percent-encoding and form encoding", () => {
    const secret = "synthetic private+key/";
    const encoded = encodeURIComponent(secret);

    const output = redactSecrets(`${encoded.toLowerCase()} ${encoded.replace(/%20/g, "+")}`, [
      secret,
    ]);

    expect(output).toBe("[REDACTED] [REDACTED]");
  });

  it.each([
    [401, "invalid_credentials"],
    [403, "permission_required"],
    [402, "rate_limited"],
    [429, "rate_limited"],
  ] as const)(
    "reports HTTP %s as %s without retaining provider response text",
    async (status, code) => {
      const { http, fetchImpl } = client(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response("Synthetic private server body: api_key=synthetic-only", { status }),
          ),
      );

      const error = await http.text(endpoint).catch((error: unknown) => error);

      expect(error).toMatchObject({ code, status });
      expect(String(error)).not.toMatch(/synthetic-only|private server body/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 403])("never retries HTTP %s even when GET retries are enabled", async (status) => {
    const { http, fetchImpl } = client(
      vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status })),
      { retries: 3 },
    );

    await expect(http.text(endpoint)).rejects.toMatchObject({ status });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("bounded GET-only retries", () => {
  it.each(["seconds", "http-date"] as const)(
    "honors a bounded 429 Retry-After expressed as %s",
    async (format) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
      const retryAfter = format === "seconds" ? "1" : new Date(Date.now() + 1000).toUTCString();
      const { http, fetchImpl } = client(
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            new Response("", { status: 429, headers: { "Retry-After": retryAfter } }),
          )
          .mockResolvedValueOnce(new Response("Synthetic recovered original")),
        { retries: 1 },
      );
      const pending = http.text(endpoint);

      await vi.advanceTimersByTimeAsync(999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toBe("Synthetic recovered original");
      expect(http.requests).toBe(2);
    },
  );

  it.each(["31", "999999", "not-a-date", "Infinity"])(
    "does not wait/retry an unbounded or malformed Retry-After %s",
    async (retryAfter) => {
      const { http, fetchImpl } = client(
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response("", {
            status: 429,
            headers: { "Retry-After": retryAfter },
          }),
        ),
        { retries: 3 },
      );

      await expect(http.text(endpoint)).rejects.toMatchObject({
        code: "rate_limited",
        status: 429,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts the 30-second retry boundary without sending an early request", async () => {
    vi.useFakeTimers();
    const { http, fetchImpl } = client(
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "30" } }))
        .mockResolvedValueOnce(new Response("Synthetic recovered")),
      { retries: 1 },
    );
    const pending = http.text(endpoint);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe("Synthetic recovered");
  });

  it("bounds retryable GET failures and counts every attempt against the request budget", async () => {
    vi.useFakeTimers();
    const { http, fetchImpl } = client(
      vi.fn<typeof fetch>().mockImplementation(async () => new Response("", { status: 503 })),
      { retries: 2 },
    );
    const assertion = expect(http.text(endpoint)).rejects.toMatchObject({
      code: "unreachable",
      status: 503,
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);

    await assertion;
    expect(http.requests).toBe(3);
  });

  it("removes abort listeners when retry backoff completes normally", async () => {
    vi.useFakeTimers();
    const run = new AbortController();
    const add = vi.spyOn(run.signal, "addEventListener");
    const remove = vi.spyOn(run.signal, "removeEventListener");
    const { http } = client(
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(new Response("Synthetic recovered")),
      { retries: 1 },
      run.signal,
    );
    const pending = http.text(endpoint);

    await vi.advanceTimersByTimeAsync(250);

    expect(await pending).toBe("Synthetic recovered");
    expect(remove.mock.calls.filter(([event]) => event === "abort")).toHaveLength(
      add.mock.calls.filter(([event]) => event === "abort").length,
    );
  });

  it("recovers from a transient GET transport failure with bounded backoff", async () => {
    vi.useFakeTimers();
    const { http, fetchImpl } = client(
      vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError("Synthetic connection failure"))
        .mockResolvedValueOnce(new Response("Synthetic original")),
      { retries: 1 },
    );
    const pending = http.text(endpoint);

    await vi.advanceTimersByTimeAsync(250);

    expect(await pending).toBe("Synthetic original");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([429, 503, "network"] as const)(
    "never retries a possibly paid POST after %s",
    async (failure) => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (failure === "network") throw new TypeError("Synthetic connection failure");
        return new Response("", { status: failure, headers: { "Retry-After": "0" } });
      });
      const { http } = client(fetchImpl, { retries: 3 });

      await expect(
        http.text("https://api.firecrawl.dev/v2/search", {
          method: "POST",
          body: { query: "synthetic", limit: 1 },
        }),
      ).rejects.toBeInstanceOf(ProviderError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(http.requests).toBe(1);
    },
  );

  it("stops retries when the shared request budget is exhausted", async () => {
    vi.useFakeTimers();
    const { http, fetchImpl } = client(
      vi.fn<typeof fetch>().mockImplementation(async () => new Response("", { status: 503 })),
      { retries: 3, maxRequests: 1 },
    );
    const assertion = expect(http.text(endpoint)).rejects.toMatchObject({ code: "limit_reached" });

    await vi.advanceTimersByTimeAsync(250);

    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("response validation and byte bounds", () => {
  it("rejects malformed JSON without echoing raw response content", async () => {
    const { http } = client(
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{"synthetic-private":invalid')),
    );

    const error = await http.json(endpoint).catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "unreachable" });
    expect(String(error)).toMatch(/malformed JSON/i);
    expect(String(error)).not.toContain("synthetic-private");
  });

  it.each(["", "{", "<html>Synthetic access page</html>"])(
    "does not report non-JSON response %j as valid data",
    async (text) => {
      const { http } = client(vi.fn<typeof fetch>().mockResolvedValue(new Response(text)));

      await expect(http.json(endpoint)).rejects.toMatchObject({ code: "unreachable" });
    },
  );

  it("preserves valid JSON scalars and null rather than applying an invented object schema", async () => {
    const { http } = client(vi.fn<typeof fetch>().mockResolvedValue(new Response("null")));

    expect(await http.json(endpoint)).toBeNull();
  });

  it("rejects a declared oversized response before consuming its body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const { http } = client(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          headers: { "Content-Length": String(responseByteLimit + 1) },
        }),
      ),
    );

    await expect(http.text(endpoint)).rejects.toMatchObject({ code: "limit_reached" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("accepts exactly 16 MiB of response bytes", async () => {
    const bytes = new Uint8Array(responseByteLimit).fill(65);
    const { http } = client(vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes)));

    expect((await http.text(endpoint)).length).toBe(responseByteLimit);
  });

  it("enforces actual streamed bytes even with a missing or dishonest Content-Length", async () => {
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode("舒".repeat(Math.floor(responseByteLimit / 3) + 1));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel,
    });
    const { http } = client(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { headers: { "Content-Length": "1" } })),
    );

    await expect(http.text(endpoint)).rejects.toMatchObject({ code: "limit_reached" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("decodes multibyte Unicode split across streamed chunks without replacement", async () => {
    const original = "Synthetic: 舒适 — café 😀\noriginal line.";
    const bytes = new TextEncoder().encode(original);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const { http } = client(vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));

    expect(await http.text(endpoint)).toBe(original);
  });

  it("does not leak a private response-stream failure after successful HTTP headers", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError("Synthetic stream URL: key=synthetic-private-stream"));
      },
    });
    const { http } = client(vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));

    const error = await http.text(endpoint).catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "unreachable" });
    expect(String(error)).not.toContain("synthetic-private-stream");
  });

  it("does not let a failed error-body cancellation hide the sanitized HTTP failure", async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel: () => Promise.reject(new Error("Synthetic private cancellation failure")),
    });
    const { http } = client(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 403 })),
    );

    const error = await http.text(endpoint).catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "permission_required", status: 403 });
    expect(String(error)).not.toContain("private cancellation");
  });
});

describe("shared request and conservative provider-credit budgets", () => {
  it("uses the exact shared planner/transport budget object while requests counts only HTTP attempts", async () => {
    const budget: RequestBudget = { used: 1 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("Synthetic original"));
    const http = createProviderHttp({
      limits: ResearchLimits.parse({ maxRequests: 3, retries: 0 }),
      signal: new AbortController().signal,
      fetchImpl,
      budget,
    });

    await http.text(endpoint);
    budget.used++; // A planner call reserves the same counter before its external attempt.

    await expect(http.text(endpoint)).rejects.toMatchObject({ code: "limit_reached" });
    expect(budget.used).toBe(3);
    expect(http.requests).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("atomically shares one budget across independent HTTP clients", async () => {
    const budget: RequestBudget = { used: 1 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("Synthetic original"));
    const clients = Array.from({ length: 6 }, () =>
      createProviderHttp({
        limits: ResearchLimits.parse({ maxRequests: 3, retries: 0 }),
        signal: new AbortController().signal,
        fetchImpl,
        budget,
      }),
    );

    const outcomes = await Promise.allSettled(clients.map((http) => http.text(endpoint)));

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
    expect(budget.used).toBe(3);
    expect(clients.reduce((sum, http) => sum + http.requests, 0)).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("atomically enforces maxRequests across concurrent agent calls", async () => {
    const { http, fetchImpl } = client(
      vi.fn<typeof fetch>().mockImplementation(async () => new Response("synthetic")),
      { maxRequests: 2, concurrency: 8 },
    );

    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) => http.text(`${endpoint}?synthetic=${index}`)),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
    for (const outcome of outcomes.filter((outcome) => outcome.status === "rejected"))
      expect(outcome.reason).toMatchObject({ code: "limit_reached" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(http.requests).toBe(2);
  });

  it("shares the credit budget across concurrent Firecrawl calls", async () => {
    const { http, fetchImpl } = client(
      vi.fn<typeof fetch>().mockImplementation(async () => new Response("synthetic")),
      { maxProviderCredits: 2, concurrency: 8 },
    );

    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        http.text("https://api.firecrawl.dev/v2/search", {
          method: "POST",
          body: { query: `synthetic ${index}`, limit: 1 },
        }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(http.requests).toBe(1);
  });

  it.each([
    [11, 3],
    [50, 9],
    [100, 19],
  ])(
    "reserves all Firecrawl search credits for %s results before a %s-credit budget is exceeded",
    async (limit, maxProviderCredits) => {
      const { http, fetchImpl } = client(undefined, { maxProviderCredits });

      // Firecrawl documents two credits per started batch of ten requested results.
      await expect(
        http.text("https://api.firecrawl.dev/v2/search", {
          method: "POST",
          body: { query: "synthetic", limit },
        }),
      ).rejects.toMatchObject({ code: "limit_reached" });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(http.requests).toBe(0);
    },
  );

  it("reserves the configured maximum PDF pages before a Firecrawl scrape", async () => {
    const { http, fetchImpl } = client(undefined, { maxDocumentPages: 5, maxProviderCredits: 4 });

    await expect(
      http.text(scrapeEndpoint, {
        method: "POST",
        body: { url: "https://sources.example.org/synthetic.pdf" },
      }),
    ).rejects.toMatchObject({ code: "limit_reached" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [11, 4],
    [50, 10],
    [100, 20],
  ])(
    "allows %s Firecrawl results at exactly %s reserved credits",
    async (limit, maxProviderCredits) => {
      const { http, fetchImpl } = client(undefined, { maxProviderCredits });

      await http.text("https://api.firecrawl.dev/v2/search", {
        method: "POST",
        body: { query: "synthetic", limit },
      });
      await expect(
        http.text("https://api.firecrawl.dev/v2/search", {
          method: "POST",
          body: { query: "another synthetic", limit: 1 },
        }),
      ).rejects.toMatchObject({ code: "limit_reached" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("reserves Firecrawl search credits from a serialized JSON body too", async () => {
    const { http, fetchImpl } = client(undefined, { maxProviderCredits: 3 });

    await expect(
      http.text("https://api.firecrawl.dev/v2/search", {
        method: "POST",
        body: JSON.stringify({ query: "synthetic", limit: 11 }),
      }),
    ).rejects.toMatchObject({ code: "limit_reached" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("budgets the serialized purchase rather than a differing toJSON input", async () => {
    const { http, fetchImpl } = client(undefined, { maxProviderCredits: 3 });

    await expect(
      http.text("https://api.firecrawl.dev/v2/search", {
        method: "POST",
        body: { limit: 1, toJSON: () => ({ query: "synthetic", limit: 11 }) },
      }),
    ).rejects.toMatchObject({ code: "limit_reached" });
    expect(http.requests).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("charges failed purchases conservatively rather than returning credits for retrying", async () => {
    const { http, fetchImpl } = client(
      vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 })),
      { maxProviderCredits: 2 },
    );

    await expect(
      http.text("https://api.firecrawl.dev/v2/search", {
        method: "POST",
        body: { query: "synthetic", limit: 1 },
      }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      http.text("https://api.firecrawl.dev/v2/search", {
        method: "POST",
        body: { query: "another synthetic", limit: 1 },
      }),
    ).rejects.toMatchObject({ code: "limit_reached" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds Tavily extraction credits conservatively for multiple URL batches", async () => {
    const { http, fetchImpl } = client(undefined, { maxProviderCredits: 3 });

    await expect(
      http.text("https://api.tavily.com/extract", {
        method: "POST",
        body: {
          urls: Array.from({ length: 6 }, (_, index) => `https://sources.example.org/${index}`),
        },
      }),
    ).rejects.toMatchObject({ code: "limit_reached" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [1, 2],
    [5, 2],
    [6, 4],
    [10, 4],
    [11, 6],
  ])("reserves %s Tavily extraction URLs as %s conservative credits", async (count, credits) => {
    const { http, fetchImpl } = client(undefined, { maxProviderCredits: credits - 1 });

    await expect(
      http.text("https://api.tavily.com/extract", {
        method: "POST",
        body: {
          urls: Array.from({ length: count }, (_, index) => `https://sources.example.org/${index}`),
        },
      }),
    ).rejects.toMatchObject({ code: "limit_reached" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reserves two conservative credits even for basic Tavily search", async () => {
    const { http, fetchImpl } = client(undefined, { maxProviderCredits: 1 });

    await expect(
      http.text("https://api.tavily.com/search", {
        method: "POST",
        body: { query: "synthetic", search_depth: "basic", max_results: 1 },
      }),
    ).rejects.toMatchObject({ code: "limit_reached" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not charge provider credits for unmetered OpenAlex/Eurostat transport calls", async () => {
    const { http, fetchImpl } = client(
      vi.fn<typeof fetch>().mockImplementation(async () => new Response("synthetic")),
      { maxProviderCredits: 1 },
    );

    await http.text(endpoint);
    await http.text(
      "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/synthetic",
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("caller-supplied cancellation and deadlines", () => {
  it("does not start a request when the run is already cancelled", async () => {
    const { http, fetchImpl } = client(undefined, {}, AbortSignal.abort());

    await expect(http.text(endpoint)).rejects.toThrow(/abort|cancel/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(http.requests).toBe(0);
  });

  it("settles run cancellation even when fetch ignores the AbortSignal", async () => {
    const pendingFetch = deferred<Response>();
    const controller = new AbortController();
    const { http, fetchImpl } = client(
      vi.fn<typeof fetch>().mockReturnValue(pendingFetch.promise),
      {},
      controller.signal,
    );
    const assertion = expect(http.text(endpoint)).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    controller.abort();

    await assertion;
    pendingFetch.resolve(new Response("Late synthetic original must not become successful data."));
    expect(http.requests).toBe(1);
  });

  it("honors a timeout AbortSignal supplied by the parent even when fetch never settles", async () => {
    const pendingFetch = deferred<Response>();
    const { http } = client(
      vi.fn<typeof fetch>().mockReturnValue(pendingFetch.promise),
      {},
      AbortSignal.timeout(25),
    );

    await expect(http.text(endpoint)).rejects.toMatchObject({
      code: "cancelled",
      message: expect.stringMatching(/time limit/i),
    });
    pendingFetch.resolve(new Response("Late synthetic response"));
  });

  it("honors a request-local abort without cancelling unrelated requests", async () => {
    const pendingFetch = deferred<Response>();
    const controller = new AbortController();
    const { http, fetchImpl } = client(
      vi
        .fn<typeof fetch>()
        .mockReturnValueOnce(pendingFetch.promise)
        .mockResolvedValueOnce(new Response("Unrelated synthetic original")),
      { concurrency: 2 },
    );
    const assertion = expect(
      http.text(`${endpoint}?one=1`, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    controller.abort();

    await assertion;
    expect(await http.text(`${endpoint}?two=2`)).toBe("Unrelated synthetic original");
    pendingFetch.resolve(new Response("Late synthetic original"));
  });

  it("settles a cancelled queued request without waiting for another agent's response", async () => {
    const pendingFetch = deferred<Response>();
    const run = new AbortController();
    const request = new AbortController();
    const { http, fetchImpl } = client(
      vi.fn<typeof fetch>().mockReturnValue(pendingFetch.promise),
      { concurrency: 1 },
      run.signal,
    );
    const first = http.text(`${endpoint}?first=1`).catch((error: unknown) => error);
    let queuedError: unknown;
    const queued = http
      .text(`${endpoint}?queued=1`, { signal: request.signal })
      .catch((error: unknown) => {
        queuedError = error;
      });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    request.abort();

    try {
      await vi.waitFor(() => expect(queuedError).toMatchObject({ code: "cancelled" }), {
        timeout: 250,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      run.abort();
      pendingFetch.resolve(new Response("Synthetic cleanup"));
      await Promise.allSettled([first, queued]);
    }
  });

  it("cancels an unresponsive response body instead of waiting indefinitely", async () => {
    const run = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const { http, fetchImpl } = client(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
      {},
      run.signal,
    );
    const assertion = expect(http.text(endpoint)).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    run.abort();

    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("settles body cancellation even when the stream's cancel implementation never settles", async () => {
    const run = new AbortController();
    const cancellation = deferred<void>();
    const cancel = vi.fn(() => cancellation.promise);
    const { http, fetchImpl } = client(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }))),
      {},
      run.signal,
    );
    const assertion = expect(http.text(endpoint)).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    run.abort();

    try {
      await assertion;
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      cancellation.resolve();
    }
  });

  it("cancels during retry backoff without making another request", async () => {
    vi.useFakeTimers();
    const run = new AbortController();
    const { http, fetchImpl } = client(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("", { status: 429, headers: { "Retry-After": "30" } })),
      { retries: 3 },
      run.signal,
    );
    const assertion = expect(http.text(endpoint)).rejects.toMatchObject({ code: "cancelled" });
    await vi.advanceTimersByTimeAsync(0);

    run.abort();
    await vi.advanceTimersByTimeAsync(30_000);

    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("races arbitrary noncooperative work against caller cancellation", async () => {
    const run = new AbortController();
    const work = deferred<string>();
    const assertion = expect(withAbort(work.promise, run.signal)).rejects.toMatchObject({
      code: "cancelled",
    });

    run.abort();

    await assertion;
    work.resolve("Late original");
  });
});

describe("global transport concurrency", () => {
  it("keeps FIFO order and removes cancelled waiters without leaking their reserved slot", async () => {
    const firstFetch = deferred<Response>();
    const cancelled = new AbortController();
    const { http, fetchImpl } = client(
      vi
        .fn<typeof fetch>()
        .mockReturnValueOnce(firstFetch.promise)
        .mockImplementation(async () => new Response("Synthetic original")),
      { concurrency: 1 },
    );
    const first = http.text(`${endpoint}?order=first`);
    const skipped = http.text(`${endpoint}?order=cancelled`, { signal: cancelled.signal });
    const assertion = expect(skipped).rejects.toMatchObject({ code: "cancelled" });
    const second = http.text(`${endpoint}?order=second`);
    const third = http.text(`${endpoint}?order=third`);

    cancelled.abort();
    await assertion;
    firstFetch.resolve(new Response("Synthetic first"));
    await Promise.all([first, second, third]);
    await http.text(`${endpoint}?order=fourth`);

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(
      ["first", "second", "third", "fourth"].map((order) => `${endpoint}?order=${order}`),
    );
    expect(http.requests).toBe(4);
  });

  it("holds the shared slot through response-body consumption, not only fetch resolution", async () => {
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => controller.close();
      },
    });
    const { http, fetchImpl } = client(
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(body))
        .mockResolvedValueOnce(new Response("Second synthetic")),
      { concurrency: 1 },
    );
    const first = http.text(`${endpoint}?first=1`);
    const second = http.text(`${endpoint}?second=1`);
    const outcomes = Promise.all([first, second]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    finish();

    expect(await outcomes).toEqual(["", "Second synthetic"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never exceeds the global upper bound when new callers arrive while queued calls drain", async () => {
    const gates: ReturnType<typeof deferred<Response>>[] = [];
    let active = 0,
      highWater = 0;
    const run = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
      active++;
      highWater = Math.max(highWater, active);
      const gate = deferred<Response>();
      gates.push(gate);
      return gate.promise.finally(() => {
        active--;
      });
    });
    const { http } = client(fetchImpl, { concurrency: 2 }, run.signal);
    const pending = Array.from({ length: 6 }, (_, index) =>
      http
        .text(`${endpoint}?initial=${index}`)
        .then(() => http.text(`${endpoint}?followup=${index}`)),
    );
    const outcomes = Promise.allSettled(pending);

    try {
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      for (let index = 0; index < 12; index++) {
        await vi.waitFor(() => expect(gates.length).toBeGreaterThan(index));
        gates[index]!.resolve(new Response(null));
      }
      expect((await outcomes).every((outcome) => outcome.status === "fulfilled")).toBe(true);
      expect(highWater).toBeLessThanOrEqual(2);
    } finally {
      run.abort();
      gates.forEach((gate) => gate.resolve(new Response(null)));
      await outcomes;
    }
  });
});

describe("in-run document reuse without stale cross-run caching", () => {
  const options = {
    method: "POST" as const,
    body: { url: "https://sources.example.org/original", maxAge: 0 },
  };

  it("shares an in-flight original document across two collecting agents", async () => {
    const pendingFetch = deferred<Response>();
    const { http, fetchImpl } = client(vi.fn<typeof fetch>().mockReturnValue(pendingFetch.promise));
    const first = http.json(scrapeEndpoint, options);
    const second = http.json(scrapeEndpoint, options);
    const outcomes = Promise.all([first, second]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    pendingFetch.resolve(new Response('{"original":"Synthetic exact document."}'));

    expect(await outcomes).toEqual([
      { original: "Synthetic exact document." },
      { original: "Synthetic exact document." },
    ]);
    expect(await http.json(scrapeEndpoint, options)).toEqual({
      original: "Synthetic exact document.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(http.requests).toBe(1);
  });

  it("starts a fresh client/run with a fresh cache and can observe a changed document", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Synthetic first revision"))
      .mockResolvedValueOnce(new Response("Synthetic changed revision"));
    const first = client(fetchImpl).http;
    const second = client(fetchImpl).http;

    expect(await first.text(scrapeEndpoint, options)).toBe("Synthetic first revision");
    expect(await second.text(scrapeEndpoint, options)).toBe("Synthetic changed revision");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a document collected with different page/body parameters", async () => {
    const { http, fetchImpl } = client(
      vi.fn<typeof fetch>().mockImplementation(async () => new Response("Synthetic original")),
    );

    await http.text(scrapeEndpoint, { ...options, body: { ...options.body, maxPages: 1 } });
    await http.text(scrapeEndpoint, { ...options, body: { ...options.body, maxPages: 2 } });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not share scrape originals across different authentication headers", async () => {
    const { http, fetchImpl } = client(
      vi.fn<typeof fetch>().mockImplementation(async () => new Response("Synthetic original")),
    );

    await http.text(scrapeEndpoint, {
      ...options,
      headers: { Authorization: "Bearer synthetic-one" },
    });
    await http.text(scrapeEndpoint, {
      ...options,
      headers: { Authorization: "Bearer synthetic-two" },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("evicts malformed JSON from the scrape cache when the JSON boundary rejects it", async () => {
    const { http, fetchImpl } = client(
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("Synthetic malformed JSON"))
        .mockResolvedValueOnce(new Response('{"synthetic":"recovered"}')),
    );

    await expect(http.json(scrapeEndpoint, options)).rejects.toMatchObject({ code: "unreachable" });
    expect(await http.json(scrapeEndpoint, options)).toEqual({ synthetic: "recovered" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("evicts failed scrape promises so a later explicit request can collect the original", async () => {
    const { http, fetchImpl } = client(
      vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError("Synthetic failure"))
        .mockResolvedValueOnce(new Response("Synthetic recovered original")),
    );

    await expect(http.text(scrapeEndpoint, options)).rejects.toMatchObject({ code: "unreachable" });

    expect(await http.text(scrapeEndpoint, options)).toBe("Synthetic recovered original");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not deduplicate independent paid search POSTs as though they were document reads", async () => {
    const { http, fetchImpl } = client(
      vi.fn<typeof fetch>().mockImplementation(async () => new Response("Synthetic result")),
    );

    await http.text("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      body: { query: "synthetic", limit: 1 },
    });
    await http.text("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      body: { query: "synthetic", limit: 1 },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(http.requests).toBe(2);
  });
});

describe("independent, reserved Apify actor cleanup", () => {
  const startUrl = "https://api.apify.com/v2/actors/apify~instagram-scraper/runs";
  const auth = { Authorization: "Bearer synthetic-apify-only" };
  const started = (id: string, status = "RUNNING") => ({
    data: { id, status, defaultDatasetId: "synthetic_dataset" },
  });
  const abortUrl = (id: string) =>
    `https://api.apify.com/v2/actor-runs/${id}/abort?gracefully=false`;

  it("real adapter aborts its known run after cancellation interrupts a poll through the HTTP wrapper", async () => {
    const run = new AbortController();
    const poll = deferred<Response>();
    const budget: RequestBudget = { used: 0 };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (value, options) => {
      const url = new URL(String(value));
      if (url.pathname.endsWith("/abort")) {
        expect(options?.signal?.aborted).toBe(false);
        return Response.json(started("synthetic_run", "ABORTED"));
      }
      if (url.pathname.includes("/actors/")) return Response.json(started("synthetic_run"));
      return poll.promise;
    });
    const limits = ResearchLimits.parse({
      retries: 0,
      maxRequests: 2,
      concurrency: 1,
      maxResults: 1,
    });
    const http = createProviderHttp({ limits, signal: run.signal, fetchImpl, budget });
    const log = vi.fn();
    const pending = createApifyAdapter().collect(
      {
        agentId: "instagram",
        queries: [],
        scope: ResearchScope.parse({ urls: ["https://www.instagram.com/p/synthetic/"] }),
      },
      {
        http,
        limits,
        signal: run.signal,
        credentials: { apify_api_token: "synthetic-apify-only" },
        config: ResearchProviderConfig.parse({
          enabled: true,
          approval: "granted",
          allowedActors: ["apify/instagram-scraper"],
        }),
        log,
        now: () => "2026-10-10T12:00:00.000Z",
      },
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    run.abort();

    try {
      expect((await pending).status).toBe("cancelled");
      expect(
        fetchImpl.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith("/abort")),
      ).toHaveLength(1);
      expect(http.requests).toBe(3);
      expect(http.cleanupRequests).toBe(1);
      expect(budget.used).toBe(2);
      expect(log.mock.calls.flat().join(" ")).toContain("Actor was aborted");
    } finally {
      poll.resolve(Response.json(started("synthetic_run", "ABORTED")));
    }
  });

  it("preserves cleanup after the real adapter exhausts its normal request budget", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        Response.json(
          started("synthetic_run", String(url).includes("/abort") ? "ABORTED" : "RUNNING"),
        ),
      );
    const { http } = client(fetchImpl, { maxRequests: 1, maxResults: 1 });
    const limits = ResearchLimits.parse({ retries: 0, maxRequests: 1, maxResults: 1 });

    const outcome = await createApifyAdapter().collect(
      {
        agentId: "instagram",
        queries: [],
        scope: ResearchScope.parse({ urls: ["https://www.instagram.com/p/synthetic/"] }),
      },
      {
        http,
        limits,
        signal: new AbortController().signal,
        credentials: { apify_api_token: "synthetic-apify-only" },
        config: ResearchProviderConfig.parse({
          enabled: true,
          approval: "granted",
          allowedActors: ["apify/instagram-scraper"],
        }),
        log: vi.fn(),
        now: () => "2026-10-10T12:00:00.000Z",
      },
    );

    expect(outcome.status).toBe("error");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(abortUrl("synthetic_run"));
    expect(http.requests).toBe(2);
    expect(http.cleanupRequests).toBe(1);
  });

  it("allows only one reserved abort attempt for each known run", async () => {
    const { http, fetchImpl } = client(
      vi.fn<typeof fetch>().mockImplementation(async () => Response.json(started("synthetic_run"))),
      { maxRequests: 1 },
    );
    await http.json(startUrl, { method: "POST", headers: auth, body: {} });

    await http.json(abortUrl("synthetic_run"), { method: "POST", headers: auth });
    await expect(
      http.json(abortUrl("synthetic_run"), { method: "POST", headers: auth }),
    ).rejects.toMatchObject({ code: "limit_reached" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "unknown run",
      "https://api.apify.com/v2/actor-runs/unknown_run/abort?gracefully=false",
      "POST",
      auth,
    ],
    ["wrong path", "https://api.apify.com/v2/actor-runs/synthetic_run/abort/extra", "POST", auth],
    ["encoded path", "https://api.apify.com/v2/actor-runs/%73ynthetic_run/abort", "POST", auth],
    ["wrong method", abortUrl("synthetic_run"), "GET", auth],
    [
      "other credentials",
      abortUrl("synthetic_run"),
      "POST",
      { Authorization: "Bearer synthetic-other" },
    ],
    ["other host", "https://api.openalex.org/v2/actor-runs/synthetic_run/abort", "POST", auth],
  ] as const)("does not grant reserved cleanup for %s", async (_label, url, method, headers) => {
    const { http, fetchImpl } = client(
      vi.fn<typeof fetch>().mockImplementation(async () => Response.json(started("synthetic_run"))),
      { maxRequests: 1 },
    );
    await http.json(startUrl, { method: "POST", headers: auth, body: {} });

    await expect(http.json(url, { method, headers })).rejects.toMatchObject({
      code: "limit_reached",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(http.cleanupRequests).toBe(0);
  });

  it("bounds cleanup to four requests per client, independently of the collection budget", async () => {
    let starts = 0;
    const budget: RequestBudget = { used: 0 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        Response.json(
          started(
            String(url).includes("/actors/") ? `synthetic_run_${++starts}` : "synthetic_run",
            "RUNNING",
          ),
        ),
      );
    const http = createProviderHttp({
      limits: ResearchLimits.parse({ maxRequests: 5, retries: 0 }),
      signal: new AbortController().signal,
      fetchImpl,
      budget,
    });
    for (let index = 1; index <= 5; index++)
      await http.json(startUrl, { method: "POST", headers: auth, body: {} });

    for (let index = 1; index <= 4; index++)
      await http.json(abortUrl(`synthetic_run_${index}`), { method: "POST", headers: auth });
    await expect(
      http.json(abortUrl("synthetic_run_5"), { method: "POST", headers: auth }),
    ).rejects.toMatchObject({ code: "limit_reached" });

    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(http.requests).toBe(9);
    expect(http.cleanupRequests).toBe(4);
    expect(budget.used).toBe(5);
  });

  it("settles cleanup at its independent five-second deadline when transport ignores cancellation", async () => {
    vi.useFakeTimers();
    const run = new AbortController();
    const ignored = deferred<Response>();
    const { http, fetchImpl } = client(
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(started("synthetic_run")))
        .mockReturnValueOnce(ignored.promise),
      { maxRequests: 1 },
      run.signal,
    );
    await http.json(startUrl, { method: "POST", headers: auth, body: {} });
    run.abort();
    const assertion = expect(
      http.json(abortUrl("synthetic_run"), { method: "POST", headers: auth }),
    ).rejects.toMatchObject({ code: "cancelled" });

    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await assertion;
    expect(http.cleanupRequests).toBe(1);
    ignored.resolve(Response.json(started("synthetic_run", "ABORTED")));
  });
});
