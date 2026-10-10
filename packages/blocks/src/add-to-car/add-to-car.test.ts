import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuditEvent,
  defaultBlockParams,
  DEFAULT_SETTINGS,
  emptyPipelineData,
  Finding,
  PipelineData,
  Requirement,
  type AuditEventInput,
  type StoredFile,
} from "@reqflow/core";
import { fixtureRecords, fixtureScope, fixtureSources } from "@reqflow/core/fixtures";
import type { BlockContext, BlockInputs } from "@reqflow/engine";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { rawBlock } from "../raw/raw";
import { addToCarBlock, priorityForRanking, scopeFor } from "./add-to-car";
import { deriveRequirements, MIN_COMMENTS_FOR_REQUIREMENT, type RankedInput } from "./derive";
import { bmwTags, classifyRecord, splitClauses } from "./splitter";

function context(scope = DEFAULT_SETTINGS.defaultScope, file?: StoredFile) {
  const logs: string[] = [];
  const audit: AuditEventInput[] = [];
  const added: Requirement[][] = [];
  const ctx = {
    runId: "run_test0001",
    blockId: "add-to-car-1",
    scope,
    settings: DEFAULT_SETTINGS,
    files: { get: async () => file },
    audit: {
      record: async (e: AuditEventInput) => {
        const validated = AuditEvent.parse({
          ...e,
          id: "aud_test",
          at: "2026-10-10T20:00:00.000Z",
          changes: e.changes ?? [],
        });
        audit.push(e);
        return validated;
      },
    },
    car: { add: async (rs: Requirement[]) => void added.push(rs) },
    log: (m: string) => logs.push(m),
    progress: () => {},
    signal: new AbortController().signal,
    resumed: false,
  } as unknown as BlockContext;
  return { ctx, logs, audit, added };
}

const params = (patch: Record<string, unknown> = {}) => ({
  ...defaultBlockParams("add_to_car"),
  method: "deterministic",
  ...patch,
});

async function runBlock(inputs: BlockInputs, patch: Record<string, unknown> = {}) {
  const c = context();
  const result = await addToCarBlock.run(inputs, params(patch), c.ctx);
  expect(result).toEqual({ status: "ok", outputs: {} });
  return { ...c, requirements: c.added.flat() };
}

const OPTS = {
  scope: fixtureScope,
  runId: "run_test0001",
  now: "2026-10-10T20:00:00.000Z",
  mergeDuplicates: true,
};
const must = (data: PipelineData): RankedInput[] => [
  { ranking: "Must have", priority: "must", data },
];

// ---------------------------------------------------------------- pure rules (no data needed)

describe("Add to Car rules", () => {
  it("judges datasets inside the existing sink and publishes scores, evidence and audit without a Judge node", async () => {
    const source = {
      ...fixtureSources[0]!,
      title: "Synthetic F70 feedback",
      kind: "customer_feedback" as const,
    };
    const data = PipelineData.parse({
      ...emptyPipelineData(),
      sources: [source],
      records: Array.from({ length: 8 }, (_, i) => ({
        id: `rec_direct${i}`,
        sourceId: source.id,
        market: "DE",
        text: "The seats squeak over bumps during every journey",
      })),
    });
    const c = context();
    const scope = vi.fn(async () => ({
      interpretation: "Seat noise",
      core: [{ component: "seats", aspect: null, reason: "Named part" }],
      adjacent: [],
    }));
    const propose = vi.fn(async () => ({
      actions: [
        {
          title: "Reduce seat squeaking",
          type: "quality_improvement" as const,
          description: "Reduce seat squeaking over bumps for occupants.",
          acceptanceCriteria: ["Occupants report no seat squeaking during the evaluation drive."],
          addresses: ["E1", "E2"],
          rationale: "Synthetic complaint evidence",
          assumptions: [],
          risks: [],
        },
      ],
    }));
    const judge = vi.fn(async () => ({
      quoteChecks: Array.from({ length: 8 }, (_, i) => ({
        ref: `E${i + 1}`,
        describesProblem: true,
        note: "Synthetic seat-noise evidence",
      })),
      solutionSupport: "moderate" as const,
      solutionReasoning: "Synthetic check",
      whyNotHigher: ["Prototype testing is still required"],
      toRaiseIt: [],
    }));
    c.ctx.agents = async () => ({
      model: "synthetic-test-model",
      resolveScope: scope,
      proposeActions: propose,
      judge,
      research: async () => ({ items: [], searchNotes: "No web research" }),
    });
    const stored: PipelineData[] = [];
    c.ctx.car = {
      nextSeq: async () => 42,
      add: async (requirements, evidence) => {
        stored.push(PipelineData.parse({ ...emptyPipelineData(), ...evidence, requirements }));
      },
    };
    expect(
      await addToCarBlock.run(
        { "in-0": data },
        params({ method: "agents", query: "seats" }),
        c.ctx,
      ),
    ).toEqual({ status: "ok", outputs: {} });
    expect(scope).toHaveBeenCalled();
    expect(propose).toHaveBeenCalled();
    expect(judge).toHaveBeenCalled();
    const out = stored[0]!;
    expect(out.requirements.length).toBeGreaterThan(0);
    expect(out.requirements[0]!.id).toBe("REQ-F70-EU-042");
    expect(
      out.requirements.every(
        (r) => r.status === "proposed" && r.score!.method.startsWith("ai-judge@"),
      ),
    ).toBe(true);
    expect(
      out.findings.every((f) =>
        f.evidence.every((e) =>
          out.records.some((r) => r.id === e.recordId && r.text.includes(e.excerpt)),
        ),
      ),
    ).toBe(true);
    expect(c.audit.some((e) => e.action === "requirement.proposed")).toBe(true);
  });

  it("fails clearly rather than silently using rules when agents are selected without a key", async () => {
    const c = context();
    const data = { ...emptyPipelineData(), sources: fixtureSources, records: fixtureRecords };
    await expect(
      addToCarBlock.run({ "in-0": data }, params({ method: "agents" }), c.ctx),
    ).rejects.toThrow(/OpenAI API key/);
    expect(c.added).toHaveLength(0);
  });
  it("maps ranking names to priorities, by name first and position second", () => {
    expect(
      ["Must have", "Should have", "Could have", "Won't have"].map(priorityForRanking),
    ).toEqual(["must", "should", "could", "wont"]);
    expect(priorityForRanking("Top", 0)).toBe("must");
    expect(priorityForRanking("Maybe", 2)).toBe("could");
  });

  it("vehicle and market params override the run's scope", () => {
    const p = { rankings: ["Must have"], vehicle: "5 Series", market: "US", mergeDuplicates: true };
    expect(scopeFor(p, fixtureScope)).toMatchObject({
      vehicleLine: "5 Series",
      vehicleCode: "G60",
      market: "US",
    });
    expect(scopeFor({ ...p, vehicle: "global", market: "global" }, fixtureScope)).toEqual(
      fixtureScope,
    );
  });

  it("continues numbering after existing requirements and hands over the evidence", async () => {
    const source = { ...fixtureSources[0]!, kind: "customer_feedback" as const };
    const data = PipelineData.parse({
      ...emptyPipelineData(),
      sources: [source],
      records: [
        "The rear seats are uncomfortable on long journeys",
        "The rear seats are uncomfortable and need better support",
      ].map((text, k) => ({ id: `rec_seq${k}`, sourceId: source.id, text, language: "en" })),
    });
    const c = context();
    const stored: unknown[] = [];
    c.ctx.car = {
      add: async (rs, evidence) => void stored.push({ rs, evidence }),
      nextSeq: async () => 42,
    };
    await addToCarBlock.run({ "in-0": data }, params(), c.ctx);
    const [{ rs, evidence }] = stored as [
      {
        rs: Requirement[];
        evidence: { findings: { id: string }[]; records: { id: string }[]; themes: unknown[] };
      },
    ];
    expect(rs[0]!.id).toBe("REQ-F70-EU-042");
    const findingIds = new Set(evidence.findings.map((f) => f.id));
    expect(rs.every((r) => r.findingIds.every((id) => findingIds.has(id)))).toBe(true);
    expect(evidence.records.length).toBeGreaterThan(0);
    expect(evidence.themes.length).toBeGreaterThan(0);
  });

  it("nothing arrived: logs it and adds nothing", async () => {
    const { requirements, logs } = await runBlock({});
    expect(requirements).toHaveLength(0);
    expect(logs).toEqual(["Nothing arrived, so no requirements were added."]);
  });

  it("publishes synthetic feedback with schema-valid creation audit events", async () => {
    const source = { ...fixtureSources[0]!, kind: "customer_feedback" as const };
    const texts = [
      "The rear seats are uncomfortable on long journeys",
      "The rear seats are uncomfortable and need better support",
      "The price is too expensive",
    ];
    const data = PipelineData.parse({
      ...emptyPipelineData(),
      sources: [source],
      records: texts.map((text, i) => ({
        id: `rec_synthetic${i}`,
        sourceId: source.id,
        text,
        language: "en",
      })),
    });
    const { requirements, audit } = await runBlock({ "in-0": data });
    expect(requirements.length).toBeGreaterThan(0);
    expect(requirements.every((r) => r.status === "proposed")).toBe(true);
    expect(audit.map((event) => event.action)).toEqual(
      expect.arrayContaining(["finding.extracted", "finding.excluded", "requirement.proposed"]),
    );
    expect(audit.every((event) => event.changes?.[0]?.path === "$")).toBe(true);
  });

  it("core fixtures: deterministic, every output parses, every excerpt is verbatim", () => {
    const data: PipelineData = {
      ...emptyPipelineData(),
      sources: fixtureSources,
      records: fixtureRecords,
    };
    const a = deriveRequirements(must(data), OPTS);
    expect(deriveRequirements(must(data), OPTS)).toEqual(a);
    const texts = new Map(fixtureRecords.map((r) => [r.id, r.text]));
    for (const f of [...a.findings, ...a.excluded]) {
      Finding.parse(f);
      for (const e of f.evidence) expect(texts.get(e.recordId!)).toContain(e.excerpt);
    }
  });
});

// ---------------------------------------------------------------- BMW's real exports (data/raw)

/** BMW's files in data/raw/ (gitignored, local only). Each suite is skipped where the file is missing. */
const BMW_DIR = join(import.meta.dirname, "../../../../data/raw");
const FEEDBACK = {
  F70: "F70_feedback_hackathon.xlsx",
  G60: "G60_feedback_hackathon.xlsx",
  G70: "G70_feedback_hackathon.xlsx",
} as const;
const STUDIES = "F70_G60_G68_G70_customer_studies.xlsx";
const has = (name: string) => existsSync(join(BMW_DIR, name));

async function ingest(name: string, dataset: string): Promise<PipelineData> {
  const file: StoredFile = {
    id: `file_${name.replace(/\W/g, "").toLowerCase()}`,
    name,
    mimeType: "application/octet-stream",
    bytes: new Uint8Array(readFileSync(join(BMW_DIR, name))),
  };
  const c = context(DEFAULT_SETTINGS.defaultScope, file);
  const result = await rawBlock.run(
    {},
    { ...defaultBlockParams("raw"), dataset, file: { fileId: file.id, name } },
    c.ctx,
  );
  if (result.status !== "ok") throw new Error("expected ok");
  return PipelineData.parse(result.outputs.out);
}

const findingsOf = (audit: AuditEventInput[], action = "finding.extracted") =>
  audit.filter((e) => e.action === action).map((e) => Finding.parse(e.changes![0]!.after));

for (const [model, name] of Object.entries(FEEDBACK)) {
  describe.skipIf(!has(name))(`BMW ${model} feedback → Add to Car (data/raw)`, () => {
    let data: PipelineData;
    let out: Awaited<ReturnType<typeof runBlock>>;
    beforeAll(async () => {
      data = await ingest(name, "customer_feedback");
      out = await runBlock({ "in-0": data });
    }, 60_000);

    it("every comment is looked at; most are placed by BMW's own classification", () => {
      const m =
        /Classified (\d+) comments: (\d+) by BMW's classification, (\d+) by keyword rules, (\d+) matched no rule/.exec(
          out.logs.join("\n"),
        );
      expect(m, "classification summary logged").not.toBeNull();
      const [total, byTag, byRule, none] = m!.slice(1).map(Number) as [
        number,
        number,
        number,
        number,
      ];
      expect(total).toBe(data.records.length);
      expect(byTag + byRule + none).toBe(total);
      expect(byTag / total).toBeGreaterThan(0.8);
      expect(none / total).toBeLessThan(0.1);
      expect(out.logs.join("\n")).not.toMatch(/have no rule yet/);
    });

    it("requirements parse, are numbered in order and rest on ≥ 2 comments", () => {
      const { requirements } = out;
      expect(requirements.length).toBeGreaterThan(20);
      requirements.forEach((r, i) => {
        Requirement.parse(r);
        expect(r.id).toBe(`REQ-F70-EU-${String(i + 1).padStart(3, "0")}`);
        expect(r.status).toBe("proposed");
        expect(r.priority).toBe("must");
        expect(["B", "C"]).toContain(r.evidenceLevel); // one BMW source: never A, never web-only D
      });
      expect(out.logs.join("\n")).toMatch(/themes rest on a single comment/);
      const findings = findingsOf(out.audit);
      const byId = new Map(findings.map((f) => [f.id, f]));
      for (const r of requirements) {
        const support = r.findingIds.map((id) => byId.get(id)!);
        expect(support.every((f) => f && f.kind !== "praise")).toBe(true);
        expect(support.reduce((n, f) => n + f.mentions, 0)).toBeGreaterThanOrEqual(
          MIN_COMMENTS_FOR_REQUIREMENT,
        );
        expect(r.conflictingFindingIds.every((id) => byId.get(id)?.kind === "praise")).toBe(true);
      }
    });

    it("every evidence excerpt is verbatim from its comment", () => {
      const texts = new Map(data.records.map((r) => [r.id, r.text]));
      const all = [...findingsOf(out.audit), ...findingsOf(out.audit, "finding.excluded")];
      expect(all.length).toBeGreaterThan(100);
      for (const f of all) {
        for (const e of f.evidence) expect(texts.get(e.recordId!)).toContain(e.excerpt);
      }
    });

    it("price-performance comments are out of scope, never requirements", () => {
      const excluded = findingsOf(out.audit, "finding.excluded");
      expect(excluded.some((f) => /price/i.test(f.statement))).toBe(true);
      const excludedIds = new Set(excluded.map((f) => f.id));
      expect(out.requirements.flatMap((r) => r.findingIds).some((id) => excludedIds.has(id))).toBe(
        false,
      );
    });

    it(`is deterministic on the ${model} export`, () => {
      expect(deriveRequirements(must(data), OPTS)).toEqual(deriveRequirements(must(data), OPTS));
    });
  });
}

describe.skipIf(!has(FEEDBACK.F70))("BMW F70: one theme end to end (data/raw)", () => {
  let data: PipelineData;
  beforeAll(async () => {
    data = await ingest(FEEDBACK.F70, "customer_feedback");
  }, 60_000);

  it("a squeaking driver seat lands in Seats › Noise via BMW's tag, quoting the clause", () => {
    const record = data.records.find((r) => r.fields?.["ID"] === "F70-0494")!;
    expect(bmwTags(record.fields).pairs).toContainEqual({ l2: "Seats", l3: "Noise" });
    const { mentions } = classifyRecord(record);
    const seat = mentions.find((m) => m.component === "seats" && m.aspect === "noise")!;
    expect(seat).toMatchObject({ polarity: "negative", method: "bmw_tag" });
    expect(seat.excerpt).toMatch(/squeak/);
    expect(record.text).toContain(seat.excerpt);
    expect(splitClauses(record.text).length).toBeGreaterThan(1);
  });

  it("the Seats › Noise requirement cites only seat-noise comments from EU", () => {
    const d = deriveRequirements(must(data), OPTS);
    const theme = d.themes.find((t) => t.label.startsWith("Seats › Noise"))!;
    expect(theme.summary).toMatch(
      /^3 complaints, 0 requests and 0 praise in 3 comments \(3 placed by BMW's classification/,
    );
    const req = d.requirements.find((r) => r.title.startsWith("Seats: eliminate squeaks"))!;
    expect(req).toMatchObject({ category: "comfort", kano: "basic", evidenceLevel: "C" });
    const finding = d.findings.find((f) => f.id === req.findingIds[0])!;
    expect(finding).toMatchObject({ kind: "complaint", mentions: 3, markets: ["EU"] });
    expect(finding.evidence.every((e) => /squeak|rattl|noise|creak/i.test(e.excerpt))).toBe(true);
  });

  it("multi-topic comments keep one placement per BMW tag pair", () => {
    const multi = data.records.find((r) => {
      const v = r.fields?.["Vfc level2 3 Name"];
      return Array.isArray(v) && v.length >= 4;
    })!;
    const tags = multi.fields!["Vfc level2 3 Name"] as string[];
    // BMW's "no_class_found" placeholder is not a classification and is skipped.
    const real = tags.filter((t) => t !== "no_class_found");
    expect(real.length).toBeGreaterThanOrEqual(4);
    expect(bmwTags(multi.fields).pairs).toHaveLength(real.length);
    expect(classifyRecord(multi).mentions.length).toBeGreaterThanOrEqual(2);
  });

  it("ranked inputs: Defect → Must, Difficult to Use → Should, Wants → Could; best ranking wins", async () => {
    const type = (r: PipelineData["records"][number]) => [r.fields?.["Feedback Type"]].flat();
    const pick = (t: string) => ({
      ...data,
      records: data.records.filter((r) => type(r).includes(t)),
    });
    const { requirements } = await runBlock({
      "in-0": pick("Defect"),
      "in-1": pick("Difficult to Use"),
      "in-2": pick("Wants"),
    });
    const order = requirements.map((r) => r.priority);
    expect(new Set(order)).toEqual(new Set(["must", "should", "could"]));
    expect(
      [...order].sort(
        (a, b) => ["must", "should", "could"].indexOf(a!) - ["must", "should", "could"].indexOf(b!),
      ),
    ).toEqual(order);
    expect(requirements.every((r) => r.priorityRationale!.startsWith(`Arrived on the "`))).toBe(
      true,
    );
  });
});

describe.skipIf(!has(STUDIES))("BMW customer studies → Add to Car (data/raw)", () => {
  it("tables of figures are not classified as comments, and the log says so", async () => {
    const studies = await ingest(STUDIES, "customer_study");
    const { requirements, logs } = await runBlock({ "in-0": studies });
    expect(requirements).toHaveLength(0);
    expect(logs.join("\n")).toMatch(
      new RegExp(`Not classified \\(not free text\\): ${studies.records.length} customer study`),
    );
  });
});
