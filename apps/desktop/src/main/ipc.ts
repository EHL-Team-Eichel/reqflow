import { IPC_INVOKE_METHODS, ipcChannel, type ReqflowHandlers } from "@reqflow/core/ipc";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { dispatch } from "./dispatch";

/** Registers one `ipcMain.handle` per contract method. Calls from untrusted frames are refused. */
export function registerIpc(
  handlers: ReqflowHandlers,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  for (const [namespace, methods] of Object.entries(IPC_INVOKE_METHODS)) {
    for (const method of methods) {
      ipcMain.handle(ipcChannel(namespace, method), (event, ...args: unknown[]) => {
        if (!isTrustedSender(event)) {
          return {
            ok: false,
            error: { code: "forbidden", message: "IPC call from an untrusted frame" },
          };
        }
        return dispatch(handlers, namespace, method, args);
      });
    }
  }
}
