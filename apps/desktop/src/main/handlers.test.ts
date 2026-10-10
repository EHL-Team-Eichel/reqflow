import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BMW_DEFAULT_TEMPLATE } from "@reqflow/blocks";
import { DEFAULT_SETTINGS } from "@reqflow/core";
import { createFileStore } from "@reqflow/db";
import { createHandlers } from "./handlers";

describe("createHandlers (Tasks 1-4)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "reqflow-handlers-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const setup = () => {
    const files = createFileStore(join(tempDir, "uploads"));
    const handlers = createHandlers({
      dataDir: tempDir,
      files,
      pickFile: vi.fn().mockResolvedValue(null),
      appInfo: () => ({
        version: "0.1.0",
        platform: "darwin",
        dataDir: tempDir,
        isPackaged: false,
      }),
    });
    return { handlers, files };
  };

  it("handles settings.get and settings.save", async () => {
    const { handlers } = setup();

    const initial = await handlers.settings.get();
    expect(initial.scoring.thresholds.must).toBe(70);

    const updated = await handlers.settings.save({
      ...initial,
      scoring: { ...initial.scoring, thresholds: { ...initial.scoring.thresholds, must: 85 } },
    });
    expect(updated.scoring.thresholds.must).toBe(85);

    const reloaded = await handlers.settings.get();
    expect(reloaded.scoring.thresholds.must).toBe(85);
  });

  it("handles workflows CRUD", async () => {
    const { handlers } = setup();

    expect(await handlers.workflows.list()).toHaveLength(0);

    const saved = await handlers.workflows.save({
      name: "BMW Flow",
      scope: DEFAULT_SETTINGS.defaultScope,
      blocks: BMW_DEFAULT_TEMPLATE.graph.blocks,
      edges: BMW_DEFAULT_TEMPLATE.graph.edges,
    });
    expect(saved.id).toMatch(/^wf_/);

    const list = await handlers.workflows.list();
    expect(list).toHaveLength(1);

    const fetched = await handlers.workflows.get(saved.id);
    expect(fetched.name).toBe("BMW Flow");

    await handlers.workflows.remove(saved.id);
    expect(await handlers.workflows.list()).toHaveLength(0);
  });

  it("serves read-only requirements and audit fixtures", async () => {
    const { handlers } = setup();

    const reqs = await handlers.requirements.list();
    expect(reqs.length).toBeGreaterThan(0);

    const detail = await handlers.requirements.get(reqs[0]!.id);
    expect(detail.requirement.id).toBe(reqs[0]!.id);
    expect(detail.findings.length).toBeGreaterThan(0);

    const audits = await handlers.audit.list();
    expect(audits.length).toBeGreaterThan(0);
  });
});
