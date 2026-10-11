import { z } from "zod";

// Provider prose, dimensions, URLs and unknown identifiers may echo inputs or credentials.
// Only known Google identifiers and bounded numeric values can enter the public error.
const Status = z.enum([
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "FAILED_PRECONDITION",
  "INTERNAL",
  "DEADLINE_EXCEEDED",
]);
const QuotaId = z
  .string()
  .regex(
    /^(?:GenerateRequestsPer(?:Minute|Day)PerProject(?:PerModel)?|GenerateContentInputTokensPer(?:ModelPerMinute|MinutePerProjectPerModel|DayPerProjectPerModel)|GenerateContentTokensPerMinutePerProjectPerModel)(?:-(?:Free|Paid)Tier)?$/,
  );
const QuotaMetric = z
  .string()
  .regex(
    /^generativelanguage\.googleapis\.com\/generate_content_(?:(?:free|paid)_tier_)?(?:requests|input_token_count|output_token_count|tokens)$/,
  );
const Limit = z.union([
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  z
    .string()
    .regex(/^\d{1,16}$/)
    .transform(Number)
    .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)),
]);
const Envelope = z.object({
  error: z.object({
    status: z.unknown().optional(),
    message: z.unknown().optional(),
    details: z.array(z.unknown()).optional(),
  }),
});
const ErrorInfo = z.object({
  "@type": z.literal("type.googleapis.com/google.rpc.ErrorInfo"),
  reason: z.enum([
    "API_KEY_INVALID",
    "API_KEY_EXPIRED",
    "API_KEY_SERVICE_BLOCKED",
    "API_KEY_HTTP_REFERRER_BLOCKED",
    "API_KEY_IP_ADDRESS_BLOCKED",
    "SERVICE_DISABLED",
    "CONSUMER_INVALID",
    "PROJECT_INVALID",
    "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
  ]),
});
const BadRequest = z.object({
  "@type": z.literal("type.googleapis.com/google.rpc.BadRequest"),
  fieldViolations: z.array(
    z.object({ field: z.unknown().optional(), description: z.unknown().optional() }),
  ),
});
const requestFields = [
  [
    "generationConfig.responseJsonSchema",
    /^generation(?:Config|_config)\.response(?:JsonSchema|_json_schema)(?:$|[.\[])/,
  ],
  [
    "generationConfig.responseSchema",
    /^generation(?:Config|_config)\.response(?:Schema|_schema)(?:$|[.\[])/,
  ],
  [
    "generationConfig.responseMimeType",
    /^generation(?:Config|_config)\.response(?:MimeType|_mime_type)$/,
  ],
  [
    "generationConfig.maxOutputTokens",
    /^generation(?:Config|_config)\.max(?:OutputTokens|_output_tokens)$/,
  ],
  ["generationConfig.temperature", /^generation(?:Config|_config)\.temperature$/],
  ["generationConfig.candidateCount", /^generation(?:Config|_config)\.candidate(?:Count|_count)$/],
  ["systemInstruction", /^system(?:Instruction|_instruction)(?:$|[.\[])/],
  ["contents", /^contents(?:$|[.\[])/],
  ["model", /^model$/],
] as const;

/** Recognize a fixed provider diagnostic; never interpolate its prose into an error. */
function argumentReason(value: unknown): string | undefined {
  if (
    typeof value === "string" &&
    /^The specified schema produces a constraint that has too many states for serving(?:[.!\s]|$)/i.test(
      value,
    )
  )
    return "reason: schema_too_complex";
  return undefined;
}
const QuotaFailure = z.object({
  "@type": z.literal("type.googleapis.com/google.rpc.QuotaFailure"),
  violations: z.array(
    z.object({
      quotaId: z.unknown().optional(),
      quotaMetric: z.unknown().optional(),
      quotaValue: z.unknown().optional(),
    }),
  ),
});
const RetryInfo = z.object({
  "@type": z.literal("type.googleapis.com/google.rpc.RetryInfo"),
  retryDelay: z.string().regex(/^\d{1,6}(?:\.\d{1,9})?s$/),
});

/** Error parsing stays small even when an endpoint returns an unexpected/oversized body. */
async function readError(response: Response, signal?: AbortSignal): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    signal?.throwIfAborted();
    while (true) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 32_768) return undefined;
      chunks.push(next.value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(buffer)) as unknown;
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Safe diagnostic suffix only; never return Google's free-form error message. */
export async function googleErrorDetails(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  const parts = new Set<string>();
  const header = response.headers?.get("retry-after");
  if (header && /^\d{1,6}$/.test(header)) parts.add(`Retry-After: ${Number(header)}s`);
  try {
    const parsed = Envelope.safeParse(await readError(response, signal));
    if (parsed.success) {
      const status = Status.safeParse(parsed.data.error.status);
      if (status.success) parts.add(`status: ${status.data}`);
      if (status.success && status.data === "INVALID_ARGUMENT") {
        const reason = argumentReason(parsed.data.error.message);
        if (reason) parts.add(reason);
      }
      for (const detail of (parsed.data.error.details ?? []).slice(0, 8)) {
        const info = ErrorInfo.safeParse(detail);
        if (info.success) parts.add(`reason: ${info.data.reason}`);
        const badRequest = BadRequest.safeParse(detail);
        if (badRequest.success) {
          for (const violation of badRequest.data.fieldViolations.slice(0, 8)) {
            if (typeof violation.field === "string") {
              const name = violation.field;
              const field = requestFields.find(([, pattern]) => pattern.test(name));
              if (field) parts.add(`field: ${field[0]}`);
            }
            if (status.success && status.data === "INVALID_ARGUMENT") {
              const reason = argumentReason(violation.description);
              if (reason) parts.add(reason);
            }
          }
        }
        const quota = QuotaFailure.safeParse(detail);
        if (quota.success) {
          for (const violation of quota.data.violations.slice(0, 8)) {
            const id = QuotaId.safeParse(violation.quotaId);
            const metric = QuotaMetric.safeParse(violation.quotaMetric);
            if (!id.success && !metric.success) continue;
            const fields = [];
            if (id.success) fields.push(`quota: ${id.data}`);
            if (metric.success) fields.push(`metric: ${metric.data}`);
            const limit = Limit.safeParse(violation.quotaValue);
            if (limit.success) fields.push(`limit: ${limit.data}`);
            parts.add(fields.join(", "));
          }
        }
        const retry = RetryInfo.safeParse(detail);
        if (retry.success) {
          const seconds = Number(retry.data.retryDelay.slice(0, -1));
          if (Number.isFinite(seconds)) parts.add(`retry delay: ${seconds}s`);
        }
      }
    }
  } catch {
    // Invalid/erroring bodies cannot replace the original HTTP error or leak parser errors.
    signal?.throwIfAborted();
  }
  return parts.size ? `; ${[...parts].join("; ")}` : "";
}
