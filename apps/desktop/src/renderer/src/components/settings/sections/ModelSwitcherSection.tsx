import { useState, useMemo } from "react";
import { cx } from "@/lib/cx";
import { Button } from "@/components/ui/Button";
import { Segmented } from "../Segmented";
import {
  useVehicleStore,
  getActiveVehicle,
} from "@/components/car/models/vehicleStore";
import {
  VEHICLE_MODELS,
  searchVehicleModels,
} from "@/components/car/models/registry";
import type { PowertrainType } from "@/components/car/models/types";

const POWERTRAIN_OPTIONS: { value: PowertrainType; label: string }[] = [
  { value: "gasoline", label: "Gasoline" },
  { value: "hybrid", label: "Hybrid" },
  { value: "electric", label: "Electric" },
  { value: "h2", label: "Hydrogen (H2)" },
];

const CATEGORIES = [
  { id: "all", label: "All models" },
  { id: "m", label: "BMW M" },
  { id: "coupe", label: "Coupés" },
  { id: "sedan", label: "Sedans" },
  { id: "suv", label: "SAV / SUVs" },
  { id: "touring", label: "Touring" },
  { id: "race", label: "Aero & GT" },
] as const;

const POWERTRAIN_DESCRIPTIONS: Record<PowertrainType, string> = {
  gasoline:
    "TwinPower Turbo combustion engine, mechanical transmission, prop shaft, rear differential, fuel tank and tuned exhaust system with tailpipes.",
  hybrid:
    "TwinPower Turbo internal combustion engine coupled with electric motor, high-voltage hybrid battery, transmission and exhaust system.",
  electric:
    "Dual front and rear electric drive units, high-capacity underfloor battery pack, power electronics inverter and charge port.",
  h2:
    "Fuel cell power system, dual 700-bar carbon-composite hydrogen cylinders, buffer battery, rear electric motor and zero-emission water vapor exhaust.",
};

const PART_LABELS: Record<string, string> = {
  gt_wing: "Swan-neck GT Wing",
  duckbill_spoiler: "Duckbill Rear Spoiler",
  rear_spoiler: "Aerodynamic Spoiler",
  front_splitter: "Carbon Front Splitter",
  canards: "Aero Dive Canards",
  widebody_flares: "Widebody Arches",
  rear_diffuser: "Aero Rear Diffuser",
  roll_cage: "Safety Roll Cage",
  roof_rails: "Aluminium Roof Rails",
  skid_plates: "Underbody Skid Plates",
  convertible_roof: "Convertible Soft-Top",
  hood_vents: "Bonnet Heat Extractors",
  exhaust_system: "Exhaust System & Tips",
  fuel_system: "Fuel Tank & Delivery",
  h2_storage: "700-bar Hydrogen Tanks",
};

export function ModelSwitcherSection() {
  const {
    selectedModelId,
    powertrain,
    searchQuery,
    selectedCategory,
    selectModel,
    setPowertrain,
    setSearchQuery,
    setSelectedCategory,
  } = useVehicleStore();

  const [localSearch, setLocalSearch] = useState(searchQuery);

  const active = useMemo(() => getActiveVehicle(), [selectedModelId, powertrain]);

  const filtered = useMemo(() => {
    return searchVehicleModels(localSearch, selectedCategory);
  }, [localSearch, selectedCategory]);

  return (
    <div className="flex flex-col gap-6" data-testid="model-switcher-section">
      <div>
        <h2 className="text-lg font-semibold text-ink">Model switcher</h2>
        <p className="mt-1 text-sm text-muted">
          Choose from BMW models, configure powertrain architecture, and examine model-specific
          aerodynamic and chassis parts in the 3D viewer.
        </p>
      </div>

      {/* Active Model Summary Card */}
      <div className="rounded-xl border border-line bg-panel p-5 shadow-xs">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded bg-brand/10 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-brand">
                Active Vehicle
              </span>
              <span className="text-xs font-medium text-muted">
                {active.model.year} · {active.model.chassisCode} · {active.model.bodyType}
              </span>
            </div>
            <h3 className="mt-1.5 text-xl font-bold text-ink">{active.model.name}</h3>
            <p className="mt-1 text-sm text-muted">{active.model.description}</p>
          </div>
          <a
            href={`https://sketchfab.com/3d-models/${active.model.sketchfabUid}`}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-xs text-brand hover:underline"
          >
            Sketchfab UID: {active.model.sketchfabUid.slice(0, 8)}… ↗
          </a>
        </div>

        {/* Vehicle Dimensions & Special Parts */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 border-t border-line/60 pt-4">
          <div>
            <div className="text-xs text-muted">Length</div>
            <div className="font-semibold text-ink">{active.model.dimensions.length} m</div>
          </div>
          <div>
            <div className="text-xs text-muted">Width</div>
            <div className="font-semibold text-ink">{active.model.dimensions.width} m</div>
          </div>
          <div>
            <div className="text-xs text-muted">Height</div>
            <div className="font-semibold text-ink">{active.model.dimensions.height} m</div>
          </div>
          <div>
            <div className="text-xs text-muted">Wheelbase</div>
            <div className="font-semibold text-ink">{active.model.dimensions.wheelbase} m</div>
          </div>
        </div>

        {/* Model-specific parts */}
        {active.model.specialParts.length > 0 && (
          <div className="mt-4 border-t border-line/60 pt-3">
            <div className="text-xs font-medium text-muted mb-2">Model-Specific Equipment:</div>
            <div className="flex flex-wrap gap-1.5">
              {active.model.specialParts.map((sp) => (
                <span
                  key={sp}
                  className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs text-ink"
                >
                  {PART_LABELS[sp] || sp}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Powertrain Selection */}
      <div className="rounded-xl border border-line bg-panel p-5 shadow-xs">
        <div className="mb-2">
          <label className="text-sm font-semibold text-ink">Powertrain Configuration</label>
          <p className="text-xs text-muted">
            Select the drive technology. In the 3D car viewer, the engine bay, underfloor and exhaust
            architecture adjust dynamically to your choice.
          </p>
        </div>
        <div className="mt-3">
          <Segmented
            options={POWERTRAIN_OPTIONS}
            value={powertrain}
            onChange={(pt) => setPowertrain(pt as PowertrainType)}
            testIdPrefix="powertrain-"
          />
        </div>
        <div className="mt-3 rounded-lg bg-panel-2 p-3 text-xs text-muted">
          <span className="font-semibold text-ink">Architecture note: </span>
          {POWERTRAIN_DESCRIPTIONS[powertrain]}
        </div>
      </div>

      {/* Search & Filter Controls */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-sm font-semibold text-ink">
            BMW Model Catalog ({VEHICLE_MODELS.length} models)
          </h3>
          <span className="text-xs text-muted">{filtered.length} matching</span>
        </div>

        <div className="relative">
          <input
            type="search"
            value={localSearch}
            onChange={(e) => {
              setLocalSearch(e.target.value);
              setSearchQuery(e.target.value);
            }}
            placeholder="Search by model name, chassis (e.g. G82, E46, G87), year, or series…"
            data-testid="model-search-input"
            className={cx(
              "w-full rounded-lg border border-line bg-panel px-3.5 py-2 text-sm text-ink placeholder:text-muted/70",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
            )}
          />
        </div>

        {/* Category Filter Pills */}
        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setSelectedCategory(cat.id)}
              className={cx(
                "rounded-lg px-2.5 py-1 text-xs font-medium transition",
                selectedCategory === cat.id
                  ? "bg-brand text-white shadow-xs"
                  : "border border-line bg-panel text-muted hover:text-ink hover:bg-panel-2",
              )}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {/* Model Cards Grid */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {filtered.map((item) => {
          const isSelected = item.id === selectedModelId;
          return (
            <div
              key={item.id}
              onClick={() => selectModel(item.id)}
              data-testid={`model-card-${item.id}`}
              className={cx(
                "flex cursor-pointer flex-col justify-between rounded-xl border p-4 transition",
                isSelected
                  ? "border-brand bg-brand-soft/40 ring-1 ring-brand"
                  : "border-line bg-panel hover:border-brand/40 hover:bg-panel-2/70",
              )}
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded bg-panel-2 px-2 py-0.5 text-xs font-semibold text-muted">
                    {item.year} · {item.chassisCode}
                  </span>
                  {isSelected ? (
                    <span className="rounded-full bg-brand px-2 py-0.5 text-xs font-semibold text-white">
                      Selected
                    </span>
                  ) : (
                    <span className="text-xs text-muted uppercase">{item.bodyType}</span>
                  )}
                </div>
                <h4 className="mt-2 text-base font-semibold text-ink leading-snug">{item.name}</h4>
                <p className="mt-1 line-clamp-2 text-xs text-muted">{item.description}</p>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-line/40 pt-3">
                <div className="flex flex-wrap gap-1">
                  {item.specialParts.slice(0, 3).map((sp) => (
                    <span key={sp} className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted">
                      {PART_LABELS[sp] || sp}
                    </span>
                  ))}
                  {item.specialParts.length > 3 && (
                    <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted">
                      +{item.specialParts.length - 3} more
                    </span>
                  )}
                </div>
                <Button
                  size="sm"
                  variant={isSelected ? "secondary" : "ghost"}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectModel(item.id);
                  }}
                >
                  {isSelected ? "Active" : "Select"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
