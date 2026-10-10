import {
  AuditEvent,
  DEFAULT_SETTINGS,
  defaultBlockParams,
  emptyPipelineData,
  PipelineData,
  Requirement,
  type AuditEventInput,
  type JudgingAgents,
  type Source,
  type SourceRecord,
} from "@reqflow/core";
import type { BlockContext, CarEvidence } from "@reqflow/engine";
import { describe, expect, it } from "vitest";
import { aiJudgeBlock } from "./ai-judge";
import { collectEvidence, dimensionTopic, studyObservations } from "./evidence";
import { rocWeights } from "./sources";

// Synthetic data only: a made-up model "X1" with feedback, a study and sales.
const scope = { ...DEFAULT_SETTINGS.defaultScope, vehicleCode: "X1", market: "EU" };
const now = "2026-10-10T20:00:00.000Z";
const src = (id: string, kind: Source["kind"], title: string): Source => ({
  id,
  kind,
  origin: "bmw_internal",
  title,
  retrievedAt: now,
  reliability: "high",
});
let n = 0;
const fb = (country: string, type: string, l2: string, l3: string, text: string): SourceRecord => ({
  id: `rec_fb${++n}`,
  sourceId: "src_fb",
  text,
  locator: `Feedback, row ${n + 1}`,
  market: country,
  fields: {
    ID: `X1-${n}`,
    Country: country,
    "Derivate (e-code)": "X1",
    "Feedback Type": type,
    "Vfc level2 Name": l2,
    "Vfc level3 Name": l3,
    "Customer Feedback": text,
  },
});
const feedback: PipelineData = {
  ...emptyPipelineData(),
  sources: [src("src_fb", "customer_feedback", "X1 feedback.xlsx")],
  records: [
    ...Array.from({ length: 6 }, (_, i) =>
      fb("GB", "Defect", "Seats", "Noise", `The driver seat squeaks over every bump, case ${i}.`),
    ),
    ...Array.from({ length: 3 }, (_, i) =>
      fb(
        "DE",
        "Wants",
        "Seat massage",
        "Customer request: function",
        `I wish the seats had a massage function ${i}.`,
      ),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      fb(
        "FR",
        "Likes",
        "Seats",
        "Likes comfort",
        `The seats are very comfortable on long trips ${i}.`,
      ),
    ),
    fb("US", "Defect", "Seats", "Noise", "Rattle from the seat rail."), // other region: filtered out for EU
  ],
};
const study: PipelineData = {
  ...emptyPipelineData(),
  sources: [src("src_st", "customer_study", "studies.xlsx · CN_EU_2025")],
  records: [
    ["Overall seating comfort", 6.5],
    ["Exterior styling", 9.0],
    ["Quietness when driving", 8.5],
  ].map(([dim, v], i) => ({
    id: `rec_st${i}`,
    sourceId: "src_st",
    text: `${dim}: ${v}`,
    fields: { Section: dim, Label: "Mean", "BMW X Series X1 (EU)": v },
  })),
};
const sales: PipelineData = {
  ...emptyPipelineData(),
  sources: [src("src_sa", "sales_volume", "sales.xlsx · X1")],
  records: [
    {
      id: "rec_sa1",
      sourceId: "src_sa",
      text: "",
      fields: { market_code: "EU", volume_2025: 1000 },
    },
  ],
};

function mockAgents(): JudgingAgents & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    model: "mock/judge",
    resolveScope: async () => ({
      interpretation: "Seats",
      core: [{ component: "seats", aspect: null, reason: "named" }],
      adjacent: [],
    }),
    research: async () => ({ items: [], searchNotes: "mock: no web" }),
    proposeActions: async (prompt) => {
      prompts.push(prompt);
      return {
        actions: [
          {
            title: "Remove seat squeaks",
            type: "fix_defect",
            description: "Make the seats silent.",
            acceptanceCriteria: ["No squeak on a bump track"],
            addresses: ["E1", "E2", "E99"],
            rationale: "quotes",
            assumptions: [],
            risks: [],
          },
          {
            title: "Investigate the cause",
            type: "investigate",
            description: "Find the cause.",
            acceptanceCriteria: ["Cause identified"],
            addresses: [],
            rationale: "open",
            assumptions: [],
            risks: [],
          },
        ],
      };
    },
    judge: async (prompt) => {
      prompts.push(prompt);
      return {
        quoteChecks: [
          { ref: "E1", describesProblem: true, note: "" },
          { ref: "E2", describesProblem: false, note: "" },
        ],
        solutionSupport: "moderate",
        solutionReasoning: "ok",
        whyNotHigher: ["small sample"],
        toRaiseIt: ["clinic"],
      };
    },
  };
}

function context(agents: JudgingAgents | null) {
  const logs: string[] = [];
  const audit: AuditEventInput[] = [];
  const added: { requirements: Requirement[]; evidence?: CarEvidence }[] = [];
  const ctx = {
    runId: "run_test0001",
    blockId: "judge-1",
    scope,
    settings: DEFAULT_SETTINGS,
    files: { get: async () => undefined },
    audit: {
      record: async (e: AuditEventInput) => {
        audit.push(e);
        return AuditEvent.parse({ ...e, id: "aud_test", at: now, changes: e.changes ?? [] });
      },
    },
    car: {
      add: async (requirements: Requirement[], evidence?: CarEvidence) =>
        void added.push({ requirements, ...(evidence ? { evidence } : {}) }),
    },
    agents: async () => agents,
    log: (m: string) => logs.push(m),
    progress: () => {},
    signal: new AbortController().signal,
    resumed: false,
  } as unknown as BlockContext;
  return { ctx, logs, audit, added };
}

const params = (patch: Record<string, unknown> = {}) => ({
  ...defaultBlockParams("ai_judge"),
  query: "seats",
  sources: ["Market research", "Customer feedback"],
  webResearch: false,
  ...patch,
});

describe("AI Judge evidence", () => {
  it("weights inputs by rank and splits an input's weight between its kinds of evidence", () => {
    expect(rocWeights(2)).toEqual([0.75, 0.25]);
    const ev = collectEvidence([study, feedback], ["Market research", "Customer feedback"], {
      derivative: "X1",
      region: "EU",
    });
    expect(ev.sources.map((s) => [s.id, s.weight])).toEqual([
      ["in0_study", 0.75],
      ["in1_feedback", 0.25],
    ]);
    expect(Object.values(ev.totals.in1_feedback ?? {}).reduce((a, b) => a + b, 0)).toBe(13); // US row filtered
  });

  it("parses study tables and maps dimensions with the feedback rules", () => {
    expect(dimensionTopic("Overall seating comfort")).toEqual({
      component: "seats",
      aspect: "comfort",
    });
    const obs = studyObservations(
      study.records,
      new Map(study.sources.map((s) => [s.id, s])),
      "st",
      { derivative: "X1", region: "EU" },
    );
    const seat = obs.find((o) => o.problemKey === "seats|comfort")!;
    expect(seat).toMatchObject({
      derivative: "X1",
      market: "EU",
      marketResolved: true,
      metric: "mean_10pt",
      value: 6.5,
    });
    expect(seat.columnMean).toBeCloseTo(8);
  });
});

describe("AI Judge block", () => {
  it("fails instead of reporting success when solution generation fails", async () => {
    const agents = mockAgents();
    agents.proposeActions = async () => {
      throw new Error("Synthetic provider failure");
    };
    const c = context(agents);
    await expect(
      aiJudgeBlock.run({ "in-0": feedback }, params({ sources: ["Feedback"] }), c.ctx),
    ).rejects.toThrow(/no proposals/);
    expect(c.added).toHaveLength(0);
  });
  it("does not inflate confidence when the judge returns no quote checks", async () => {
    const agents = mockAgents();
    agents.judge = async () => ({
      quoteChecks: [],
      solutionSupport: "strong",
      solutionReasoning: "synthetic",
      whyNotHigher: [],
      toRaiseIt: [],
    });
    const c = context(agents);
    const result = await aiJudgeBlock.run(
      { "in-0": feedback },
      params({ sources: ["Feedback"] }),
      c.ctx,
    );
    if (result.status !== "ok") throw new Error("Expected output");
    expect(
      result.outputs.out!.requirements.every(
        (r) => r.score!.factors.evidence_strength!.value === 0,
      ),
    ).toBe(true);
  });

  it("keeps study-only proposals traceable and never invents feedback quotes", async () => {
    const c = context(mockAgents());
    const result = await aiJudgeBlock.run({ "in-0": study }, params({ sources: ["Study"] }), c.ctx);
    if (result.status !== "ok") throw new Error("Expected output");
    const out = PipelineData.parse(result.outputs.out);
    expect(out.requirements.length).toBeGreaterThan(0);
    expect(out.findings.every((f) => f.kind === "usage_pattern")).toBe(true);
    expect(
      out.findings.every((f) =>
        f.evidence.every((e) =>
          study.records.some((r) => r.id === e.recordId && r.text.includes(e.excerpt)),
        ),
      ),
    ).toBe(true);
  });

  it("does not broaden an empty market scope to other markets", async () => {
    const c = context(mockAgents());
    const result = await aiJudgeBlock.run(
      { "in-0": feedback },
      params({ sources: ["Feedback"], market: "CN" }),
      c.ctx,
    );
    if (result.status !== "ok") throw new Error("Expected output");
    expect(result.outputs.out!.requirements).toHaveLength(0);
  });

  it("stops cancellation before auditing or publication", async () => {
    const c = context(mockAgents());
    const controller = new AbortController();
    controller.abort();
    c.ctx.signal = controller.signal;
    await expect(
      aiJudgeBlock.run({ "in-0": feedback }, params({ sources: ["Feedback"] }), c.ctx),
    ).rejects.toThrow();
    expect(c.added).toHaveLength(0);
    expect(c.audit).toHaveLength(0);
  });

  it("fails clearly without an OpenAI key", async () => {
    const c = context(null);
    await expect(
      aiJudgeBlock.run({ "in-0": study, "in-1": feedback }, params(), c.ctx),
    ).rejects.toThrow(/OpenAI API key/);
  });

  it("ranks actions with importance and independent confidence, cites verbatim evidence, decides nothing", async () => {
    const agents = mockAgents();
    const c = context(agents);
    const res = await aiJudgeBlock.run(
      { "in-0": study, "in-1": feedback, "in-2": sales },
      params({ sources: ["Market research", "Customer feedback", "Sales"] }),
      c.ctx,
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("Expected proposed output");
    expect(c.added).toHaveLength(0); // publication happens only downstream, after HIL
    const evidence = res.outputs.out!;
    const { requirements } = evidence;
    expect(requirements.length).toBeGreaterThanOrEqual(2);
    for (const r of requirements) {
      Requirement.parse(r);
      expect(r.status).toBe("proposed");
      expect(r.score!.factors.customer_impact!.weight).toBe(1);
      expect(r.score!.factors.evidence_strength!.weight).toBe(0); // confidence never mixed into importance
      expect(r.score!.factors.evidence_strength!.note).toMatch(/Confidence/);
    }
    expect(requirements[0]!.score!.total).toBeLessThan(100); // no relative-score inflation
    // The judge never sees the priority.
    for (const p of agents.prompts.filter((x) => x.startsWith("Problem:")))
      expect(p).not.toMatch(/Importance|priority \d|scores \d/i);
    // Every cited excerpt is verbatim from its record, and the evidence is stored with the requirements.
    const records = new Map(evidence.records.map((r) => [r.id, r]));
    for (const f of evidence.findings) {
      for (const e of f.evidence) expect(records.get(e.recordId!)!.text).toContain(e.excerpt);
    }
    // The citation to E99 (never shown) was dropped.
    expect(c.logs.join("\n")).toMatch(/removed 1 citation/);
    // AI proposes, nothing approved; scoring is logged as deterministic.
    expect(c.audit.filter((a) => a.action === "requirement.proposed")).toHaveLength(
      requirements.length,
    );
    expect(
      c.audit.some(
        (a) =>
          a.action === "requirement.scored" &&
          a.actor.type === "ai" &&
          a.actor.model === "deterministic",
      ),
    ).toBe(true);
    expect(c.audit.some((a) => a.action === "requirement.status_changed")).toBe(false);
  });
});
