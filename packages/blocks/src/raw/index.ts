import type { BlockImplementation } from "@reqflow/engine";

// Owner: WS5 — the Raw block: Excel upload or database → one unified data stream.
// One file per concern (e.g. ./excel.ts, ./database.ts) + colocated *.test.ts; export the block here.
export const rawImplementations: BlockImplementation<"raw">[] = [];
