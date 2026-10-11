import type { RequirementDetail } from "@reqflow/core/ipc";
import {
  fixtureFindings,
  fixtureRecords,
  fixtureRequirements,
  fixtureSources,
} from "@reqflow/core/fixtures";
import { describe, expect, it, vi } from "vitest";
import { loadRequirementDetail, type DetailState } from "./detail-loader";

const requirement = fixtureRequirements[0]!;
const detail: RequirementDetail = {
  requirement,
  findings: fixtureFindings,
  sources: fixtureSources,
  records: fixtureRecords,
  versions: [requirement],
};
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("requirement detail loading", () => {
  it("loads the exact clicked id and returns validated evidence and version data", async () => {
    const publish = vi.fn<(state: DetailState) => void>();
    const get = vi.fn(async () => detail);
    loadRequirementDetail(requirement.id, get, publish);
    expect(publish).toHaveBeenCalledWith({ status: "loading" });
    await flush();
    expect(get).toHaveBeenCalledWith(requirement.id);
    expect(publish).toHaveBeenLastCalledWith({ status: "ready", detail });
  });

  it("exposes IPC failures without substituting sample evidence", async () => {
    const publish = vi.fn();
    loadRequirementDetail(
      requirement.id,
      async () => {
        throw new Error("Requirement not found");
      },
      publish,
    );
    await flush();
    expect(publish).toHaveBeenLastCalledWith({ status: "error", message: "Requirement not found" });
  });

  it("rejects incomplete detail payloads", async () => {
    const publish = vi.fn();
    loadRequirementDetail(
      requirement.id,
      async () => ({ ...detail, records: undefined }) as unknown as RequirementDetail,
      publish,
    );
    await flush();
    expect(publish).toHaveBeenLastCalledWith({
      status: "error",
      message: "The requirement details are incomplete or invalid. Please retry.",
    });
  });

  it("rejects evidence returned for another requirement", async () => {
    const publish = vi.fn();
    loadRequirementDetail("REQ-F70-EU-999", async () => detail, publish);
    await flush();
    expect(publish.mock.lastCall?.[0].status).toBe("error");
  });

  it("ignores a late successful reply after closing", async () => {
    const publish = vi.fn();
    let resolve!: (value: RequirementDetail) => void;
    const promise = new Promise<RequirementDetail>((r) => {
      resolve = r;
    });
    const cancel = loadRequirementDetail(requirement.id, () => promise, publish);
    await flush();
    cancel();
    resolve(detail);
    await flush();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("ignores stale errors when a retry has already succeeded", async () => {
    const publish = vi.fn();
    let reject!: (error: Error) => void;
    const promise = new Promise<RequirementDetail>((_r, fail) => {
      reject = fail;
    });
    const cancel = loadRequirementDetail(requirement.id, () => promise, publish);
    await flush();
    cancel();
    loadRequirementDetail(requirement.id, async () => detail, publish);
    await flush();
    reject(new Error("Old request failed"));
    await flush();
    expect(publish).toHaveBeenLastCalledWith({ status: "ready", detail });
  });
});
