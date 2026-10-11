import { DEFAULT_SETTINGS } from "@reqflow/core";
import { createLlmClient } from "@reqflow/llm";
import { describe, expect, it, vi } from "vitest";
import { structurePdf } from "./structure";

const text = "Synthetic heated seats are standard.";
const options = {
  key: "file_synthetic_pdf",
  title: "synthetic.pdf",
  dataset: "equipment_data" as const,
  scope: DEFAULT_SETTINGS.defaultScope,
  retrievedAt: "2026-10-11T00:00:00.000Z",
};
const page = { page: 1, text, method: "text" as const };

describe("PDF extraction through Google transport", () => {
  it.each([400, 401, 404, 429, 503])(
    "retains safe HTTP %i diagnostics from the real Google adapter",
    async (status) => {
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "PRIVATE_PROVIDER_BODY synthetic-key" } }),
            { status },
          ),
      );
      const llm = createLlmClient(
        { ...DEFAULT_SETTINGS.llm, provider: "google" },
        { apiKey: "synthetic-key", fetch },
      );
      const error = await structurePdf([page], llm, options).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`HTTP ${status}`);
      expect((error as Error).message).not.toContain("PRIVATE_PROVIDER_BODY");
      expect((error as Error).message).not.toContain("synthetic-key");
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("accepts explicit nulls for absent section/availability evidence in Gemini JSON", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            modelVersion: "gemini-synthetic-configured",
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  role: "model",
                  parts: [
                    {
                      text: JSON.stringify({
                        items: [
                          {
                            title: text,
                            section: null,
                            itemType: "note",
                            verbatimExcerpt: text,
                            availability: "unknown",
                            availabilityEvidence: null,
                            cells: [],
                            uncertainties: null,
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const llm = createLlmClient(
      { ...DEFAULT_SETTINGS.llm, provider: "google", model: "gemini-synthetic-configured" },
      { apiKey: "synthetic-key", fetch },
    );
    const result = await structurePdf([page], llm, options);
    expect(result.records).toHaveLength(2);
    expect(result.records[1]?.fields?.section).toBeNull();
    expect(result.modelId).toBe("gemini-synthetic-configured");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
