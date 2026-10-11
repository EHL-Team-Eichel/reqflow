import { describe, expect, it } from "vitest";
import {
  BLOCK_SPECS,
  blockPorts,
  defaultBlockParams,
  isParamVisible,
  migrateBlockParams,
  parseBlockParams,
} from "./blocks";
import { CAR_AREAS, CAR_PART_GROUPS, carPartOutputs } from "./car-parts";

const splitter = (params: Record<string, unknown>) => ({
  kind: "ai_splitter" as const,
  params: { ...defaultBlockParams("ai_splitter"), ...params },
});
const outputs = (params: Record<string, unknown>) =>
  blockPorts(splitter(params)).outputs.map((p) => p.label);

describe("car-part depth of the AI Splitter", () => {
  it("has one output per area or part group, plus Other last", () => {
    expect(outputs({ splitBy: "car_parts", partDepth: "areas" })).toEqual([
      "Exterior",
      "Interior",
      "Technology & chassis",
      "Other (no specific part)",
    ]);
    const fine = outputs({ splitBy: "car_parts", partDepth: "groups" });
    expect(fine).toHaveLength(CAR_PART_GROUPS.length + 1);
    expect(fine).toContain("Seats");
    expect(fine).toContain("Cockpit & controls");
    expect(blockPorts(splitter({ splitBy: "car_parts", partDepth: "groups" })).outputs[0]!.id).toBe(
      "out-0",
    );
  });

  it("keeps the branch list for every other mode", () => {
    expect(outputs({ splitBy: "custom", instruction: "x", branches: ["A", "B"] })).toEqual([
      "A",
      "B",
    ]);
  });

  it("shows the depth only for car parts, and the branch list for every other mode", () => {
    const spec = (key: string) => BLOCK_SPECS.ai_splitter.params.find((p) => p.key === key)!;
    const car = splitter({ splitBy: "car_parts" }).params;
    const custom = splitter({ splitBy: "custom" }).params;
    expect(isParamVisible(spec("partDepth"), car)).toBe(true);
    expect(isParamVisible(spec("partDepth"), custom)).toBe(false);
    expect(isParamVisible(spec("branches"), car)).toBe(false);
    expect(isParamVisible(spec("branches"), custom)).toBe(true);
  });

  it("brings older splitters up to date with the coarse depth", () => {
    const { partDepth: _, ...old } = defaultBlockParams("ai_splitter");
    expect(() => parseBlockParams("ai_splitter", old)).toThrow();
    const migrated = migrateBlockParams("ai_splitter", old);
    expect(parseBlockParams("ai_splitter", migrated).partDepth).toBe("areas");
  });

  it("puts every part group in one of the areas, with unique ids", () => {
    const areas = new Set(CAR_AREAS.map((a) => a.id));
    expect(CAR_PART_GROUPS.every((g) => areas.has(g.area))).toBe(true);
    for (const depth of ["areas", "groups"] as const) {
      const ids = carPartOutputs(depth).map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.at(-1)).toBe("other");
    }
  });
});
