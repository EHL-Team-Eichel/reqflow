import type { BlockImplementation } from "@reqflow/engine";
import { addToCarBlock } from "./add-to-car";

// Owner: WS7 — the Add to Car agents: analysts, synthesizer, architect, critic and judge turn the
// priority inputs (with context inputs as background) into requirements with confidence scores,
// handed to ctx.car.add; the thought process goes to ctx.car.saveReasoning.
export const addToCarImplementations: BlockImplementation<"add_to_car">[] = [addToCarBlock];
