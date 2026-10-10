import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BMW_DEFAULT_TEMPLATE } from "@reqflow/blocks";
import { DEFAULT_SETTINGS } from "@reqflow/core";
import { getWorkflow, listWorkflows, removeWorkflow, saveWorkflow } from "./workflow-storage";

describe("workflow-storage", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "reqflow-workflows-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("saves, versions, and lists valid workflows", () => {
    const saved = saveWorkflow(tempDir, {
      name: "BMW Default Flow",
      scope: DEFAULT_SETTINGS.defaultScope,
      blocks: BMW_DEFAULT_TEMPLATE.graph.blocks,
      edges: BMW_DEFAULT_TEMPLATE.graph.edges,
    });

    expect(saved.id).toMatch(/^wf_/);
    expect(saved.version).toBe(1);

    const fetched = getWorkflow(tempDir, saved.id);
    expect(fetched.name).toBe("BMW Default Flow");

    const updated = saveWorkflow(tempDir, {
      id: saved.id,
      name: "BMW Default Flow Updated",
      scope: saved.scope,
      blocks: saved.blocks,
      edges: saved.edges,
    });

    expect(updated.version).toBe(2);
    expect(updated.name).toBe("BMW Default Flow Updated");

    const list = listWorkflows(tempDir);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(saved.id);

    removeWorkflow(tempDir, saved.id);
    expect(listWorkflows(tempDir)).toHaveLength(0);
  });

  it("rejects invalid graphs with invalid_input error and issues details", () => {
    expect(() =>
      saveWorkflow(tempDir, {
        name: "Broken Flow",
        scope: DEFAULT_SETTINGS.defaultScope,
        blocks: [
          {
            id: "b1",
            kind: "raw",
            label: "Raw 1",
            position: { x: 0, y: 0 },
            params: {},
          },
          {
            id: "b1", // duplicate id
            kind: "raw",
            label: "Raw 2",
            position: { x: 100, y: 0 },
            params: {},
          },
        ],
        edges: [],
      }),
    ).toThrowError(/Workflow graph has .* validation issue/);
  });
});
