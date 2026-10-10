import { useState } from "react";
import { CarViewer, type CameraPreset, type CarView } from "@/components/car/CarViewer";
import { PartPanel } from "@/components/car/PartPanel";
import { useCarRequirements } from "@/components/car/useCarRequirements";
import { Segmented } from "@/components/settings/Segmented";
import { Button } from "@/components/ui/Button";
import { MStripe } from "@/components/ui/MStripe";
import { Panel } from "@/components/ui/Panel";
import { api } from "@/lib/api";
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
  const [view, setView] = useState<CarView>("exterior");
  const [selected, setSelected] = useState<string | null>(null);
  const [preset, setPreset] = useState<CameraPreset>("front");
  const [presetNonce, setPresetNonce] = useState(0);
  const data = useCarRequirements();
  const reset = useReset(data.reload);

  const emptyHint =
    data.error ??
    (data.loading
      ? "Loading requirements…"
      : "Run a flow with an Add to Car block to see its requirements here.");

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
          <CarViewer
            counts={data.counts}
            selected={selected}
            view={view}
            preset={preset}
            presetNonce={presetNonce}
            onSelect={setSelected}
          />
          <p className="pointer-events-none absolute bottom-3 left-4 text-xs text-muted">
            BMW-inspired sketch · drag to turn, scroll to zoom, click any part
          </p>
        </div>
      </Panel>
      <Panel
        title="Parts & requirements"
        actions={
          <Button
            size="sm"
            variant="danger"
            data-testid="car-reset"
            disabled={data.total === 0 || reset.busy}
            onClick={reset.ask}
          >
            Reset
          </Button>
        }
        className="w-[26rem] shrink-0"
        testId="car-side"
      >
        {reset.asking && (
          <div
            role="alertdialog"
            aria-label="Remove all requirements"
            data-testid="car-reset-confirm"
            className="m-3 rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm"
          >
            <p className="text-ink">
              Remove all {data.total} requirement{data.total === 1 ? "" : "s"} from the car?
            </p>
            <p className="mt-1 text-xs text-muted">
              Their history stays in the audit trail, and their IDs won't be given out again.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={reset.cancel} disabled={reset.busy}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                data-testid="car-reset-confirm-button"
                onClick={() => void reset.confirm()}
                disabled={reset.busy}
              >
                {reset.busy ? "Removing…" : "Remove all"}
              </Button>
            </div>
          </div>
        )}
        {reset.message && (
          <p
            role={reset.failed ? "alert" : "status"}
            data-testid="car-reset-message"
            className={`px-4 pt-3 text-xs ${reset.failed ? "text-danger" : "text-muted"}`}
          >
            {reset.message}
          </p>
        )}
        <PartPanel
          selected={selected}
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

/** Reset on the Car page: ask in place, then remove every requirement (`requirements.reset`). */
function useReset(reload: () => Promise<void>) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      const { removed } = await api.requirements.reset();
      setFailed(false);
      setMessage(`Removed ${removed} requirement${removed === 1 ? "" : "s"}.`);
      setAsking(false);
    } catch (e) {
      setFailed(true);
      setMessage(`Reset failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      await reload();
    }
  };

  return {
    asking,
    busy,
    message,
    failed,
    ask: () => {
      setMessage(null);
      setAsking(true);
    },
    cancel: () => setAsking(false),
    confirm,
  };
}
