import React, { createElement, type ButtonHTMLAttributes, type InputHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  LLM_MODEL_DEFAULTS,
  type LlmProvider,
  type Settings,
} from "@reqflow/core";
import { createSettingsStore } from "../../../lib/settings-store";
import { settingsStore, useSettings } from "../../../lib/settings";
import { Select, Slider, ValidatedTextInput } from "../../ui/controls";
import { AiSection } from "./AiSection";

vi.mock("../../ui/Button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) =>
    createElement("button", props),
}));
vi.mock("../../ui/controls", () => ({
  Select: vi.fn(
    ({
      options,
      value,
      id,
      disabled,
    }: {
      options: readonly { value: string; label: string }[];
      value: string;
      id?: string;
      disabled?: boolean;
    }) =>
      createElement(
        "select",
        { id, value, disabled, onChange: () => {} },
        options.map((option) =>
          createElement("option", { key: option.value, value: option.value }, option.label),
        ),
      ),
  ),
  TextInput: (props: Omit<InputHTMLAttributes<HTMLInputElement>, "onChange">) =>
    createElement("input", { ...props, onChange: () => {} }),
  ValidatedTextInput: vi.fn(
    ({
      onCommit: _onCommit,
      ...props
    }: InputHTMLAttributes<HTMLInputElement> & { onCommit: (value: string) => string | null }) =>
      createElement("input", { ...props, onChange: () => {} }),
  ),
  Slider: vi.fn(() => null),
  TextArea: () => null,
  NumberInput: () => null,
  Toggle: () => null,
}));
vi.mock("../../../lib/api", () => ({ api: {} }));
vi.mock("../../../lib/settings", () => ({
  settingsStore: { getState: vi.fn() },
  useSettings: vi.fn(),
}));
vi.stubGlobal("React", React);

function setup(provider: LlmProvider = "mock", models?: Partial<Settings["llm"]>) {
  const save = vi.fn(async (input: Settings) => input);
  const store = createSettingsStore({
    settings: { get: vi.fn(), save, secrets: vi.fn(), setSecret: vi.fn() },
  });
  store.setState({
    persistence: "unavailable",
    settings: {
      ...DEFAULT_SETTINGS,
      llm: {
        ...DEFAULT_SETTINGS.llm,
        provider,
        ...(provider === "mock" ? {} : LLM_MODEL_DEFAULTS[provider]),
        ...models,
      },
    },
  });
  vi.mocked(useSettings).mockImplementation((selector) => selector(store.getState()));
  vi.mocked(settingsStore.getState).mockImplementation(() => store.getState());
  const render = () => {
    vi.mocked(Select).mockClear();
    vi.mocked(ValidatedTextInput).mockClear();
    vi.mocked(Slider).mockClear();
    return renderToStaticMarkup(createElement(AiSection));
  };
  return { store, render };
}
const select = (id: string) => vi.mocked(Select).mock.calls.find(([props]) => props.id === id)?.[0];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("AI provider/model presentation contract", () => {
  it("offers Mock, Claude, OpenAI, and Google Gemini with an accessible provider label", () => {
    const { render } = setup();
    const html = render();
    expect(select("llm-provider")?.options.map((option) => option.value)).toEqual([
      "mock",
      "anthropic",
      "openai",
      "google",
    ]);
    expect(html).toContain('for="llm-provider"');
    expect(html).toContain("Google Gemini");
    expect(html).toContain("OpenAI");
  });

  it("switches canonical runtime models and preserves old custom Anthropic IDs without changing research", () => {
    const { store, render } = setup("anthropic", {
      model: "claude-custom",
      fastModel: "claude-small",
    });
    render();
    const originalResearch = store.getState().settings.research;
    select("llm-provider")!.onChange("invalid-provider");
    expect(store.getState().settings.llm.provider).toBe("anthropic");
    select("llm-provider")!.onChange("openai");
    expect(store.getState().settings.llm).toMatchObject({
      provider: "openai",
      ...LLM_MODEL_DEFAULTS.openai,
    });
    render();
    select("llm-provider")!.onChange("anthropic");
    expect(store.getState().settings.llm).toMatchObject({
      provider: "anthropic",
      model: "claude-custom",
      fastModel: "claude-small",
    });
    expect(store.getState().settings.research).toBe(originalResearch);
  });

  it.each(["anthropic", "openai", "google"] as const)(
    "shows %s QUALITY/FAST presets plus Custom IDs, without a live model lookup",
    (provider) => {
      const { render } = setup(provider);
      const html = render();
      for (const id of ["llm-quality-preset", "llm-fast-preset"]) {
        expect(select(id)?.options.map((option) => option.value)).toEqual([
          LLM_MODEL_DEFAULTS[provider].model,
          LLM_MODEL_DEFAULTS[provider].fastModel,
          "custom",
        ]);
        expect(html).toContain(`for="${id}"`);
      }
      expect(html).toContain("Custom model ID");
      expect(html).toContain("account access");
    },
  );

  it("preset selection updates only the chosen runtime tier; unknown option values do nothing", () => {
    const { store, render } = setup("google");
    render();
    select("llm-quality-preset")!.onChange("not-a-preset");
    expect(store.getState().settings.llm.model).toBe(LLM_MODEL_DEFAULTS.google.model);
    select("llm-quality-preset")!.onChange(LLM_MODEL_DEFAULTS.google.fastModel);
    expect(store.getState().settings.llm.model).toBe(LLM_MODEL_DEFAULTS.google.fastModel);
    expect(store.getState().settings.llm.fastModel).toBe(LLM_MODEL_DEFAULTS.google.fastModel);
  });

  it("old custom model IDs appear in custom fields; invalid/mismatched input cannot change runtime settings", () => {
    const { store, render } = setup("openai", {
      model: "custom-quality",
      fastModel: "custom-fast",
    });
    const html = render();
    expect(select("llm-quality-preset")?.value).toBe("custom");
    expect(select("llm-fast-preset")?.value).toBe("custom");
    expect(html).toContain('value="custom-quality"');
    const quality = vi
      .mocked(ValidatedTextInput)
      .mock.calls.find(([props]) => props.id === "llm-quality-custom")?.[0];
    expect(quality?.onCommit("claude-opus-5-5")).toContain("provider");
    expect(quality?.onCommit(" ")).toBeTruthy();
    expect(store.getState().settings.llm.model).toBe("custom-quality");
    expect(quality?.onCommit(" gpt-custom ")).toBeNull();
    expect(store.getState().settings.llm.model).toBe("gpt-custom");
  });

  it("shows mismatches from older settings without silently rewriting them", () => {
    const { store, render } = setup("google", { model: "gpt-4.1" });
    expect(render()).toContain("This model belongs to another provider");
    expect(store.getState().settings.llm.model).toBe("gpt-4.1");
  });

  it("mock disables model and temperature controls and explains no paid planning calls", () => {
    const { render } = setup();
    const html = render();
    expect(select("llm-quality-preset")?.disabled).toBe(true);
    expect(select("llm-fast-preset")?.disabled).toBe(true);
    expect(vi.mocked(Slider).mock.calls[0]?.[0].disabled).toBe(true);
    expect(html).toContain("Mock is offline");
    expect(html).toContain("never makes paid model calls");
    expect(html).not.toContain('type="password"');
  });

  it.each([
    ["anthropic", "anthropic_api_key", "Anthropic key"],
    ["openai", "openai_api_key", "OpenAI key"],
    ["google", "google_api_key", "Google Gemini key"],
  ] as const)(
    "shows only selected %s masked key editor and matching opt-in planning help",
    (provider, name, keyLabel) => {
      const { render } = setup(provider);
      const html = render();
      expect(html).toContain(`id="${name}"`);
      expect(html.match(/type="password"/g)).toHaveLength(1);
      expect(html).toContain('value=""');
      expect(html).toContain("Status unavailable");
      expect(html).toContain(keyLabel);
      expect(html).toContain("off by default");
      expect(html).toContain("cannot enable providers");
      expect(html).toContain("switching providers");
    },
  );

  it("explains ignored OpenAI reasoning temperature without changing saved settings", () => {
    const { store, render } = setup("openai", { model: "o3", temperature: 0.2 });
    expect(render()).toContain("omits temperature");
    expect(store.getState().settings.llm.temperature).toBe(0.2);
  });
});
