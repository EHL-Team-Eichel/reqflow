import {
  CATEGORY_LABELS,
  type DecisionAnswer,
  type DecisionClient,
  type FindingKind,
  type LlmClient,
  type RequirementCategory,
} from "@reqflow/core";
import {
  CONTRACT,
  type AnalystAnswer,
  type ContextAnswer,
  type DraftAnswer,
  type MergeAnswer,
  type ReviewAnswer,
  type SynthesizerAnswer,
} from "./schemas";

/**
 * The agents without AI, for the "Mock (offline)" provider: tests, smoke runs and demos without
 * an API key. Same contracts as the real agents, answered by plain rules and clearly marked
 * "[Offline]", so nobody mistakes it for an AI's judgement.
 */

export const OFFLINE_MODEL = "offline";

const CATEGORY_WORDS: [RequirementCategory, RegExp][] = [
  ["range_charging", /range|reichweite|charg|lade|batter|akku|consumption|verbrauch/i],
  [
    "infotainment_digital",
    /navi|display|screen|bildschirm|\bapp\b|carplay|android|connect|radio|sound|audio|speaker|bluetooth|software|update|voice|sprach/i,
  ],
  ["driver_assistance", /assist|camera|kamera|park|lane|spur|cruise|tempomat|sensor/i],
  [
    "space_practicality",
    /space|room|platz|trunk|boot|kofferraum|legroom|knee|beinfreiheit|storage|ablage|rear seat|rücksitz|fond/i,
  ],
  [
    "comfort",
    /seat|sitz|comfort|komfort|noise|laut|geräusch|climate|klima|heat|heiz|suspension|federung/i,
  ],
  [
    "driving_experience",
    /drive|fahr|steering|lenkung|engine|motor|accelerat|beschleunig|handling|brake|bremse/i,
  ],
  [
    "interior_quality",
    /interior|innen|material|plastic|plastik|quality|qualität|verarbeitung|leather|leder|trim/i,
  ],
  [
    "exterior_design",
    /design|look|colou?r|farbe|paint|lack|wheel|felge|light|licht|exterior|außen/i,
  ],
  ["usability_controls", /button|knopf|taste|control|bedien|menu|menü|touch|ergonom/i],
  ["variants_packages", /package|paket|option|ausstattung|variant/i],
];
const PRAISE = /\b(great|love|excellent|perfect|super|toll|prima|klasse|zufrieden|begeistert)\b/i;
const NEED = /\b(wish|would like|missing|lack|need|want|fehlt|wünsche|hätte gern|vermisse)\b/i;
const OUT_OF_SCOPE =
  /\b(price|preis|expensive|teuer|cost|kosten|dealer|händler|werkstatt|warranty|garantie)\b/i;

/** The first sentence of a text, which is verbatim by construction. */
function firstSentence(text: string): string {
  const t = text.trim();
  const end = t.search(/[.!?](\s|$)/);
  const s = end > 10 ? t.slice(0, end + 1) : t;
  return s.length > 240
    ? s.slice(0, s.lastIndexOf(" ", 240) > 60 ? s.lastIndexOf(" ", 240) : 240)
    : s;
}

function categoryOf(text: string): RequirementCategory {
  return CATEGORY_WORDS.find(([, re]) => re.test(text))?.[0] ?? "usability_controls";
}

type Payload = Record<string, unknown> & { contract?: string };
type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");

function analyst(p: Payload): AnalystAnswer {
  const signals: AnalystAnswer["signals"] = [];
  const ignored: string[] = [];
  for (const r of rows(p.records)) {
    const ref = str(r.ref);
    const text = str(r.text);
    if (text.trim().length < 10) {
      ignored.push(ref);
      continue;
    }
    const kind: FindingKind = PRAISE.test(text)
      ? "praise"
      : NEED.test(text)
        ? "unmet_need"
        : "complaint";
    const quote = firstSentence(text);
    const inScope = !OUT_OF_SCOPE.test(text);
    signals.push({
      kind,
      statement: `[Offline] ${quote}`,
      category: categoryOf(text),
      inScope,
      outOfScopeReason: inScope ? "" : "[Offline] Price or dealer topic (keyword rule).",
      refs: [ref],
      quotes: [{ ref, quote }],
      sentiment: kind === "praise" ? 0.6 : kind === "unmet_need" ? -0.2 : -0.6,
    });
  }
  return { signals, ignored };
}

function synthesizer(p: Payload): SynthesizerAnswer {
  const byCategory = new Map<RequirementCategory, string[]>();
  for (const s of rows(p.signals)) {
    const category = s.category as RequirementCategory;
    const list = byCategory.get(category) ?? [];
    list.push(str(s.ref));
    byCategory.set(category, list);
  }
  return {
    themes: [...byCategory].map(([category, refs]) => ({
      label: CATEGORY_LABELS[category] ?? category,
      need: `[Offline] Customers raised ${refs.length} point(s) in this area.`,
      category,
      signals: refs,
      conflicting: [],
    })),
  };
}

function architect(p: Payload): DraftAnswer {
  const theme = (p.theme ?? {}) as Row;
  const label = str(theme.label) || "Customer feedback";
  const signals = rows(p.signals);
  const top = str(signals[0]?.statement).replace(/^\[Offline\]\s*/, "");
  return {
    title: `[Offline] ${label}: act on customer feedback`,
    description: `Offline demo, written without AI from ${signals.length} customer signal(s) about ${label.toLowerCase()}. Strongest: "${top}". Add an API setup in Settings → AI to have real agents write this requirement.`,
    category: (theme.category as RequirementCategory) ?? "usability_controls",
    kano: "performance",
    targets: [
      {
        metric: `Customer rating of ${label.toLowerCase()}`,
        target: "Better than the current model",
        acceptance: "Customer clinic with owners of the current model",
      },
    ],
    assumptions: ["[Offline] No AI weighed this evidence."],
    uncertainties: ["[Offline] Not reviewed by an AI model."],
    why: `[Offline] Built from ${signals.map((s) => `[${str(s.ref)}]`).join(" ")} by rules: counts only, no reasoning.`,
    usedSignals: signals.map((s) => str(s.ref)),
    contextUsed: rows(p.context).map((c) => str(c.ref)),
  };
}

function critic(_p: Payload): ReviewAnswer {
  const note = "Assumption: offline demo, set by a rule; not measured.";
  return {
    verdict: "accept",
    issues: [],
    fixes: [],
    rejectReason: "",
    factors: {
      brand_fit: { value: 2.5, note },
      ease: { value: 2.5, note },
    },
  };
}

function context(p: Payload): ContextAnswer {
  const facts = Array.isArray(p.facts) ? (p.facts as unknown[]).map(str).filter(Boolean) : [];
  const samples = rows(p.samples);
  return {
    whatItIs: `[Offline] ${str(p.mode) === "sales_volumes" ? "Sales volumes" : "Context data"} from ${str(p.label)}.`,
    facts: (facts.length ? facts : samples.map((s) => str(s.text)))
      .slice(0, 8)
      .map((text, i) => ({ text, refs: facts.length ? [] : [str(samples[i]?.ref)] })),
    implications: ["[Offline] No AI read this context."],
    caveats: [],
  };
}

function merge(): MergeAnswer {
  return { merges: [] };
}

/** Answers every agent contract by rules. Same validation path as a real model's answer. */
export const offlineLlm: LlmClient = {
  async generateObject(request) {
    request.signal?.throwIfAborted();
    let payload: Payload;
    try {
      payload = JSON.parse(request.prompt) as Payload;
    } catch {
      throw new Error("The offline agents only understand Add to Car payloads.");
    }
    const answer =
      payload.contract === CONTRACT.analyst
        ? analyst(payload)
        : payload.contract === CONTRACT.synthesizer
          ? synthesizer(payload)
          : payload.contract === CONTRACT.merge
            ? merge()
            : payload.contract === CONTRACT.architect || payload.contract === CONTRACT.revise
              ? architect(payload)
              : payload.contract === CONTRACT.critic
                ? critic(payload)
                : payload.contract === CONTRACT.context
                  ? context(payload)
                  : null;
    if (!answer) throw new Error(`The offline agents don't know contract "${payload.contract}".`);
    return {
      object: request.schema.parse(answer),
      model: OFFLINE_MODEL,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  },
  async generateText() {
    throw new Error("The offline agents don't write free text.");
  },
};

/** The judge without AI: neutral, clearly middling answers. */
export const offlineDecisions: DecisionClient = {
  async decide({ questions, signal }) {
    signal?.throwIfAborted();
    const answers: Record<string, DecisionAnswer> = {};
    for (const [name, q] of Object.entries(questions)) {
      if (q.type === "noul") answers[name] = { type: "noul", value: name === "scope" ? 0.9 : 0.6 };
      else if (q.type === "score") {
        const mid = Math.floor((q.criteria.length - 1) / 2);
        answers[name] = {
          type: "score",
          score: mid,
          probabilities: q.criteria.map((_, i) => (i === mid ? 1 : 0)),
          confidence: 1,
        };
      } else {
        const options = Object.keys(q.criteria);
        answers[name] = {
          type: "choice",
          choice: options[0]!,
          probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 1 : 0])),
          confidence: 1,
        };
      }
    }
    return { answers, model: OFFLINE_MODEL, usage: { inputTokens: 0, outputTokens: 0 } };
  },
};
