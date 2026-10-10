import { describe, expect, it, vi } from "vitest";
import type { SecretStatus } from "@reqflow/core";
import { saveStartupOpenAiKey } from "./openai-startup";

const status = (configured: boolean): SecretStatus => ({
  openai_api_key: { configured, source: configured ? "keychain" : null },
  anthropic_api_key: { configured: false, source: null },
  tavily_api_key: { configured: false, source: null },
});

describe("startup OpenAI key entry", () => {
  it("trims and saves only through the secret IPC method", async () => {
    const save = vi.fn().mockResolvedValue(status(true));
    await saveStartupOpenAiKey(save, " synthetic-test-key ");
    expect(save).toHaveBeenCalledWith("openai_api_key", "synthetic-test-key");
  });
  it("rejects a blank key without altering the configured key", async () => {
    const save = vi.fn();
    await expect(saveStartupOpenAiKey(save, "  ")).rejects.toThrow("Enter an OpenAI API key");
    expect(save).not.toHaveBeenCalled();
  });
  it("does not dismiss setup when storage reports no key", async () => {
    await expect(
      saveStartupOpenAiKey(async () => status(false), "synthetic-test-key"),
    ).rejects.toThrow("wasn't saved");
  });
  it("does not expose secret-bearing backend errors", async () => {
    await expect(
      saveStartupOpenAiKey(async () => {
        throw new Error("synthetic-private-value");
      }, "synthetic-test-key"),
    ).rejects.toThrow("Couldn't securely save the key");
  });
});
