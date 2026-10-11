import type { BlockImplementation } from "@reqflow/engine";
import { analyticsBlock } from "./analytics";

// Owner: WS9 — the Analytics block: pass inputs on; the analytics view computes the charts.
export const analyticsImplementations: BlockImplementation<"analytics">[] = [analyticsBlock];
