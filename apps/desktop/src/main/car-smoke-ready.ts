export interface CarSmokeState {
  modelId: string | null;
  powertrain: string | null;
  canvasCount: number;
  loading: boolean;
  failed: boolean;
}

/** Imported source meshes load asynchronously; a route being loaded is not a rendered scene. */
export async function waitForCarScene(
  read: () => Promise<CarSmokeState>,
  expected: { modelId?: string; powertrain?: string } = {},
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 30000);
  do {
    const state = await read();
    if (state.failed) throw new Error("The Car scene reported a source-load or rendering error.");
    if (
      state.canvasCount === 1 &&
      !state.loading &&
      (!expected.modelId || state.modelId === expected.modelId) &&
      (!expected.powertrain || state.powertrain === expected.powertrain)
    )
      return;
    if (now() >= deadline) break;
    await sleep(options.intervalMs ?? 100);
  } while (now() <= deadline);
  throw new Error(
    "Timed out waiting for the selected Car model and powertrain to render exactly one canvas.",
  );
}
