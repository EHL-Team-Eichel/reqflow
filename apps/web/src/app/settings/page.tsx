import { PagePlaceholder } from "@/components/shell/PagePlaceholder";

export default function SettingsPage() {
  return (
    <PagePlaceholder
      title="Settings"
      purpose="Configure the AI, web research, prioritization logic and default scope. Changes are audited."
      owner="WS4"
      builds={[
        "AI model: provider (anthropic / mock), quality + fast model, temperature; API-key status (configured or not, never the key)",
        "Web research: provider, max results, allowed / blocked domains",
        "Prioritization: factor weights (sliders) + must/should/could thresholds, with a live example score",
        "Default scope: vehicle line, derivative, vehicle code, market, horizon",
        "Reviewer identity used in the audit trail",
      ]}
    />
  );
}
