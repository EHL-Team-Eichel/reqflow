import type { BlockImplementation } from "@reqflow/engine";
import { aiSplitterBlock } from "./ai-splitter";

export { aiSplitterBlock } from "./ai-splitter";
export const aiSplitterImplementations: BlockImplementation<"ai_splitter">[] = [aiSplitterBlock];
