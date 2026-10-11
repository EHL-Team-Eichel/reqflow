import { BLOCK_SPECS, type WorkflowBlock } from "@reqflow/core";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/controls";
import { useSettings } from "@/lib/settings";
import { ParamField } from "./ParamField";
import { dataflowStore } from "./store";
import { applyFilterPreset, filterBypassed, type FilterPreset } from "./filter-configuration";

export function AiFilterConfiguration({ block }: { block: WorkflowBlock }) {
  const [preset, setPreset] = useState<FilterPreset>("custom");
  const [error, setError] = useState<string | null>(null);
  const scope = useSettings((state) => state.settings.defaultScope);
  const bypassed = filterBypassed(block);
  return (
    <div data-testid="ai-filter-configuration" className="flex flex-col gap-4">
      {bypassed && (
        <p role="alert" className="rounded-lg border border-warn bg-panel-2 p-3 text-sm text-warn">
          Built-in AI filtering is bypassed by this block's user-authored inner workplace.
          Configuration below is inactive; the existing inner flow runs instead.
        </p>
      )}
      <p className="text-xs text-muted">
        Keeps original items unchanged, including mixed-topic items with relevant content. Filtering
        does not rewrite evidence or approve requirements. Missing requested fields are flagged for
        review.
      </p>
      <p className="text-xs text-muted">
        Uses the configured provider and default / fast models from Settings &gt; AI, without a
        separate setup. Scope from Settings: {scope.vehicleLine} /{" "}
        {scope.derivative || "any derivative"} / {scope.market}.
      </p>
      <fieldset disabled={bypassed} className="flex min-w-0 flex-col gap-4 disabled:opacity-60">
        <Field
          label="Preset"
          help="Selecting a preset does not change your edits. Apply replaces only criterion, include, exclude and examples."
          error={error}
        >
          {(id) => (
            <Select
              id={id}
              value={preset}
              onChange={(value) => setPreset(value as FilterPreset)}
              options={[
                { value: "custom", label: "Custom (preserve edits)" },
                { value: "customer-facing", label: "Customer-facing" },
                { value: "all-relevant", label: "All relevant context" },
              ]}
            />
          )}
        </Field>
        <Button
          disabled={bypassed || preset === "custom"}
          onClick={() => {
            try {
              setError(
                dataflowStore
                  .getState()
                  .setParams(block.id, applyFilterPreset(block.params, preset)),
              );
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }}
        >
          Apply preset
        </Button>
        {BLOCK_SPECS.ai_filter.params.map((spec) => (
          <ParamField key={spec.key} block={block} spec={spec} />
        ))}
      </fieldset>
      <p className="text-xs text-muted">
        Confidence is a model self-assessment, not a calibrated probability. Below the threshold,
        items need review. With Keep unsure enabled, uncertain items are forwarded for review;
        otherwise they are held. Original evidence and supporting context remain preserved in the
        saved report.
      </p>
    </div>
  );
}
