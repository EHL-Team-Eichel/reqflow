import type { PowertrainType } from "../models/types";
import { POWERTRAINS } from "./powertrains";

export function PowertrainSwitcher({
  value,
  onChange,
}: {
  value: PowertrainType;
  onChange: (value: PowertrainType) => void;
}) {
  return (
    <label className="absolute top-3 left-4 z-10 flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-sm shadow-sm">
      <span className="text-muted">Powertrain</span>
      <select
        data-testid="car-powertrain"
        value={value}
        onChange={(event) => onChange(event.target.value as PowertrainType)}
        className="rounded-md bg-panel text-ink focus-visible:outline-2 focus-visible:outline-brand"
      >
        {POWERTRAINS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
