import { describe, expect, it } from "vitest";
import { pdfAiFailureReason } from "./ai-error";

describe("safe PDF provider diagnostics", () => {
  it.each([400, 401, 403, 404, 429, 500, 503])(
    "reports HTTP %i without provider payloads",
    (status) => {
      const message = pdfAiFailureReason(
        new Error(`Google request failed (HTTP ${status}): PRIVATE_PROVIDER_BODY synthetic-secret`),
      );
      expect(message).toContain(`HTTP ${status}`);
      expect(message).not.toContain("PRIVATE_PROVIDER_BODY");
      expect(message).not.toContain("synthetic-secret");
    },
  );

  it("keeps quota distinct from missing or rejected credentials", () => {
    expect(pdfAiFailureReason(new Error("Google request failed (HTTP 429)"))).toMatch(
      /rate-limited or out of quota/,
    );
    expect(pdfAiFailureReason(new Error("The default AI (google) has no API key."))).toMatch(
      /agent API setup alone is not used by Raw/,
    );
    expect(pdfAiFailureReason({ statusCode: 401, message: "PRIVATE" })).toMatch(
      /rejected credentials/,
    );
  });

  it("unwraps internal preview causes, without returning their content", () => {
    expect(
      pdfAiFailureReason(
        new Error("Preview failed", { cause: { status: 429, message: "PRIVATE" } }),
      ),
    ).toMatch(/HTTP 429/);
  });

  it.each([
    ["Google structured response failed schema validation", "does not match"],
    ["Google structured output schema is unsupported", "cannot send"],
    ["Google structured response is not valid JSON", "invalid JSON"],
    ["Google response is invalid or incomplete", "incomplete or refused"],
    ["Google transport failed", "could not be reached"],
  ])("classifies %s without request or response content", (message, expected) => {
    expect(pdfAiFailureReason(new Error(message))).toContain(expected);
  });

  it("never forwards arbitrary exception text", () => {
    expect(pdfAiFailureReason(new Error("PRIVATE_DOC sk-synthetic-key"))).toBe(
      "Check the configured default AI and credentials",
    );
    expect(pdfAiFailureReason(undefined)).toBe("Check the configured default AI and credentials");
  });
});
