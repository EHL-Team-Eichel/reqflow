import { describe, expect, it } from "vitest";
import { filterGraph } from "./filter-report";
import { fixturePipelineData } from "./fixtures";
import { emptyPipelineData, type PipelineData } from "./pipeline";

const source = fixturePipelineData.sources[0]!;
const record = (id: string, text: string) => ({ id, sourceId: source.id, text });
const finding = (id: string, recordId: string, text: string) => ({
  ...fixturePipelineData.findings[0]!,
  id,
  themeId: undefined,
  statement: text,
  evidence: [{ sourceId: source.id, recordId, excerpt: text }],
});

function data(patch: Partial<PipelineData>): PipelineData {
  return { ...emptyPipelineData(), sources: [source], ...patch };
}

describe("what the AI Filter classifies", () => {
  it("records nothing refers to are classified next to the findings, not dropped", () => {
    const input = data({
      records: [record("rec_a", "Rear seats are tight."), record("rec_b", "Great screen.")],
      findings: [finding("fnd_a", "rec_a", "Rear seats are tight.")],
    });
    expect(filterGraph(input).units()).toEqual([
      { layer: "findings", id: "fnd_a" },
      { layer: "records", id: "rec_b" },
    ]);
  });

  it("every item of the most advanced layer is classified, even one another brings along", () => {
    const base = fixturePipelineData.themes[0]!;
    const input = data({
      records: [record("rec_a", "Seats.")],
      findings: [finding("fnd_a", "rec_a", "Seats.")],
      themes: [
        { ...base, id: "thm_a", findingIds: ["fnd_a"] },
        { ...base, id: "thm_b", findingIds: ["fnd_a"] },
      ],
    });
    expect(filterGraph(input).units()).toEqual([
      { layer: "themes", id: "thm_a" },
      { layer: "themes", id: "thm_b" },
    ]);
  });

  it("a closure brings evidence along and reports missing references", () => {
    const input = data({
      records: [record("rec_a", "Seats.")],
      findings: [{ ...finding("fnd_a", "rec_a", "Seats."), themeId: "thm_missing" }],
    });
    const missing: string[] = [];
    const brought = filterGraph(input).closure("findings", "fnd_a", (key) => missing.push(key));
    expect([...brought.records]).toEqual(["rec_a"]);
    expect([...brought.sources]).toEqual([source.id]);
    expect(missing).toEqual(["themes"]);
  });
});
