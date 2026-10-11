/** Fixed diagnostics only: provider exceptions can contain keys, prompts and response bodies. */
export function pdfAiFailureReason(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const failure = current as {
      message?: unknown;
      name?: unknown;
      status?: unknown;
      statusCode?: unknown;
      cause?: unknown;
    };
    const message = typeof failure.message === "string" ? failure.message : "";
    const http = /\bHTTP ([45]\d{2})\b/.exec(message);
    const status = failure.status ?? failure.statusCode ?? (http ? Number(http[1]) : undefined);
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
      if (status === 401 || status === 403)
        return `The default AI provider rejected credentials or access (HTTP ${status}). Check Settings -> AI -> Default AI`;
      if (status === 404)
        return "The configured default AI model or endpoint was not found (HTTP 404). Check the model selected in Settings";
      if (status === 429)
        return "The default AI provider is rate-limited or out of quota (HTTP 429). Check provider quota and retry later";
      if (status === 400)
        return "The default AI provider rejected the extraction request (HTTP 400). Check model and structured-output compatibility";
      return `The default AI provider request failed (HTTP ${status}). Retry or check provider availability`;
    }
    if (/^The default AI \((?:anthropic|openai|google)\) has no API key\./.test(message)) {
      return "The default AI has no API key. Configure Settings -> AI -> Default AI; an agent API setup alone is not used by Raw";
    }
    if (
      failure.name === "ZodError" ||
      /structured response failed schema validation/.test(message)
    ) {
      return "The AI returned JSON that does not match the PDF extraction schema";
    }
    if (/structured output schema is unsupported/.test(message))
      return "The default AI adapter cannot send this extraction schema";
    if (/structured response is not valid JSON/.test(message))
      return "The AI returned invalid JSON";
    if (
      /response is invalid or incomplete|response is incomplete|stopped before finishing/.test(
        message,
      )
    )
      return "The AI response was incomplete or refused. Check output-token limits and model support";
    if (/transport failed|could not be reached/.test(message))
      return "The default AI provider could not be reached. Check connectivity";
    current = failure.cause;
  }
  return "Check the configured default AI and credentials";
}
