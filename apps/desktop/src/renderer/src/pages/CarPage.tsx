import { Panel } from "@/components/ui/Panel";
import { CarIcon } from "@/components/ui/icons";
import { MStripe } from "@/components/ui/MStripe";
import { useSettings } from "@/lib/settings";

/** Placeholder: the car and its requirements (WS3 builds the requirement list, review and audit here). */
export function CarPage() {
  const scope = useSettings((s) => s.settings.defaultScope);
  return (
    <Panel title="Car" className="h-full" testId="car-page">
      <h1 className="sr-only">Car</h1>
      <div className="grid h-full place-items-center p-8">
        <div className="flex flex-col items-center text-center">
          <CarIcon className="size-56 text-line-strong" strokeWidth={0.6} />
          <p className="flex items-center gap-2.5 text-lg font-medium">
            <MStripe variant="badge" />
            BMW {scope.vehicleLine}
            {scope.derivative ? ` ${scope.derivative}` : ""}
          </p>
          <p className="mt-1 text-sm text-muted">
            {scope.market} · {scope.horizonYears}-year horizon (from Settings)
          </p>
          <p className="mt-6 max-w-md text-sm text-muted">
            Requirements from the Add to Car blocks will appear here, ranked and linked to their
            evidence.
          </p>
        </div>
      </div>
    </Panel>
  );
}
