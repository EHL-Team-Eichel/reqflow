import {
  IPC_INVOKE_METHODS,
  ipcChannel,
  type ReqflowApi,
  type ReqflowBridge,
} from "@reqflow/core/ipc";

/** Thrown by every `api.*` call that fails in the main process. `code` is machine-readable. */
export class ReqflowError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ReqflowError";
  }
}

type InvokeClient = {
  [N in keyof typeof IPC_INVOKE_METHODS]: {
    [M in (typeof IPC_INVOKE_METHODS)[N][number]]: M extends keyof ReqflowApi[N]
      ? ReqflowApi[N][M]
      : never;
  };
};

/** Builds the typed API from the bridge; a method missing from IPC_INVOKE_METHODS is a type error here. */
export function createApi(bridge: ReqflowBridge): ReqflowApi {
  const client = Object.fromEntries(
    Object.entries(IPC_INVOKE_METHODS).map(([ns, methods]) => [
      ns,
      Object.fromEntries(
        methods.map((method) => [
          method,
          async (...args: unknown[]) => {
            const result = await bridge.invoke(ipcChannel(ns, method), ...args);
            if (!result.ok) {
              throw new ReqflowError(result.error.code, result.error.message, result.error.details);
            }
            return result.value;
          },
        ]),
      ),
    ]),
  ) as InvokeClient;
  return { ...client, runs: { ...client.runs, onUpdate: bridge.onRunUpdate } };
}
