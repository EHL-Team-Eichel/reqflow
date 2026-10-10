import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  emptyPipelineData,
  newId,
  type AuditLogger,
  type FileStore,
  type LlmClient,
} from "@reqflow/core";
import { fixtureRequirements, fixtureScope } from "@reqflow/core/fixtures";
import { type NodeContext } from "@reqflow/engine";
import {
  formatRequirementsCsv,
  formatRequirementsJson,
  formatRequirementsMarkdown,
} from "./formatters";
import { publishNode } from "./publish";
import { exportNode } from "./export";

const mockCtx = (): NodeContext => ({
  runId: newId("run"),
  nodeId: "output-node",
  scope: fixtureScope,
  settings: DEFAULT_SETTINGS,
  llm: { generateObject: vi.fn(), generateText: vi.fn() } as unknown as LlmClient,
  audit: { record: vi.fn().mockResolvedValue({}) } as unknown as AuditLogger,
  files: { get: vi.fn() } as unknown as FileStore,
  web: null,
  log: vi.fn(),
  progress: vi.fn(),
  signal: new AbortController().signal,
  resumed: false,
});

describe("output formatters & nodes", () => {
  it("formats requirements to JSON, CSV, and Markdown", () => {
    const json = formatRequirementsJson(fixtureRequirements);
    expect(json).toContain("REQ-5S-EU-");
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(fixtureRequirements.length);

    const csv = formatRequirementsCsv(fixtureRequirements);
    expect(csv).toContain("ID,Title,Category");
    expect(csv).toContain("REQ-5S-EU-");

    const md = formatRequirementsMarkdown(fixtureRequirements);
    expect(md).toContain("# BMW Vehicle Requirements Specification");
    expect(md).toContain("| ID | Title | Category |");
  });

  it("publish node publishes requirements and writes audit logs", async () => {
    const ctx = mockCtx();
    const input = {
      ...emptyPipelineData(),
      requirements: fixtureRequirements,
    };

    const res = await publishNode.run(input, {}, ctx);
    expect(res.status).toBe("ok");
    expect(ctx.audit.record).toHaveBeenCalledTimes(fixtureRequirements.length);
  });

  it("export node writes audit event and returns data", async () => {
    const ctx = mockCtx();
    const input = {
      ...emptyPipelineData(),
      requirements: fixtureRequirements,
    };

    const res = await exportNode.run(input, { format: "csv" }, ctx);
    expect(res.status).toBe("ok");
    expect(ctx.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "export.created",
      }),
    );
  });
});
