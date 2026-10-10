import { PagePlaceholder } from "@/components/shell/PagePlaceholder";

export function SettingsPage() {
  return (
    <PagePlaceholder
      title="Settings"
      purpose="Configure the AI, web research, prioritization logic and default scope. Changes are audited."
      owner="WS4"
      builds={[
        "API keys (Anthropic, Tavily): entered here, stored encrypted in the OS keychain (api.settings.setSecret) — never shown again",
        "AI model: provider (anthropic / mock), quality + fast model, temperature",
        "Web research: provider, max results, allowed / blocked domains",
        "Prioritization: factor weights (sliders) + must/should/could thresholds, with a live example score",
        "Default scope (vehicle line, derivative, code, market, horizon) and reviewer identity",
      ]}
    />
  );
}
