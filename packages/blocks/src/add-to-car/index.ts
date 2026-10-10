import type { BlockImplementation } from "@reqflow/engine";

// Owner: WS7 — the Add to Car block: turn what arrives into requirements; the input port it
// arrives on sets the ranking. Hands them to ctx.car.add (WS1 stores them for the Car page).
export const addToCarImplementations: BlockImplementation<"add_to_car">[] = [];
