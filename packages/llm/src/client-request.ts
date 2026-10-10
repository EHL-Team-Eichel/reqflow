import { z } from "zod";

export const Request = z.object({
  prompt: z.string().min(1),
  system: z.string().optional(),
  tier: z.enum(["default", "fast"]).optional(),
});

/** Race even injected transports that ignore AbortSignal; always remove the listener. */
export async function cancellable<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return work();
  let listener: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    const value = await Promise.race([work(), aborted]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener("abort", listener);
  }
}
