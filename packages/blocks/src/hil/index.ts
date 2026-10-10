import type { BlockImplementation } from "@reqflow/engine";
import { hilBlock } from "./hil";

// Owner: WS1 — the HIL block: pause the run until the reviewer is done, then pass the items on.
export const hilImplementations: BlockImplementation<"hil">[] = [hilBlock];
