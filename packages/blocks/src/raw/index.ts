import type { BlockImplementation } from "@reqflow/engine";
import { rawBlock } from "./raw";

// Owner: WS5 — the Raw block: Excel/CSV upload or SQLite query → one unified data stream.
export const rawImplementations: BlockImplementation<"raw">[] = [rawBlock];
