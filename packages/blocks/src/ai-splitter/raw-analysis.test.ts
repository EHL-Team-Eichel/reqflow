import {
  DEFAULT_SETTINGS,
  PipelineData,
  SplitterReport,
  emptyPipelineData,
  mergePipelineData,
  type LlmClient,
  type PipelineData as Data,
  type Source,
  type SourceRecord,
} from "@reqflow/core";
import { fixturePipelineData } from "@reqflow/core/fixtures";
import type { BlockContext, BlockResult } from "@reqflow/engine";
import { createMastraLlmClient } from "@reqflow/llm";
import { describe, expect, it, vi } from "vitest";
import { aiSplitterBlock } from "./ai-splitter";

type Topic = { key: string; label?: string; impact?: number | null; stance?: string };
const source = (id = "src_feedback", kind: Source["kind"] = "customer_feedback"): Source => ({
  id,
  kind,
  origin: "bmw_internal",
  title: "Synthetic opinions",
  uri: "file_synthetic",
  retrievedAt: "2026-01-01T00:00:00.000Z",
  reliability: "high",
});
function record(id: string, topics: Topic[], extra: Record<string, unknown> = {}): SourceRecord {
  return {
    id: `rec_${id}`,
    sourceId: "src_feedback",
    text: `Synthetic opinion ${id}: ${topics.map((t) => t.key).join(" and ")}`,
    locator: `row ${id}`,
    fields: { topics, ...extra },
  };
}
function data(records: SourceRecord[], sources = [source()]): Data {
  return { ...emptyPipelineData(), sources, records };
}
/** Scripted protocol peer: no imports from implementation helpers, no generic schema synthesis. */
function peer(change?: (response: any, payload: any) => void): LlmClient {
  return {
    generateText: vi.fn(),
    generateObject: vi.fn(async (request) => {
      const p = JSON.parse(request.prompt);
      let response: any;
      if (p.contract === "reqflow.ai-splitter.discover@1") {
        const byKey = new Map<string, any>();
        response = {
          contract: p.contract,
          needs: [],
          items: p.items.map((item: any) => {
            const topics = item.record.fields?.topics ?? [];
            const needIds = topics.map((topic: Topic) => {
              const key = `${topic.key}:${topic.label ?? topic.key}`;
              if (!byKey.has(key)) {
                const need = {
                  id: `${p.needIdPrefix}${byKey.size}`,
                  label: topic.label ?? topic.key,
                  description: topic.key,
                };
                byKey.set(key, need);
              }
              return byKey.get(key).id;
            });
            return {
              id: item.id,
              kind: item.record.fields?.actualOpinion === false ? "context" : "feedback",
              reason: "Synthetic expressed opinion",
              evidence: {
                sourceId: item.record.sourceId,
                recordId: item.id,
                excerpt: item.record.text,
              },
              needIds,
            };
          }),
        };
        response.needs = [...byKey.values()];
      } else if (p.contract === "reqflow.ai-splitter.consolidate@1") {
        const needs = new Map<string, any>();
        for (const n of p.needs) {
          if (!needs.has(n.description))
            needs.set(n.description, {
              id: `need_${needs.size}`,
              label: n.label,
              description: n.description,
              aliasIds: [],
            });
          needs.get(n.description).aliasIds.push(n.id);
        }
        response = { contract: p.contract, needs: [...needs.values()] };
      } else if (p.contract === "reqflow.ai-splitter.plan@1") {
        response = {
          contract: p.contract,
          groups: Array.from({ length: p.branchCount }, (_, i) => ({
            id: `group_${i}`,
            label: `${p.mode === "custom" ? "Instruction" : "Car part"} ${i + 1}`,
            description: `Global group ${i + 1}`,
            needIds: p.needs
              .filter((_: unknown, n: number) => n % p.branchCount === i)
              .map((n: any) => n.id),
            reason: "Synthetic global grouping",
          })),
        };
      } else if (p.contract === "reqflow.ai-splitter.assign@1") {
        response = {
          contract: p.contract,
          items: p.items.map((item: any) => ({
            id: item.id,
            reason: "Synthetic topic assignment",
            confidence: 0.8,
            signals: item.needIds.map((id: string) => {
              const need = p.needs.find((n: any) => n.id === id);
              const t = item.record.fields.topics.find(
                (topic: Topic) => topic.key === need.description,
              );
              return {
                needId: id,
                stance: t.stance ?? "support",
                impact:
                  item.kind === "feedback" && (!t.stance || t.stance === "support")
                    ? (t.impact ?? null)
                    : null,
                confidence: 0.8,
                evidence: {
                  sourceId: item.record.sourceId,
                  recordId: item.id,
                  excerpt: item.record.text,
                },
                reason: "Synthetic excerpt grounds explicit impact anchor",
              };
            }),
          })),
        };
      } else throw new Error(`Unexpected protocol ${p.contract}`);
      change?.(response, p);
      return { object: request.schema.parse(response), model: "synthetic-protocol-model" };
    }),
  };
}
function context(llm = peer(), controller = new AbortController()) {
  return {
    runId: "run_test",
    blockId: "splitter_test",
    settings: structuredClone(DEFAULT_SETTINGS),
    llm,
    log: vi.fn(),
    progress: vi.fn(),
    signal: controller.signal,
    audit: { record: vi.fn() },
  } as unknown as BlockContext;
}
const params = {
  splitBy: "customer_priority",
  branches: ["Saved A", "Saved B", "Saved C"],
  instruction: "",
  model: "default",
};
function result(r: BlockResult) {
  if (r.status !== "ok" || !r.splitterReport) throw new Error("Expected analytical report");
  SplitterReport.parse(r.splitterReport);
  for (const output of Object.values(r.outputs)) PipelineData.parse(output);
  return { out: r.outputs, report: r.splitterReport };
}
function topics(key: string, impact: number | null = 50): Topic[] {
  return [{ key, impact }];
}

describe("raw AI Splitter analytical protocol", () => {
  it("globally merges aliases across batches before any assignments, then counts every original signal", async () => {
    const input = data(
      Array.from({ length: 45 }, (_, i) =>
        record(`${i}`, [
          { key: "seating", label: i < 20 ? "Seat comfort" : "Comfortable chairs", impact: 75 },
        ]),
      ),
    );
    const llm = peer();
    const { report, out } = result(await aiSplitterBlock.run({ in: input }, params, context(llm)));
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({
      support: 45,
      frequency: 100,
      impact: 75,
      score: 92.5,
      outputPortId: "out-0",
    });
    expect(report.signals).toHaveLength(45);
    expect(out["out-0"]!.records).toEqual(input.records);
    const requests = vi.mocked(llm.generateObject).mock.calls.map(([r]) => JSON.parse(r.prompt));
    expect(requests.map((r) => r.contract)).toEqual([
      ...Array(3).fill("reqflow.ai-splitter.discover@1"),
      "reqflow.ai-splitter.consolidate@1",
      ...Array(3).fill("reqflow.ai-splitter.assign@1"),
    ]);
    expect(
      new Set(requests.filter((p) => p.groups).map((p) => JSON.stringify(p.groups))).size,
    ).toBe(1);
    expect(report.models).toEqual(["synthetic-protocol-model"]);
    expect(report.reviews).toEqual([]);
  });

  it.each([3, 5, 10])(
    "uses %i fixed equal score bands; ties share a band and multi-topic records choose highest need",
    async (count) => {
      const input = data([
        ...Array.from({ length: 4 }, (_, i) => record(`top${i}`, topics("top", 50))),
        ...Array.from({ length: 2 }, (_, i) => record(`tiea${i}`, topics("tie a", 100))),
        ...Array.from({ length: 2 }, (_, i) => record(`tieb${i}`, topics("tie b", 100))),
        record("multi", [
          { key: "top", impact: 50 },
          { key: "low", impact: 0 },
        ]),
      ]);
      const { report } = result(
        await aiSplitterBlock.run(
          { in: input },
          { ...params, branches: Array.from({ length: count }, (_, i) => `Saved ${i}`) },
          context(),
        ),
      );
      const top = report.groups.find((g) => g.label === "top")!;
      const a = report.groups.find((g) => g.label === "tie a")!;
      const b = report.groups.find((g) => g.label === "tie b")!;
      expect(a.score).toBe(b.score);
      expect(a.outputPortId).toBe(b.outputPortId);
      for (const g of report.groups) {
        const i = Math.min(count - 1, count - 1 - Math.floor((g.score! * count) / 100));
        expect(g.outputPortId).toBe(`out-${Math.max(0, i)}`);
      }
      expect(report.scoreMethod.thresholds).toEqual(
        Array.from({ length: count }, (_, i) => ({
          portId: `out-${i}`,
          min: (100 * (count - i - 1)) / count,
          max: (100 * (count - i)) / count,
        })),
      );
      expect(report.assignments.find((a) => a.itemId === "rec_multi")).toMatchObject({
        primaryGroupId: top.id,
        outputPortId: top.outputPortId,
        groupIds: [top.id, report.groups.find((g) => g.label === "low")!.id],
      });
      if (count === 3)
        expect(report.branches.map((b) => b.label)).toEqual(["High", "Medium", "Low"]);
      if (count === 5)
        expect(report.branches.map((b) => b.label)).toEqual([
          "Very High",
          "High",
          "Medium",
          "Low",
          "Very Low",
        ]);
    },
  );

  it("counts actual feedback units, not sales/equipment/market context or unexpressed review facts", async () => {
    const input = data(
      [
        record("customer", topics("seats", 75)),
        ...["sales", "equipment", "market", "review"].map((k) => ({
          ...record(k, topics("seats", 100), { actualOpinion: k !== "review" }),
          sourceId: `src_${k}`,
        })),
        { ...record("opinion", topics("seats", 50)), sourceId: "src_review" },
      ],
      [
        source(),
        source("src_sales", "sales_volume"),
        source("src_equipment", "equipment_data"),
        source("src_market", "market_trend"),
        source("src_review", "review"),
      ],
    );
    const { report } = result(await aiSplitterBlock.run({ in: input }, params, context()));
    expect(report.input).toMatchObject({
      feedbackUnitCount: 2,
      contextUnitCount: 4,
      customerCount: null,
    });
    expect(report.groups[0]).toMatchObject({ support: 2, impact: 62.5, score: 88.75 });
    expect(report.sourceMatrix.find((s) => s.sourceId === "src_sales")).toMatchObject({
      support: 0,
      denominator: null,
    });
    expect(report.sourceMatrix.find((s) => s.sourceId === "src_review")).toMatchObject({
      support: 1,
      denominator: 1,
    });
    expect(report.assignments.find((a) => a.itemId === "rec_review")!.reason).toMatch(
      /context.*review/i,
    );
    expect(report.assignments.find((a) => a.itemId === "rec_opinion")!.reason).toMatch(
      /expressed feedback unit.*review/i,
    );
    expect(report.input.countingBasis).toMatch(/feedback units.*not.*people/i);
  });

  it("deduplicates explicit original/provider identities across reimports, never identical opinions from distinct IDs/customers", async () => {
    const same = "Identical synthetic opinion";
    const make = (id: string, extra: Record<string, unknown>) => ({
      ...record(id, topics("seats"), extra),
      text: same,
    });
    const input = data(
      [
        make("a", { provider: "survey", originalId: "42", customerId: "a" }),
        {
          ...make("reimport", { provider: "survey", originalId: "42", customerId: "a" }),
          sourceId: "src_reimport",
        },
        make("distinct", { provider: "survey", originalId: "43", customerId: "b" }),
        make("bare1", {}),
        make("bare2", {}),
      ],
      [source(), source("src_reimport")],
    );
    const { report, out } = result(await aiSplitterBlock.run({ in: input }, params, context()));
    expect(report.input).toMatchObject({ feedbackUnitCount: 4, duplicateUnitCount: 1 });
    expect(report.groups[0]!.support).toBe(4);
    expect(report.assignments[0]!.unitId).toBe(report.assignments[1]!.unitId);
    expect(report.assignments[0]!.unitId).not.toBe(report.assignments[2]!.unitId);
    expect(Object.values(out).flatMap((d) => d.records)).toHaveLength(5);
  });

  it("counts one unit/group even with multiple synonymous mentions; opposition and uncertainty stay separate", async () => {
    const input = data([
      record("s1", topics("seat", 75), { originalId: "a" }),
      record("s2", topics("seat", 75), { originalId: "a" }),
      record("o", [{ key: "seat", stance: "opposition" }]),
      record("u", [{ key: "seat", stance: "unclear" }]),
    ]);
    const { report } = result(await aiSplitterBlock.run({ in: input }, params, context()));
    expect(report.groups[0]).toMatchObject({ support: 1, opposition: 1, unclear: 1 });
  });

  it("leaves absent impact and score null; context/no-score routes explicitly to default lowest band", async () => {
    const input = data(
      [
        record("missing", topics("seat", null)),
        { ...record("context", topics("screen", 100)), sourceId: "src_market" },
      ],
      [source(), source("src_market", "market_trend")],
    );
    const { report } = result(await aiSplitterBlock.run({ in: input }, params, context()));
    expect(
      report.groups.every(
        (g) => g.score === null && g.impact === null && g.scoreOrigin === "not_computed",
      ),
    ).toBe(true);
    expect(
      report.assignments.every(
        (a) => a.outputPortId === "out-2" && /default|not computed|context/i.test(a.reason),
      ),
    ).toBe(true);
    expect(report.limitations.join(" ")).toMatch(/impact.*not.*expressed|absent.*impact/i);
  });

  it.each(["car_parts", "custom"])(
    "creates exactly requested global %s groups, including empty groups, without saving labels",
    async (splitBy) => {
      const input = data([record("a", topics("seat")), record("b", topics("screen"))]);
      const llm = peer();
      const p = {
        ...params,
        splitBy,
        branches: ["Old A", "Old B", "Old C", "Old D", "Old E"],
        instruction: "Group needs by journey stage",
      };
      const before = structuredClone(p);
      const { report } = result(await aiSplitterBlock.run({ in: input }, p, context(llm)));
      expect(report.groups).toHaveLength(5);
      expect(report.groups.filter((g) => g.support === 0)).toHaveLength(3);
      expect(report.branches.map((b) => b.label)).not.toEqual(p.branches);
      expect(p).toEqual(before);
      expect(
        vi
          .mocked(llm.generateObject)
          .mock.calls.filter(
            ([r]) => JSON.parse(r.prompt).contract === "reqflow.ai-splitter.plan@1",
          ),
      ).toHaveLength(1);
    },
  );

  it.each([
    "unknown alias",
    "missing alias",
    "duplicate alias",
    "missing assignment",
    "unknown need",
    "invented excerpt",
    "wrong source",
    "wrong locator",
  ])("fails closed for %s", async (failure) => {
    const llm = peer((r, p) => {
      if (p.contract.endsWith("consolidate@1")) {
        if (failure === "unknown alias") r.needs[0].aliasIds = ["invented"];
        if (failure === "missing alias") r.needs = [];
        if (failure === "duplicate alias") r.needs[0].aliasIds.push(r.needs[0].aliasIds[0]);
      }
      if (p.contract.endsWith("assign@1")) {
        if (failure === "missing assignment") r.items = [];
        if (failure === "unknown need") r.items[0].signals[0].needId = "invented";
        if (failure === "invented excerpt")
          r.items[0].signals[0].evidence.excerpt = "invented quotation";
        if (failure === "wrong source") r.items[0].signals[0].evidence.sourceId = "src_invented";
        if (failure === "wrong locator") r.items[0].signals[0].evidence.locator = "page invented";
      }
    });
    await expect(
      aiSplitterBlock.run({ in: data([record("a", topics("seat"))]) }, params, context(llm)),
    ).rejects.toThrow();
  });

  it.each([
    "missing discovery",
    "duplicate discovery",
    "unknown discovery need",
    "unsupported discovery need",
    "missing signal",
    "duplicate signal",
    "wrong record",
    "unanchored impact",
    "context impact",
  ])("rejects invalid protocol coverage/judgements: %s", async (failure) => {
    const llm = peer((r, p) => {
      if (p.contract.endsWith("discover@1")) {
        if (failure === "missing discovery") r.items = [];
        if (failure === "duplicate discovery") r.items.push(r.items[0]);
        if (failure === "unknown discovery need") r.items[0].needIds = ["invented"];
        if (failure === "unsupported discovery need")
          r.needs.push({
            id: `${p.needIdPrefix}unused`,
            label: "Unused",
            description: "Invented need",
          });
      }
      if (p.contract.endsWith("assign@1")) {
        if (failure === "missing signal") r.items[0].signals = [];
        if (failure === "duplicate signal") r.items[0].signals.push(r.items[0].signals[0]);
        if (failure === "wrong record") r.items[0].signals[0].evidence.recordId = "rec_invented";
        if (failure === "unanchored impact") r.items[0].signals[0].impact = 33;
        if (failure === "context impact") r.items[0].signals[0].impact = 100;
      }
    });
    const input = data([
      record("a", topics("seat"), failure === "context impact" ? { actualOpinion: false } : {}),
    ]);
    await expect(aiSplitterBlock.run({ in: input }, params, context(llm))).rejects.toThrow();
  });

  it.each(["wrong count", "missing need", "duplicate need", "unknown need", "duplicate group"])(
    "rejects invalid fixed group plan: %s",
    async (failure) => {
      const llm = peer((r, p) => {
        if (p.contract.endsWith("plan@1")) {
          if (failure === "wrong count") r.groups.pop();
          if (failure === "missing need") r.groups[0].needIds = [];
          if (failure === "duplicate need") r.groups[1].needIds = r.groups[0].needIds;
          if (failure === "unknown need") r.groups[0].needIds = ["invented"];
          if (failure === "duplicate group") r.groups[1].id = r.groups[0].id;
        }
      });
      await expect(
        aiSplitterBlock.run(
          { in: data([record("a", topics("seat"))]) },
          { ...params, splitBy: "car_parts" },
          context(llm),
        ),
      ).rejects.toThrow();
    },
  );

  it("maps every discovered signal through aliases even when one record has multiple synonymous topics", async () => {
    const input = data([
      record("a", [
        { key: "seat", label: "Comfortable chairs", impact: 75 },
        { key: "seat", label: "Seating comfort", impact: 75 },
      ]),
    ]);
    const { report } = result(await aiSplitterBlock.run({ in: input }, params, context()));
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]!.support).toBe(1);
    expect(report.assignments[0]!.groupIds).toHaveLength(1);
    expect(report.signals).toHaveLength(1);
  });

  it("keeps secondary canonical need identities visible even when car-part needs share a group", async () => {
    const input = data([
      record("multi", [
        { key: "seat", impact: 75 },
        { key: "screen", impact: 50 },
        { key: "cargo", impact: 25 },
      ]),
    ]);
    const { report } = result(
      await aiSplitterBlock.run(
        { in: input },
        { ...params, splitBy: "car_parts", branches: ["Old A", "Old B"] },
        context(),
      ),
    );
    expect(report.signals).toHaveLength(3);
    expect(report.assignments[0]!.groupIds).toHaveLength(2);
    expect(report.signals.map((s) => s.reason).join(" ")).toMatch(/seat/);
    expect(report.signals.map((s) => s.reason).join(" ")).toMatch(/screen/);
    expect(report.signals.map((s) => s.reason).join(" ")).toMatch(/cargo/);
  });

  it("preserves envelope extension identity on every raw output, including empty branches", async () => {
    const input = data([record("a", topics("seat", 100))]);
    const metadata = { synthetic: true };
    Object.assign(input, { metadata });
    const { out } = result(await aiSplitterBlock.run({ in: input }, params, context()));
    for (const output of Object.values(out))
      expect((output as Data & { metadata: unknown }).metadata).toBe(metadata);
  });

  it("reports missing raw data for upstream-only new modes without manufacturing demand or changing human decisions", async () => {
    const input = {
      ...emptyPipelineData(),
      requirements: fixturePipelineData.requirements.slice(0, 1),
    };
    const llm = peer();
    const { report, out } = result(await aiSplitterBlock.run({ in: input }, params, context(llm)));
    expect(report.input).toMatchObject({
      primaryLayer: "requirements",
      primaryCount: 1,
      feedbackUnitCount: 0,
    });
    expect(report.assignments[0]).toMatchObject({
      outputPortId: "out-2",
      primaryGroupId: null,
      confidence: null,
    });
    expect(out["out-2"]!.requirements[0]).toBe(input.requirements[0]);
    expect(report.groups).toEqual([]);
    expect(llm.generateObject).not.toHaveBeenCalled();
  });

  it("fails a globally oversized catalog explicitly rather than consolidating only a prefix", async () => {
    const records = Array.from({ length: 140 }, (_, i) => record(`${i}`, [{ key: `need${i}` }]));
    const llm = peer((r, p) => {
      if (p.contract.endsWith("discover@1"))
        for (const n of r.needs) {
          n.description = "x".repeat(600);
          n.label = "x".repeat(120);
        }
    });
    await expect(aiSplitterBlock.run({ in: data(records) }, params, context(llm))).rejects.toThrow(
      /global catalog.*exceeds 96,000/,
    );
    expect(
      vi
        .mocked(llm.generateObject)
        .mock.calls.every(([r]) => JSON.parse(r.prompt).contract.endsWith("discover@1")),
    ).toBe(true);
  });

  it("uses records as primary even with upstream findings; preserves identity/provenance and shared evidence without repeating raw records", async () => {
    const input = structuredClone(fixturePipelineData);
    input.records = input.records.slice(0, 2);
    input.records[0]!.fields = { topics: topics("top", 100) };
    input.records[1]!.fields = { topics: topics("lower", 0) };
    input.records[0]!.text = "First synthetic quote";
    input.records[1]!.text = "Second synthetic quote";
    input.findings = [
      {
        ...input.findings[0]!,
        evidence: input.records.map((r) => ({
          sourceId: r.sourceId,
          recordId: r.id,
          excerpt: r.text,
        })),
      },
    ];
    input.themes = [];
    input.requirements = [
      { ...input.requirements[0]!, findingIds: [input.findings[0]!.id], conflictingFindingIds: [] },
    ];
    Object.assign(input.records[0]!, { provenance: { original: true } });
    const before = structuredClone(input);
    const c = context();
    const { report, out } = result(
      await aiSplitterBlock.run(
        { in: input },
        { ...params, branches: Array.from({ length: 10 }, (_, i) => `Band ${i}`) },
        c,
      ),
    );
    expect(report.input.primaryLayer).toBe("records");
    const routed = Object.values(out).flatMap((d) => d.records);
    expect(routed).toHaveLength(2);
    for (const r of routed) expect(r).toBe(input.records.find((x) => x.id === r.id));
    expect(out["out-0"]!.findings[0]).toBe(input.findings[0]);
    expect(out["out-2"]!.findings[0]).toBe(input.findings[0]);
    expect(
      Object.values(out)
        .flatMap((d) => d.requirements)
        .every((r) => r === input.requirements[0]),
    ).toBe(true);
    expect(input).toEqual(before);
    expect(c.audit.record).not.toHaveBeenCalled();
    expect(vi.mocked(c.log).mock.calls.flat().join(" ")).not.toContain("synthetic quote");
    expect(report.limitations.join(" ")).toMatch(/cross.branch|other output/i);
  });

  it("processes already-merged incoming envelopes as one global population", async () => {
    const first = data([record("a", topics("seat", 50))]);
    const second = data(
      [{ ...record("b", topics("seat", 100)), sourceId: "src_second" }],
      [source("src_second")],
    );
    const input = mergePipelineData(first, second);
    const { report } = result(await aiSplitterBlock.run({ in: input }, params, context()));
    expect(report.input).toMatchObject({ sourceCount: 2, recordCount: 2, feedbackUnitCount: 2 });
    expect(report.groups[0]).toMatchObject({ support: 2, impact: 75, score: 92.5 });
  });

  it.each(["customer_priority", "car_parts", "custom"])(
    "reports empty/source-only %s input honestly without LLM calls",
    async (splitBy) => {
      const llm = peer();
      const p = { ...params, splitBy, instruction: "Group by journey" };
      const empty = result(await aiSplitterBlock.run({}, p, context(llm)));
      expect(empty.report.input.primaryCount).toBe(0);
      const input = data([], [source()]);
      const only = result(await aiSplitterBlock.run({ in: input }, p, context(llm)));
      expect(Object.values(only.out).flatMap((d) => d.sources)).toEqual(input.sources);
      expect(only.report.input).toMatchObject({
        primaryLayer: "sources",
        feedbackUnitCount: 0,
        customerCount: null,
      });
      expect(only.report.limitations.join(" ")).toMatch(/no.*records/i);
      expect(llm.generateObject).not.toHaveBeenCalled();
    },
  );

  it("fails oversized full records before any LLM call rather than truncating", async () => {
    const llm = peer();
    const r = record("huge", topics("seat"));
    r.text = "x".repeat(100000);
    await expect(aiSplitterBlock.run({ in: data([r]) }, params, context(llm))).rejects.toThrow(
      /exceed.*96,000|oversized/i,
    );
    expect(llm.generateObject).not.toHaveBeenCalled();
  });

  it("keeps canonical needs distinct when several same-excerpt signals share a custom group", async () => {
    const unit = { provider: "synthetic", originalId: "entry_42" };
    const original = record(
      "multi",
      [
        { key: "seat", impact: 100 },
        { key: "screen", impact: 0 },
        { key: "climate", impact: 0 },
      ],
      unit,
    );
    const copy = { ...original, id: "rec_reimport", sourceId: "src_reimport" };
    const llm = () =>
      peer((r, p) => {
        if (p.contract.endsWith("plan@1")) {
          r.groups[0].needIds = p.needs.map((n: any) => n.id);
          for (const group of r.groups.slice(1)) group.needIds = [];
        }
      });
    const p = { ...params, splitBy: "custom", instruction: "Keep all needs in one group" };
    const before = result(await aiSplitterBlock.run({ in: data([original]) }, p, context(llm())));
    const after = result(
      await aiSplitterBlock.run(
        { in: data([original, copy], [source(), source("src_reimport")]) },
        p,
        context(llm()),
      ),
    );
    expect(before.report.groups[0]).toMatchObject({ support: 1, score: 80 });
    expect(before.report.groups[0]!.impact).toBeCloseTo(100 / 3);
    expect(after.report.groups.map(({ confidence, ...group }) => group)).toEqual(
      before.report.groups.map(({ confidence, ...group }) => group),
    );
    expect(after.report.groups[0]!.confidence).toBeCloseTo(before.report.groups[0]!.confidence!);
    expect(after.report.signals).toHaveLength(6);
    expect(Object.values(after.out).flatMap((d) => d.records)).toEqual([original, copy]);
  });

  it("offline mock integration keeps reimport impact, score, primary routes and original citations unchanged", async () => {
    const llm = () => createMastraLlmClient({ ...DEFAULT_SETTINGS.llm, provider: "mock" });
    const identity = { provider: "synthetic_review", originalId: "42" };
    const high = { ...record("high", [], identity), text: "I cannot use the seats." };
    const neutral = {
      ...record("neutral", [], identity),
      text: "I need better seats with no impact on use.",
    };
    const copy = { ...high, id: "rec_high_reimport", sourceId: "src_reimport" };
    const p = { ...params, branches: Array.from({ length: 10 }, (_, i) => `Band ${i}`) };
    const before = result(
      await aiSplitterBlock.run({ in: data([high, neutral]) }, p, context(llm())),
    );
    const input = data([high, neutral, copy], [source(), source("src_reimport")]);
    const snapshot = structuredClone(input);
    const after = result(await aiSplitterBlock.run({ in: input }, p, context(llm())));
    expect(before.report.groups[0]).toMatchObject({
      support: 1,
      impact: 50,
      score: 85,
      outputPortId: "out-1",
    });
    expect(after.report.groups).toEqual(before.report.groups);
    expect(after.report.assignments.every((a) => a.outputPortId === "out-1")).toBe(true);
    expect(after.report.input).toMatchObject({ feedbackUnitCount: 1, duplicateUnitCount: 2 });
    expect(after.report.signals).toHaveLength(3);
    expect(new Set(after.report.signals.map((s) => s.evidence.recordId))).toEqual(
      new Set(input.records.map((r) => r.id)),
    );
    expect(after.out["out-1"]!.records).toEqual(input.records);
    for (const [i, r] of after.out["out-1"]!.records.entries()) expect(r).toBe(input.records[i]);
    expect(input).toEqual(snapshot);
  });

  it.each(["customer_priority", "car_parts", "custom"])(
    "offline mock integrates %s across bounded batches without collapsing distinct identical opinions",
    async (splitBy) => {
      const records = Array.from({ length: 45 }, (_, i) => ({
        ...record(`mock${i}`, [], { provider: "synthetic", originalId: `${i}` }),
        text: "I cannot use the seats. I need a screen with no impact on use.",
      }));
      const input = data(records);
      const llm = createMastraLlmClient({ ...DEFAULT_SETTINGS.llm, provider: "mock" });
      const calls = vi.spyOn(llm, "generateObject");
      const { report, out } = result(
        await aiSplitterBlock.run(
          { in: input },
          { ...params, splitBy, instruction: "Groups: Seats, Screens, Other", model: "fast" },
          context(llm),
        ),
      );
      expect(report.input.feedbackUnitCount).toBe(45);
      expect(report.input.duplicateUnitCount).toBe(0);
      expect(report.models).toEqual(["mock:fast"]);
      expect(report.signals).toHaveLength(90);
      expect(Object.values(out).flatMap((d) => d.records)).toHaveLength(45);
      expect(report.groups.filter((g) => g.support > 0).map((g) => g.support)).toEqual([45, 45]);
      const prompts = calls.mock.calls.map(([request]) => JSON.parse(request.prompt));
      expect(prompts.filter((p) => p.contract.endsWith("discover@1"))).toHaveLength(3);
      expect(prompts.filter((p) => p.contract.endsWith("assign@1"))).toHaveLength(3);
      expect(
        new Set(prompts.filter((p) => p.groups).map((p) => JSON.stringify(p.groups))).size,
      ).toBe(1);
    },
  );

  it("cancels immediately even if protocol peer ignores AbortSignal", async () => {
    const controller = new AbortController();
    const llm: LlmClient = {
      generateText: vi.fn(),
      generateObject: vi.fn(() => new Promise<never>(() => {})),
    };
    const pending = aiSplitterBlock.run(
      { in: data([record("a", topics("seat"))]) },
      params,
      context(llm, controller),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(aiSplitterBlock.run({}, params, context(llm, controller))).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
