import { createHash } from "node:crypto";
import {
  emptyPipelineData,
  formatRequirementId,
  parseBlockParams,
  priorityForScore,
  type Actor,
  type EvidenceLevel,
  type EvidenceRef,
  Finding,
  type JudgeActions,
  type JudgeVerdict,
  type JudgingAgents,
  PipelineData,
  Requirement,
  type Source,
  type SourceRecord,
} from "@reqflow/core";
import { defineBlock, type BlockContext } from "@reqflow/engine";
import { ASPECTS, COMPONENTS, GENERAL_ASPECT } from "../add-to-car/taxonomy";
import { collectEvidence, segmentsFor, type Citation, type JudgeSource } from "./evidence";
import {
  GENERAL_DIMENSION_WEIGHT,
  REQUEST_WEIGHT,
  band,
  computeSignals,
  confidenceScores,
  evidenceStrength,
  mulberry32,
  problemPriority,
  rankActions,
  severityOf,
  studyBadness,
  type EvidenceStrength,
  type ProblemDef,
  type StudyObservation,
  type WebItem,
} from "./scoring";
import { verifyQuote } from "./web-verify";

/** Mirrors BLOCK_SPECS.ai_judge.params (validated by parseBlockParams before use). */
interface JudgeParams {
  query: string;
  sources: string[];
  webResearch: boolean;
  market: string; // "global" = from Settings, "all" = every market weighted by sales
  salesYear: string;
  maxProblems: number;
  model: string;
  reasoningEffort: string;
}

const SAMPLE_SIZE = 20;
const JUDGE_QUOTES = 12;
const CONCURRENCY = 3;

const COMPONENT_BY_ID = new Map(COMPONENTS.map((c) => [c.id, c]));
const ASPECT_BY_ID = new Map([...ASPECTS, GENERAL_ASPECT].map((a) => [a.id, a]));
const labelOf = (key: string) => {
  const [c, a] = key.split("|") as [string, string];
  return `${COMPONENT_BY_ID.get(c)?.label ?? c} › ${ASPECT_BY_ID.get(a)?.label ?? a}`;
};
const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const hash = (s: string) => createHash("sha1").update(s).digest("hex");

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

function quoteLine(c: Citation): string {
  const context = c.record.text.length > 700 ? `${c.record.text.slice(0, 699)}…` : c.record.text;
  return `[${c.ref}] (${c.derivative}/${c.region}, ${c.mention.polarity ?? "unclear"}) "${c.mention.excerpt}"${
    context !== c.mention.excerpt ? `\n      full text: "${context}"` : ""
  }`;
}

/** Seeded sample without duplicate records, so a rerun shows the same quotes. */
function sample(cites: Citation[], n: number, seed: string): Citation[] {
  const seen = new Set<string>();
  const unique = cites.filter((c) =>
    seen.has(c.record.id) ? false : (seen.add(c.record.id), true),
  );
  const rnd = mulberry32(parseInt(hash(seed).slice(0, 8), 16));
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [unique[i], unique[j]] = [unique[j]!, unique[i]!];
  }
  return unique.slice(0, n);
}

/**
 * AI Judge: for one part or problem, ranks what should be done.
 * - Inputs are the PM's source ranking (input 1 counts most, rank-order centroid weights).
 * - Importance is deterministic (scoring.ts); confidence comes from an independent judge agent plus
 *   deterministic evidence strength that ignores the PM's ranking.
 * - Every requirement cites verbatim excerpts with their row (or the verified web page).
 * Agents (Mastra, OpenAI) only propose and check; the PM decides.
 */
export const aiJudgeBlock = defineBlock({
  kind: "ai_judge",
  async run(inputs, rawParams, ctx: BlockContext) {
    const p = parseBlockParams("ai_judge", rawParams) as unknown as JudgeParams;
    if (!p.query.trim())
      throw new Error('Name the part or problem to judge (parameter "Part or problem")');
    const agents = ctx.agents
      ? await ctx.agents({ model: p.model, reasoningEffort: p.reasoningEffort })
      : null;
    if (!agents) {
      throw new Error("The AI Judge needs an OpenAI API key: add it in Settings → AI & research.");
    }
    const actorAi = (component: string): Actor => ({ type: "ai", component, model: agents.model });
    const actorDet: Actor = { type: "ai", component: "ai_judge.scoring", model: "deterministic" };
    const run = ctx.runId.startsWith("run_") ? { runId: ctx.runId, blockId: ctx.blockId } : {};
    const notes: string[] = [];

    // ------------------------------------------------------------ evidence from the ranked inputs
    const labels = p.sources;
    const data = labels.map((_, i) => inputs[`in-${i}`] ?? emptyPipelineData());
    const region = p.market === "global" ? ctx.scope.market : p.market === "all" ? null : p.market;
    const filter = { derivative: ctx.scope.vehicleCode as string | null, region };
    const ev = collectEvidence(data, labels, filter);
    notes.push(...ev.notes);
    const segments = segmentsFor(ev, filter, p.salesYear, notes);
    ctx.progress(
      0.05,
      `Read ${ev.citations.length} classified mentions from ${labels.length} ranked inputs`,
    );
    ctx.signal.throwIfAborted();

    // ------------------------------------------------------------ scope (agent)
    const scope = await agents.resolveScope(
      `Query: "${p.query}"\n\nComponents (id: label):\n${COMPONENTS.map((c) => `- ${c.id}: ${c.label}`).join("\n")}\n\nAspects (id: label):\n${[
        ...ASPECTS,
        GENERAL_ASPECT,
      ]
        .map((a) => `- ${a.id}: ${a.label}`)
        .join("\n")}`,
      ctx.signal,
    );
    const valid = (e: { component: string; aspect: string | null }) =>
      COMPONENT_BY_ID.has(e.component) && (e.aspect === null || ASPECT_BY_ID.has(e.aspect));
    const core = scope.core.filter(valid);
    const adjacent = scope.adjacent
      .filter(valid)
      .map((e) => ({ ...e, relevance: Math.min(0.8, Math.max(0.2, e.relevance)) }));
    if (!core.length)
      throw new Error(
        `Could not map "${p.query}" to a vehicle component. Try naming a part, e.g. "seats".`,
      );
    const relevance = (c: string, a: string) => {
      let r = 0;
      for (const e of core)
        if (e.component === c) r = Math.max(r, e.aspect === null || e.aspect === a ? 1 : 0.5);
      for (const e of adjacent)
        if (e.component === c)
          r = Math.max(r, e.aspect === null || e.aspect === a ? e.relevance : e.relevance * 0.5);
      return r;
    };
    const outOfScope = (c: string, a: string) =>
      COMPONENT_BY_ID.get(c)?.outOfScope ?? ASPECT_BY_ID.get(a)?.outOfScope;
    const keys = new Set([
      ...ev.cells.map((c) => c.problemKey),
      ...ev.studies.map((s) => s.problemKey),
    ]);
    const problems: ProblemDef[] = [];
    for (const key of keys) {
      const [component, aspect] = key.split("|") as [string, string];
      const r = relevance(component, aspect);
      if (r === 0) continue;
      const why = outOfScope(component, aspect);
      if (why) {
        notes.push(`${labelOf(key)}: left out (${why})`);
        continue;
      }
      problems.push({ key, component, aspect, relevance: r });
    }
    const studies: StudyObservation[] = [];
    for (const o of ev.studies) {
      const [c, a] = o.problemKey.split("|") as [string, string];
      studies.push(o);
      if (a === "general") {
        for (const pr of problems) {
          if (pr.component === c && pr.aspect !== "general")
            studies.push({ ...o, problemKey: pr.key, mapWeight: GENERAL_DIMENSION_WEIGHT });
        }
      }
    }
    ctx.progress(0.15, `Scope: ${scope.interpretation}`);

    // ------------------------------------------------------------ web research for empty inputs (agent + live check)
    const sources: JudgeSource[] = [...ev.sources];
    const webItems: WebItem[] = ev.citations
      .filter((c) => c.region === "WEB" && c.mention.polarity)
      .map((c) => ({
        sourceId: c.sourceId,
        problemKey: `${c.mention.component}|${c.mention.aspect}`,
        polarity: c.mention.polarity!,
        verified: true,
        tierFactor: 0.75,
      }));
    const webCitations = ev.citations.filter((c) => c.region === "WEB");
    const webSources: Source[] = [];
    const webRecords: SourceRecord[] = [];
    const webRejected: string[] = [];
    if (p.webResearch && ev.emptyInputs.length) {
      const internal = sources.filter((s) => s.kind !== "web");
      const pre = computeSignals(problems, internal, segments, ev.totals, ev.cells, studies, []);
      const candidates = [...problems]
        .sort(
          (a, b) =>
            problemPriority(b, internal, pre).score - problemPriority(a, internal, pre).score,
        )
        .slice(0, 8);
      const top = labels.map((_, i) => i);
      const weightOf = (i: number) => {
        const n = top.length;
        let s = 0;
        for (let k = i + 1; k <= n; k++) s += 1 / k;
        return s / n;
      };
      await Promise.all(
        ev.emptyInputs.map(async (i) => {
          const sid = `in${i}_web`;
          const label = labels[i]!;
          try {
            ctx.log(`Researching "${label}" on the web…`);
            const res = await agents.research(
              `Source type to use: ${label}.\nVehicle: ${ctx.scope.vehicleLine}${filter.derivative ? ` (${filter.derivative})` : ""}${region ? `, market ${region}` : ""}.\nTopic from the product manager: "${p.query}" (${scope.interpretation}).\nProblems to find evidence for (key: label):\n${candidates.map((c) => `- ${c.key}: ${labelOf(c.key)}`).join("\n")}`,
              ctx.signal,
            );
            const items = res.items.slice(0, 12);
            const checked = await pool(items, 4, async (it) => ({
              it,
              v: await verifyQuote(it.url, it.quote, {
                signal: ctx.signal,
                allowedDomains: ctx.settings.research.allowedDomains,
                blockedDomains: ctx.settings.research.blockedDomains,
              }),
            }));
            let ok = 0;
            for (const { it, v } of checked) {
              const key = problems.some((x) => x.key === it.problemKey) ? it.problemKey : "other";
              if (!v.verified) {
                webRejected.push(`${label}: ${it.url} (${v.reason})`);
                continue;
              }
              ok++;
              const src: Source = {
                id: `src_web_${hash(it.url).slice(0, 12)}`,
                kind: /forum|reddit|social|owner/i.test(label) ? "review" : "other_web",
                origin: "web",
                title: `${it.publisher} — ${it.title}`.slice(0, 200),
                uri: it.url,
                publisher: it.publisher,
                retrievedAt: new Date().toISOString(),
                reliability: /forum|reddit|social/i.test(label) ? "low" : "medium",
              };
              const rec: SourceRecord = {
                id: `rec_web_${hash(it.url + it.quote).slice(0, 12)}`,
                sourceId: src.id,
                text: it.quote,
                locator: it.url,
              };
              webSources.push(src);
              webRecords.push(rec);
              webItems.push({
                sourceId: sid,
                problemKey: key,
                polarity: it.polarity,
                verified: true,
                tierFactor: 0.5,
              });
              webCitations.push({
                ref: "",
                sourceId: sid,
                record: rec,
                source: src,
                mention: {
                  component: key.split("|")[0]!,
                  aspect: key.split("|")[1] ?? "general",
                  polarity: it.polarity,
                  method: "text_rule",
                  excerpt: it.quote,
                  rule: "web research",
                },
                derivative: "ALL",
                region: "WEB",
              });
            }
            ctx.log(`"${label}": ${ok} of ${items.length} web quotes verified on the live page.`);
            if (ok > 0)
              sources.push({
                id: sid,
                kind: "web",
                family: `web:${label}`,
                weight: weightOf(i),
                label,
                input: i,
                tier: 3,
              });
          } catch (e) {
            notes.push(
              `Web research for "${label}" failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }),
      );
    }
    // Inputs that stayed empty don't count; the others keep their ranked share, renormalized.
    const total = sources.reduce((s, x) => s + x.weight, 0);
    if (total <= 0)
      throw new Error(
        "No usable evidence arrived on any input (connect Raw blocks with customer feedback or a study).",
      );
    for (const s of sources) s.weight /= total;
    ctx.progress(0.3, "Scoring problems");
    ctx.signal.throwIfAborted();

    // ------------------------------------------------------------ problems: importance (deterministic)
    const signals = computeSignals(
      problems,
      sources,
      segments,
      ev.totals,
      ev.cells,
      studies,
      webItems,
    );
    const prio = new Map(problems.map((x) => [x.key, problemPriority(x, sources, signals)]));
    const ordered = [...problems].sort(
      (a, b) => prio.get(b.key)!.score - prio.get(a.key)!.score || a.key.localeCompare(b.key),
    );
    const chosen = ordered.filter((x) => prio.get(x.key)!.score > 0).slice(0, p.maxProblems);
    const fbIds = new Set(sources.filter((s) => s.kind === "feedback").map((s) => s.id));
    const citesOf = (key: string, pol: (x: string | null) => boolean) =>
      [...ev.citations.filter((c) => fbIds.has(c.sourceId)), ...webCitations].filter(
        (c) => `${c.mention.component}|${c.mention.aspect}` === key && pol(c.mention.polarity),
      );

    // ------------------------------------------------------------ actions (agent, per problem)
    const sourceLabel = new Map(sources.map((s) => [s.id, s.label]));
    const tasks = chosen.map((x) => {
      const quotes = sample(
        citesOf(x.key, (q) => q === "negative" || q === "request"),
        SAMPLE_SIZE,
        `${x.key}|neg`,
      ).map((c, i) => ({ ...c, ref: `E${i + 1}` }));
      const counter = sample(
        citesOf(x.key, (q) => q === "positive"),
        4,
        `${x.key}|pos`,
      ).map((c, i) => ({ ...c, ref: `P${i + 1}` }));
      const cells = ev.cells.filter((c) => c.problemKey === x.key && fbIds.has(c.sourceId));
      const sum = (k: "negative" | "request" | "positive") => cells.reduce((s, c) => s + c[k], 0);
      const studyLines = studies
        .filter((o) => o.problemKey === x.key)
        .map(
          (o) =>
            `"${o.dimension}" ${o.derivative}/${o.marketResolved ? o.market : "market unresolved"}: ${o.metric} ${r1(o.value * 100) / 100} vs the car's average ${r1(o.columnMean * 100) / 100} (${studyBadness(o) > 0 ? "worse" : "better"} than average)`,
        );
      const evidenceText = [
        `Customer feedback in scope: ${sum("negative")} complaints, ${sum("request")} requests, ${sum("positive")} positive mentions.`,
        ...[...fbIds].map((id) => {
          const c = cells.filter((y) => y.sourceId === id);
          return `  - ${sourceLabel.get(id)}: ${c.reduce((s, y) => s + y.negative, 0)} complaints, ${c.reduce((s, y) => s + y.request, 0)} requests, ${c.reduce((s, y) => s + y.positive, 0)} positive`;
        }),
        studyLines.length
          ? `Customer studies:\n${studyLines.map((l) => `  - ${l}`).join("\n")}`
          : "Customer studies: no mapped dimension.",
      ].join("\n");
      const population = new Set(
        citesOf(x.key, (q) => q === "negative" || q === "request").map((c) => c.record.id),
      ).size;
      return { problem: x, quotes, counter, evidenceText, population };
    });
    const proposals = await pool(tasks, CONCURRENCY, async (t) => {
      try {
        const res: JudgeActions = await agents.proposeActions(
          `Product manager's topic: "${p.query}" (${scope.interpretation}).\n\nProblem: ${labelOf(t.problem.key)}\n\nEvidence summary:\n${t.evidenceText}\n\nComplaint/request quotes (random sample of ${t.quotes.length} out of ${t.population}):\n${t.quotes.map(quoteLine).join("\n") || "(none)"}\n\nCounter-evidence (praise on the same topic):\n${t.counter.map(quoteLine).join("\n") || "(none sampled)"}`,
          ctx.signal,
        );
        const refs = new Set(t.quotes.map((q) => q.ref));
        const invalid = res.actions.flatMap((a) => a.addresses.filter((r) => !refs.has(r)));
        if (invalid.length)
          notes.push(
            `${labelOf(t.problem.key)}: removed ${invalid.length} citation(s) to quotes that were never shown.`,
          );
        return {
          t,
          actions: res.actions.slice(0, 3).map((a) => ({
            ...a,
            addresses: [...new Set(a.addresses.filter((r) => refs.has(r)))],
          })),
        };
      } catch (e) {
        notes.push(
          `No actions for ${labelOf(t.problem.key)}: ${e instanceof Error ? e.message : String(e)}`,
        );
        return { t, actions: [] };
      }
    });
    ctx.progress(0.6, "Ranking actions");
    ctx.signal.throwIfAborted();

    // ------------------------------------------------------------ action ranking (deterministic)
    const actions = proposals.flatMap(({ t, actions: list }) =>
      list.map((a) => {
        const n = t.quotes.length;
        let coverage = n ? a.addresses.length / n : 1;
        let coverageNote = n
          ? `addresses ${a.addresses.length} of ${n} sampled complaints/requests`
          : "no sampled quotes: coverage not discounted";
        if (n && a.type === "investigate" && coverage < 0.5) {
          coverage = 0.5;
          coverageNote +=
            "; investigate actions count at least 50% (they target the open question)";
        }
        return {
          t,
          a,
          coverage,
          coverageNote,
          pinned: severityOf(t.problem.component, t.problem.aspect).safety,
        };
      }),
    );
    const ids = actions.map((_, i) => `A${i + 1}`);
    const ranked = actions.length
      ? rankActions(
          actions.map((x, i) => ({
            id: ids[i]!,
            problemKey: x.t.problem.key,
            coverage: x.coverage,
            pinned: x.pinned,
          })),
          problems,
          sources,
          signals,
        )
      : [];
    const strength = new Map<string, EvidenceStrength>(
      tasks.map((t) => [
        t.problem.key,
        evidenceStrength(
          t.problem,
          sources,
          segments,
          ev.totals,
          ev.cells,
          studies,
          webItems,
          signals,
        ),
      ]),
    );

    // ------------------------------------------------------------ confidence (independent judge, per action)
    const verdicts = await pool(actions, CONCURRENCY, async (x) => {
      const st = strength.get(x.t.problem.key)!;
      const shown = [
        ...x.t.quotes.filter((q) => x.a.addresses.includes(q.ref)),
        ...x.t.quotes.filter((q) => !x.a.addresses.includes(q.ref)),
      ].slice(0, JUDGE_QUOTES);
      try {
        const v: JudgeVerdict = await agents.judge(
          `Problem: ${labelOf(x.t.problem.key)}\n\nProposed action (${x.a.type}): ${x.a.title}\n${x.a.description}\nAcceptance criteria: ${x.a.acceptanceCriteria.join(" | ")}\nThe proposer says it addresses: ${x.a.addresses.join(", ") || "(no quotes)"}\n\nEvidence quotes to check:\n${shown.map(quoteLine).join("\n") || "(no quotes; the problem rests on study scores only)"}\n\nOther evidence:\n${x.t.evidenceText}\n\nDeterministic evidence metrics (computed, do not re-score):\n- effective number of supporting mentions: ${r1(st.effectiveN)}\n- supporting source families: ${st.supportingFamilies.join(", ") || "none"}\n- share of in-scope sales with direct evidence: ${pct(st.factors.coverage)}\n- label accuracy of the classified evidence: ${pct(st.factors.labelCertainty)}\n- conflicts: ${st.conflicts.map((c) => `${c.type}: ${c.detail}`).join("; ") || "none detected"}\n- gaps: ${st.gaps.join("; ") || "none detected"}`,
          ctx.signal,
        );
        const refs = new Set(shown.map((q) => q.ref));
        const checks = [
          ...new Map(v.quoteChecks.filter((c) => refs.has(c.ref)).map((c) => [c.ref, c])).values(),
        ];
        return {
          v,
          confirmed: checks.filter((c) => c.describesProblem).length,
          checked: shown.length,
          error: null as string | null,
        };
      } catch (e) {
        return {
          v: null,
          confirmed: 0,
          checked: 0,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    });
    ctx.signal.throwIfAborted();
    ctx.progress(0.85, "Preparing proposals for human review");

    // ------------------------------------------------------------ requirements, findings, audit
    const now = new Date().toISOString();
    const marketCode = region ?? "ALL";
    const outputScope = { ...ctx.scope, market: marketCode };
    const firstSeq = ranked.length
      ? ((await ctx.car.nextSeq?.(outputScope, ranked.length)) ?? 1)
      : 1;
    const requirements: Requirement[] = [];
    const findings: Finding[] = [];
    const usedRecords = new Map<string, SourceRecord>();
    const usedSources = new Map<string, Source>();
    const ref = (c: Citation): EvidenceRef => {
      usedRecords.set(c.record.id, c.record);
      usedSources.set(c.source.id, c.source);
      return {
        sourceId: c.source.id,
        recordId: c.record.id,
        excerpt: c.mention.excerpt.slice(0, 1000),
        ...(c.record.locator ? { locator: c.record.locator } : {}),
      };
    };

    for (const rk of ranked) {
      const i = ids.indexOf(rk.id);
      const x = actions[i]!;
      const verdict = verdicts[i]!;
      const st = strength.get(x.t.problem.key)!;
      const pr = prio.get(x.t.problem.key)!;
      const component = COMPONENT_BY_ID.get(x.t.problem.component);
      const aspect = ASPECT_BY_ID.get(x.t.problem.aspect) ?? GENERAL_ASPECT;
      const id = formatRequirementId(ctx.scope.vehicleCode, marketCode, firstSeq + rk.rank - 1);
      const addressed = x.t.quotes.filter((q) => x.a.addresses.includes(q.ref));
      const evidence = (addressed.length ? addressed : x.t.quotes).slice(0, 12).map(ref);
      if (!evidence.length) {
        for (const cite of studies
          .filter((o) => o.problemKey === x.t.problem.key)
          .flatMap((o) => o.evidence ?? [])
          .slice(0, 12)) {
          if (!cite.record.text.trim()) continue;
          usedRecords.set(cite.record.id, cite.record);
          usedSources.set(cite.source.id, cite.source);
          evidence.push({
            sourceId: cite.source.id,
            recordId: cite.record.id,
            excerpt: cite.record.text.slice(0, 1000),
            ...(cite.record.locator ? { locator: cite.record.locator } : {}),
          });
        }
      }
      if (!evidence.length)
        throw new Error(
          `Cannot propose ${labelOf(x.t.problem.key)} without traceable source excerpts`,
        );
      const cells = ev.cells.filter(
        (c) => c.problemKey === x.t.problem.key && fbIds.has(c.sourceId),
      );
      const neg = cells.reduce((s, c) => s + c.negative, 0);
      const req = cells.reduce((s, c) => s + c.request, 0);
      const pos = cells.reduce((s, c) => s + c.positive, 0);
      const category = component?.area ?? aspect.area;
      const fId = `fnd_${hash(`${id}|issue`).slice(0, 16)}`;
      if (evidence.length) {
        findings.push({
          id: fId,
          kind: !x.t.quotes.length ? "usage_pattern" : req > neg ? "unmet_need" : "complaint",
          statement: `${labelOf(x.t.problem.key)}: ${neg} complaints and ${req} requests in scope; this action addresses ${addressed.length} of ${x.t.quotes.length} sampled.`,
          category,
          evidence,
          mentions: neg + req,
          markets: [
            ...new Set(cells.filter((c) => c.negative + c.request > 0).map((c) => c.market)),
          ],
          confidence: 1,
          inScope: true,
        });
      }
      const conflicting: string[] = [];
      if (x.t.counter.length) {
        const pId = `fnd_${hash(`${id}|praise`).slice(0, 16)}`;
        findings.push({
          id: pId,
          kind: "praise",
          statement: `${labelOf(x.t.problem.key)}: ${pos} positive mentions argue against changing what works.`,
          category,
          evidence: x.t.counter.map(ref),
          mentions: pos,
          markets: [...new Set(x.t.counter.map((c) => c.region))],
          confidence: 1,
          inScope: true,
        });
        conflicting.push(pId);
      }
      const conf = verdict.v
        ? confidenceScores(
            st.strength,
            { confirmed: verdict.confirmed, checked: verdict.checked },
            verdict.v.solutionSupport,
          )
        : null;
      const level: EvidenceLevel = !conf
        ? "D"
        : conf.problem >= 70
          ? "A"
          : conf.problem >= 45
            ? "B"
            : conf.problem >= 20
              ? "C"
              : "D";
      const totalScore = Math.min(100, r1(rk.score));
      const suggested = priorityForScore(totalScore, ctx.settings.scoring.thresholds);
      const contributions = pr.perSource
        .filter((s) => s.contribution > 0)
        .sort((a, b) => b.contribution - a.contribution)
        .map(
          (s) => `${sourceLabel.get(s.sourceId)} (weight ${pct(s.weight)}) ${r1(s.contribution)}`,
        );
      const notAssessed = "Not assessed by the AI Judge (weight 0).";
      const evidenceNote = conf
        ? `Confidence (independent judge, not part of the importance): problem ${r1(conf.problem)} (${band(conf.problem)}), solution ${r1(conf.solution)} (${band(conf.solution)}); judge confirmed ${verdict.confirmed}/${verdict.checked} quotes; support "${verdict.v!.solutionSupport}"; evidence strength ${r1(st.strength * 100)}/100.`
        : `Confidence not assessed: the judge failed (${verdict.error}).`;
      requirements.push({
        id,
        version: 1,
        title: x.a.title.slice(0, 120),
        description: x.a.description,
        category,
        scope: { ...ctx.scope, market: marketCode },
        targets: x.a.acceptanceCriteria.map((t, k) => ({
          metric: `Acceptance ${k + 1}`,
          target: t,
          acceptance: t,
        })),
        findingIds: evidence.length ? [fId] : conflicting.slice(0, 1),
        sourceIds: [...new Set(evidence.map((e) => e.sourceId))],
        conflictingFindingIds: conflicting,
        score: {
          factors: {
            customer_impact: {
              value: Math.round(5 * (totalScore / 100) * 100) / 100,
              weight: 1,
              note: `Importance ${r1(rk.score)}/100 = problem ${r1(pr.score)} × coverage ${r1(x.coverage * 100) / 100}; rank #${rk.rank}, stays within #${rk.rankRange[0]}–#${rk.rankRange[1]} when weights vary ±25%.`,
            },
            evidence_strength: {
              value: conf ? Math.round((conf.solution / 20) * 100) / 100 : 0,
              weight: 0,
              note: evidenceNote,
            },
            competitive_gap: { value: 0, weight: 0, note: notAssessed },
            trend_momentum: { value: 0, weight: 0, note: notAssessed },
            brand_fit: { value: 0, weight: 0, note: notAssessed },
            ease: { value: 0, weight: 0, note: notAssessed },
          },
          total: totalScore,
          suggestedPriority: suggested,
          method: "ai-judge@1: absolute importance; confidence reported separately",
          scoredAt: now,
        },
        priority: suggested,
        priorityRationale:
          `Rank ${rk.rank}${x.pinned ? " (pinned: safety topic)" : ""}. Problem "${labelOf(x.t.problem.key)}" scores ${r1(pr.score)}/100 = relevance ${pr.relevance} × severity ${pr.severity} × weighted source signal` +
          `${contributions.length ? `, driven by ${contributions.join(", ")}` : ""}. The action ${x.coverageNote}. Evidence: ${neg} negative, ${req} requests, ${pos} positive.`,
        evidenceLevel: level,
        kano: aspect.kano,
        assumptions: x.a.assumptions,
        uncertainties: [
          ...(verdict.v ? verdict.v.whyNotHigher : []),
          ...st.conflicts.map((c) => `Conflict (${c.type.replace(/_/g, " ")}): ${c.detail}`),
          ...st.gaps.map((g) => `Gap: ${g}`),
          ...(verdict.v ? verdict.v.toRaiseIt.map((t) => `To raise confidence: ${t}`) : []),
          ...x.a.risks.map((r) => `Risk: ${r}`),
        ],
        status: "proposed",
        createdBy: actorAi("ai_judge"),
        createdAt: now,
        updatedAt: now,
        ...(ctx.runId.startsWith("run_") ? { runId: ctx.runId } : {}),
      });
    }

    const stored = PipelineData.parse({
      sources: [...usedSources.values()],
      records: [...usedRecords.values()],
      findings: findings.map((f) => Finding.parse(f)),
      requirements: requirements.map((r) => Requirement.parse(r)),
      themes: [],
    });
    for (const f of findings) {
      await ctx.audit.record({
        actor: actorDet,
        action: "finding.extracted",
        entityType: "finding",
        entityId: f.id,
        changes: [{ path: "$", before: null, after: f }],
        rationale: f.statement,
        ...run,
      });
    }
    for (const r of requirements) {
      await ctx.audit.record({
        actor: actorAi("ai_judge.solution"),
        action: "requirement.proposed",
        entityType: "requirement",
        entityId: r.id,
        changes: [{ path: "$", before: null, after: r }],
        rationale: `Proposed for "${p.query}". Only the PM can approve, reject or defer.`,
        ...run,
      });
      await ctx.audit.record({
        actor: actorDet,
        action: "requirement.scored",
        entityType: "requirement",
        entityId: r.id,
        changes: [{ path: "score.total", before: null, after: r.score!.total }],
        rationale: r.score!.factors.customer_impact!.note,
        ...run,
      });
      await ctx.audit.record({
        actor: actorAi("ai_judge.confidence"),
        action: "requirement.evidence_linked",
        entityType: "requirement",
        entityId: r.id,
        changes: [],
        rationale: r.score!.factors.evidence_strength!.note,
        ...run,
      });
    }
    ctx.signal.throwIfAborted();

    for (const n of notes) ctx.log(n);
    if (webRejected.length)
      ctx.log(`${webRejected.length} web quote(s) could not be verified and were not used.`);
    ctx.log(
      `Ranked ${requirements.length} actions for ${chosen.length} problems (of ${problems.length} in scope). Sources: ${sources
        .map((s) => `${s.label} ${pct(s.weight)}`)
        .join(", ")}.`,
    );
    ctx.progress(1);
    return { status: "ok", outputs: { out: stored } };
  },
});

export const aiJudgeImplementations = [aiJudgeBlock];
export { REQUEST_WEIGHT };
