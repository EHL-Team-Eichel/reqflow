import { fixtureAuditEvents } from "@reqflow/core/fixtures";
import type { AuditEvent } from "@reqflow/core";
import { describe, expect, it, vi } from "vitest";
import { actorLabel, filterAuditEvents, formatAuditValue, loadAuditEvents } from "./audit-view";

const event = fixtureAuditEvents.find((item) => item.entityType === "requirement")!;
const noFilters = { action: "", actorType: "", text: "" };
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("audit loading", () => {
  it("requests and validates the requirement scope with the 200 event limit", async () => {
    const publish = vi.fn();
    const list = vi.fn(async () => [event]);
    loadAuditEvents(event.entityId, list, publish);
    expect(publish).toHaveBeenCalledWith({ status: "loading" });
    await flush();
    expect(list).toHaveBeenCalledWith({
      entityId: event.entityId,
      entityType: "requirement",
      limit: 200,
    });
    expect(publish).toHaveBeenLastCalledWith({ status: "ready", events: [event] });
  });

  it("requests all entities globally and preserves an empty result", async () => {
    const publish = vi.fn();
    const list = vi.fn(async () => []);
    loadAuditEvents(undefined, list, publish);
    await flush();
    expect(list).toHaveBeenCalledWith({ limit: 200 });
    expect(publish).toHaveBeenLastCalledWith({ status: "ready", events: [] });
  });

  it.each([
    null,
    {},
    [event, { ...event, actor: { type: "human" } }],
    [{ ...event, at: "invalid" }],
  ])("rejects invalid array payload %# rather than showing a partial history", async (payload) => {
    const publish = vi.fn();
    loadAuditEvents(undefined, async () => payload, publish);
    await flush();
    expect(publish).toHaveBeenLastCalledWith({
      status: "error",
      message: "The audit events are incomplete or invalid. Please retry.",
    });
  });

  it.each([
    { ...event, entityId: "REQ-synthetic-other" },
    { ...event, entityType: "finding" },
  ])("rejects responses from a different scope %#", async (payload) => {
    const publish = vi.fn();
    loadAuditEvents(event.entityId, async () => [payload], publish);
    await flush();
    expect(publish.mock.lastCall?.[0]).toEqual({
      status: "error",
      message: "The returned audit events do not match this requirement. Please retry.",
    });
  });

  it("reports IPC rejection and synchronous errors", async () => {
    for (const list of [
      async () => {
        throw new Error("Audit unavailable");
      },
      () => {
        throw new Error("Audit unavailable");
      },
    ]) {
      const publish = vi.fn();
      loadAuditEvents(undefined, list, publish);
      await flush();
      expect(publish).toHaveBeenLastCalledWith({ status: "error", message: "Audit unavailable" });
    }
  });

  it("provides an explicit fallback for non-Error failures", async () => {
    const publish = vi.fn();
    loadAuditEvents(
      undefined,
      async () => {
        throw null;
      },
      publish,
    );
    await flush();
    expect(publish).toHaveBeenLastCalledWith({
      status: "error",
      message: "Could not load audit events. Please retry.",
    });
  });

  it("does not dispatch IPC when cancelled before starting", async () => {
    const list = vi.fn(async () => [event]);
    const publish = vi.fn();
    loadAuditEvents(undefined, list, publish)();
    await flush();
    expect(list).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"])(
    "ignores stale %s replies after retry or unmount",
    async (outcome) => {
      let resolve!: (value: AuditEvent[]) => void;
      let reject!: (reason: Error) => void;
      const pending = new Promise<AuditEvent[]>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const publish = vi.fn();
      const cancel = loadAuditEvents(event.entityId, () => pending, publish);
      await flush();
      cancel();
      loadAuditEvents(undefined, async () => [], publish);
      await flush();
      if (outcome === "success") resolve([event]);
      else reject(new Error("Old request failed"));
      await flush();
      expect(publish).toHaveBeenCalledTimes(3);
      expect(publish).toHaveBeenLastCalledWith({ status: "ready", events: [] });
    },
  );
});

describe("audit filtering and presentation", () => {
  it("sorts by timestamp newest first with ascending id ties, without mutation", () => {
    const events = [
      { ...event, id: "aud_z", at: "2026-01-01T00:00:00Z" },
      { ...event, id: "aud_b", at: "2026-01-02T00:00:00.000Z" },
      { ...event, id: "aud_a", at: "2026-01-02T00:00:00Z" },
    ];
    const snapshot = structuredClone(events);
    expect(filterAuditEvents(Object.freeze(events), noFilters).map((item) => item.id)).toEqual([
      "aud_a",
      "aud_b",
      "aud_z",
    ]);
    expect(events).toEqual(snapshot);
  });

  it("combines action, actor and case-insensitive text filters across original details", () => {
    const synthetic: AuditEvent = {
      ...event,
      actor: { type: "human", name: "Synthetic Reviewer", userId: "synthetic-user", role: "PM" },
      action: "requirement.edited",
      rationale: "  Preserve this Reason\nexactly.  ",
      changes: [{ path: "targets", before: null, after: { metric: "Cabin Comfort" } }],
    };
    const events = [
      synthetic,
      { ...event, actor: { type: "system" as const, component: "engine" } },
    ];
    for (const text of [
      " reviewer ",
      "preserve",
      "CABIN COMFORT",
      "targets",
      "synthetic-user",
      synthetic.entityId,
      "null",
    ]) {
      expect(
        filterAuditEvents(events, { action: "requirement.edited", actorType: "human", text }),
      ).toEqual([synthetic]);
    }
    expect(filterAuditEvents(events, { ...noFilters, text: "not present" })).toEqual([]);
    expect(filterAuditEvents([synthetic], { ...noFilters, action: "requirement.viewed" })).toEqual(
      [],
    );
    expect(filterAuditEvents([synthetic], { ...noFilters, actorType: "ai" })).toEqual([]);
    expect(synthetic.rationale).toBe("  Preserve this Reason\nexactly.  ");
  });

  it("names every actor without inventing a human identity", () => {
    expect(actorLabel({ type: "human", name: "Reviewer", userId: "u", role: "PM" })).toBe(
      "Reviewer (u) / PM",
    );
    expect(actorLabel({ type: "human", name: "Reviewer", userId: "u" })).toBe("Reviewer (u)");
    expect(actorLabel({ type: "ai", component: "ai_filter", model: "synthetic-model" })).toBe(
      "ai_filter / synthetic-model",
    );
    expect(actorLabel({ type: "system", component: "engine" })).toBe("engine");
  });

  it("preserves strings and distinguishes absent, null, objects and unsupported JSON", () => {
    expect(formatAuditValue("  exact\ntext <b>  ")).toBe("  exact\ntext <b>  ");
    expect(formatAuditValue("")).toBe("");
    expect(formatAuditValue(undefined)).toBe("(Absent)");
    expect(formatAuditValue(null)).toBe("null");
    expect(formatAuditValue({ value: [null, false, 0] })).toBe(
      JSON.stringify({ value: [null, false, 0] }, null, 2),
    );
    expect(formatAuditValue(1n)).toBe('"1n"');
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(formatAuditValue(circular)).toContain("circular or unsupported");
  });
});
