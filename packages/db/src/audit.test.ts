import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { Actor, AuditEventInput } from "@reqflow/core";
import { createDatabase } from "./db";
import { SqliteAuditLogger } from "./audit";

// Synthetic actors and entities only.
const human: Actor = { type: "human", userId: "pm-synthetic", name: "Synthetic PM" };
const ai: Actor = { type: "ai", component: "add_to_car", model: "synthetic-model" };
const system: Actor = { type: "system", component: "engine" };

describe("SqliteAuditLogger.list", () => {
  let db: DatabaseSync;
  let audit: SqliteAuditLogger;
  const record = (actor: Actor, entityId: string, at?: string) => {
    if (at) vi.setSystemTime(new Date(at));
    const input: AuditEventInput = {
      actor,
      action: "requirement.edited",
      entityType: "requirement",
      entityId,
    };
    return audit.recordSync(input);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T08:00:00.000Z"));
    db = createDatabase(":memory:");
    audit = new SqliteAuditLogger(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it("filters on the actor type in SQL, also together with a limit", async () => {
    record(human, "e1");
    record(ai, "e2");
    record(system, "e3");
    record(human, "e4");
    record(ai, "e5");
    record(human, "e6");
    const ids = async (filter: Parameters<typeof audit.list>[0]) =>
      (await audit.list(filter)).map((e) => e.entityId);
    expect(await ids({ actorType: "human" })).toEqual(["e1", "e4", "e6"]);
    expect(await ids({ actorType: "ai" })).toEqual(["e2", "e5"]);
    expect(await ids({ actorType: "system" })).toEqual(["e3"]);
    // The limit applies after the actor filter: the newest two human events.
    expect(await ids({ actorType: "human", limit: 2 })).toEqual(["e4", "e6"]);
    expect(await ids({ actorType: "ai", entityId: "e5" })).toEqual(["e5"]);
  });

  it("keeps insertion order for equal timestamps", async () => {
    for (const id of ["a", "b", "c", "d", "e"]) record(human, id); // all at the same instant
    expect((await audit.list()).map((e) => e.entityId)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("a limit returns the newest events, oldest first", async () => {
    record(human, "t3", "2026-10-11T08:00:03.000Z");
    record(human, "t1", "2026-10-11T08:00:01.000Z"); // recorded late, but older
    record(human, "t4a", "2026-10-11T08:00:04.000Z");
    record(human, "t4b", "2026-10-11T08:00:04.000Z");
    record(human, "t2", "2026-10-11T08:00:02.000Z");
    const ids = async (limit?: number) => (await audit.list({ limit })).map((e) => e.entityId);
    expect(await ids()).toEqual(["t1", "t2", "t3", "t4a", "t4b"]);
    expect(await ids(2)).toEqual(["t4a", "t4b"]);
    expect(await ids(3)).toEqual(["t3", "t4a", "t4b"]);
    expect(await ids(1)).toEqual(["t4b"]);
    expect(await ids(10)).toEqual(["t1", "t2", "t3", "t4a", "t4b"]);
  });
});
