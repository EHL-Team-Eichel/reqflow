import {
  DEFAULT_SETTINGS,
  FilterReport,
  defaultBlockParams,
  emptyPipelineData,
  type FilterOverride,
  type LlmClient,
  type PipelineData,
} from "@reqflow/core";
import { fixturePipelineData, fixtureRequirements } from "@reqflow/core/fixtures";
import type { BlockContext, BlockResult } from "@reqflow/engine";
import { createLlmClient } from "@reqflow/llm";
import { describe, expect, it, vi } from "vitest";
import { aiFilterBlock, filterHash } from "./ai-filter";
import { aiFilterImplementations } from "./index";

const defaults = defaultBlockParams("ai_filter");
const contract = "reqflow.ai-filter.selection@1";
function records(texts = ["The seats are comfortable."]): PipelineData {
  const source = fixturePipelineData.sources[0]!;
  return {
    ...emptyPipelineData(),
    sources: [source],
    records: texts.map((text, i) => ({
      id: `rec_${i}`,
      sourceId: source.id,
      text,
    })),
  };
}
function context(llm = createLlmClient(DEFAULT_SETTINGS.llm)) {
  const controller = new AbortController();
  const audit = { record: vi.fn().mockResolvedValue({}) };
  const log = vi.fn();
  const ctx = {
    runId: "run_filter_test",
    blockId: "filter_test",
    scope: fixtureRequirements[0]!.scope,
    settings: structuredClone(DEFAULT_SETTINGS),
    signal: controller.signal,
    llm,
    audit,
    log,
    progress: vi.fn(),
  } as unknown as BlockContext;
  return { ctx, audit, controller, log };
}
function fake(transform?: (decisions: any[], payload: any) => unknown): LlmClient {
  return {
    generateObject: vi.fn(async (request) => {
      const payload = JSON.parse(request.prompt);
      const decisions = payload.items.map((entry: any) => ({
        id: entry.id,
        decision: "keep",
        confidence: 0.8,
        reason: "Synthetic classification reason.",
        quotes:
          entry.layer === "records" && entry.item.text.trim()
            ? [{ recordId: entry.id, excerpt: entry.item.text }]
            : [],
      }));
      return {
        object: transform ? transform(decisions, payload) : { contract, decisions },
        model: "synthetic-model",
      };
    }) as LlmClient["generateObject"],
    generateText: vi.fn(),
  };
}
function ok(result: BlockResult) {
  if (result.status !== "ok" || !result.filterReport) throw new Error("Expected filter report");
  expect(FilterReport.safeParse(result.filterReport).success).toBe(true);
  return { output: result.outputs.out!, report: result.filterReport };
}
function freeze(value: any): any {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe("selection-only AI Filter", () => {
  it("registers the in/out implementation", () => {
    expect(aiFilterImplementations).toEqual([aiFilterBlock]);
  });
  it("labels persisted classification attempts as unpublished when a later audit write fails", async () => {
    const test = context(fake());
    test.audit.record
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("Synthetic audit failure"));
    await expect(
      aiFilterBlock.run(
        { in: records(["Seats are comfortable.", "Screen is slow."]) },
        defaults,
        test.ctx,
      ),
    ).rejects.toThrow("audit could not be persisted");
    const first = test.audit.record.mock.calls[0]![0];
    expect(first.changes[0].after.publication).toBe("not_committed");
    expect(first.changes[0].after).not.toHaveProperty("forwarded");
  });
  it("preserves frozen originals, nested extensions, metadata, order and model reasons", async () => {
    const data = records(["Seats are great.", "The screen is poor."]);
    (data.records[0] as any).extra = { z: [1, { provenance: true }], a: "synthetic" };
    data.metadata = { supplied: true };
    freeze(data);
    const test = context(fake((decisions) => ({ contract, decisions: decisions.reverse() })));
    const { output, report } = ok(await aiFilterBlock.run({ in: data }, defaults, test.ctx));
    expect(Object.keys(output)).toEqual(Object.keys(data));
    expect(output).toEqual(data);
    expect(output.records[0]).toBe(data.records[0]);
    expect(output.metadata).toBe(data.metadata);
    expect(report.originalInput).toBe(data);
    expect(report.decisions.map((d) => d.itemId)).toEqual(["rec_0", "rec_1"]);
    expect(test.audit.record).toHaveBeenCalledTimes(2);
    expect(test.audit.record.mock.calls[0]![0]).toMatchObject({
      action: "filter.classified",
      entityType: "filter",
      entityId: "rec_0",
      actor: { type: "ai", model: "synthetic-model" },
      rationale: "Classification attempt, not a publication: Synthetic classification reason.",
    });
    expect(test.log.mock.calls.flat().join(" ")).not.toContain(data.records[0]!.text);
  });
  it.each([
    ["missing", (d: any[]) => d.slice(1)],
    ["duplicate", (d: any[]) => [d[0], d[0]]],
    ["unknown", (d: any[]) => [d[0], { ...d[1], id: "rec_unknown" }]],
  ])("rejects %s ID coverage without auditing", async (_, transform) => {
    const test = context(fake((d) => ({ contract, decisions: transform(d) })));
    await expect(
      aiFilterBlock.run({ in: records(["Seats.", "Screen."]) }, defaults, test.ctx),
    ).rejects.toThrow("coverage");
    expect(test.audit.record).not.toHaveBeenCalled();
  });
  it.each([
    ["no quotes", { quotes: [] }],
    ["invented", { quotes: [{ recordId: "rec_0", excerpt: "invented synthetic quote" }] }],
    ["unavailable", { quotes: [{ recordId: "rec_other", excerpt: "Seats." }] }],
    ["blank", { quotes: [{ recordId: "rec_0", excerpt: " " }] }],
    ["invalid confidence", { confidence: 2 }],
    ["blank reason", { reason: "  " }],
    ["long reason", { reason: "x".repeat(2001) }],
    ["rewritten object", { item: { text: "rewrite" } }],
  ])("rejects %s strict selection responses", async (_, change) => {
    const test = context(
      fake((d) => ({ contract, decisions: d.map((v) => ({ ...v, ...change })) })),
    );
    await expect(aiFilterBlock.run({ in: records() }, defaults, test.ctx)).rejects.toThrow(
      "AI Filter",
    );
    expect(test.audit.record).not.toHaveBeenCalled();
  });
  it("rejects additional envelope fields in model output", async () => {
    const test = context(fake((decisions) => ({ contract, decisions, rewritten: [] })));
    await expect(aiFilterBlock.run({ in: records() }, defaults, test.ctx)).rejects.toThrow(
      "invalid",
    );
  });
  it.each([true, false])(
    "confidence below threshold reviews and keepUnsure=%s controls forwarding",
    async (keepUnsure) => {
      const test = context(
        fake((d) => ({ contract, decisions: d.map((v) => ({ ...v, confidence: 0.699 })) })),
      );
      const { output, report } = ok(
        await aiFilterBlock.run({ in: records() }, { ...defaults, keepUnsure }, test.ctx),
      );
      expect(report.decisions[0]).toMatchObject({
        modelDecision: "keep",
        outcome: "review",
        forwarded: keepUnsure,
        confidence: 0.699,
      });
      expect(output.records.length).toBe(keepUnsure ? 1 : 0);
    },
  );
  it("accepts threshold equality", async () => {
    const test = context(
      fake((d) => ({ contract, decisions: d.map((v) => ({ ...v, confidence: 0.7 })) })),
    );
    const { report } = ok(await aiFilterBlock.run({ in: records() }, defaults, test.ctx));
    expect(report.decisions[0]!.outcome).toBe("keep");
  });
  it("allows structured-only records without manufacturing an impossible text quote", async () => {
    const data = records([""]);
    data.records[0]!.fields = { rating: 5 };
    const test = context(fake());
    const { report, output } = ok(
      await aiFilterBlock.run({ in: data }, { ...defaults, fields: "rating" }, test.ctx),
    );
    expect(report.decisions[0]!.quotes).toEqual([]);
    expect(output.records).toEqual(data.records);
  });
  it("forces review for missing fields and literal contradictory include/exclude", async () => {
    for (const change of [{ fields: "missing" }, { include: "seats", exclude: "seats" }]) {
      const test = context(fake());
      const { report } = ok(
        await aiFilterBlock.run({ in: records() }, { ...defaults, ...change }, test.ctx),
      );
      expect(report.decisions[0]).toMatchObject({ modelDecision: "keep", outcome: "review" });
    }
  });
  it("parses selected fields and includes criteria, examples, scope and data isolation in prompt", async () => {
    const data = records();
    data.records[0]!.fields = { comment: "Seats are comfortable.", rating: 5 };
    const llm = fake();
    const test = context(llm);
    const { report } = ok(
      await aiFilterBlock.run(
        { in: data },
        {
          ...defaults,
          criterion: "Keep relevant customer experience",
          include: "seats",
          exclude: "tax",
          examples: "Keep: comfortable seats",
          fields: " comment, rating,comment ",
          model: "default",
        },
        test.ctx,
      ),
    );
    const request = vi.mocked(llm.generateObject).mock.calls[0]![0];
    const payload = JSON.parse(request.prompt);
    expect(report.configuration.fields).toEqual(["comment", "rating"]);
    expect(payload.items[0].assessed).toEqual({ comment: "Seats are comfortable.", rating: 5 });
    expect(payload.scope).toEqual(test.ctx.scope);
    expect(request.tier).toBe("default");
    expect(request.system).toContain("untrusted DATA");
    expect(request.system).toContain("conflicting and minority");
  });
  it("all excluded means empty arrays, not orphan resurrection", async () => {
    const test = context(
      fake((d) => ({ contract, decisions: d.map((v) => ({ ...v, decision: "exclude" })) })),
    );
    const data = records();
    data.metadata = { preserved: true };
    const { output } = ok(await aiFilterBlock.run({ in: data }, defaults, test.ctx));
    expect(output).toEqual({ ...emptyPipelineData(), metadata: data.metadata });
  });
  it("sources-only and empty envelopes preserve context without classification", async () => {
    for (const data of [emptyPipelineData(), { ...records(), records: [] }]) {
      const test = context(fake());
      const { output, report } = ok(await aiFilterBlock.run({ in: data }, defaults, test.ctx));
      expect(output).toEqual(data);
      expect(report.primaryLayer).toBe("sources");
      expect(report.decisions).toEqual([]);
      expect(test.ctx.llm.generateObject).not.toHaveBeenCalled();
      expect(test.audit.record).not.toHaveBeenCalled();
    }
  });
  it("blank records can be reviewed without fabricated quotes", async () => {
    const test = context();
    const { report } = ok(await aiFilterBlock.run({ in: records([""]) }, defaults, test.ctx));
    expect(report.decisions[0]).toMatchObject({
      modelDecision: "review",
      quotes: [],
      model: "mock:fast",
    });
  });
  it("batches at 20 and bounds prompts to 48000 without truncation", async () => {
    const llm = fake();
    const test = context(llm);
    const { report } = ok(
      await aiFilterBlock.run(
        { in: records(Array(41).fill("Seats are great.")) },
        defaults,
        test.ctx,
      ),
    );
    expect(report.decisions).toHaveLength(41);
    expect(
      vi.mocked(llm.generateObject).mock.calls.map(([r]) => JSON.parse(r.prompt).items.length),
    ).toEqual([20, 20, 1]);
    const llm2 = fake();
    await aiFilterBlock.run(
      { in: records(Array(10).fill("Seats " + "x".repeat(2000))) },
      defaults,
      context(llm2).ctx,
    );
    expect(vi.mocked(llm2.generateObject).mock.calls.length).toBeGreaterThan(1);
    for (const [request] of vi.mocked(llm2.generateObject).mock.calls)
      expect(request.prompt.length).toBeLessThanOrEqual(48000);
  });
  it("rejects oversized item before model calls", async () => {
    const test = context(fake());
    await expect(
      aiFilterBlock.run({ in: records(["x".repeat(48000)]) }, defaults, test.ctx),
    ).rejects.toThrow("no input was truncated");
    expect(test.ctx.llm.generateObject).not.toHaveBeenCalled();
  });
  it("rejects a bad late batch without accepting or auditing partial classifications", async () => {
    const llm = fake();
    const original = llm.generateObject;
    let calls = 0;
    llm.generateObject = async (request) => {
      if (++calls === 2)
        return { object: { contract, decisions: [] } as any, model: "synthetic-model" };
      return original(request);
    };
    const test = context(llm);
    await expect(
      aiFilterBlock.run({ in: records(Array(21).fill("Seats.")) }, defaults, test.ctx),
    ).rejects.toThrow("coverage");
    expect(test.audit.record).not.toHaveBeenCalled();
  });
  it.each(["before", "batch", "overrides", "audit"])(
    "cancels %s without accepting output",
    async (when) => {
      const llm = fake();
      const test = context(llm);
      if (when === "before") test.controller.abort();
      if (when === "batch") {
        const original = llm.generateObject;
        llm.generateObject = async (request) => {
          const value = await original(request);
          test.controller.abort();
          return value;
        };
      }
      if (when === "overrides")
        test.ctx.filterOverrides = async () => {
          test.controller.abort();
          return [];
        };
      if (when === "audit")
        test.audit.record.mockImplementation(async () => {
          test.controller.abort();
          return {};
        });
      await expect(
        aiFilterBlock.run({ in: records(Array(21).fill("Seats.")) }, defaults, test.ctx),
      ).rejects.toThrow("cancelled");
      if (when !== "audit") expect(test.audit.record).not.toHaveBeenCalled();
      else expect(test.audit.record).toHaveBeenCalledTimes(1);
    },
  );
  it("sanitizes errors from provider, overrides, and audit", async () => {
    for (const operation of ["provider", "override", "audit"]) {
      const test = context(fake());
      const failure = async () => {
        throw new Error("sensitive synthetic text");
      };
      if (operation === "provider") test.ctx.llm.generateObject = failure;
      if (operation === "override") test.ctx.filterOverrides = failure;
      if (operation === "audit") test.audit.record.mockImplementation(failure);
      await expect(aiFilterBlock.run({ in: records() }, defaults, test.ctx)).rejects.not.toThrow(
        "sensitive synthetic text",
      );
    }
  });
  it("rejects invalid input/duplicate IDs/configuration/ports and inconsistent available evidence", async () => {
    const data = records();
    for (const input of [
      { ...data, records: [data.records[0], data.records[0]] },
      { ...data, records: [{}] },
    ]) {
      await expect(
        aiFilterBlock.run({ in: input as PipelineData }, defaults, context(fake()).ctx),
      ).rejects.toThrow("AI Filter");
    }
    await expect(
      aiFilterBlock.run({ in: data }, { ...defaults, criterion: " " }, context(fake()).ctx),
    ).rejects.toThrow("nonblank");
    await expect(
      aiFilterBlock.run({ in: data, extra: data }, defaults, context(fake()).ctx),
    ).rejects.toThrow("input port");
    await expect(aiFilterBlock.run({}, defaults, context(fake()).ctx)).rejects.toThrow(
      "input port",
    );
    const evidence = structuredClone(fixturePipelineData);
    evidence.records[0]!.text = "Changed synthetic text.";
    await expect(
      aiFilterBlock.run({ in: evidence }, defaults, context(fake()).ctx),
    ).rejects.toThrow("inconsistent");
  });
});

describe("evidence closure and human restore hashes", () => {
  function linked() {
    const data = records(["Seats are great.", "Seats are poor.", "Orphan screen."]);
    const base = fixturePipelineData.findings[0]!;
    data.findings = [0, 1].map((i) => ({
      ...base,
      id: `fnd_${i}`,
      statement: data.records[i]!.text,
      themeId: "thm_shared",
      evidence: [
        { sourceId: data.sources[0]!.id, recordId: `rec_${i}`, excerpt: data.records[i]!.text },
      ],
    }));
    data.themes = [
      {
        id: "thm_shared",
        label: "Seats",
        summary: "Conflicting synthetic evidence",
        category: base.category,
        findingIds: ["fnd_0", "fnd_1"],
      },
    ];
    return data;
  }
  it("classifies requirements first and retains full conflicting findings, theme siblings and records", async () => {
    const data = linked();
    data.requirements = [
      {
        ...fixtureRequirements[0]!,
        findingIds: ["fnd_0"],
        conflictingFindingIds: ["fnd_1"],
        sourceIds: [data.sources[0]!.id],
      },
    ];
    const test = context(fake());
    const { output, report } = ok(
      await aiFilterBlock.run({ in: freeze(data) }, defaults, test.ctx),
    );
    expect(report.primaryLayer).toBe("requirements");
    // The requirement, plus the record nothing refers to: classified on its own, not dropped.
    expect(report.decisions.map((d) => [d.layer, d.itemId])).toEqual([
      ["requirements", data.requirements[0]!.id],
      ["records", "rec_2"],
    ]);
    expect(report.decisions[0]!.quotes).toEqual([]);
    expect(output.findings).toEqual(data.findings);
    expect(output.themes).toEqual(data.themes);
    expect(output.records).toEqual(data.records);
    expect(output.requirements[0]).toBe(data.requirements[0]);
  });
  it("classifies feedback without findings next to findings from other inputs", async () => {
    const data = linked();
    data.themes = [];
    for (const f of data.findings) f.themeId = undefined;
    data.findings = data.findings.slice(0, 1); // rec_1 and rec_2 have no finding
    const test = context(fake());
    const { output, report } = ok(await aiFilterBlock.run({ in: data }, defaults, test.ctx));
    expect(report.primaryLayer).toBe("findings");
    expect(report.decisions.map((d) => [d.layer, d.itemId])).toEqual([
      ["findings", "fnd_0"],
      ["records", "rec_1"],
      ["records", "rec_2"],
    ]);
    expect(output.records).toEqual(data.records);
  });
  it("classifies themes before findings and preserves referenced excluded primary as context, cycle safe", async () => {
    const data = linked();
    data.themes.push({ ...data.themes[0]!, id: "thm_other", findingIds: ["fnd_1"] });
    const test = context(
      fake((d) => ({
        contract,
        decisions: d.map((v, i) => ({ ...v, decision: i ? "exclude" : "keep" })),
      })),
    );
    const { output, report } = ok(await aiFilterBlock.run({ in: data }, defaults, test.ctx));
    expect(report.primaryLayer).toBe("themes");
    expect(output.themes).toEqual(data.themes);
    expect(report.decisions[1]).toMatchObject({
      modelDecision: "exclude",
      outcome: "exclude",
      forwarded: true,
      retainedAsContext: true,
    });
    expect(report.warnings.join(" ")).toContain("context");
  });
  it("classifies findings before records and reports unavailable links without inventing them", async () => {
    const data = linked();
    data.themes = [];
    data.findings[0]!.themeId = undefined;
    data.findings[1]!.themeId = undefined;
    data.findings[0]!.evidence.push({
      sourceId: "src_unavailable",
      recordId: "rec_unavailable",
      excerpt: "synthetic missing evidence",
    });
    const test = context(
      fake((d) => ({
        contract,
        decisions: d.map((v, i) => ({ ...v, decision: i ? "exclude" : "keep" })),
      })),
    );
    const { output, report } = ok(await aiFilterBlock.run({ in: data }, defaults, test.ctx));
    expect(report.primaryLayer).toBe("findings");
    expect(output.findings).toEqual([data.findings[0]]);
    expect(output.records).toEqual([data.records[0]]);
    expect(output.findings[0]!.evidence).toHaveLength(2);
    expect(report.warnings.join(" ")).toContain("Unavailable");
  });
  it("requires quotes to belong to the individual item context, not other available records", async () => {
    const data = linked();
    data.themes = [];
    for (const finding of data.findings) finding.themeId = undefined;
    const test = context(
      fake((d) => ({
        contract,
        decisions: d.map((v) => ({
          ...v,
          quotes: [{ recordId: "rec_2", excerpt: "Orphan screen." }],
        })),
      })),
    );
    await expect(aiFilterBlock.run({ in: data }, defaults, test.ctx)).rejects.toThrow(
      "supplied record context",
    );
  });
  it("applies only matching human restores and preserves the model classification", async () => {
    const data = records(["Pricing and tax."]);
    const test = context();
    const first = ok(await aiFilterBlock.run({ in: data }, defaults, test.ctx));
    const override: FilterOverride = {
      itemId: "rec_0",
      itemHash: first.report.decisions[0]!.itemHash,
      configurationHash: first.report.configurationHash,
      actor: { type: "human", userId: "human_test", name: "Synthetic reviewer" },
      at: new Date().toISOString(),
      rationale: "Restore for synthetic contextual comparison",
      version: 1,
    };
    test.ctx.filterOverrides = async () => [override];
    const restored = ok(await aiFilterBlock.run({ in: data }, defaults, test.ctx));
    expect(restored.report.decisions[0]).toMatchObject({
      modelDecision: "exclude",
      outcome: "keep",
      override,
      forwarded: true,
    });
    expect(restored.output.records[0]).toBe(data.records[0]);
    for (const change of [
      { include: "seats" },
      { exclude: "tax" },
      { examples: "Keep: pricing" },
      { fields: "text" },
      { model: "default" },
      { minConfidence: 0.9 },
      { keepUnsure: false },
      { criterion: "Other" },
    ]) {
      const result = ok(
        await aiFilterBlock.run({ in: data }, { ...defaults, ...change }, test.ctx),
      );
      expect(result.report.configurationHash).not.toBe(first.report.configurationHash);
      expect(result.report.decisions[0]!.override).toBeUndefined();
    }
    for (const mutate of [
      (d: PipelineData) => {
        d.records[0]!.text += " Changed.";
      },
      (d: PipelineData) => {
        (d.records[0] as any).extra = true;
      },
      (d: PipelineData) => {
        d.sources[0]!.title += " Changed.";
      },
    ]) {
      const changed = structuredClone(data);
      mutate(changed);
      expect(
        ok(await aiFilterBlock.run({ in: changed }, defaults, test.ctx)).report.decisions[0]!
          .override,
      ).toBeUndefined();
    }
    test.ctx.scope = { ...test.ctx.scope, market: "US" };
    expect(
      ok(await aiFilterBlock.run({ in: data }, defaults, test.ctx)).report.decisions[0]!.override,
    ).toBeUndefined();
  });
  it("invalidates overrides when actual provider model changes or item hash mismatches", async () => {
    const data = records();
    const test = context(fake());
    const first = ok(await aiFilterBlock.run({ in: data }, defaults, test.ctx));
    const override: FilterOverride = {
      itemId: "rec_0",
      itemHash: first.report.decisions[0]!.itemHash,
      configurationHash: first.report.configurationHash,
      actor: { type: "human", userId: "human_test", name: "Synthetic reviewer" },
      at: new Date().toISOString(),
      rationale: "Synthetic restoration",
      version: 1,
    };
    test.ctx.filterOverrides = async () => [{ ...override, itemHash: "0".repeat(64) }];
    expect(
      ok(await aiFilterBlock.run({ in: data }, defaults, test.ctx)).report.decisions[0]!.override,
    ).toBeUndefined();
    test.ctx.filterOverrides = async () => [override];
    const original = test.ctx.llm.generateObject;
    test.ctx.llm.generateObject = async (request) => ({
      ...(await original(request)),
      model: "changed-model",
    });
    const changed = ok(await aiFilterBlock.run({ in: data }, defaults, test.ctx));
    expect(changed.report.configurationHash).not.toBe(first.report.configurationHash);
    expect(changed.report.decisions[0]!.override).toBeUndefined();
  });
  it("rejects malformed/nonhuman overrides", async () => {
    const test = context();
    test.ctx.filterOverrides = async () => [{ actor: { type: "ai" } } as unknown as FilterOverride];
    await expect(aiFilterBlock.run({ in: records() }, defaults, test.ctx)).rejects.toThrow(
      "overrides are invalid",
    );
  });
  it("hashes recursive key order deterministically and includes all extensions", () => {
    expect(filterHash({ z: { b: 1, a: [2, { y: true, x: 0 }] }, a: null })).toBe(
      filterHash({ a: null, z: { a: [2, { x: 0, y: true }], b: 1 } }),
    );
    expect(filterHash({ id: "rec_1", extra: 1 })).not.toBe(filterHash({ id: "rec_1", extra: 2 }));
    const cycle: any = {};
    cycle.self = cycle;
    expect(() => filterHash(cycle)).toThrow("JSON");
    expect(() => filterHash({ invalid: NaN })).toThrow("JSON");
  });
});
