import type { BlockImplementation } from "@reqflow/engine";
import { rawBlock } from "./raw";

export { parseResearchJson } from "./research-json";

// Owner: WS5 — Excel/CSV/Research JSON upload or SQLite query → one unified data stream.
export const rawImplementations: BlockImplementation<"raw">[] = [rawBlock];
