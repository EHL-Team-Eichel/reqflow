import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { anthropicClient } from "./anthropic";
import { Limiter, LlmHttpError, postJson } from "./http";
import { jevClient } from "./jev";
import { openAiClient } from "./openai";

/** Recorded-style fetch: returns the queued responses in order and keeps every request. */
function fakeFetch(
  ...responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> } | Error>
) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  });
  return { fetch: fn as unknown as typeof fetch, requests };
}

const claudeAnswer = (text: string, extra: Record<string, unknown> = {}) => ({
  body: {
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "Weighed the quotes.", signature: "sig" },
      { type: "text", text },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 1000,
    },
    ...extra,
  },
});
const claude = (fetch: typeof globalThis.fetch, patch: Record<string, unknown> = {}) =>
  anthropicClient({
    baseUrl: "https://api.anthropic.com",
    apiKey: "test-key",
    model: "claude-opus-5-5",
    fastModel: "claude-haiku-5-5",
    effort: "medium",
    temperature: 0.2,
    fetch,
    sleep: async () => {},
    ...patch,
  });
const schema = z.object({ ok: z.boolean() });

describe("anthropic client", () => {
  it("maps effort to thinking, never sending temperature while Claude thinks", async () => {
    const f = fakeFetch(
      claudeAnswer('{"ok":true}'),
      claudeAnswer('{"ok":true}'),
      claudeAnswer('{"ok":true}'),
    );
    const llm = claude(f.fetch);
    await llm.generateObject({ prompt: "p", system: "s", schema, tier: "fast", effort: "off" });
    await llm.generateObject({ prompt: "p", schema, effort: "off" });
    await llm.generateObject({ prompt: "p", schema, effort: "high" });
    const [haikuOff, opusOff, opusHigh] = f.requests.map((r) => r.body);
    expect(haikuOff).toMatchObject({
      model: "claude-haiku-5-5",
      thinking: { type: "disabled" },
      temperature: 0.2,
    });
    expect(haikuOff.system).toEqual([
      { type: "text", text: "s", cache_control: { type: "ephemeral" } },
    ]);
    expect(opusOff.thinking).toBeUndefined();
    expect(opusOff.temperature).toBeUndefined();
    expect(opusOff.output_config.effort).toBe("low");
    expect(opusHigh.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(opusHigh.temperature).toBeUndefined();
    expect(opusHigh.output_config).toMatchObject({
      effort: "high",
      format: { type: "json_schema" },
    });
    expect(opusHigh.max_tokens).toBe(4096 + 32000);
  });

  it("returns the thinking summary and counts cached input tokens", async () => {
    const res = await claude(fakeFetch(claudeAnswer('{"ok":true}')).fetch).generateObject({
      prompt: "p",
      schema,
    });
    expect(res).toMatchObject({
      object: { ok: true },
      model: "claude-opus-5-5",
      usage: { inputTokens: 1110, outputTokens: 5 },
      thinking: "Weighed the quotes.",
    });
  });

  it("treats every stop other than end_turn as incomplete", async () => {
    const cut = claude(fakeFetch(claudeAnswer("{", { stop_reason: "max_tokens" })).fetch);
    await expect(cut.generateObject({ prompt: "p", schema })).rejects.toThrow(/max_tokens/);
    const refused = claude(fakeFetch(claudeAnswer("{}", { stop_reason: "refusal" })).fetch);
    await expect(refused.generateObject({ prompt: "p", schema })).rejects.toThrow(/declined/);
    const paused = claude(fakeFetch(claudeAnswer("{}", { stop_reason: "pause_turn" })).fetch);
    await expect(paused.generateObject({ prompt: "p", schema })).rejects.toThrow(
      /stopped early \(pause_turn\)/,
    );
  });

  it("names the error type but never echoes the provider's message", async () => {
    const f = fakeFetch({
      status: 401,
      body: {
        type: "error",
        error: { type: "authentication_error", message: "secret-ish detail sk-123" },
      },
    });
    const err = await claude(f.fetch)
      .generateObject({ prompt: "p", schema })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(String((err as Error).message)).toContain("authentication_error");
    expect(String((err as Error).message)).not.toContain("sk-123");
    expect(f.requests).toHaveLength(1); // 401 is not retried
  });

  it("retries overloaded answers and honors retry-after", async () => {
    const slept: number[] = [];
    const f = fakeFetch(
      { status: 529, body: { type: "error", error: { type: "overloaded_error" } } },
      {
        status: 429,
        body: { type: "error", error: { type: "rate_limit_error" } },
        headers: { "retry-after": "2" },
      },
      claudeAnswer('{"ok":true}'),
    );
    const llm = claude(f.fetch, { sleep: async (ms: number) => void slept.push(ms) });
    await expect(llm.generateObject({ prompt: "p", schema })).resolves.toMatchObject({
      object: { ok: true },
    });
    expect(f.requests).toHaveLength(3);
    expect(slept[1]).toBe(2000);
  });

  it("does not retry a bad request", async () => {
    const f = fakeFetch({
      status: 400,
      body: { type: "error", error: { type: "invalid_request_error" } },
    });
    await expect(claude(f.fetch).generateObject({ prompt: "p", schema })).rejects.toThrow(
      /HTTP 400, invalid_request_error/,
    );
    expect(f.requests).toHaveLength(1);
  });
});

describe("transport", () => {
  it("wraps network errors without passing their details on", async () => {
    const f = fakeFetch(
      new TypeError("fetch failed: getaddrinfo ENOTFOUND internal-host"),
      new TypeError("again"),
    );
    const err = await postJson("https://x.test/v1", {
      headers: {},
      body: {},
      fetch: f.fetch,
      timeoutMs: 1000,
      retries: 1,
      provider: "Test",
      sleep: async () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect((err as Error).message).toBe("Test could not be reached (network error)");
  });

  it("stops promptly when the caller aborts during a backoff", async () => {
    const controller = new AbortController();
    const f = fakeFetch({ status: 503, body: {} }, claudeAnswer("{}"));
    const pending = postJson("https://x.test/v1", {
      headers: {},
      body: {},
      fetch: f.fetch,
      timeoutMs: 1000,
      provider: "Test",
      signal: controller.signal,
      random: () => 0.5,
    });
    setTimeout(() => controller.abort(new Error("cancelled")), 20);
    await expect(pending).rejects.toThrow("cancelled");
    expect(f.requests).toHaveLength(1);
  });

  it("the limiter never runs more than its limit at once", async () => {
    const limiter = new Limiter(2);
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});

describe("openai-compatible client", () => {
  const answer = (content: string) => ({
    body: {
      model: "local-model",
      choices: [{ finish_reason: "stop", message: { content } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    },
  });

  it("falls back to JSON mode after a 400 without deadlocking a full limiter", async () => {
    const f = fakeFetch(
      { status: 400, body: { error: { code: "unsupported_response_format" } } },
      answer('{"ok":true}'),
    );
    const llm = openAiClient({
      provider: "openai_compatible",
      baseUrl: "http://localhost:11434/v1/",
      model: "local-model",
      fastModel: "",
      effort: "off",
      temperature: 0.1,
      fetch: f.fetch,
      limiter: new Limiter(1),
      sleep: async () => {},
    });
    const result = await Promise.race([
      llm.generateObject({ prompt: "p", schema }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("deadlock")), 1000)),
    ]);
    expect(result).toMatchObject({
      object: { ok: true },
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(f.requests[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(f.requests[0]!.headers.Authorization).toBeUndefined();
    expect(f.requests[0]!.body.response_format.type).toBe("json_schema");
    expect(f.requests[1]!.body.response_format).toEqual({ type: "json_object" });
    expect(f.requests[1]!.body.messages[0].content).toContain("JSON Schema");
  });
});

describe("jev client", () => {
  it("sends the documented request and maps the documented answer", async () => {
    const f = fakeFetch({
      body: {
        model: "jev-1.13.0",
        answers: {
          department: {
            type: "choice",
            choice: "technical",
            confidence: 0.78,
            probabilities: { technical: 0.85, sales: 0, billing: 0.15 },
          },
          frustration: {
            type: "score",
            score: 1,
            confidence: 1,
            legend: { "0": "Calm", "1": "Frustrated", "2": "Angry" },
            probabilities: { "0": 0, "1": 1, "2": 0 },
          },
          is_urgent: { type: "noul", noul: 1 },
        },
        usage: { input_tokens: 392, output_tokens: 65 },
      },
    });
    const jev = jevClient({ apiKey: "jev-key", fetch: f.fetch });
    const res = await jev.decide({
      state: "Integration keeps failing.",
      questions: {
        department: {
          type: "choice",
          instructions: "Team",
          criteria: { billing: "b", technical: "t", sales: "s" },
        },
        frustration: {
          type: "score",
          instructions: "How frustrated",
          criteria: ["Calm", "Frustrated", "Angry"],
        },
        is_urgent: { type: "noul", instructions: "Urgent" },
      },
    });
    const req = f.requests[0]!;
    expect(req.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(req.headers).toMatchObject({
      "content-type": "application/json",
      Authorization: "Bearer jev-key",
    });
    expect(req.body).toMatchObject({ model: "jev-latest", state: "Integration keeps failing." });
    expect(req.body.questions.frustration.criteria).toEqual(["Calm", "Frustrated", "Angry"]);
    expect(res.model).toBe("jev-1.13.0");
    expect(res.answers.is_urgent).toEqual({ type: "noul", value: 1 });
    expect(res.answers.frustration).toEqual({
      type: "score",
      score: 1,
      probabilities: [0, 1, 0],
      confidence: 1,
    });
    expect(res.answers.department).toMatchObject({
      type: "choice",
      choice: "technical",
      confidence: 0.78,
    });
    expect(res.usage).toEqual({ inputTokens: 392, outputTokens: 65 });
  });

  it("rejects an answer of the wrong type", async () => {
    const f = fakeFetch({
      body: { model: "jev", answers: { q: { type: "choice", choice: "x" } } },
    });
    await expect(
      jevClient({ apiKey: "k", fetch: f.fetch }).decide({
        state: "s",
        questions: { q: { type: "noul", instructions: "i" } },
      }),
    ).rejects.toThrow(/doesn't match/);
  });
});
