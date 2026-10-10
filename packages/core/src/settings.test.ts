import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  LLM_MODEL_DEFAULTS,
  LLM_SECRET_NAMES,
  LiveLlmProvider,
  Settings,
} from "./settings";
import { SecretName } from "./secrets";

describe("LLM provider settings compatibility", () => {
  it("retains legacy canonical model IDs without requiring provider profiles", () => {
    const legacy = structuredClone(DEFAULT_SETTINGS);
    legacy.llm.provider = "anthropic";
    legacy.llm.model = "custom-legacy-quality";
    legacy.llm.fastModel = "custom-legacy-fast";
    const parsed = Settings.parse(legacy);
    expect(parsed.llm).toMatchObject(legacy.llm);
    expect(parsed.llm.modelProfiles).toBeUndefined();
    expect(parsed.research.provider).toBe("off");
  });

  it.each(LiveLlmProvider.options)(
    "accepts %s models and its registered secret name",
    (provider) => {
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.llm = {
        ...settings.llm,
        provider,
        ...LLM_MODEL_DEFAULTS[provider],
        modelProfiles: { [provider]: { model: "custom-quality", fastModel: "custom-fast" } },
      };
      const parsed = Settings.parse(settings);
      expect(parsed.llm.modelProfiles?.[provider]).toEqual({
        model: "custom-quality",
        fastModel: "custom-fast",
      });
      expect(SecretName.parse(LLM_SECRET_NAMES[provider])).toBe(LLM_SECRET_NAMES[provider]);
      expect(parsed.research.apis).toEqual(DEFAULT_SETTINGS.research.apis);
    },
  );

  it.each([
    { unknown_provider: { model: "quality", fastModel: "fast" } },
    { openai: { model: "   ", fastModel: "fast" } },
    { google: { model: "quality", fastModel: "   " } },
    { anthropic: { model: "x".repeat(201), fastModel: "fast" } },
    { google: { model: "quality" } },
  ])("rejects invalid remembered provider profiles", (modelProfiles) => {
    expect(
      Settings.safeParse({
        ...DEFAULT_SETTINGS,
        llm: { ...DEFAULT_SETTINGS.llm, modelProfiles },
      }).success,
    ).toBe(false);
  });
});
