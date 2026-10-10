import { describe, expect, it } from "vitest";
import { IPC_INVOKE_CHANNELS, IPC_INVOKE_METHODS, ipcChannel } from "./ipc";

describe("IPC contract", () => {
  it("derives one namespaced channel per method, without duplicates", () => {
    const count = Object.values(IPC_INVOKE_METHODS).reduce((n, ms) => n + ms.length, 0);
    expect(IPC_INVOKE_CHANNELS.size).toBe(count);
    expect(IPC_INVOKE_CHANNELS.has(ipcChannel("requirements", "decide"))).toBe(true);
    for (const ch of IPC_INVOKE_CHANNELS) expect(ch).toMatch(/^reqflow:[a-z]+\.[A-Za-z]+$/);
  });
});
