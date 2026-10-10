import {
  DATA_KEYS,
  DEFAULT_SETTINGS,
  PipelineData,
  ScoreFactor,
  defaultBlockParams,
  emptyPipelineData,
  type LlmClient,
  type PipelineData as Data,
} from "@reqflow/core";
import { fixturePipelineData, fixtureRecords, fixtureRequirements } from "@reqflow/core/fixtures";
import type { BlockContext, BlockResult } from "@reqflow/engine";
import { createLlmClient } from "@reqflow/llm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { aiSplitterBlock } from "./ai-splitter";
import { aiSplitterImplementations } from "./index";
import { Assignments, Scores } from "./protocol";

const defaults = defaultBlockParams("ai_splitter");
function context(llm = createLlmClient(DEFAULT_SETTINGS.llm), controller = new AbortController()) {
  const log = vi.fn();
  const progress = vi.fn();
  const audit = { record: vi.fn() };
  return {
    log,
    progress,
    audit,
    controller,
    ctx: {
      settings: structuredClone(DEFAULT_SETTINGS),
      llm,
      log,
      progress,
      audit,
      signal: controller.signal,
    } as unknown as BlockContext,
  };
}
function records(texts: string[]): Data {
  return {
    ...emptyPipelineData(),
    sources: fixturePipelineData.sources.slice(0, 1),
    records: texts.map((text, i) => ({ ...fixtureRecords[0]!, id: `rec_${i}`, text })),
  };
}
function outputs(result: BlockResult) {
  if (result.status !== "ok") throw new Error("Splitter must not pause");
  return result.outputs;
}
function fakeLlm(object: unknown): LlmClient {
  return {
    generateObject: vi.fn(async () => ({
      object,
      model: "recorded-test-model",
    })) as LlmClient["generateObject"],
    generateText: vi.fn(),
  };
}

// Assert schema nodes, not property names or annotation contents, against the documented subset.
function assertAnthropicSchema(schema: Record<string, unknown>): void {
  const supported = new Set([
    "type",
    "title",
    "description",
    "enum",
    "const",
    "default",
    "required",
    "additionalProperties",
    "properties",
    "items",
    "anyOf",
    "allOf",
    "$ref",
    "$defs",
    "definitions",
    "format",
    "minItems",
  ]);
  for (const key of Object.keys(schema))
    expect(supported.has(key), `Unsupported schema keyword ${key}`).toBe(true);
  if (schema.type === "object") expect(schema.additionalProperties).toBe(false);
  if (schema.minItems !== undefined) expect([0, 1]).toContain(schema.minItems);
  if (schema.properties)
    for (const property of Object.values(
      schema.properties as Record<string, Record<string, unknown>>,
    ))
      assertAnthropicSchema(property);
  if (schema.items) assertAnthropicSchema(schema.items as Record<string, unknown>);
  for (const key of ["anyOf", "allOf"] as const) {
    if (schema[key])
      for (const alternative of schema[key] as Record<string, unknown>[])
        assertAnthropicSchema(alternative);
  }
  for (const key of ["$defs", "definitions"] as const) {
    if (schema[key])
      for (const definition of Object.values(
        schema[key] as Record<string, Record<string, unknown>>,
      ))
        assertAnthropicSchema(definition);
  }
}

describe("Anthropic transport with actual AI Splitter schemas", () => {
  const factors = Object.fromEntries(
    ScoreFactor.options.map((factor) => [
      factor,
      { value: 2, note: "Assumption: recorded synthetic value" },
    ]),
  );
  const cases: { name: string; schema: z.ZodType<unknown>; valid: unknown; invalid: unknown }[] = [
    {
      name: "Assignments",
      schema: Assignments,
      valid: {
        assignments: [{ id: "rec_test", branchIndex: 1, reason: "Recorded synthetic route" }],
      },
      invalid: { assignments: [{ id: "rec_test", branchIndex: 10, reason: "Out of range" }] },
    },
    {
      name: "Scores",
      schema: Scores,
      valid: { scores: [{ id: "rec_test", factors }] },
      invalid: {
        scores: [
          {
            id: "rec_test",
            factors: { ...factors, ease: { value: 6, note: "Assumption: invalid value" } },
          },
        ],
      },
    },
  ];
  it.each(cases)(
    "adapts $name to closed supported JSON Schema and keeps original local bounds",
    async ({ name, schema, valid, invalid }) => {
      const original = z.toJSONSchema(schema);
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              model: "recorded-anthropic-model",
              stop_reason: "end_turn",
              content: [{ type: "text", text: JSON.stringify(valid) }],
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              model: "recorded-anthropic-model",
              stop_reason: "end_turn",
              content: [{ type: "text", text: JSON.stringify(invalid) }],
            }),
          ),
        );
      const client = createLlmClient(
        { ...DEFAULT_SETTINGS.llm, provider: "anthropic" },
        { apiKey: "synthetic-test-key", fetch },
      );
      expect(await client.generateObject({ schema, prompt: "Recorded test" })).toEqual({
        object: valid,
        model: "recorded-anthropic-model",
      });
      const sent = JSON.parse(fetch.mock.calls[0]![1]!.body as string).output_config.format
        .schema as Record<string, unknown>;
      assertAnthropicSchema(sent);
      if (name === "Scores") {
        const factorSchema = (sent.properties as Record<string, any>).scores.items.properties
          .factors;
        expect(Object.keys(factorSchema.properties)).toEqual(ScoreFactor.options);
        expect(factorSchema.required).toEqual(ScoreFactor.options);
        expect(factorSchema.additionalProperties).toBe(false);
        expect(factorSchema.propertyNames).toBeUndefined();
      }
      await expect(
        client.generateObject({ schema, prompt: "Recorded invalid value" }),
      ).rejects.toThrow();
      expect(z.toJSONSchema(schema)).toEqual(original);
    },
  );
});

describe("AI Splitter", () => {
  it("registers exactly one implementation", () => {
    expect(aiSplitterImplementations).toEqual([aiSplitterBlock]);
  });

  it.each(["category", "sentiment", "custom"] as const)(
    "routes %s with one validated assignment per primary item and stable input order",
    async (splitBy) => {
      const input = records(["first", "second", "third"]);
      const llm = fakeLlm({
        assignments: [
          { id: "rec_2", branchIndex: 0, reason: "same group" },
          { id: "rec_1", branchIndex: 1, reason: "other group" },
          { id: "rec_0", branchIndex: 0, reason: "same group" },
        ],
      });
      const c = context(llm);
      const out = outputs(
        await aiSplitterBlock.run(
          { in: input },
          {
            ...defaults,
            splitBy,
            branches: ["A", "B"],
            instruction: "Use subject matter",
          },
          c.ctx,
        ),
      );
      expect(Object.keys(out)).toEqual(["out-0", "out-1"]);
      expect(out["out-0"]!.records.map((r) => r.id)).toEqual(["rec_0", "rec_2"]);
      expect(out["out-1"]!.records.map((r) => r.id)).toEqual(["rec_1"]);
      for (const envelope of Object.values(out))
        expect(PipelineData.safeParse(envelope).success).toBe(true);
      expect(c.log.mock.calls.flat().join(" ")).toContain("same group");
      const request = vi.mocked(llm.generateObject).mock.calls[0]![0];
      expect(request).toMatchObject({ tier: "default", signal: c.controller.signal });
      expect(request.system).toMatch(/untrusted/i);
      expect(JSON.parse(request.prompt)).toMatchObject({ mode: splitBy, branches: ["A", "B"] });
      expect(c.progress).toHaveBeenLastCalledWith(1, expect.any(String));
    },
  );

  it("supports ten outputs and leaves unused branches completely empty", async () => {
    const out = outputs(
      await aiSplitterBlock.run(
        { in: records(["Comfort"]) },
        {
          ...defaults,
          splitBy: "category",
          branches: Array.from({ length: 10 }, (_, i) => `Group ${i}`),
          model: "fast",
        },
        context().ctx,
      ),
    );
    expect(Object.keys(out)).toHaveLength(10);
    expect(Object.values(out).filter((d) => d.records.length)).toHaveLength(1);
    for (const d of Object.values(out).filter((d) => !d.records.length))
      expect(d).toEqual(emptyPipelineData());
  });

  it("preserves all evidence, conflicts, original extension fields, and requirement statuses without mutations", async () => {
    const input = structuredClone(fixturePipelineData);
    Object.assign(input.requirements[3]!, { provenance: { originBlock: "synthetic-upstream" } });
    Object.assign(input.findings[7]!, { provenance: { line: 22 } });
    const before = structuredClone(input);
    const c = context();
    const out = outputs(await aiSplitterBlock.run({ in: input }, defaults, c.ctx));
    const branch = out["out-0"]!;
    const override = branch.requirements.find((r) => r.id === fixtureRequirements[3]!.id)!;
    expect(override).toBe(input.requirements[3]);
    expect(override).toMatchObject({
      status: "approved",
      priority: "must",
      provenance: { originBlock: "synthetic-upstream" },
    });
    expect(branch.findings.map((f) => f.id)).toEqual(
      expect.arrayContaining(["fnd_range", "fnd_comp_charge", "fnd_grille_praise"]),
    );
    expect(branch.records.map((r) => r.id)).toEqual(
      expect.arrayContaining(["rec_study002", "rec_comp001", "rec_fb002"]),
    );
    expect(branch.sources.map((s) => s.id)).toEqual(
      expect.arrayContaining(["src_study01", "src_comp01"]),
    );
    expect(branch.findings.find((f) => f.id === "fnd_range")).toMatchObject({
      provenance: { line: 22 },
    });
    expect(input).toEqual(before);
    expect(Object.values(out).flatMap((d) => d.requirements)).toHaveLength(
      input.requirements.length,
    );
    for (const key of ["sources", "records", "findings", "themes"] as const) {
      const seen = new Set(Object.values(out).flatMap((d) => d[key].map((v) => v.id)));
      expect(seen).toEqual(new Set(input[key].map((v) => v.id)));
    }
    expect(c.log.mock.calls.flat().join(" ")).toMatch(/orphan.*context/i);
    expect(c.audit.record).not.toHaveBeenCalled();
  });

  it("closes every available evidence reference per priority output, including retained orphan dependencies", async () => {
    const input = structuredClone(fixturePipelineData);
    Object.assign(
      input.sources.find((source) => source.id === "src_equip01")!,
      {
        provenance: { originBlock: "synthetic-equipment" },
      },
    );
    const before = structuredClone(input);
    const out = outputs(await aiSplitterBlock.run({ in: input }, defaults, context().ctx));
    expect(out["out-0"]!.findings.some((finding) => finding.id === "fnd_seats_usage")).toBe(true);
    expect(out["out-0"]!.records.some((record) => record.id === "rec_equip001")).toBe(true);
    expect(out["out-0"]!.sources.map((source) => source.id)).toContain("src_equip01");
    expect(out["out-1"]!.sources.map((source) => source.id)).toContain("src_equip01");

    for (const branch of Object.values(out)) {
      const available = Object.fromEntries(
        DATA_KEYS.map((key) => [key, new Set(input[key].map((item) => item.id))]),
      );
      const present = Object.fromEntries(
        DATA_KEYS.map((key) => [key, new Set(branch[key].map((item) => item.id))]),
      );
      function resolves(key: (typeof DATA_KEYS)[number], id: string) {
        if (available[key]!.has(id))
          expect(present[key]!.has(id), `${key}:${id} missing from referring output`).toBe(true);
      }
      for (const requirement of branch.requirements) {
        for (const id of [...requirement.findingIds, ...requirement.conflictingFindingIds])
          resolves("findings", id);
        for (const id of requirement.sourceIds) resolves("sources", id);
      }
      for (const theme of branch.themes)
        for (const id of theme.findingIds) resolves("findings", id);
      for (const finding of branch.findings) {
        if (finding.themeId) resolves("themes", finding.themeId);
        for (const evidence of finding.evidence) {
          resolves("sources", evidence.sourceId);
          if (evidence.recordId) resolves("records", evidence.recordId);
        }
      }
      for (const record of branch.records) resolves("sources", record.sourceId);
      for (const key of DATA_KEYS) {
        const originalById = new Map(input[key].map((item) => [item.id, item]));
        expect(branch[key]).toEqual(input[key].filter((item) => present[key]!.has(item.id)));
        for (const item of branch[key]) expect(item).toBe(originalById.get(item.id));
      }
    }
    expect(
      Object.values(out)
        .flatMap((branch) => branch.requirements)
        .map((item) => item.id)
        .sort(),
    ).toEqual(input.requirements.map((item) => item.id).sort());
    expect(input).toEqual(before);
  });

  it.each(["themes", "findings"] as const)(
    "uses %s as primary and does not classify supporting records",
    async (layer) => {
      const input = structuredClone(fixturePipelineData);
      input.requirements = [];
      if (layer === "findings") input.themes = [];
      const llm = fakeLlm({
        assignments: input[layer].map((item) => ({
          id: item.id,
          branchIndex: 1,
          reason: "primary only",
        })),
      });
      const c = context(llm);
      const out = outputs(
        await aiSplitterBlock.run(
          { in: input },
          {
            ...defaults,
            splitBy: "category",
            branches: ["A", "B"],
          },
          c.ctx,
        ),
      );
      expect(out["out-0"]).toEqual(emptyPipelineData());
      expect(out["out-1"]).toEqual(input);
      const request = JSON.parse(vi.mocked(llm.generateObject).mock.calls[0]![0].prompt);
      expect(request.items.map((i: { id: string }) => i.id)).toEqual(input[layer].map((v) => v.id));
    },
  );

  it("retains orphan context once on first occupied output, not on every branch", async () => {
    const input = structuredClone(fixturePipelineData);
    input.themes = [];
    input.requirements = input.requirements.slice(0, 1);
    const c = context(
      fakeLlm({
        assignments: [{ id: input.requirements[0]!.id, branchIndex: 1, reason: "selected" }],
      }),
    );
    const out = outputs(
      await aiSplitterBlock.run({ in: input }, { ...defaults, splitBy: "category" }, c.ctx),
    );
    expect(out["out-0"]).toEqual(emptyPipelineData());
    expect(out["out-2"]).toEqual(emptyPipelineData());
    expect(out["out-1"]).toEqual(input);
  });

  it("does not call LLM on empty input; retains source-only context explicitly", async () => {
    const llm = fakeLlm(null);
    const c = context(llm);
    const out = outputs(await aiSplitterBlock.run({}, defaults, c.ctx));
    expect(Object.values(out)).toEqual([
      emptyPipelineData(),
      emptyPipelineData(),
      emptyPipelineData(),
    ]);
    expect(llm.generateObject).not.toHaveBeenCalled();
    const input = { ...emptyPipelineData(), sources: fixturePipelineData.sources.slice(0, 1) };
    const sourceOut = outputs(await aiSplitterBlock.run({ in: input }, defaults, c.ctx));
    expect(sourceOut["out-0"]).toEqual(input);
    expect(sourceOut["out-1"]).toEqual(emptyPipelineData());
    expect(c.log.mock.calls.flat().join(" ")).toMatch(/source-only.*context/i);
  });

  it.each([
    { assignments: [{ id: "rec_unknown", branchIndex: 0, reason: "x" }] },
    { assignments: [] },
    {
      assignments: [
        { id: "rec_0", branchIndex: 0, reason: "x" },
        { id: "rec_0", branchIndex: 1, reason: "x" },
      ],
    },
    { assignments: [{ id: "rec_0", branchIndex: 2, reason: "x" }] },
    { assignments: [{ id: "rec_0", branchIndex: 0.5, reason: "x" }] },
    { assignments: [{ id: "rec_0", branchIndex: 0, reason: " " }] },
    { assignments: [{ id: "rec_0", branchIndex: 0, reason: "x", invented: true }] },
    { assignments: null },
  ])("rejects malformed or semantically invalid assignments: %j", async (answer) => {
    await expect(
      aiSplitterBlock.run(
        { in: records(["one"]) },
        {
          ...defaults,
          splitBy: "category",
          branches: ["A", "B"],
        },
        context(fakeLlm(answer)).ctx,
      ),
    ).rejects.toThrow();
  });

  it("validates params, input ports, schemas, and duplicate input IDs even on direct calls", async () => {
    for (const params of [
      { ...defaults, branches: ["Only"] },
      { ...defaults, branches: Array(11).fill("A") },
      { ...defaults, branches: ["A", " a "] },
      { ...defaults, splitBy: "custom", instruction: " " },
      { ...defaults, splitBy: "bogus" },
      { ...defaults, extra: "not supported" },
    ])
      await expect(aiSplitterBlock.run({}, params, context().ctx)).rejects.toThrow();
    await expect(
      aiSplitterBlock.run({ other: records(["one"]) }, defaults, context().ctx),
    ).rejects.toThrow(/input port/i);
    await expect(
      aiSplitterBlock.run(
        { in: { ...records(["one"]), records: [{}] } as Data },
        defaults,
        context().ctx,
      ),
    ).rejects.toThrow();
    const duplicate = records(["one"]);
    duplicate.records.push(duplicate.records[0]!);
    await expect(aiSplitterBlock.run({ in: duplicate }, defaults, context().ctx)).rejects.toThrow(
      /duplicate/i,
    );
  });

  it("recomputes existing factor values with current weights and thresholds without persisting scores", async () => {
    const input = structuredClone(fixturePipelineData);
    input.requirements = input.requirements.slice(0, 1);
    delete input.requirements[0]!.priority;
    const c = context(fakeLlm(null));
    c.ctx.settings.scoring.weights = Object.fromEntries(
      ScoreFactor.options.map((f) => [f, f === "customer_impact" ? 1 : 0]),
    ) as typeof DEFAULT_SETTINGS.scoring.weights;
    c.ctx.settings.scoring.thresholds = { must: 90, should: 85, could: 80 };
    const out = outputs(
      await aiSplitterBlock.run(
        { in: input },
        { ...defaults, branches: ["Won't have", "Must have", "Could have", "Should have"] },
        c.ctx,
      ),
    );
    expect(out["out-2"]!.requirements).toEqual(input.requirements);
    expect(c.ctx.llm.generateObject).not.toHaveBeenCalled();
    expect(c.log.mock.calls.flat().join(" ")).toMatch(/80.*could/i);
    expect(input.requirements[0]!.score).toEqual(fixtureRequirements[0]!.score);
  });

  it("scores missing factors provisionally in code and logs every evidence/assumption note", async () => {
    const factors = Object.fromEntries(
      ScoreFactor.options.map((f) => [
        f,
        { value: 1, note: "Assumption: unmeasured synthetic estimate" },
      ]),
    );
    const c = context(fakeLlm({ scores: [{ id: "rec_0", factors }] }));
    const out = outputs(
      await aiSplitterBlock.run({ in: records(["unmeasured need"]) }, defaults, c.ctx),
    );
    expect(out["out-2"]!.records.map((r) => r.id)).toEqual(["rec_0"]);
    const logs = c.log.mock.calls.flat().join(" ");
    expect(logs).toMatch(/WS8.*unavailable/i);
    expect(logs).toMatch(/provisional.*20/i);
    expect(logs).toMatch(/wont.*fallback/i);
    expect(logs).toContain("Assumption: unmeasured synthetic estimate");
    expect(c.audit.record).not.toHaveBeenCalled();
  });

  it.each([
    [3.5, "out-0"],
    [2.5, "out-1"],
    [1.5, "out-2"],
    [1.49, "out-3"],
  ])("uses inclusive Settings thresholds at factor %s", async (value, branch) => {
    const factors = Object.fromEntries(
      ScoreFactor.options.map((f) => [f, { value, note: "Assumption: synthetic threshold test" }]),
    );
    const out = outputs(
      await aiSplitterBlock.run(
        { in: records(["threshold"]) },
        {
          ...defaults,
          branches: ["Must", "Should", "Could", "Won’t have"],
        },
        context(fakeLlm({ scores: [{ id: "rec_0", factors }] })).ctx,
      ),
    );
    expect(out[branch as string]!.records.map((r) => r.id)).toEqual(["rec_0"]);
  });

  it("supports two named priority outputs with explicit lower-band coarsening", async () => {
    const c = context();
    const out = outputs(
      await aiSplitterBlock.run(
        { in: records(["synthetic"]) },
        {
          ...defaults,
          branches: ["Should have", "Must have"],
        },
        c.ctx,
      ),
    );
    expect(Object.keys(out)).toEqual(["out-0", "out-1"]);
    expect(out["out-0"]!.records).toHaveLength(1);
    expect(c.log.mock.calls.flat().join(" ")).toMatch(/could.*fallback.*Should have/);
  });

  it.each([
    'Evidence: src_invented | "synthetic" | unsupported judgement',
    'Evidence: rec_0 | "invented quote" | unsupported judgement',
    "Measured sales rose by 200%",
  ])("rejects unsupported evidence and unlabeled factor notes: %s", async (note) => {
    const factors = Object.fromEntries(ScoreFactor.options.map((f) => [f, { value: 2, note }]));
    await expect(
      aiSplitterBlock.run(
        { in: records(["synthetic"]) },
        defaults,
        context(fakeLlm({ scores: [{ id: "rec_0", factors }] })).ctx,
      ),
    ).rejects.toThrow(/note|evidence|excerpt/i);
  });

  it("accepts only verifiable Evidence notes for provisional factors", async () => {
    const factors = Object.fromEntries(
      ScoreFactor.options.map((f) => [
        f,
        { value: 2, note: 'Evidence: rec_0 | "synthetic" | provisional judgement, not measured' },
      ]),
    );
    const out = outputs(
      await aiSplitterBlock.run(
        { in: records(["synthetic record"]) },
        defaults,
        context(fakeLlm({ scores: [{ id: "rec_0", factors }] })).ctx,
      ),
    );
    expect(out["out-2"]!.records).toHaveLength(1);
  });

  it("rejects unknown, missing, duplicate, incomplete, and out-of-range provisional scores", async () => {
    const factors = Object.fromEntries(
      ScoreFactor.options.map((f) => [f, { value: 2, note: "Assumption: synthetic estimate" }]),
    );
    const good = { id: "rec_0", factors };
    const answers = [
      { scores: [{ ...good, id: "rec_unknown" }] },
      { scores: [] },
      { scores: [good, good] },
      { scores: [{ ...good, factors: { customer_impact: factors.customer_impact } }] },
      {
        scores: [
          {
            ...good,
            factors: { ...factors, customer_impact: { value: 6, note: "Assumption: invalid" } },
          },
        ],
      },
    ];
    for (const answer of answers)
      await expect(
        aiSplitterBlock.run({ in: records(["synthetic"]) }, defaults, context(fakeLlm(answer)).ctx),
      ).rejects.toThrow();
  });

  it("supports deterministic mock category, sentiment, and custom contracts offline", async () => {
    const category = structuredClone(fixturePipelineData);
    category.requirements = category.requirements.slice(0, 1);
    const categoryOut = outputs(
      await aiSplitterBlock.run(
        { in: category },
        {
          ...defaults,
          splitBy: "category",
          branches: ["Space & practicality", "Other"],
        },
        context().ctx,
      ),
    );
    expect(categoryOut["out-0"]!.requirements).toEqual(category.requirements);
    const sentimentOut = outputs(
      await aiSplitterBlock.run(
        { in: records(["great", "bad", "unknown"]) },
        {
          ...defaults,
          splitBy: "sentiment",
          branches: ["Positive", "Negative", "Neutral"],
        },
        context().ctx,
      ),
    );
    expect(Object.values(sentimentOut).map((data) => data.records[0]!.text)).toEqual([
      "great",
      "bad",
      "unknown",
    ]);
    const customOut = outputs(
      await aiSplitterBlock.run(
        { in: records(["Seats", "Screens"]) },
        {
          ...defaults,
          splitBy: "custom",
          branches: ["Seats", "Screens"],
          instruction: "Group by component keyword",
        },
        context().ctx,
      ),
    );
    expect(Object.values(customOut).map((data) => data.records[0]!.text)).toEqual([
      "Seats",
      "Screens",
    ]);
  });

  it("preserves partial evidence links and explicitly logs unavailable dependencies", async () => {
    const input = { ...emptyPipelineData(), requirements: [fixtureRequirements[3]!] };
    const c = context();
    const out = outputs(await aiSplitterBlock.run({ in: input }, defaults, c.ctx));
    expect(out["out-0"]!.requirements[0]).toBe(input.requirements[0]);
    expect(c.log.mock.calls.flat().join(" ")).toMatch(/Unavailable referenced findings fnd_range/);
    expect(out["out-0"]!.findings).toEqual([]);
  });

  it("rejects evidence-record mismatches and non-verbatim quotations", async () => {
    for (const change of [{ sourceId: "src_wrong" }, { excerpt: "invented quotation" }]) {
      const input = structuredClone(fixturePipelineData);
      Object.assign(input.findings[0]!.evidence[0]!, change);
      await expect(aiSplitterBlock.run({ in: input }, defaults, context().ctx)).rejects.toThrow(
        /source|verbatim/i,
      );
    }
  });

  it("fails oversized prompts explicitly instead of truncating evidence", async () => {
    const c = context(fakeLlm(null));
    await expect(
      aiSplitterBlock.run(
        { in: records(["x".repeat(100_000)]) },
        {
          ...defaults,
          splitBy: "category",
        },
        c.ctx,
      ),
    ).rejects.toThrow(/exceed.*reduce upstream/i);
    expect(c.ctx.llm.generateObject).not.toHaveBeenCalled();
  });

  it.each(["scores", "routing"])(
    "honors pre-cancellation and cancellation while %s response ignores signal",
    async (mode) => {
      const controller = new AbortController();
      const llm: LlmClient = {
        generateObject: vi.fn(() => new Promise<never>(() => {})),
        generateText: vi.fn(),
      };
      const c = context(llm, controller);
      const pending = aiSplitterBlock.run(
        { in: records(["one"]) },
        { ...defaults, splitBy: mode === "scores" ? "priority" : "category" },
        c.ctx,
      );
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await expect(
        aiSplitterBlock.run({ in: records(["one"]) }, defaults, c.ctx),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(llm.generateObject).toHaveBeenCalledTimes(1);
    },
  );

  it("uses bounded batches and forwards fast tier", async () => {
    const llm: LlmClient = {
      generateObject: vi.fn(async (request) => {
        const payload = JSON.parse(request.prompt);
        return {
          object: request.schema.parse({
            assignments: payload.items.map((i: { id: string }) => ({
              id: i.id,
              branchIndex: 0,
              reason: "batch",
            })),
          }),
          model: "batch-test",
        };
      }),
      generateText: vi.fn(),
    };
    const input = records(Array.from({ length: 45 }, (_, i) => `item ${i}`));
    const out = outputs(
      await aiSplitterBlock.run(
        { in: input },
        { ...defaults, splitBy: "category", model: "fast" },
        context(llm).ctx,
      ),
    );
    const calls = vi.mocked(llm.generateObject).mock.calls;
    expect(calls).toHaveLength(3);
    expect(
      calls.every(
        ([request]) => request.tier === "fast" && JSON.parse(request.prompt).items.length <= 20,
      ),
    ).toBe(true);
    expect(out["out-0"]!.records).toEqual(input.records);
  });

  it.each([
    ["High", "Low"],
    ["Must", "Must have"],
    ["Must", "Could"],
    ["Must", "Should", "Later"],
  ])("rejects ambiguous or incomplete priority branch mapping: %j", async (...branches) => {
    await expect(
      aiSplitterBlock.run({ in: records(["one"]) }, { ...defaults, branches }, context().ctx),
    ).rejects.toThrow(/priority branches/i);
  });
});
