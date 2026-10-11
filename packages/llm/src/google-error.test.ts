import { DEFAULT_SETTINGS } from "@reqflow/core";
import { describe, expect, it, vi } from "vitest";
import { createLlmClient } from "./default-client";

const privateText = "SYNTHETIC_PRIVATE_PROMPT";
const apiKey = "SYNTHETIC_SECRET_API_KEY";
const quotaId = "GenerateRequestsPerMinutePerProjectPerModel-FreeTier";
const quotaMetric = "generativelanguage.googleapis.com/generate_content_free_tier_requests";
const errorBody = {
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    message: `${apiKey} ${privateText}`,
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          { quotaId, quotaMetric, quotaValue: "0", quotaDimensions: { model: privateText } },
        ],
      },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "32.5s" },
      { "@type": "type.googleapis.com/google.rpc.Help", links: [{ url: apiKey }] },
    ],
  },
};

async function failure(response: Response, signal?: AbortSignal) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
  const client = createLlmClient(
    { ...DEFAULT_SETTINGS.llm, provider: "google" },
    { apiKey, fetch },
  );
  const error = await client.generateText({ prompt: privateText, signal }).catch((e: unknown) => e);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(privateText);
  expect(String(error)).not.toContain(apiKey);
  return error as Error;
}

describe("Google HTTP diagnostics", () => {
  it("identifies an invalid API key from typed ErrorInfo without exposing metadata", async () => {
    const error = await failure(
      new Response(
        JSON.stringify({
          error: {
            status: "INVALID_ARGUMENT",
            message: `${apiKey} ${privateText}`,
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "API_KEY_INVALID",
                metadata: { key: apiKey, request: privateText },
              },
            ],
          },
        }),
        { status: 400 },
      ),
    );
    expect(error.message).toBe(
      "Google request failed (HTTP 400); status: INVALID_ARGUMENT; reason: API_KEY_INVALID",
    );
  });

  it.each(["generation_config.response_json_schema", "generationConfig.responseJsonSchema"])(
    "identifies a rejected schema field without disclosing nested property names (%s)",
    async (field) => {
      const error = await failure(
        new Response(
          JSON.stringify({
            error: {
              status: "INVALID_ARGUMENT",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.BadRequest",
                  fieldViolations: [
                    { field: `${field}.properties.${privateText}`, description: apiKey },
                    { field, description: privateText },
                    { field: apiKey, description: privateText },
                  ],
                },
              ],
            },
          }),
          { status: 400 },
        ),
      );
      expect(error.message).toBe(
        "Google request failed (HTTP 400); status: INVALID_ARGUMENT; field: generationConfig.responseJsonSchema",
      );
    },
  );

  it.each(["message", "description"])(
    "classifies Google's schema complexity rejection using a static label (%s)",
    async (location) => {
      const message =
        `The specified schema produces a constraint that has too many states for serving. ` +
        `Typical causes are long array length limits. ${apiKey} ${privateText}`;
      const error = await failure(
        new Response(
          JSON.stringify({
            error: {
              status: "INVALID_ARGUMENT",
              ...(location === "message"
                ? { message }
                : {
                    details: [
                      {
                        "@type": "type.googleapis.com/google.rpc.BadRequest",
                        fieldViolations: [{ description: message }],
                      },
                    ],
                  }),
            },
          }),
          { status: 400 },
        ),
      );
      expect(error.message).toBe(
        "Google request failed (HTTP 400); status: INVALID_ARGUMENT; reason: schema_too_complex",
      );
    },
  );

  it("discards unknown reasons and fields, and does not classify prose under another RPC status", async () => {
    const error = await failure(
      new Response(
        JSON.stringify({
          error: {
            status: "RESOURCE_EXHAUSTED",
            message: `schema too complex ${apiKey}`,
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: privateText,
              },
              {
                "@type": "type.googleapis.com/google.rpc.BadRequest",
                fieldViolations: [
                  { field: privateText, description: `schema too many states ${apiKey}` },
                  { field: `generationConfig.maxOutputTokens.${privateText}` },
                  { field: `contents_${privateText}` },
                ],
              },
            ],
          },
        }),
        { status: 429 },
      ),
    );
    expect(error.message).toBe("Google request failed (HTTP 429); status: RESOURCE_EXHAUSTED");
  });

  it("does not infer schema complexity from an arbitrary message quoting those words", async () => {
    const error = await failure(
      new Response(
        JSON.stringify({
          error: {
            status: "INVALID_ARGUMENT",
            message: `${privateText}: schema too complex; too many states ${apiKey}`,
          },
        }),
        { status: 400 },
      ),
    );
    expect(error.message).toBe("Google request failed (HTTP 400); status: INVALID_ARGUMENT");
  });

  it("shows typed quota, zero limit and retry information without echoing prose or retrying", async () => {
    const error = await failure(
      new Response(JSON.stringify(errorBody), {
        status: 429,
        headers: { "Retry-After": "33" },
      }),
    );
    expect(error.message).toBe(
      `Google request failed (HTTP 429); Retry-After: 33s; status: RESOURCE_EXHAUSTED; quota: ${quotaId}, metric: ${quotaMetric}, limit: 0; retry delay: 32.5s`,
    );
  });

  it("ignores injected identifiers, status, values, dimensions and free-form detail text", async () => {
    const unsafe = {
      error: {
        status: apiKey,
        message: privateText,
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              { quotaId: apiKey, quotaMetric: privateText, quotaValue: "0" },
              { quotaId, quotaValue: privateText, description: apiKey, subject: privateText },
            ],
          },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: privateText },
        ],
      },
    };
    const error = await failure(
      new Response(JSON.stringify(unsafe), {
        status: 429,
        headers: { "Retry-After": apiKey },
      }),
    );
    expect(error.message).toBe(`Google request failed (HTTP 429); quota: ${quotaId}`);
  });

  it.each(["not JSON", JSON.stringify({ error: { message: apiKey } }), "x".repeat(32_769)])(
    "keeps the original HTTP status for malformed, unstructured or oversized errors",
    async (body) => {
      expect((await failure(new Response(body, { status: 429 }))).message).toBe(
        "Google request failed (HTTP 429)",
      );
    },
  );

  it("keeps a numeric Retry-After even if the body cannot be read", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error(apiKey));
      },
    });
    expect(
      (await failure(new Response(stream, { status: 429, headers: { "Retry-After": "60" } })))
        .message,
    ).toBe("Google request failed (HTTP 429); Retry-After: 60s");
  });

  it("bounds streamed error bodies and cancels further reads", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(32_769));
      },
      cancel,
    });
    expect((await failure(new Response(stream, { status: 429 }))).message).toBe(
      "Google request failed (HTTP 429)",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves cancellation while the provider error body stalls", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 429 });
    const pending = failure(response, controller.signal);
    await vi.waitFor(() => expect(response.body?.locked).toBe(true));
    controller.abort(new Error("Synthetic cancellation"));
    expect((await pending).message).toBe("Synthetic cancellation");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
