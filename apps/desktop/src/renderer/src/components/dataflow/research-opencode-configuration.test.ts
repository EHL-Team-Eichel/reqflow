import { BLOCK_SPECS, createBlock, setBlockParams } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import {
  scopeFormFromJson,
  scopeJsonFromForm,
  selectSocialMedia,
  validateResearchAgents,
  validateScopeJson,
} from "./research-configuration";

describe("OpenCode Research configuration spec", () => {
  it("defines block spec with ports and required parameters", () => {
    const spec = BLOCK_SPECS.research_opencode;
    expect(spec.kind).toBe("research_opencode");
    expect(spec.label).toBe("OpenCode Research");
    expect(spec.ports({}).inputs).toHaveLength(0);
    expect(spec.ports({}).outputs).toHaveLength(1);
    expect(spec.ports({})?.outputs[0]?.id).toBe("out");

    const paramKeys = spec.params.map((p) => p.key);
    expect(paramKeys).toContain("agents");
    expect(paramKeys).toContain("question");
    expect(paramKeys).toContain("scopeJson");
    expect(paramKeys).toContain("market");
    expect(paramKeys).toContain("sources");
    expect(paramKeys).toContain("maxResults");
    expect(paramKeys).toContain("timeoutMs");
    expect(paramKeys).toContain("workingDir");
    expect(paramKeys).toContain("autoApprove");
    expect(paramKeys).toContain("installSkill");
  });

  it("creates block with default parameters", () => {
    const block = createBlock("research_opencode", {
      id: "opencode-1",
      position: { x: 0, y: 0 },
    });
    expect(block.kind).toBe("research_opencode");
    expect(block.params.agents).toEqual([
      "editorial_reviews",
      "reddit",
      "competitor_models",
      "technology",
    ]);
    expect(block.params.autoApprove).toBe(true);
    expect(block.params.installSkill).toBe(true);
    expect(block.params.timeoutMs).toBe(600000);
    expect(block.params.maxResults).toBe(25);
  });

  it("updates parameters and preserves scope integrity", () => {
    const block = createBlock("research_opencode", {
      id: "opencode-test",
      position: { x: 10, y: 10 },
    });
    const form = scopeFormFromJson("{}");
    form.model = "1 Series";
    form.keywords = "EV efficiency\nHUD clarity";
    const updatedScopeJson = scopeJsonFromForm("{}", form);

    const updatedGraph = setBlockParams({ blocks: [block], edges: [] }, block.id, {
      ...block.params,
      question: "Analyze F70 successor market trends",
      scopeJson: updatedScopeJson,
      workingDir: "/tmp/opencode-run",
      autoApprove: true,
      installSkill: true,
      timeoutMs: 300000,
      agents: selectSocialMedia(block.params.agents as string[], "all"),
    });

    const updated = updatedGraph.graph.blocks[0]!;
    expect(updated.params.question).toBe("Analyze F70 successor market trends");
    expect(updated.params.workingDir).toBe("/tmp/opencode-run");
    expect(updated.params.timeoutMs).toBe(300000);
    expect(JSON.parse(updated.params.scopeJson as string)).toEqual({
      model: "1 Series",
      keywords: ["EV efficiency", "HUD clarity"],
    });
    expect(validateScopeJson(updated.params.scopeJson as string)).toBeTruthy();
  });

  it("validates research agents against core validation schema", () => {
    expect(() => validateResearchAgents([])).toThrow(/at least one/i);
    expect(() => validateResearchAgents(["reddit", "reddit"])).toThrow(/only once/i);
    expect(validateResearchAgents(["reddit", "youtube"])).toEqual(["reddit", "youtube"]);
  });
});
