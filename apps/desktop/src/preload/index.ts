import {
  IPC_EVENTS,
  IPC_INVOKE_CHANNELS,
  type IpcResult,
  type ReqflowBridge,
} from "@reqflow/core/ipc";
import type { WorkflowRun } from "@reqflow/core";
import { contextBridge, ipcRenderer } from "electron";

// The renderer gets exactly this — no Node, no raw ipcRenderer. Keep it minimal; the typed client
// lives in the renderer (src/renderer/src/lib/api.ts).
const bridge: ReqflowBridge = {
  invoke(channel, ...args) {
    if (!IPC_INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`Blocked IPC channel "${channel}"`));
    }
    return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<unknown>>;
  },
  onRunUpdate(listener) {
    const handler = (_event: unknown, run: WorkflowRun) => listener(run);
    ipcRenderer.on(IPC_EVENTS.runUpdate, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.runUpdate, handler);
  },
};

contextBridge.exposeInMainWorld("reqflowBridge", bridge);
