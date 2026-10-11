import type { BlockImplementation } from "@reqflow/engine";
import { aiFilterBlock } from "./ai-filter";

export { aiFilterBlock } from "./ai-filter";
export const aiFilterImplementations: BlockImplementation<"ai_filter">[] = [aiFilterBlock];
