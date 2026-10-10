import { DEFAULT_SETTINGS, defaultBlockParams, ReasoningTrace, Requirement } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { addToCarBlock, scopeFor } from "./add-to-car";
import { agents, context, dataset, scriptedLlm } from "./test-helpers";

const params = (patch: Record<string, unknown> = {}) => ({
  ...defaultBlockParams("add_to_car"),
  contexts: ["sales_volumes"],
  ...patch,
});

// Invented comments (AGENTS.md rule 3).
const mustHave = dataset("must", "customer_feedback", [
  { text: "The rear seats are too cramped for adults on long trips.", market: "DE" },
  { text: "Rear seat room is tight, my teenagers complain on every holiday drive.", market: "FR" },
  { text: "Not enough knee room in the rear seats for tall passengers.", market: "DE" },
  { text: "The navigation screen lags when I zoom the map.", market: "DE" },
  { text: "Navigation display is slow and freezes sometimes.", market: "IT" },
  { text: "The price is too high for the equipment you get.", market: "DE" },
]);
const shouldHave = dataset("should", "customer_feedback", [
  { text: "I love the steering, it feels sporty and direct.", market: "DE" },
  { text: "The cup holders are too small for my bottle.", market: "FR" },
]);
const sales = dataset("sales", "sales_volume", [
  {
    text: "market: Germany; volume_2024: 1000",
    fields: {
      market: "Germany",
      market_code: "DE",
      volume_2024: 1000,
      volume_2025: 900,
      volume_2030: 1200,
    },
  },
  {
    text: "market: France; volume_2024: 500",
    fields: {
      market: "France",
      market_code: "FR",
      volume_2024: 500,
      volume_2025: 550,
      volume_2030: 600,
    },
  },
]);

describe("Add to Car (offline agents)", () => {
  it("turns the priority inputs into ranked requirements with confidence and a thought process", async () => {
    const c = context(agents({ provider: "mock" }), 7);
    const res = await addToCarBlock.run(
      { "in-0": mustHave, "in-1": shouldHave, "ctx-0": sales },
      params(),
      c.ctx,
    );
    expect(res).toEqual({ status: "ok", outputs: {} });

    const [{ requirements, evidence }] = c.added as [(typeof c.added)[number]];
    expect(requirements.map((r) => r.id)).toEqual(["REQ-F70-EU-007", "REQ-F70-EU-008"]);
    for (const r of requirements) {
      expect(() => Requirement.parse(r)).not.toThrow();
      expect(r).toMatchObject({ status: "proposed", priority: "must", inputRank: 1 });
      expect(r.confidence!.signals.length).toBeGreaterThan(3);
      expect(r.createdBy).toEqual({ type: "ai", component: "add_to_car", model: "offline" });
    }
    // The space theme has three comments, navigation two; single comments are held back.
    expect(requirements[0]!.findingIds).toHaveLength(3);
    expect(requirements[0]!.evidenceLevel).toBe("C");

    // Every excerpt is verbatim text of the record it cites.
    const records = new Map(evidence!.records!.map((r) => [r.id, r.text]));
    for (const f of evidence!.findings!) {
      for (const e of f.evidence) expect(records.get(e.recordId!)).toContain(e.excerpt);
    }
    expect(evidence!.findings!.filter((f) => !f.inScope)).toHaveLength(1); // the price comment

    const [trace] = c.traces as [ReasoningTrace];
    expect(() => ReasoningTrace.parse(trace)).not.toThrow();
    expect(trace.offline).toBe(true);
    expect(trace.steps.map((s) => s.role)).toEqual([
      "context",
      "analyst",
      "synthesizer",
      "architect",
      "critic",
      "judge",
    ]);
    expect(trace.requirements.map((r) => r.requirementId)).toEqual(requirements.map((r) => r.id));
    expect(trace.heldBack.map((h) => h.reason).join(" ")).toMatch(/Only one comment/);
    expect(trace.heldBack.some((h) => h.theme === "Out of scope")).toBe(true);
    expect(trace.inputs.map((i) => i.label)).toEqual([
      "1. Priority",
      "2. Priority",
      "3. Priority",
      "Context 1 · Sales volumes",
    ]);
    // The sales digest reached the context step with exact figures and the plan year marked.
    const contextNotes = trace.steps[0]!;
    expect(contextNotes.stats.find((s) => s.label === "facts")!.value).toBeGreaterThan(0);

    const actions = c.audit.map((e) => e.action);
    expect(actions.filter((a) => a === "requirement.proposed")).toHaveLength(2);
    expect(actions.filter((a) => a === "requirement.scored")).toHaveLength(2);
    expect(actions.filter((a) => a === "finding.excluded")).toHaveLength(1);
    expect(c.audit.every((e) => e.actor.type === "ai")).toBe(true);
  });

  it("does nothing, without any AI call, when nothing arrived on a priority input", async () => {
    const c = context(agents({ provider: "anthropic", failWriter: "must not be asked" }));
    await expect(addToCarBlock.run({ "ctx-0": sales }, params(), c.ctx)).resolves.toEqual({
      status: "ok",
      outputs: {},
    });
    expect(c.added).toHaveLength(0);
    expect(c.logs.join(" ")).toMatch(/Only context arrived/);
  });

  it("rejects data on a port the block doesn't have", async () => {
    const c = context(agents({}));
    await expect(addToCarBlock.run({ "in-7": mustHave }, params(), c.ctx)).rejects.toThrow(
      /no input "in-7"/,
    );
  });

  it("fails before any work when an agent's API setup can't be used", async () => {
    const c = context(
      agents({ provider: "anthropic", failWriter: 'API setup "Claude" has no API key.' }),
    );
    await expect(
      addToCarBlock.run({ "in-0": mustHave }, params({ contexts: [] }), c.ctx),
    ).rejects.toThrow(/no API key/);
    expect(c.audit).toHaveLength(0);
  });

  it("vehicle and market params override the run's scope", () => {
    const p = {
      priorities: 1,
      contexts: [],
      maxRequirements: 20,
      vehicle: "5 Series",
      market: "US",
    };
    expect(scopeFor(p, DEFAULT_SETTINGS.defaultScope)).toMatchObject({
      vehicleLine: "5 Series",
      vehicleCode: "G60",
      market: "US",
    });
    expect(
      scopeFor({ ...p, vehicle: "global", market: "global" }, DEFAULT_SETTINGS.defaultScope),
    ).toEqual(DEFAULT_SETTINGS.defaultScope);
  });
});

describe("Add to Car (scripted models)", () => {
  const factor = { value: 4, note: "Evidence: [s1] adults complain." };
  const factors = Object.fromEntries(
    [
      "customer_impact",
      "evidence_strength",
      "competitive_gap",
      "trend_momentum",
      "brand_fit",
      "ease",
    ].map((f) => [f, factor]),
  );
  const draft = (title: string, used: string[]) => ({
    title,
    description: "Adults sit comfortably in the rear on trips of two hours.",
    category: "space_practicality",
    kano: "performance",
    targets: [
      {
        metric: "Rear comfort rating",
        target: "≥ 8 of 10 adults satisfied",
        acceptance: "Clinic with 30 adults",
      },
    ],
    assumptions: ["Families stay the core buyers."],
    uncertainties: ["Boot space may shrink."],
    why: "Three owners [s1] [s2] [s3] say the rear is too tight.",
    usedSignals: used,
    contextUsed: [],
  });

  function script(criticVerdicts: string[]) {
    const calls: string[] = [];
    let review = 0;
    const llm = scriptedLlm((contract, p) => {
      if (contract.endsWith("analyst@1")) {
        const refs = p.records.map((r: { ref: string }) => r.ref);
        return {
          signals: [
            {
              kind: "complaint",
              statement: "Rear passengers lack knee room.",
              category: "space_practicality",
              inScope: true,
              outOfScopeReason: "",
              refs: refs.slice(0, 3),
              // r1 is quoted with changed case and curly quotes, r2 with words that aren't there, r99 doesn't exist.
              quotes: [
                { ref: "r1", quote: "“THE REAR SEATS are too cramped”" },
                { ref: "r2", quote: "seats feel like a prison" },
                { ref: "r99", quote: "ghost" },
              ],
              sentiment: -0.7,
            },
            {
              kind: "complaint",
              statement: "The navigation screen is slow.",
              category: "infotainment_digital",
              inScope: true,
              outOfScopeReason: "",
              refs: ["r4", "r5"],
              quotes: [{ ref: "r4", quote: "navigation screen lags" }],
              sentiment: -0.5,
            },
          ],
          ignored: ["r6"],
        };
      }
      if (contract.endsWith("synthesizer@1")) {
        return {
          themes: [
            {
              label: "Rear knee room",
              need: "Adults sit comfortably in the rear.",
              category: "space_practicality",
              signals: ["s1"],
              conflicting: [],
            },
            {
              label: "Navigation speed",
              need: "The map reacts at once.",
              category: "infotainment_digital",
              signals: ["s2"],
              conflicting: [],
            },
          ],
        };
      }
      if (contract.endsWith("architect@1") || contract.endsWith("revise@1")) {
        return p.theme.label === "Rear knee room"
          ? draft("Rear seats fit adults on long trips", ["s1"])
          : draft("Instant map response", ["s2"]);
      }
      if (contract.endsWith("critic@1")) {
        if (p.theme.label === "Navigation speed") {
          return {
            verdict: "reject",
            issues: [],
            fixes: [],
            rejectReason: "An engineering spec, not a customer need.",
            factors,
          };
        }
        const verdict = criticVerdicts[review++] ?? "accept";
        return {
          verdict,
          issues: verdict === "accept" ? [] : ["Target is vague."],
          fixes: verdict === "accept" ? [] : ["Name the trip length."],
          rejectReason: "",
          factors,
        };
      }
      throw new Error(`unexpected ${contract}`);
    }, calls);
    const decisions = {
      async decide() {
        return {
          model: "jev-1.13.0",
          answers: {
            support: { type: "noul" as const, value: 0.9 },
            scope: { type: "noul" as const, value: 0.95 },
            durability: {
              type: "score" as const,
              score: 3,
              probabilities: [0, 0, 0, 1, 0],
              confidence: 1,
            },
            clarity: {
              type: "score" as const,
              score: 3,
              probabilities: [0, 0, 0, 1],
              confidence: 1,
            },
          },
        };
      },
    };
    return { calls, services: agents({ provider: "anthropic", llm, decisions }) };
  }

  it("checks quotes, revises after review, drops rejected drafts and scores confidence", async () => {
    const { calls, services } = script(["revise", "accept"]);
    const c = context(services);
    await addToCarBlock.run({ "in-0": mustHave }, params({ contexts: [] }), c.ctx);

    const [{ requirements, evidence }] = c.added as [(typeof c.added)[number]];
    expect(requirements.map((r) => r.title)).toEqual(["Rear seats fit adults on long trips"]);
    const space = evidence!.findings!.find((f) => f.statement.startsWith("Rear passengers"))!;
    expect(space.mentions).toBe(3);
    expect(space.evidence.map((e) => e.excerpt)).toEqual([
      "The rear seats are too cramped", // original characters, not the model's casing or quote marks
      "Rear seat room is tight, my teenagers complain on every holiday drive.", // repaired: opening words
      "Not enough knee room in the rear seats for tall passengers.",
    ]);
    expect(space.confidence).toBe(0.6); // a quote had to be repaired

    const [trace] = c.traces as [ReasoningTrace];
    const why = trace.requirements[0]!;
    expect(why.verdict).toBe("revised");
    expect(why.issues).toEqual(["Target is vague."]);
    expect(why.thoughts.map((t) => t.role)).toEqual([
      "analyst",
      "synthesizer",
      "architect",
      "architect",
      "critic",
      "judge",
    ]);
    expect(why.thoughts[3]!.text).toMatch(/Own reasoning \(summary\): Weighed knee room/);
    expect(trace.heldBack.find((h) => h.theme === "Navigation speed")!.reason).toMatch(
      /critic rejected it: An engineering spec/,
    );
    expect(trace.offline).toBe(false);
    expect(trace.steps.find((s) => s.role === "judge")!.model).toBe("jev-1.13.0");

    const conf = requirements[0]!.confidence!;
    const signal = (key: string) => conf.signals.find((s) => s.key === key)!;
    expect(signal("support")).toMatchObject({ value: 0.9, by: "jev-1.13.0" });
    expect(signal("durability").value).toBe(0.75);
    expect(signal("clarity").value).toBe(1);
    expect(signal("agreement").value).toBe(0.85);
    expect(conf.level).toBe("high");
    expect(calls.filter((x) => x.endsWith("revise@1"))).toHaveLength(1);
    expect(requirements[0]!.score!.total).toBe(80);
    expect(requirements[0]!.priorityRationale).toMatch(
      /1\. Priority of 3, so it is a must-have.*80\/100 \(must\), which agrees/,
    );
  });

  it("keeps open issues visible when the rewrite still doesn't pass", async () => {
    const { services } = script(["revise", "revise"]);
    const c = context(services);
    await addToCarBlock.run({ "in-0": mustHave }, params({ contexts: [] }), c.ctx);
    const [{ requirements }] = c.added as [(typeof c.added)[number]];
    expect(requirements[0]!.uncertainties).toContain(
      "Open issue from the critic: Target is vague.",
    );
    expect(c.traces[0]!.requirements[0]!.verdict).toBe("flagged");
    expect(requirements[0]!.confidence!.signals.find((s) => s.key === "agreement")!.value).toBe(
      0.45,
    );
  });

  it("stops with a clear error when most analyst calls fail, and on cancel", async () => {
    const failing = scriptedLlm(() => {
      throw new Error("Anthropic request failed (HTTP 529, overloaded_error)");
    });
    const c = context(agents({ provider: "anthropic", llm: failing }));
    await expect(
      addToCarBlock.run({ "in-0": mustHave }, params({ contexts: [] }), c.ctx),
    ).rejects.toThrow(
      /analysts failed on 1 of 1 batches: Analysts: Anthropic request failed \(HTTP 529/,
    );

    const { services } = script(["accept"]);
    const cancelled = context(services);
    cancelled.abort.abort(new Error("Run cancelled"));
    await expect(
      addToCarBlock.run({ "in-0": mustHave }, params({ contexts: [] }), cancelled.ctx),
    ).rejects.toThrow("Run cancelled");
    expect(cancelled.added).toHaveLength(0);
  });
});
