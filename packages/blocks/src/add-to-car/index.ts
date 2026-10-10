import type { BlockImplementation } from "@reqflow/engine";
import { addToCarBlock } from "./add-to-car";

// Owner: WS7 — the Add to Car block: sort what arrives into themes (deterministic splitter),
// derive requirements; the input port it arrives on sets the ranking. Hands them to ctx.car.add
// (WS1 stores them for the Car page).
export const addToCarImplementations: BlockImplementation<"add_to_car">[] = [addToCarBlock];
