import {
  AGENT_ROLE_INFO,
  CATEGORY_LABELS,
  Finding,
  formatRequirementId,
  ReasoningTrace,
  Requirement,
  type AgentModel,
  type AgentRole,
  type DecisionAnswer,
  type DecisionClient,
  type LlmClient,
  type LlmUsage,
  type ModelTier,
  type ProductScope,
  type ReasoningEffort,
  type ReasoningStep,
  type RequirementCategory,
  type RequirementReasoning,
  type Source,
  type SourceRecord,
  type StepStatus,
  type Theme,
  type ThoughtLine,
  type TraceEvidence,
  type WriterRole,
} from "@reqflow/core";
import type { BlockContext } from "@reqflow/engine";
import { z } from "zod";
import {
  combineConfidence,
  evidenceLevel,
  judgeQuestions,
  oneLine,
  priorityForRank,
  QUANTITATIVE_KINDS,
  scoreFromReview,
  type CritiqueOutcome,
  type EvidenceFacts,
} from "./confidence";
import { contextProfile, salesDigest } from "./context";
import {
  findVerbatim,
  hash,
  MAX_EXCERPT_CHARS,
  MAX_EXCERPTS_PER_FINDING,
  openingExcerpt,
  prepareEvidence,
  type ContextInputData,
  type PriorityInputData,
  type RecordItem,
} from "./evidence";
import { OFFLINE_MODEL, offlineDecisions, offlineLlm } from "./offline";
import { errorText, mapPool } from "./pool";
import {
  analystSystem,
  architectSystem,
  contextSystem,
  criticSystem,
  mergeSystem,
  synthesizerSystem,
  type PromptSetup,
} from "./prompts";
import {
  AnalystAnswer,
  ContextAnswer,
  CONTRACT,
  DraftAnswer,
  MergeAnswer,
  ReviewAnswer,
  SynthesizerAnswer,
} from "./schemas";

/**
 * The Add to Car agent system. Code does everything that must be exact (ids, quotes, counts,
 * evidence levels, scores, priorities); models do the reading, grouping, writing and judging:
 *
 *   context reader ─┐
 *   analysts (map) ─┴→ synthesizer (cluster) → architect ⇄ critic (one revision) → judge
 *
 * Every step is recorded for the thought-process view. Failures of single calls are reported and
 * the run continues; too many failures stop it with a clear error.
 */

export interface AgentRunInput {
  priorities: PriorityInputData[];
  contexts: ContextInputData[];
  maxRequirements: number;
  scope: ProductScope;
  firstSeq: number; // next unused requirement number for the scope
}

export interface AgentRunResult {
  requirements: Requirement[];
  findings: Finding[]; // created by the analysts, in scope (themed or not)
  excluded: Finding[]; // created by the analysts, out of scope
  themes: Theme[];
  upstreamUsed: Finding[]; // upstream findings linked to a requirement
  records: SourceRecord[]; // every record cited by the findings above
  sources: Source[];
  trace: ReasoningTrace;
}

const RECORD_CHARS = 1500; // per record in an analyst prompt; quotes are checked against the full text
const BATCH_RECORDS = 50;
const BATCH_CHARS = 14_000;
const MAX_SIGNALS_PER_GROUP = 220;
const MAX_FAILED_SHARE = 0.25; // more failed calls than this in a step stops the run

interface Writer {
  role: WriterRole;
  info: AgentModel;
  llm: LlmClient;
  offline: boolean;
}
interface Judge {
  info: AgentModel;
  decisions: DecisionClient;
  offline: boolean;
}

interface Signal {
  ref: string;
  finding: Finding;
  rank: number;
  upstream: boolean;
}
interface ThemeItem {
  label: string;
  need: string;
  category: RequirementCategory;
  support: Signal[];
  conflicting: Signal[];
}
interface Brief {
  ref: string;
  label: string;
  whatItIs: string;
  facts: string[];
  implications: string[];
  caveats: string[];
}
interface Built {
  theme: ThemeItem;
  draft: DraftAnswer;
  review: ReviewAnswer;
  outcome: CritiqueOutcome;
  firstIssues: string[];
  openIssues: string[];
  thinking?: string;
  architectModel: string;
}

/** Counts calls, tokens, models and time of one step. */
class Meter {
  calls = 0;
  failed = 0;
  inputTokens = 0;
  outputTokens = 0;
  models = new Set<string>();
  readonly started = Date.now();
  add(model: string, usage?: LlmUsage) {
    this.calls++;
    this.models.add(model);
    this.inputTokens += usage?.inputTokens ?? 0;
    this.outputTokens += usage?.outputTokens ?? 0;
  }
}

const unique = <T>(xs: readonly T[]) => [...new Set(xs)];
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export async function runAgents(ctx: BlockContext, input: AgentRunInput): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const now = () => new Date().toISOString();
  const setup: PromptSetup = { scope: input.scope, language: ctx.settings.llm.outputLanguage };
  const steps: ReasoningStep[] = [];
  const meters: Meter[] = [];
  const log = (m: string) => ctx.log(m);

  const prepared = prepareEvidence(input.priorities);
  for (const note of prepared.notes) log(note);
  const contexts = input.contexts.filter((c) => c.data.records.length + c.data.findings.length > 0);

  // Resolve every model up front: a missing key fails now, not after ten minutes of work.
  const needed: WriterRole[] = [
    ...(contexts.length ? (["context"] as const) : []),
    ...(prepared.records.length ? (["analyst"] as const) : []),
    "synthesizer",
    "architect",
    "critic",
  ];
  const writers = new Map<WriterRole, Writer>();
  for (const role of needed) {
    const { info, llm } = await ctx.agents.writer(role);
    const offline = info.provider === "mock";
    writers.set(role, { role, info, llm: offline ? offlineLlm : llm, offline });
  }
  const judgeService = await ctx.agents.judge();
  const judge: Judge = {
    info: judgeService.info,
    decisions: judgeService.info.provider === "mock" ? offlineDecisions : judgeService.decisions,
    offline: judgeService.info.provider === "mock",
  };
  const writer = (role: WriterRole) => writers.get(role)!;

  /** One structured call; a malformed answer is asked again once before it counts as failed. */
  async function ask<T>(
    w: Writer,
    meter: Meter,
    req: {
      system: string;
      payload: Record<string, unknown>;
      schema: z.ZodType<T>;
      tier: ModelTier;
      effort?: ReasoningEffort;
      maxTokens: number;
    },
  ): Promise<{ object: T; model: string; thinking?: string }> {
    for (let attempt = 0; ; attempt++) {
      ctx.signal.throwIfAborted();
      try {
        const res = await w.llm.generateObject({
          system: req.system,
          prompt: JSON.stringify(req.payload),
          schema: req.schema,
          tier: req.tier,
          effort: req.effort,
          maxTokens: req.maxTokens,
          signal: ctx.signal,
        });
        meter.add(res.model, res.usage);
        return { object: res.object, model: res.model, thinking: res.thinking };
      } catch (err) {
        meter.calls++;
        if (ctx.signal.aborted) throw err;
        const malformed = err instanceof z.ZodError || /not valid JSON/i.test(errorText(err));
        if (attempt > 0 || !malformed) {
          meter.failed++;
          throw new Error(`${AGENT_ROLE_INFO[w.role].label}: ${errorText(err)}`);
        }
      }
    }
  }

  function step(
    role: AgentRole,
    meter: Meter,
    o: {
      title: string;
      summary: string;
      notes: string[];
      stats: [string, number][];
      status?: StepStatus;
      info: AgentModel;
      offline: boolean;
    },
  ) {
    meters.push(meter);
    steps.push({
      id: `step-${steps.length + 1}`,
      role,
      title: o.title,
      summary: o.summary,
      notes: o.notes.filter(Boolean).map((n) => oneLine(n, 400)),
      stats: o.stats.map(([label, value]) => ({ label, value })),
      model: o.offline
        ? OFFLINE_MODEL
        : meter.models.size
          ? [...meter.models].join(", ")
          : o.info.model || o.info.setupName,
      setup: o.info.setupName,
      calls: meter.calls,
      durationMs: Date.now() - meter.started,
      status: o.status ?? (meter.failed ? "warning" : "done"),
    });
  }

  // ── 1. Context reader ────────────────────────────────────────────────────────────────────
  const briefs: Brief[] = [];
  if (contexts.length) {
    ctx.progress(0.03, "Reading the context inputs");
    const w = writer("context");
    const meter = new Meter();
    const notes: string[] = [];
    const settled = await mapPool(
      contexts,
      w.info.maxParallel,
      async (c, i) => {
        const ref = `c${i + 1}`;
        const sales = c.mode === "sales_volumes" ? salesDigest(c.data) : null;
        if (c.mode === "sales_volumes" && !sales) {
          notes.push(`${c.label}: no volumes per period found, so it was read like Auto.`);
        }
        const { profile, samples } = contextProfile(c.data);
        const payload = sales
          ? { contract: CONTRACT.context, mode: c.mode, label: c.label, facts: sales.facts }
          : {
              contract: CONTRACT.context,
              mode: "auto",
              label: c.label,
              profile,
              samples: samples.map((s) => ({ ref: s.handle, text: s.text })),
            };
        try {
          const { object } = await ask(w, meter, {
            system: contextSystem(setup),
            payload,
            schema: ContextAnswer,
            tier: "default",
            effort: "low",
            maxTokens: 2000,
          });
          // Facts the code computed stay first: the reader's own facts can't replace exact figures.
          const facts = unique([...(sales?.facts ?? []), ...object.facts.map((f) => f.text)])
            .map((f) => oneLine(f, 300))
            .filter(Boolean)
            .slice(0, sales ? 12 : 8);
          return {
            ref,
            label: c.label,
            whatItIs: oneLine(object.whatItIs, 300) || c.label,
            facts,
            implications: object.implications
              .map((x) => oneLine(x, 300))
              .filter(Boolean)
              .slice(0, 4),
            caveats: object.caveats
              .map((x) => oneLine(x, 300))
              .filter(Boolean)
              .slice(0, 3),
          } satisfies Brief;
        } catch (err) {
          notes.push(`${c.label}: the context reader failed (${errorText(err)}).`);
          return {
            ref,
            label: c.label,
            whatItIs: c.label,
            facts: (sales?.facts ?? []).slice(0, 12),
            implications: [],
            caveats: ["Not summarized: the context reader failed."],
          } satisfies Brief;
        }
      },
      ctx.signal,
    );
    for (const r of settled) if (r.status === "fulfilled") briefs.push(r.value);
    const skipped = input.contexts.length - contexts.length;
    if (skipped) notes.push(`${plural(skipped, "context input")} received no data.`);
    step("context", meter, {
      title: "Read the context",
      summary: `Read ${plural(briefs.length, "context input")} as background for the other agents; context never becomes a requirement by itself.`,
      notes: [...briefs.flatMap((b) => [`${b.label}: ${b.whatItIs}`, ...b.implications]), ...notes],
      stats: [
        ["context inputs", briefs.length],
        ["facts", briefs.reduce((n, b) => n + b.facts.length, 0)],
      ],
      info: w.info,
      offline: w.offline,
    });
    log(`Context: ${briefs.length} input(s) summarized.`);
  }

  // ── 2. Analysts ──────────────────────────────────────────────────────────────────────────
  const signals: Signal[] = prepared.upstream.map((u, i) => ({
    ref: `s${i + 1}`,
    finding: u.finding,
    rank: u.rank,
    upstream: true,
  }));
  const excluded: Finding[] = [];
  const created: Finding[] = [];
  if (prepared.records.length) {
    ctx.progress(0.08, "Analysts are reading the priority inputs");
    const w = writer("analyst");
    const meter = new Meter();
    const batches = batchRecords(prepared.records);
    let repaired = 0;
    let unknownRefs = 0;
    let unaccounted = 0;
    let dropped = 0;
    let done = 0;
    const settled = await mapPool(
      batches,
      w.info.maxParallel,
      async (batch) => {
        const handles = new Map(batch.map((item, i) => [`r${i + 1}`, item]));
        const { object } = await ask(w, meter, {
          system: analystSystem(setup),
          payload: {
            contract: CONTRACT.analyst,
            records: [...handles].map(([ref, item]) => ({
              ref,
              text: clip(item.record.text, RECORD_CHARS),
              source: item.sourceKind,
              ...(item.record.market ? { market: item.record.market } : {}),
              ...(item.record.language ? { language: item.record.language } : {}),
              ...(item.hints.length ? { hints: Object.fromEntries(item.hints) } : {}),
            })),
          },
          schema: AnalystAnswer,
          tier: "fast",
          effort: "off",
          maxTokens: 8000,
        });
        const used = new Set<string>(object.ignored.filter((r) => handles.has(r)));
        const findings: Finding[] = [];
        for (const s of object.signals) {
          let made: ReturnType<typeof toFinding>;
          try {
            made = toFinding(ctx, s, handles);
          } catch {
            dropped++; // e.g. a statement the Finding schema rejects; the batch's other signals stay
            continue;
          }
          repaired += made.repaired;
          unknownRefs += made.unknownRefs;
          if (!made.finding) {
            dropped++;
            continue;
          }
          for (const ref of made.refs) used.add(ref);
          findings.push(made.finding);
        }
        unaccounted += batch.length - [...handles.keys()].filter((r) => used.has(r)).length;
        done++;
        ctx.progress(
          0.08 + 0.42 * (done / batches.length),
          `Analysts read ${done}/${batches.length} batches`,
        );
        return { findings, rank: batch[0]!.rank };
      },
      ctx.signal,
    );
    const failures = settled.filter((r) => r.status === "rejected");
    if (failures.length / batches.length > MAX_FAILED_SHARE) {
      throw new Error(
        `The analysts failed on ${failures.length} of ${batches.length} batches: ${errorText((failures[0] as PromiseRejectedResult).reason)}`,
      );
    }
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      for (const f of r.value.findings) {
        if (!f.inScope) excluded.push(f);
        else {
          created.push(f);
          signals.push({
            ref: `s${signals.length + 1}`,
            finding: f,
            rank: r.value.rank,
            upstream: false,
          });
        }
      }
    }
    const readRecords = settled.reduce(
      (n, r, i) => n + (r.status === "fulfilled" ? batches[i]!.length : 0),
      0,
    );
    const notes = [
      ...prepared.notes,
      failures.length
        ? `${failures.length} of ${batches.length} batches failed (${errorText((failures[0] as PromiseRejectedResult).reason)}); their records were not read.`
        : "",
      repaired
        ? `${repaired} quote(s) weren't verbatim; the record's opening words are cited instead.`
        : "",
      unknownRefs ? `${unknownRefs} reference(s) to records that don't exist were ignored.` : "",
      dropped ? `${dropped} signal(s) without a readable record were dropped.` : "",
      unaccounted ? `${unaccounted} record(s) were neither used nor marked as empty.` : "",
      ...input.priorities.map((p) => {
        const n = created.filter(
          (f) => signals.find((s) => s.finding === f)?.rank === p.rank,
        ).length;
        return `${p.label}: ${plural(p.data.records.length, "record")} in, ${plural(n, "signal")} out.`;
      }),
    ];
    step("analyst", meter, {
      title: "Read the priority inputs",
      summary: `Read ${plural(readRecords, "record")} in ${plural(batches.length, "batch", "batches")} and found ${plural(created.length, "customer signal")}${excluded.length ? `; ${excluded.length} more are out of scope` : ""}.`,
      notes,
      stats: [
        ["records read", readRecords],
        ["signals", created.length],
        ["out of scope", excluded.length],
      ],
      info: w.info,
      offline: w.offline,
    });
    log(
      `Analysts: ${readRecords} records → ${created.length} signals (${excluded.length} out of scope).`,
    );
  }

  // ── 3. Synthesizer ───────────────────────────────────────────────────────────────────────
  const heldBack: ReasoningTrace["heldBack"] = excluded.length
    ? [
        {
          theme: "Out of scope",
          reason: `Customer points about ${summarizeReasons(excluded)}: outside the customer-facing scope (briefing).`,
          signals: excluded.length,
        },
      ]
    : [];
  let themes: ThemeItem[] = [];
  const synthW = writer("synthesizer");
  const synthMeter = new Meter();
  const synthNotes: string[] = [];
  if (signals.length) {
    ctx.progress(0.52, "Synthesizer is grouping signals into themes");
    const byRef = new Map(signals.map((s) => [s.ref, s]));
    const groups = signalGroups(signals);
    const assigned = new Set<string>();
    const settled = await mapPool(
      groups,
      synthW.info.maxParallel,
      async (group) => {
        const { object } = await ask(synthW, synthMeter, {
          system: synthesizerSystem(setup),
          payload: {
            contract: CONTRACT.synthesizer,
            signals: group.map((s) => ({
              ref: s.ref,
              kind: s.finding.kind,
              statement: clip(s.finding.statement, 300),
              category: s.finding.category,
              mentions: s.finding.mentions,
              rank: s.rank,
              markets: s.finding.markets.slice(0, 3),
            })),
          },
          schema: SynthesizerAnswer,
          tier: "default",
          maxTokens: 8000,
        });
        return { group, answer: object };
      },
      ctx.signal,
    );
    const failed = settled.filter((r) => r.status === "rejected");
    if (failed.length === groups.length) {
      throw new Error(
        `The synthesizer failed: ${errorText((failed[0] as PromiseRejectedResult).reason)}`,
      );
    }
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      const inGroup = new Set(r.value.group.map((s) => s.ref));
      for (const t of r.value.answer.themes) {
        const support = unique(t.signals).filter((ref) => inGroup.has(ref) && !assigned.has(ref));
        if (!support.length) continue;
        for (const ref of support) assigned.add(ref);
        const conflicting = unique(t.conflicting).filter(
          (ref) => byRef.has(ref) && !support.includes(ref),
        );
        const label = oneLine(t.label, 80) || CATEGORY_LABELS[t.category];
        themes.push({
          label,
          need: oneLine(t.need, 300) || label,
          category: t.category,
          support: support.map((ref) => byRef.get(ref)!),
          conflicting: conflicting.map((ref) => byRef.get(ref)!),
        });
      }
    }
    if (failed.length) {
      synthNotes.push(
        `${failed.length} of ${groups.length} groups failed (${errorText((failed[0] as PromiseRejectedResult).reason)}); their signals stay unthemed.`,
      );
    }
    if (groups.length > 1 && themes.length > 1) {
      try {
        const { object } = await ask(synthW, synthMeter, {
          system: mergeSystem(setup),
          payload: {
            contract: CONTRACT.merge,
            themes: themes.map((t, i) => ({
              ref: `t${i + 1}`,
              label: t.label,
              need: t.need,
              category: t.category,
              signals: t.support.length,
            })),
          },
          schema: MergeAnswer,
          tier: "default",
          maxTokens: 4000,
        });
        const merged = mergeThemes(themes, object);
        if (merged.count)
          synthNotes.push(`Merged ${plural(merged.count, "duplicate theme")} across groups.`);
        themes = merged.themes;
      } catch (err) {
        synthNotes.push(
          `The merge pass failed (${errorText(err)}); themes from different groups may overlap.`,
        );
      }
    }
    const unthemed = signals.filter((s) => !assigned.has(s.ref));
    if (unthemed.length) {
      heldBack.push({
        theme: "Signals without a theme",
        reason:
          "They fit no theme the synthesizer found, so they stay findings for the audit trail.",
        signals: unthemed.length,
      });
    }
  }

  // Which themes become requirements: code decides, by rank and weight, never silently.
  const ranked = themes
    .map((t) => ({
      theme: t,
      rank: Math.min(...t.support.map((s) => s.rank)),
      weight: weightOf(t),
    }))
    .sort((a, b) => a.rank - b.rank || b.weight - a.weight);
  const eligible = ranked.filter(({ theme }) => {
    const ok =
      mentionsOf(theme.support) >= 2 ||
      theme.support.some((s) => s.upstream) ||
      theme.support.some((s) => isQuantitative(s.finding, prepared.sources));
    if (!ok) {
      heldBack.push({
        theme: theme.label,
        reason: "Only one comment: kept as a finding, not a requirement.",
        signals: theme.support.length,
      });
    }
    return ok;
  });
  const selected = eligible.slice(0, input.maxRequirements);
  for (const { theme } of eligible.slice(input.maxRequirements)) {
    heldBack.push({
      theme: theme.label,
      reason: `Below the cut: the limit of ${input.maxRequirements} requirements went to themes from more important inputs or with more evidence.`,
      signals: theme.support.length,
    });
  }
  if (signals.length) {
    step("synthesizer", synthMeter, {
      title: "Grouped the signals into themes",
      summary: `Grouped ${plural(signals.length, "signal")} into ${plural(themes.length, "theme")} and picked ${selected.length} for requirements: most important input first, then the most evidence.`,
      notes: synthNotes,
      stats: [
        ["themes", themes.length],
        ["picked", selected.length],
        ["held back", Math.max(0, themes.length - selected.length)],
      ],
      info: synthW.info,
      offline: synthW.offline,
    });
    log(`Synthesizer: ${themes.length} themes, ${selected.length} picked for requirements.`);
  }

  // ── 4. Architect ⇄ critic ────────────────────────────────────────────────────────────────
  const archW = writer("architect");
  const criticW = writer("critic");
  const archMeter = new Meter();
  const criticMeter = new Meter();
  const rejected: string[] = [];
  const otherThemes = selected.map(({ theme }) => theme.label);
  const contextPayload = briefs.map((b) => ({
    ref: b.ref,
    label: b.label,
    whatItIs: b.whatItIs,
    facts: b.facts,
    implications: b.implications,
    caveats: b.caveats,
  }));
  let built: Built[] = [];
  if (selected.length) {
    ctx.progress(0.6, "Architect is writing, critic is reviewing");
    let done = 0;
    const settled = await mapPool(
      selected,
      Math.min(archW.info.maxParallel, criticW.info.maxParallel),
      async ({ theme }): Promise<Built | null> => {
        const base = {
          theme: { label: theme.label, need: theme.need, category: theme.category },
          ...themeEvidence(theme),
          context: contextPayload,
          otherThemes: otherThemes.filter((l) => l !== theme.label).slice(0, 40),
        };
        const first = await ask(archW, archMeter, {
          system: architectSystem(setup),
          payload: { contract: CONTRACT.architect, ...base },
          schema: DraftAnswer,
          tier: "default",
          maxTokens: 3000,
        });
        let draft = cleanDraft(first.object, theme, briefs);
        let thinking = first.thinking;
        let architectModel = first.model;
        const review1 = (
          await ask(criticW, criticMeter, {
            system: criticSystem(setup),
            payload: { contract: CONTRACT.critic, ...base, draft },
            schema: ReviewAnswer,
            tier: "default",
            maxTokens: 3000,
          })
        ).object;
        let review = review1;
        let outcome: CritiqueOutcome = "accepted";
        let openIssues: string[] = [];
        if (review1.verdict === "reject") {
          rejected.push(
            `${theme.label}: ${oneLine(review1.rejectReason || review1.issues.join("; "), 200)}`,
          );
          return null;
        }
        if (review1.verdict === "revise") {
          const second = await ask(archW, archMeter, {
            system: architectSystem(setup),
            payload: {
              contract: CONTRACT.revise,
              ...base,
              draft,
              review: { issues: review1.issues, fixes: review1.fixes },
            },
            schema: DraftAnswer,
            tier: "default",
            maxTokens: 3000,
          });
          draft = cleanDraft(second.object, theme, briefs);
          thinking = second.thinking ?? thinking;
          architectModel = second.model;
          const review2 = (
            await ask(criticW, criticMeter, {
              system: criticSystem(setup),
              payload: { contract: CONTRACT.critic, ...base, draft },
              schema: ReviewAnswer,
              tier: "default",
              maxTokens: 3000,
            })
          ).object;
          if (review2.verdict === "reject") {
            rejected.push(
              `${theme.label}: ${oneLine(review2.rejectReason || review2.issues.join("; "), 200)}`,
            );
            return null;
          }
          review = review2;
          outcome = review2.verdict === "accept" ? "revised" : "flagged";
          openIssues =
            review2.verdict === "accept" ? [] : review2.issues.map((x) => oneLine(x, 300));
        }
        done++;
        ctx.progress(
          0.6 + 0.28 * (done / selected.length),
          `Requirements drafted: ${done}/${selected.length}`,
        );
        return {
          theme,
          draft,
          review,
          outcome,
          firstIssues: review1.issues.map((x) => oneLine(x, 300)),
          openIssues,
          thinking,
          architectModel,
        };
      },
      ctx.signal,
    );
    const failures = settled.filter((r) => r.status === "rejected");
    if (failures.length / selected.length > MAX_FAILED_SHARE) {
      throw new Error(
        `Writing requirements failed for ${failures.length} of ${selected.length} themes: ${errorText((failures[0] as PromiseRejectedResult).reason)}`,
      );
    }
    settled.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value) built.push(r.value);
      else if (r.status === "rejected") {
        heldBack.push({
          theme: selected[i]!.theme.label,
          reason: `Couldn't be written: ${oneLine(errorText(r.reason), 200)}`,
          signals: selected[i]!.theme.support.length,
        });
      }
    });
    for (const line of rejected) {
      const [label, ...why] = line.split(": ");
      heldBack.push({
        theme: label!,
        reason: `The critic rejected it: ${why.join(": ") || "no reason given"}`,
        signals: themes.find((t) => t.label === label)?.support.length ?? 0,
      });
    }
    built = dedupeByTitle(built, heldBack);
    const revised = built.filter((b) => b.outcome === "revised").length;
    const flagged = built.filter((b) => b.outcome === "flagged").length;
    step("architect", archMeter, {
      title: "Wrote the requirements",
      summary: `Drafted ${plural(selected.length, "requirement")}; ${revised} were rewritten after the critic's review.`,
      notes: failures.length
        ? [
            `${failures.length} theme(s) couldn't be written: ${errorText((failures[0] as PromiseRejectedResult).reason)}`,
          ]
        : [],
      stats: [
        ["drafts", selected.length],
        ["rewritten", revised],
      ],
      info: archW.info,
      offline: archW.offline,
    });
    step("critic", criticMeter, {
      title: "Reviewed every draft",
      summary: `Accepted ${built.length - revised - flagged} as written, ${revised} after a rewrite; ${flagged} keep open issues and ${rejected.length} were rejected.`,
      notes: rejected.map((r) => `Rejected — ${r}`),
      stats: [
        ["accepted", built.length - revised - flagged],
        ["after rewrite", revised],
        ["open issues", flagged],
        ["rejected", rejected.length],
      ],
      info: criticW.info,
      offline: criticW.offline,
    });
    log(
      `Architect and critic: ${built.length} requirements (${revised} rewritten, ${flagged} with open issues, ${rejected.length} rejected).`,
    );
  }

  // ── 5. Judge ─────────────────────────────────────────────────────────────────────────────
  const judgeMeter = new Meter();
  const judgeNotes: string[] = [];
  const questions = judgeQuestions(input.scope.horizonYears);
  const answers: (Record<string, DecisionAnswer> | null)[] = [];
  if (built.length) {
    ctx.progress(0.9, "Judge is rating each requirement");
    const settled = await mapPool(
      built,
      judge.info.maxParallel,
      async (b) => {
        const res = await judge.decisions.decide({
          state: judgeState(b, input.scope),
          questions,
          signal: ctx.signal,
        });
        judgeMeter.add(res.model, res.usage);
        return res.answers;
      },
      ctx.signal,
    );
    settled.forEach((r) => {
      if (r.status === "fulfilled") answers.push(r.value);
      else {
        judgeMeter.calls++;
        judgeMeter.failed++;
        answers.push(null);
        judgeNotes.push(`The judge couldn't rate one requirement: ${errorText(r.reason)}`);
      }
    });
  }

  // ── 6. Requirements (code only) ──────────────────────────────────────────────────────────
  const at = now();
  const order = built
    .map((b, i) => ({
      b,
      answers: answers[i] ?? null,
      rank: Math.min(...b.theme.support.map((s) => s.rank)),
    }))
    .sort((x, y) => x.rank - y.rank || weightOf(y.b.theme) - weightOf(x.b.theme));
  const requirements: Requirement[] = [];
  const themeObjects: Theme[] = [];
  const reasoning: RequirementReasoning[] = [];
  const linked = new Map<string, Finding>();
  const actorModel = (m: string) => (archW.offline ? OFFLINE_MODEL : m);
  order.forEach(({ b, answers: judged, rank }, i) => {
    const id = formatRequirementId(input.scope.vehicleCode, input.scope.market, input.firstSeq + i);
    // The whole theme backs the requirement (the architect only sees its strongest signals);
    // the signals it cited lead the evidence shown in the thought process.
    const support = b.theme.support;
    const cited = support.filter((s) => b.draft.usedSignals.includes(s.ref));
    const facts = evidenceFacts(support, b.theme.conflicting, prepared.sources);
    const score = scoreFromReview(b.review.factors, ctx.settings.scoring, at);
    const priority = priorityForRank(rank, input.priorities.length);
    const confidence = combineConfidence({
      answers: judged,
      judgeModel: judge.offline ? OFFLINE_MODEL : ([...judgeMeter.models][0] ?? judge.info.model),
      evidence: facts,
      outcome: b.outcome,
    });
    const disagree = score.suggestedPriority !== priority;
    const rankLabel = `${rank}. Priority`;
    const themeId = `thm_${hash(`${ctx.runId}|${ctx.blockId}|${b.theme.label}`)}`;
    for (const s of [...support, ...b.theme.conflicting]) linked.set(s.finding.id, s.finding);
    const requirement = Requirement.parse({
      id,
      version: 1,
      title: b.draft.title,
      description: b.draft.description,
      category: b.draft.category,
      scope: input.scope,
      targets: b.draft.targets,
      findingIds: support.map((s) => s.finding.id),
      sourceIds: unique(support.flatMap((s) => s.finding.evidence.map((e) => e.sourceId))),
      conflictingFindingIds: b.theme.conflicting.map((s) => s.finding.id),
      score,
      priority,
      priorityRationale:
        `Its evidence arrived on ${rankLabel} of ${input.priorities.length}, so it is a ${priority}-have. ` +
        `The critic's scores give ${score.total}/100 (${score.suggestedPriority})` +
        (disagree
          ? ": input ranking and scores disagree, so check it before approving."
          : ", which agrees."),
      evidenceLevel: evidenceLevel(facts),
      kano: b.draft.kano,
      assumptions: b.draft.assumptions,
      uncertainties: [
        ...b.draft.uncertainties,
        ...b.openIssues.map((x) => `Open issue from the critic: ${x}`),
        ...(disagree
          ? [
              `The input ranking (${priority}) and the critic's scores (${score.suggestedPriority}) disagree.`,
            ]
          : []),
      ],
      status: "proposed",
      confidence,
      inputRank: rank,
      createdBy: { type: "ai", component: "add_to_car", model: actorModel(b.architectModel) },
      createdAt: at,
      updatedAt: at,
      runId: ctx.runId,
    });
    requirements.push(requirement);
    themeObjects.push({
      id: themeId,
      label: b.theme.label,
      summary: b.theme.need,
      category: b.theme.category,
      findingIds: support.map((s) => s.finding.id),
    });
    reasoning.push({
      requirementId: id,
      title: requirement.title,
      theme: b.theme.label,
      ranks: unique(support.map((s) => s.rank)).sort((x, y) => x - y),
      evidence: traceEvidence(cited.length ? cited : support, b.theme.conflicting),
      thoughts: thoughtsFor(b, support, judged, briefs, input.scope),
      verdict: b.outcome,
      issues: b.outcome === "revised" ? b.firstIssues : b.openIssues,
      confidence,
      contextUsed: briefs.filter((c) => b.draft.contextUsed.includes(c.ref)).map((c) => c.label),
    });
  });
  if (built.length) {
    const mean =
      requirements.reduce((s, r) => s + (r.confidence?.value ?? 0), 0) / requirements.length;
    step("judge", judgeMeter, {
      title: "Rated each requirement",
      summary: `Answered four short questions per requirement (backed by the evidence? customer-facing? still wanted at launch? testable?); with facts about the evidence they make up the confidence.`,
      notes: [
        judge.info.provider === "jev"
          ? "TypeSafe Jev answered: a decision model built for calibrated yes/no and scale answers."
          : judge.offline
            ? "Offline: fixed middle answers, not a judgement."
            : `An LLM (${judge.info.setupName}) answered the typed questions.`,
        ...judgeNotes,
      ],
      stats: [
        ["rated", requirements.length],
        ["mean confidence %", Math.round(mean * 100)],
      ],
      info: judge.info,
      offline: judge.offline,
    });
  }

  // Link our own findings to their theme (upstream findings stay untouched).
  const themeOf = new Map(themeObjects.flatMap((t) => t.findingIds.map((f) => [f, t.id] as const)));
  const findings = created.map((f) =>
    themeOf.has(f.id) ? { ...f, themeId: themeOf.get(f.id) } : f,
  );
  const upstreamUsed = [...linked.values()].filter((f) => !created.some((c) => c.id === f.id));
  const citedRecords = new Set(
    [...findings, ...excluded, ...upstreamUsed].flatMap((f) => f.evidence.map((e) => e.recordId)),
  );
  const records = [...prepared.recordIndex.values()]
    .map((r) => r.record)
    .filter((r) => citedRecords.has(r.id));

  const offline = [...writers.values()].every((w) => w.offline) && judge.offline;
  const trace = ReasoningTrace.parse({
    id: `rsn_${hash(`${ctx.runId}|${ctx.blockId}|${at}`)}`,
    runId: ctx.runId,
    blockId: ctx.blockId,
    createdAt: at,
    scope: input.scope,
    inputs: [
      ...input.priorities.map((p) => ({
        port: p.port,
        label: p.label,
        kind: "priority" as const,
        rank: p.rank,
        counts: countsOf(p.data),
      })),
      ...input.contexts.map((c) => ({
        port: c.port,
        label: c.label,
        kind: "context" as const,
        mode: c.mode,
        counts: countsOf(c.data),
      })),
    ],
    steps,
    requirements: reasoning,
    heldBack,
    totals: {
      calls: meters.reduce((n, m) => n + m.calls, 0),
      inputTokens: meters.reduce((n, m) => n + m.inputTokens, 0),
      outputTokens: meters.reduce((n, m) => n + m.outputTokens, 0),
      durationMs: Date.now() - startedAt,
    },
    offline,
  });
  return {
    requirements,
    findings,
    excluded,
    themes: themeObjects,
    upstreamUsed,
    records,
    sources: [...prepared.sources.values()],
    trace,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────

/** Records in prompt-sized batches; a batch never mixes inputs, so its signals keep one rank. */
export function batchRecords(records: RecordItem[]): RecordItem[][] {
  const batches: RecordItem[][] = [];
  let current: RecordItem[] = [];
  let chars = 0;
  for (const item of records) {
    const size = Math.min(item.record.text.length, RECORD_CHARS) + 40 * item.hints.length;
    if (
      current.length &&
      (current[0]!.rank !== item.rank ||
        current.length >= BATCH_RECORDS ||
        chars + size > BATCH_CHARS)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** All signals in one call when they fit; otherwise per category, in chunks. */
function signalGroups(signals: Signal[]): Signal[][] {
  if (signals.length <= MAX_SIGNALS_PER_GROUP) return [signals];
  const byCategory = new Map<string, Signal[]>();
  for (const s of signals) {
    const list = byCategory.get(s.finding.category) ?? [];
    list.push(s);
    byCategory.set(s.finding.category, list);
  }
  const groups: Signal[][] = [];
  for (const list of byCategory.values()) {
    list.sort((a, b) => a.rank - b.rank || b.finding.mentions - a.finding.mentions);
    for (let i = 0; i < list.length; i += MAX_SIGNALS_PER_GROUP) {
      groups.push(list.slice(i, i + MAX_SIGNALS_PER_GROUP));
    }
  }
  return groups;
}

function mergeThemes(
  themes: ThemeItem[],
  answer: MergeAnswer,
): { themes: ThemeItem[]; count: number } {
  const byRef = new Map(themes.map((t, i) => [`t${i + 1}`, t]));
  const absorbed = new Set<string>();
  let count = 0;
  for (const m of answer.merges) {
    const keep = byRef.get(m.keep);
    if (!keep || absorbed.has(m.keep)) continue;
    for (const ref of unique(m.absorb)) {
      const other = byRef.get(ref);
      if (!other || ref === m.keep || absorbed.has(ref)) continue;
      absorbed.add(ref);
      count++;
      const support = new Set(keep.support.map((s) => s.ref));
      for (const s of other.support) if (!support.has(s.ref)) keep.support.push(s);
      const all = new Set(keep.support.map((s) => s.ref));
      const conflicting = new Map(keep.conflicting.map((s) => [s.ref, s]));
      for (const s of other.conflicting) if (!all.has(s.ref)) conflicting.set(s.ref, s);
      keep.conflicting = [...conflicting.values()].filter((s) => !all.has(s.ref));
    }
  }
  return { themes: [...byRef].filter(([ref]) => !absorbed.has(ref)).map(([, t]) => t), count };
}

/** An analyst's signal as a Finding: refs checked, quotes made verbatim, nothing invented. */
function toFinding(
  ctx: BlockContext,
  s: AnalystAnswer["signals"][number],
  handles: Map<string, RecordItem>,
): { finding: Finding | null; refs: string[]; repaired: number; unknownRefs: number } {
  const mentioned = unique([...s.refs, ...s.quotes.map((q) => q.ref)]);
  const refs = mentioned.filter((r) => handles.has(r));
  const result = { refs, repaired: 0, unknownRefs: mentioned.length - refs.length };
  const statement = oneLine(s.statement, 500);
  if (!refs.length || !statement) return { ...result, finding: null };
  const evidence: Finding["evidence"] = [];
  const seen = new Set<string>();
  const cite = (item: RecordItem, excerpt: string) => {
    const key = `${item.record.id}|${excerpt}`;
    if (seen.has(key) || evidence.length >= MAX_EXCERPTS_PER_FINDING) return;
    seen.add(key);
    evidence.push({
      sourceId: item.record.sourceId,
      recordId: item.record.id,
      excerpt: excerpt.slice(0, MAX_EXCERPT_CHARS),
      ...(item.record.locator ? { locator: item.record.locator } : {}),
    });
  };
  const quoted = new Set<string>();
  for (const q of s.quotes) {
    const item = handles.get(q.ref);
    if (!item) continue;
    let excerpt = findVerbatim(item.record.text, q.quote);
    if (!excerpt) {
      result.repaired++;
      excerpt = openingExcerpt(item.record.text);
    }
    cite(item, excerpt);
    quoted.add(q.ref);
  }
  for (const ref of refs)
    if (!quoted.has(ref)) cite(handles.get(ref)!, openingExcerpt(handles.get(ref)!.record.text));
  const records = refs.map((r) => handles.get(r)!.record);
  const finding = Finding.parse({
    id: `fnd_${hash(
      `${ctx.runId}|${ctx.blockId}|${records
        .map((r) => r.id)
        .sort()
        .join(",")}|${statement}`,
    )}`,
    kind: s.kind,
    statement,
    category: s.category,
    evidence,
    mentions: refs.length,
    sentiment: Math.max(-1, Math.min(1, Number.isFinite(s.sentiment) ? s.sentiment : 0)),
    markets: unique(records.map((r) => r.market).filter((m): m is string => !!m)),
    confidence: result.repaired ? 0.6 : 0.8,
    inScope: s.inScope,
    ...(s.inScope ? {} : { outOfScopeReason: oneLine(s.outOfScopeReason, 300) || "Out of scope." }),
  });
  return { ...result, finding };
}

function cleanDraft(d: DraftAnswer, theme: ThemeItem, briefs: Brief[]): DraftAnswer {
  const title = oneLine(d.title, 120);
  const description = d.description.replace(/\s+/g, " ").trim();
  if (!title || !description)
    throw new Error("The architect returned a requirement without title or description");
  const refs = new Set(theme.support.map((s) => s.ref));
  const used = unique(d.usedSignals).filter((r) => refs.has(r));
  const lines = (xs: string[], max: number) =>
    xs
      .map((x) => oneLine(x, 300))
      .filter(Boolean)
      .slice(0, max);
  return {
    ...d,
    title,
    description,
    targets: d.targets
      .map((t) => ({
        metric: oneLine(t.metric, 200),
        target: oneLine(t.target, 300),
        acceptance: oneLine(t.acceptance, 300),
      }))
      .filter((t) => t.metric && t.target && t.acceptance)
      .slice(0, 3),
    assumptions: lines(d.assumptions, 6),
    uncertainties: lines(d.uncertainties, 6),
    why: oneLine(d.why, 700),
    usedSignals: used.length ? used : [...refs],
    contextUsed: unique(d.contextUsed).filter((r) => briefs.some((b) => b.ref === r)),
  };
}

/** The evidence an architect or critic sees for one theme: strongest signals first, with quotes. */
function themeEvidence(t: ThemeItem) {
  const order = (xs: Signal[]) =>
    [...xs].sort((a, b) => a.rank - b.rank || b.finding.mentions - a.finding.mentions);
  return {
    signals: order(t.support)
      .slice(0, 12)
      .map((s) => ({
        ref: s.ref,
        kind: s.finding.kind,
        statement: clip(s.finding.statement, 300),
        mentions: s.finding.mentions,
        rank: s.rank,
        markets: s.finding.markets.slice(0, 3),
        quotes: s.finding.evidence.slice(0, 2).map((e) => clip(e.excerpt, 300)),
      })),
    moreSignals: Math.max(0, t.support.length - 12),
    conflicting: order(t.conflicting)
      .slice(0, 5)
      .map((s) => ({
        ref: s.ref,
        statement: clip(s.finding.statement, 300),
        mentions: s.finding.mentions,
        quotes: s.finding.evidence.slice(0, 1).map((e) => clip(e.excerpt, 300)),
      })),
  };
}

function judgeState(b: Built, scope: ProductScope): string {
  const used = b.theme.support.filter((s) => b.draft.usedSignals.includes(s.ref));
  const quotes = (used.length ? used : b.theme.support)
    .flatMap((s) => s.finding.evidence.slice(0, 2))
    .slice(0, 8);
  const against = b.theme.conflicting.flatMap((s) => s.finding.evidence.slice(0, 1)).slice(0, 3);
  const lines = [
    `Requirement for the successor of the BMW ${scope.vehicleLine}${scope.derivative ? ` ${scope.derivative}` : ""} (${scope.vehicleCode}), market ${scope.market}, launching in about ${scope.horizonYears} years.`,
    `Title: ${b.draft.title}`,
    `Description: ${b.draft.description}`,
    ...b.draft.targets.map(
      (t) => `Target: ${t.metric} — ${t.target} (checked by: ${t.acceptance})`,
    ),
    "Customer evidence (verbatim quotes):",
    ...quotes.map((e) => `- "${clip(e.excerpt, 400)}"`),
    ...(against.length
      ? ["Evidence against it:", ...against.map((e) => `- "${clip(e.excerpt, 400)}"`)]
      : []),
  ];
  return lines.join("\n").slice(0, 12_000);
}

function thoughtsFor(
  b: Built,
  support: Signal[],
  judged: Record<string, DecisionAnswer> | null,
  briefs: Brief[],
  scope: ProductScope,
): ThoughtLine[] {
  const top = [...support].sort((x, y) => y.finding.mentions - x.finding.mentions)[0]!;
  const ranks = unique(support.map((s) => s.rank)).sort((x, y) => x - y);
  const lines: ThoughtLine[] = [
    {
      role: "analyst",
      text: `${plural(mentionsOf(support), "record")} on ${ranks.map((r) => `${r}. Priority`).join(" and ")} back this, e.g. “${clip(top.finding.statement, 200)}”`,
    },
    {
      role: "synthesizer",
      text: `Grouped ${plural(b.theme.support.length, "signal")} into “${b.theme.label}”: ${b.theme.need}${b.theme.conflicting.length ? ` ${plural(b.theme.conflicting.length, "signal")} argue against it.` : ""}`,
    },
    { role: "architect", text: b.draft.why || "Wrote the requirement from the theme's signals." },
  ];
  const used = briefs.filter((c) => b.draft.contextUsed.includes(c.ref));
  if (used.length) {
    lines.push({
      role: "context",
      text: `Drew on ${used.map((c) => c.label).join(", ")}: ${used[0]!.implications[0] ?? used[0]!.whatItIs}`,
    });
  }
  if (b.thinking)
    lines.push({
      role: "architect",
      text: `Own reasoning (summary): ${clip(b.thinking.replace(/\s+/g, " "), 600)}`,
    });
  lines.push({
    role: "critic",
    text:
      b.outcome === "accepted"
        ? "Accepted the draft: no material issues."
        : b.outcome === "revised"
          ? `Asked for changes (${b.firstIssues.slice(0, 3).join("; ") || "unspecified"}); the rewrite passed.`
          : `Still sees open issues: ${b.openIssues.slice(0, 3).join("; ")}`,
  });
  const p = (key: string) => {
    const a = judged?.[key];
    return a?.type === "noul" ? `${Math.round(a.value * 100)} %` : "–";
  };
  const level = (key: string) => {
    const a = judged?.[key];
    const q = judgeQuestions(scope.horizonYears)[key];
    return a?.type === "score" && q?.type === "score"
      ? (q.criteria[Math.round(a.score)] ?? "–").toLowerCase()
      : "–";
  };
  lines.push({
    role: "judge",
    text: judged
      ? `Backed by the evidence: ${p("support")} · customer-facing: ${p("scope")} · still wanted at launch: ${level("durability")} · ${level("clarity")}.`
      : "Couldn't answer; the confidence rests on the evidence facts only.",
  });
  return lines;
}

function traceEvidence(support: Signal[], conflicting: Signal[]): TraceEvidence[] {
  const from = (s: Signal, supports: boolean, n: number) =>
    s.finding.evidence.slice(0, n).map((e) => ({
      sourceId: e.sourceId,
      ...(e.recordId ? { recordId: e.recordId } : {}),
      findingId: s.finding.id,
      excerpt: e.excerpt,
      rank: s.rank,
      supports,
    }));
  const strongest = [...support].sort(
    (a, b) => a.rank - b.rank || b.finding.mentions - a.finding.mentions,
  );
  return [
    ...strongest.flatMap((s) => from(s, true, 1)).slice(0, 5),
    ...conflicting.flatMap((s) => from(s, false, 1)).slice(0, 2),
  ];
}

function evidenceFacts(
  support: Signal[],
  conflicting: Signal[],
  sources: Map<string, Source>,
): EvidenceFacts {
  const sourceIds = unique(support.flatMap((s) => s.finding.evidence.map((e) => e.sourceId)));
  return {
    mentions: mentionsOf(support),
    sources: sourceIds.length,
    quantitative: sourceIds.some((id) =>
      QUANTITATIVE_KINDS.has(sources.get(id)?.kind ?? "other_web"),
    ),
    forwardOnly: support.every((s) => s.finding.kind === "market_trend"),
    conflictingMentions: mentionsOf(conflicting),
  };
}

const mentionsOf = (xs: Signal[]) => xs.reduce((n, s) => n + Math.max(1, s.finding.mentions), 0);
/** Evidence weighted by how important its input is: 1. Priority counts fully, 2. half, … */
const weightOf = (t: ThemeItem) =>
  t.support.reduce((w, s) => w + Math.max(1, s.finding.mentions) / s.rank, 0);
const isQuantitative = (f: Finding, sources: Map<string, Source>) =>
  f.evidence.some((e) => QUANTITATIVE_KINDS.has(sources.get(e.sourceId)?.kind ?? "other_web"));

function summarizeReasons(fs: Finding[]): string {
  const counts = new Map<string, number>();
  for (const f of fs)
    counts.set(CATEGORY_LABELS[f.category], (counts.get(CATEGORY_LABELS[f.category]) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c]) => c.toLowerCase())
    .join(", ");
}

/** Two drafts with the same title are one requirement: keep the stronger, report the other. */
function dedupeByTitle(built: Built[], heldBack: ReasoningTrace["heldBack"]): Built[] {
  const seen = new Map<string, Built>();
  for (const b of built) {
    const key = b.draft.title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    const prev = seen.get(key);
    if (!prev) seen.set(key, b);
    else {
      const [keep, drop] = weightOf(prev.theme) >= weightOf(b.theme) ? [prev, b] : [b, prev];
      seen.set(key, keep);
      heldBack.push({
        theme: drop.theme.label,
        reason: `Same requirement as “${keep.draft.title}”, which has more evidence.`,
        signals: drop.theme.support.length,
      });
    }
  }
  return [...seen.values()];
}

function countsOf(d: {
  sources: unknown[];
  records: unknown[];
  findings: unknown[];
  themes: unknown[];
  requirements: unknown[];
}) {
  return {
    sources: d.sources.length,
    records: d.records.length,
    findings: d.findings.length,
    themes: d.themes.length,
    requirements: d.requirements.length,
  };
}
