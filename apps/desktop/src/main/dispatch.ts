import type { ApiError } from "@reqflow/core";
import type { IpcResult, ReqflowHandlers } from "@reqflow/core/ipc";
import { ZodError } from "zod";

/** Throw this from a handler to send a specific error code to the UI. */
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

export function toIpcError(err: unknown): ApiError["error"] {
  if (err instanceof ReqflowError) {
    return { code: err.code, message: err.message, details: err.details };
  }
  if (err instanceof ZodError) {
    return { code: "invalid_input", message: "Input failed validation", details: err.issues };
  }
  if (err instanceof Error) return { code: "internal", message: err.message };
  return { code: "internal", message: String(err) };
}

/** Pure (Electron-free) so it can be unit-tested: route one IPC call to its handler. */
export async function dispatch(
  handlers: ReqflowHandlers,
  namespace: string,
  method: string,
  args: unknown[],
): Promise<IpcResult<unknown>> {
  const ns = (handlers as unknown as Record<string, Record<string, unknown> | undefined>)[
    namespace
  ];
  const fn = ns?.[method];
  if (typeof fn !== "function") {
    return {
      ok: false,
      error: { code: "unknown_method", message: `No handler for ${namespace}.${method}` },
    };
  }
  try {
    return { ok: true, value: await fn.apply(ns, args) };
  } catch (err) {
    const error = toIpcError(err);
    if (error.code === "internal") console.error(`[ipc] ${namespace}.${method} failed:`, err);
    return { ok: false, error };
  }
}
