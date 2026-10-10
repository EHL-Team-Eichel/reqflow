import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import readXlsxFile from "read-excel-file/node";
import {
  defaultBlockParams,
  emptyPipelineData,
  mergePipelineData,
  type PipelineData,
  type ReasoningTrace,
  type Requirement,
  type Settings,
  type StoredFile,
} from "@reqflow/core";
import { createBlockRegistry } from "@reqflow/blocks";
import type { BlockContext, CarEvidence } from "@reqflow/engine";
import { createLlmClient } from "@reqflow/llm";
import { createAgentServices, testSetup, type AgentDeps } from "./agents";
import { SecretsStore } from "./secrets";
import { loadSettings } from "./settings-storage";

/**
 * `npm run eval:f70`: the Add to Car agents on BMW's F70 files, with the user's own Settings and
 * keys, to tune them. BMW data is confidential and session logs are public, so the console gets
 * numbers only. The requirements and the thought process go to `<outDir>/<timestamp>/`, which
 * lives in data/raw/ (gitignored), for the user to read privately.
 */

const FEEDBACK = "F70_feedback_hackathon.xlsx";
const SALES = "sales_volumes.xlsx";
const STUDY = "F70_G60_G68_G70_customer_studies.xlsx";

export function parseEvalArg(argv: string[]): string | null {
  const arg = argv.find((a) => a.startsWith("--eval-f70="));
  return arg ? resolve(arg.slice("--eval-f70=".length)) : null;
}

const print = (line: string) => console.log(`[eval] ${line}`);
const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)} %` : "–");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
function tally<T extends string>(xs: T[]): string {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k} ${n}`).join(" · ") || "none";
}

export async function runEvalF70(
  outDir: string,
  o: { rawDir: string; dataDir: string; maxRequirements: number },
): Promise<number> {
  const missing = [FEEDBACK, SALES].filter((f) => !existsSync(join(o.rawDir, f)));
  if (missing.length) {
    print(`missing in data/raw: ${missing.join(", ")}`);
    return 1;
  }
  const stored = new Map<string, StoredFile>();
  const files = {
    get: async (id: string) => {
      const f = stored.get(id);
      if (!f) throw new Error(`No file ${id}`);
      return f;
    },
  };
  const registry = createBlockRegistry();
  const raw = registry.get("raw");
  const quietCtx = (blockId: string): BlockContext =>
    ({
      runId: "run_evalf70",
      blockId,
      scope: settings.defaultScope,
      settings,
      files,
      log: () => {},
      progress: () => {},
      audit: { record: async () => ({}) as never },
      signal: new AbortController().signal,
      resumed: false,
    }) as unknown as BlockContext;
  /** Every sheet of a workbook through the Raw block, merged into one stream. */
  async function read(
    name: string,
    dataset: string,
  ): Promise<{ data: PipelineData; sheets: number }> {
    const bytes = new Uint8Array(readFileSync(join(o.rawDir, name)));
    const id = `file_${stored.size + 1}`;
    stored.set(id, { id, name, mimeType: "", bytes });
    const sheets = await readXlsxFile(Buffer.from(bytes));
    let data = emptyPipelineData();
    for (const s of sheets) {
      const params = {
        ...defaultBlockParams("raw"),
        dataset,
        file: { fileId: id, name },
        sheet: s.sheet,
      };
      const res = await raw.run({}, params, quietCtx(`raw-${dataset}`));
      if (res.status === "ok" && res.outputs.out) data = mergePipelineData(data, res.outputs.out);
    }
    return { data, sheets: sheets.length };
  }

  const settings: Settings = loadSettings(o.dataDir);
  const feedback = await read(FEEDBACK, "customer_feedback");
  const sales = await read(SALES, "sales_volume");
  const study = existsSync(join(o.rawDir, STUDY)) ? await read(STUDY, "customer_study") : null;
  print(
    `inputs: 1. Priority = feedback (${feedback.data.records.length} records) · Context 1 = sales volumes (${sales.data.records.length} records, ${sales.sheets} sheets)` +
      (study ? ` · Context 2 = study, Auto (${study.data.records.length} records)` : ""),
  );

  const secrets = new SecretsStore(o.dataDir);
  const deps: AgentDeps = {
    defaultLlm: async (s) => {
      const apiKey =
        s.llm.provider === "anthropic"
          ? ((await secrets.getSecret("anthropic_api_key")) ?? undefined)
          : undefined;
      if (s.llm.provider === "anthropic" && !apiKey) {
        throw new Error("The default AI (Anthropic) has no API key. Add it in Settings → AI.");
      }
      return createLlmClient(s.llm, { apiKey });
    },
    getKey: (id) => secrets.getSecret(`setup:${id}`),
  };
  // Check every setup the agents use before reading anything: a bad key fails in seconds.
  for (const id of new Set(Object.values(settings.agents.roles))) {
    const result = await testSetup(settings, id, deps);
    print(
      `setup ${id}: ${result.ok ? `ok · ${result.model} · ${result.ms} ms` : `FAILED · ${result.message}`}`,
    );
    if (!result.ok) return 1;
  }
  const agents = createAgentServices(settings, deps);
  for (const role of ["context", "analyst", "synthesizer", "architect", "critic"] as const) {
    const { info } = await agents.writer(role);
    print(
      `${role}: ${info.setupName} · ${info.provider} · ${info.model}${role === "analyst" ? ` (fast: ${info.fastModel})` : ""}`,
    );
  }
  const judge = await agents.judge();
  print(`judge: ${judge.info.setupName} · ${judge.info.provider} · ${judge.info.model}`);

  const added: { requirements: Requirement[]; evidence?: CarEvidence }[] = [];
  const traces: ReasoningTrace[] = [];
  const logs: string[] = [];
  let shown = -1;
  const ctx: BlockContext = {
    ...quietCtx("car"),
    agents,
    llm: {
      generateObject: async () => Promise.reject(new Error("unused")),
      generateText: async () => Promise.reject(new Error("unused")),
    },
    web: null,
    car: {
      add: async (requirements, evidence) => void added.push({ requirements, evidence }),
      nextSeq: async () => 1,
      saveReasoning: async (t) => void traces.push(t),
    },
    log: (m) => void logs.push(m), // kept in the private output, never printed: it can name themes
    progress: (fraction, message) => {
      const step = Math.floor(fraction * 10);
      if (step > shown) {
        shown = step;
        print(
          `${Math.round(fraction * 100)} %${message && !/[“"]/.test(message) ? ` ${message}` : ""}`,
        );
      }
    },
  };
  const inputs: Record<string, PipelineData> = { "in-0": feedback.data, "ctx-0": sales.data };
  if (study) inputs["ctx-1"] = study.data;
  const params = {
    ...defaultBlockParams("add_to_car"),
    priorities: 1,
    contexts: study ? ["sales_volumes", "auto"] : ["sales_volumes"],
    maxRequirements: o.maxRequirements,
  };
  const started = Date.now();
  try {
    await registry.get("add_to_car").run(inputs, params, ctx);
  } catch (err) {
    // Our own error messages carry counts and setup names, never data.
    print(
      `FAILED after ${Math.round((Date.now() - started) / 1000)} s: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const requirements = added.flatMap((a) => a.requirements);
  const evidence = added[0]?.evidence ?? {};
  const trace = traces[0];
  const runDir = join(outDir, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "requirements.json"), JSON.stringify(requirements, null, 2));
  writeFileSync(join(runDir, "trace.json"), JSON.stringify(trace ?? null, null, 2));
  writeFileSync(join(runDir, "evidence.json"), JSON.stringify(evidence, null, 2));
  writeFileSync(join(runDir, "logs.txt"), logs.join("\n"));

  // ── numbers only ─────────────────────────────────────────────────────────────────────────
  for (const s of trace?.steps ?? []) {
    print(
      `step ${s.role}: ${s.stats.map((x) => `${x.label} ${x.value}`).join(" · ")} · ${s.calls} calls · ${round(s.durationMs / 1000, 1)} s · ${s.status}`,
    );
  }
  print(
    `requirements: ${requirements.length} · priority ${tally(requirements.map((r) => r.priority ?? "none"))} · evidence ${tally(requirements.map((r) => r.evidenceLevel))}`,
  );
  print(
    `critic: ${tally((trace?.requirements ?? []).map((r) => r.verdict))} · mean score ${round(mean(requirements.map((r) => r.score?.total ?? 0)), 1)}/100 · score/rank disagree ${requirements.filter((r) => r.score && r.score.suggestedPriority !== r.priority).length}`,
  );
  const conf = requirements.map((r) => r.confidence?.value ?? 0);
  print(
    `confidence: mean ${round(mean(conf))} · min ${round(Math.min(...conf, 1))} · max ${round(Math.max(...conf, 0))} · ${tally(requirements.map((r) => r.confidence?.level ?? "none"))}`,
  );
  for (const key of [
    "support",
    "scope",
    "durability",
    "clarity",
    "breadth",
    "agreement",
    "conflicts",
  ]) {
    const v = requirements
      .map((r) => r.confidence?.signals.find((s) => s.key === key)?.value)
      .filter((x): x is number => x !== undefined);
    if (v.length) print(`  signal ${key}: mean ${round(mean(v))} · min ${round(Math.min(...v))}`);
  }
  const records = new Map((evidence.records ?? []).map((r) => [r.id, r.text]));
  const excerpts = (evidence.findings ?? []).flatMap((f) => f.evidence);
  const verbatim = excerpts.filter(
    (e) => e.recordId && records.get(e.recordId)?.includes(e.excerpt),
  ).length;
  print(
    `evidence: ${evidence.findings?.length ?? 0} findings · excerpts verbatim ${pct(verbatim, excerpts.length)} (${excerpts.length}) · findings per requirement ${round(mean(requirements.map((r) => r.findingIds.length)), 1)} · with conflicting evidence ${pct(requirements.filter((r) => r.conflictingFindingIds.length).length, requirements.length)}`,
  );
  print(
    `content: with targets ${pct(requirements.filter((r) => r.targets.length).length, requirements.length)} · mean targets ${round(mean(requirements.map((r) => r.targets.length)), 1)} · with assumptions ${pct(requirements.filter((r) => r.assumptions.length).length, requirements.length)} · categories ${new Set(requirements.map((r) => r.category)).size}`,
  );
  const kinds = (trace?.heldBack ?? []).map((h) =>
    h.theme === "Out of scope"
      ? "out of scope"
      : h.theme === "Signals without a theme"
        ? "unthemed"
        : /^Only one comment/.test(h.reason)
          ? "single comment"
          : /^Below the cut/.test(h.reason)
            ? "below the cut"
            : /critic rejected/.test(h.reason)
              ? "rejected"
              : /^Same requirement/.test(h.reason)
                ? "duplicate"
                : "failed",
  );
  print(`held back: ${tally(kinds)}`);
  const t = trace?.totals;
  if (t)
    print(
      `totals: ${t.calls} calls · ${t.inputTokens} input tokens · ${t.outputTokens} output tokens · ${round(t.durationMs / 1000, 1)} s${trace.offline ? " · OFFLINE (no AI)" : ""}`,
    );
  print(`details (private, gitignored): ${runDir}`);
  return 0;
}
