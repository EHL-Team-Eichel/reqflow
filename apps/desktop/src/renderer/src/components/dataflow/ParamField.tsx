import { useState } from "react";
import { Field } from "@/components/ui/Field";
import {
  TextInput,
  TextArea,
  NumberInput,
  Slider,
  Select,
  ChipSelect,
  Toggle,
  ListEditor,
} from "@/components/ui/controls";
import { Button } from "@/components/ui/Button";
import { dataflowStore } from "./store";
import { api, ReqflowError } from "@/lib/api";
import { useSettings } from "@/lib/settings";
import type { ParamSpec, WorkflowBlock, FileRef } from "@reqflow/core";

export function ParamField({ block, spec }: { block: WorkflowBlock; spec: ParamSpec }) {
  const [error, setError] = useState<string | null>(null);
  const settings = useSettings((s) => s.settings);

  const val = block.params[spec.key];

  const handleChange = (newValue: unknown) => {
    const err = dataflowStore
      .getState()
      .setParams(block.id, { ...block.params, [spec.key]: newValue });
    setError(err);
  };

  let help = spec.help;
  if (spec.type === "select" && val === "global") {
    if (spec.key === "market") {
      help = `From Settings: ${settings.defaultScope.market}`;
    } else if (spec.key === "vehicle") {
      help = `From Settings: ${settings.defaultScope.vehicleLine}`;
    }
  }

  const renderControl = (id: string) => {
    switch (spec.type) {
      case "text":
        return (
          <TextInput
            id={id}
            value={(val as string) ?? spec.default}
            onChange={handleChange}
            placeholder={spec.placeholder}
            maxLength={spec.maxLength}
          />
        );
      case "textarea":
        return (
          <TextArea
            id={id}
            value={(val as string) ?? spec.default}
            onChange={handleChange}
            placeholder={spec.placeholder}
            maxLength={spec.maxLength}
          />
        );
      case "number":
        return (
          <NumberInput
            id={id}
            value={(val as number) ?? spec.default}
            onChange={handleChange}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            unit={spec.unit}
          />
        );
      case "slider":
        return (
          <Slider
            id={id}
            value={(val as number) ?? spec.default}
            onChange={handleChange}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            unit={spec.unit}
          />
        );
      case "select":
        return (
          <Select
            id={id}
            value={(val as string) ?? spec.default}
            onChange={handleChange}
            options={spec.options}
          />
        );
      case "multiselect":
        return (
          <ChipSelect
            id={id}
            value={(val as string[]) ?? spec.default}
            onChange={handleChange}
            options={spec.options}
          />
        );
      case "toggle":
        return <Toggle id={id} value={(val as boolean) ?? spec.default} onChange={handleChange} />;
      case "list":
        return (
          <ListEditor
            id={id}
            value={(val as string[]) ?? spec.default}
            onChange={handleChange}
            minItems={spec.minItems}
            maxItems={spec.maxItems}
            itemPlaceholder={spec.itemPlaceholder}
            itemOptions={spec.itemOptions}
          />
        );
      case "file": {
        const fileRef = val as FileRef | null;
        return (
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm text-ink">
              {fileRef ? fileRef.name : "No file chosen"}
            </span>
            <div className="flex gap-2">
              <Button
                id={id}
                variant={fileRef ? "secondary" : "primary"}
                onClick={async () => {
                  try {
                    const res = await api.files.import();
                    if (res) {
                      handleChange({ fileId: res.id, name: res.name });
                    }
                  } catch (e) {
                    if (e instanceof ReqflowError && e.code === "not_implemented") {
                      setError("File import isn't built yet (WS1/WS5).");
                    } else {
                      setError(e instanceof Error ? e.message : "Importing the file failed.");
                    }
                  }
                }}
              >
                Choose file…
              </Button>
              {fileRef && (
                <Button variant="danger" onClick={() => handleChange(null)}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        );
      }
      default:
        return null;
    }
  };

  if (spec.type === "toggle") {
    // Label and switch on one row.
    const id = `param-${block.id}-${spec.key}`;
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={id} className="text-xs font-medium text-muted">
            {spec.label}
          </label>
          {renderControl(id)}
        </div>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <Field label={spec.label} error={error} help={help}>
      {(id) => renderControl(id)}
    </Field>
  );
}
