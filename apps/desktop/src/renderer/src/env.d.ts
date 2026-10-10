import type { ReqflowBridge } from "@reqflow/core/ipc";

declare global {
  interface Window {
    /** Exposed by the preload script. Use `api` from "@/lib/api" instead of calling this directly. */
    reqflowBridge: ReqflowBridge;
  }
}
