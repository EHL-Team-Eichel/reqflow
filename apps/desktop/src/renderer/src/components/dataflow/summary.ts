import { type WorkflowBlock, type ParamSpec } from "@reqflow/core";

export function summarizeParams(
  block: WorkflowBlock,
  scope: { vehicleLine: string; market: string },
  specParams: readonly ParamSpec[],
): string[] {
  const fromSettings: Record<string, string> = {
    vehicle: scope.vehicleLine,
    market: scope.market,
  };

  if (block.kind === "analytics") {
    const inputs = Array.isArray(block.params.inputs) ? block.params.inputs.length : 1;
    const phrases = String(block.params.phrases ?? "")
      .split("\n")
      .filter((p) => p.trim()).length;
    return [
      `${inputs} input${inputs === 1 ? "" : "s"}`,
      "rules, no AI",
      ...(phrases ? [`${phrases} tracked phrase${phrases === 1 ? "" : "s"}`] : []),
    ];
  }

  return specParams
    .filter((p): p is Extract<ParamSpec, { type: "select" }> => p.type === "select")
    .slice(0, 2)
    .map((p) => {
      const value = block.params[p.key];
      if (value === "global") return fromSettings[p.key] ?? "From Settings";
      return p.options.find((o) => o.value === value)?.label ?? String(value);
    });
}
