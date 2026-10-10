import { describe, expect, it, vi } from "vitest";
import { Limiter } from "./http";

describe("Limiter", () => {
  it("never more than N concurrent", async () => {
    const limiter = new Limiter(2);
    let active = 0;
    let maxActive = 0;
    const task = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    };
    await Promise.all([limiter.run(task), limiter.run(task), limiter.run(task), limiter.run(task)]);
    expect(maxActive).toBe(2);
  });

  it("queued abort", async () => {
    const limiter = new Limiter(1);
    const controller = new AbortController();
    let executed = false;
    const p1 = limiter.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const p2 = limiter.run(async () => {
      executed = true;
    }, controller.signal);
    controller.abort(new Error("aborted"));
    await expect(p2).rejects.toThrow("aborted");
    expect(executed).toBe(false);
    await p1;
  });
});
