import type { BlockImplementation } from "@reqflow/engine";

// Owner: WS7 — the AI Splitter block: route every item to one branch (one output per branch).
// "Split by: Priority" uses WS8's scoring from ../prioritization.
export const aiSplitterImplementations: BlockImplementation<"ai_splitter">[] = [];
