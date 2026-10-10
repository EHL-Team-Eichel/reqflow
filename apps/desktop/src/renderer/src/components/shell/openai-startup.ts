import type { SecretStatus } from "@reqflow/core";

export async function saveStartupOpenAiKey(
  save: (name: "openai_api_key", value: string) => Promise<SecretStatus>,
  draft: string,
): Promise<void> {
  const key = draft.trim();
  if (!key) throw new Error("Enter an OpenAI API key.");
  let status: SecretStatus;
  try {
    status = await save("openai_api_key", key);
  } catch {
    // IPC/provider error details can contain sensitive values. Never repeat them in the UI.
    throw new Error("Couldn't securely save the key. Check OS key storage and try again.");
  }
  if (!status.openai_api_key.configured) throw new Error("The key wasn't saved. Please try again.");
}
