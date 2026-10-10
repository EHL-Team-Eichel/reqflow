import { PowertrainSwitcher } from "@/components/car/modelSwitcher/PowertrainSwitcher";
import {
  availablePartIds,
  powertrainSubclasses,
  POWERTRAINS,
} from "@/components/car/modelSwitcher/powertrains";
import { useVehicleStore, getActiveVehicle } from "@/components/car/models/vehicleStore";
import { useState, useMemo } from "react";
import { CarViewer, type CameraPreset, type CarView } from "@/components/car/CarViewer";
import { PartPanel } from "@/components/car/PartPanel";
import { useCarRequirements } from "@/components/car/useCarRequirements";
import {
  initialMarkerMenu,
  menuGroup,
  menuPartIds,
  toggleMarkerMenu,
} from "@/components/car/markerMenu";
import { Segmented } from "@/components/settings/Segmented";
import { Button } from "@/components/ui/Button";
import { MStripe } from "@/components/ui/MStripe";
import { Panel } from "@/components/ui/Panel";
import { useSettings } from "@/lib/settings";

const VIEWS = [
  { value: "exterior", label: "Exterior" },
  { value: "interior", label: "Interior" },
] as const;
const PRESETS: { value: CameraPreset; label: string }[] = [
  { value: "front", label: "Front" },
  { value: "side", label: "Side" },
  { value: "rear", label: "Rear" },
  { value: "top", label: "Top" },
];

/**
 * The car: a 3D sketch of the vehicle where every part can be clicked to see the requirements on
 * it. The auto classifier decides which part a requirement belongs to; it never changes the
 * requirement itself.
 */
export function CarPage() {
  const scope = useSettings((s) => s.settings.defaultScope);
  const { selectedModelId, powertrain, setPowertrain } = useVehicleStore();
  const active = useMemo(() => getActiveVehicle(), [selectedModelId, powertrain]);
  const availableParts = availablePartIds(powertrain, active.model);
  const subclasses = powertrainSubclasses(powertrain, active.model);
  const [view, setView] = useState<CarView>("exterior");
  const [selected, setSelected] = useState<string | null>(null);
  const [markerMenu, setMarkerMenu] = useState(initialMarkerMenu);
  const [preset, setPreset] = useState<CameraPreset>("front");
  const [presetNonce, setPresetNonce] = useState(0);
  const data = useCarRequirements("app");
  const markerParts = selected ? [selected] : menuPartIds(markerMenu.active, subclasses);

  const onMenuToggle = (id: string) => {
    const next = toggleMarkerMenu(markerMenu, id);
    setMarkerMenu(next);
    setSelected(null);
    if (next.active) setView(menuGroup(next.active) === "exterior" ? "exterior" : "interior");
  };

  const emptyHint =
    data.error ??
    (data.loading
      ? "Loading requirements…"
      : "Run a flow with an Add to Car block to see requirements here.");

  return (
    <div className="flex h-full gap-2">
      <h1 className="sr-only">Car</h1>
      <Panel
        title={
          <span className="flex items-center gap-2.5">
            <MStripe variant="badge" />
            BMW {scope.vehicleLine}
            {scope.derivative ? ` ${scope.derivative}` : ""}
            <span className="text-sm font-normal text-muted">
              {scope.market} · {scope.horizonYears}-year horizon
            </span>
          </span>
        }
        actions={
          <>
            <Segmented options={VIEWS} value={view} onChange={setView} testIdPrefix="car-view-" />
            <div className="flex items-center gap-1">
              {PRESETS.map((p) => (
                <Button
                  key={p.value}
                  size="sm"
                  variant={preset === p.value ? "secondary" : "ghost"}
                  data-testid={`car-camera-${p.value}`}
                  onClick={() => {
                    setPreset(p.value);
                    setPresetNonce((n) => n + 1);
                  }}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </>
        }
        className="min-w-0 flex-1"
        testId="car-page"
      >
        <div className="relative h-full">
          <PowertrainSwitcher value={powertrain} onChange={setPowertrain} />
          <CarViewer
            modelId={selectedModelId}
            powertrain={powertrain}
            counts={data.counts}
            markerParts={markerParts}
            selected={selected}
            view={view}
            preset={preset}
            presetNonce={presetNonce}
            onSelect={setSelected}
          />
          <p className="pointer-events-none absolute bottom-3 left-4 text-xs text-muted">
            Sketch: {active.model.name} ·{" "}
            {POWERTRAINS.find((option) => option.value === powertrain)?.description} · schematic
            sketch · drag to turn, scroll to zoom, click any part
          </p>
        </div>
      </Panel>
      <Panel title="Parts & requirements" className="w-[26rem] shrink-0" testId="car-side">
        <PartPanel
          selected={selected}
          availableParts={availableParts}
          subclasses={subclasses}
          markerMenu={markerMenu}
          onMenuToggle={onMenuToggle}
          byPart={data.byPart}
          counts={data.counts}
          total={data.total}
          emptyHint={emptyHint}
          onSelect={setSelected}
        />
      </Panel>
    </div>
  );
}
