import {
  CATEGORY_LABELS,
  FILTER_CUSTOMER_CRITERION,
  FILTER_PRESETS,
  ScoreFactor,
  Source,
  SourceRecord,
} from "@reqflow/core";
import { z } from "zod";

const Item = z.object({
  id: z.string().min(1),
  layer: z.enum(["requirements", "themes", "findings", "records"]),
  item: z.record(z.string(), z.unknown()),
  context: z
    .object({ findings: z.array(z.record(z.string(), z.unknown())).default([]) })
    .passthrough(),
});
const Payload = z
  .object({
    contract: z.enum(["reqflow.ai-splitter.routing@1", "reqflow.ai-splitter.scoring@1"]),
    mode: z.enum(["category", "sentiment", "custom", "priority"]),
    branches: z.array(z.string().min(1)).min(2).max(10),
    instruction: z.string(),
    items: z.array(Item).min(1).max(20),
  })
  .passthrough();

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function stableIndex(id: string, size: number): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % size;
}

const RawId = z.string().min(1).max(120);
const RawNeed = z.strictObject({
  id: RawId,
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(600),
});
const CanonicalNeed = RawNeed.extend({ aliasIds: z.array(RawId).min(1).max(10000) });
const RawItem = z.strictObject({ id: RawId, record: SourceRecord, source: Source });
const Group = z.strictObject({
  id: RawId,
  label: z.string().trim().min(1).max(120),
  description: z.string().max(600),
  needIds: z.array(RawId).max(400),
  reason: z.string().trim().min(1).max(1000),
});
const RawBase = {
  mode: z.enum(["customer_priority", "car_parts", "custom"]),
  instruction: z.string().max(5000),
};
const BranchCount = z.number().int().min(2).max(10);
const RawPayload = z.discriminatedUnion("contract", [
  z.strictObject({
    contract: z.literal("reqflow.ai-splitter.discover@1"),
    ...RawBase,
    branchCount: BranchCount,
    needIdPrefix: z.string().min(1).max(100),
    items: z.array(RawItem).min(1).max(20),
  }),
  z.strictObject({
    contract: z.literal("reqflow.ai-splitter.consolidate@1"),
    ...RawBase,
    needs: z.array(RawNeed).max(10000),
  }),
  z.strictObject({
    contract: z.literal("reqflow.ai-splitter.plan@1"),
    ...RawBase,
    branchCount: BranchCount,
    needs: z.array(CanonicalNeed).max(400),
  }),
  z.strictObject({
    contract: z.literal("reqflow.ai-splitter.assign@1"),
    ...RawBase,
    needs: z.array(CanonicalNeed).max(400),
    groups: z.array(Group).max(400),
    items: z
      .array(
        RawItem.extend({
          kind: z.enum(["feedback", "context"]),
          needIds: z.array(RawId).max(12),
        }),
      )
      .min(1)
      .max(20),
  }),
]);
type RawEntry = z.infer<typeof RawItem>;
type Need = z.infer<typeof RawNeed>;
type Canonical = z.infer<typeof CanonicalNeed>;
type Topic = { key: string; label: string; words: RegExp };

// Deliberately small vocabulary. These are offline rules, not learned topics or AI judgements.
const TOPICS: Topic[] = [
  {
    key: "seating",
    label: "Seating comfort",
    words: /\b(seats?|seating|chairs?|sitzkomfort|sitze?)\b/i,
  },
  {
    key: "infotainment",
    label: "Infotainment usability",
    words:
      /\b(infotainment|screens?|displays?|touchscreens?|carplay|android auto|navigation|software|menus?|bluetooth)\b/i,
  },
  {
    key: "controls",
    label: "Usable controls",
    words: /\b(buttons?|controls?|knobs?|switches|bedienung)\b/i,
  },
  {
    key: "storage",
    label: "Practical storage",
    words: /\b(boot|trunk|cargo|luggage|storage|cupholders?|kofferraum)\b/i,
  },
  {
    key: "space",
    label: "Passenger space",
    words:
      /\b(legroom|headroom|rear space|passenger space|cabin space|knee room|roomy|beinfreiheit)\b/i,
  },
  {
    key: "climate",
    label: "Climate comfort",
    words: /\b(climate|heating|heated|ventilation|air conditioning|air con|klima)\b/i,
  },
  { key: "noise", label: "Cabin noise", words: /\b(noise|noisy|quiet|rattles?|laut)\b/i },
  {
    key: "driving",
    label: "Driving experience",
    words: /\b(ride|steering|handling|suspension|driving|lenkung)\b/i,
  },
  {
    key: "charging",
    label: "Convenient charging",
    words: /\b(charge|charges|charging|chargers?|plug|laden)\b/i,
  },
  { key: "range", label: "Usable range", words: /\b(range|reichweite)\b/i },
  {
    key: "quality",
    label: "Perceived quality",
    words: /\b(quality|cheap|plastics?|materials?|finish|verarbeitung)\b/i,
  },
  {
    key: "design",
    label: "Exterior design",
    words: /\b(design|styling|appearance|grille|headlights?|paint|colou?r)\b/i,
  },
];
const FEEDBACK = new Set(["customer_feedback", "customer_study", "review"]);
const COMMENT_FIELDS = new Set([
  "customerfeedback",
  "feedback",
  "comment",
  "comments",
  "commenttext",
  "customercomment",
  "review",
  "reviewtext",
  "opinion",
  "verbatim",
  "response",
]);
const SUPPORT =
  /\b(hurt|hurts|pain|uncomfortable|complain|complaint|poor|bad|frustrating|frustrated|difficult|fail|fails|failed|failure|broken|cannot|can't|unable|unusable|unsafe|dangerous|need|needs|want|wish|please|improve|improvement|lack|lacks|missing|unavailable|better|not enough|too small|noisy|hate|dislike|annoy|annoys|annoying|inconvenience|not working)\b/i;
const OPPOSE =
  /\b(love|great|excellent|comfortable|satisfied|perfect|fine as is|works well|unnecessary|no need|do not want|don't want)\b/i;
const NEGATED_DESIRE = /\b(no need|do not want|don't want|do not need|don't need|unnecessary)\b/i;
// Numeric/rating rows are context even when a heading contains an opinion-like word.
const AGGREGATE_ROW =
  /\b(score|rating|satisfaction|volume|sales|take rate|mentions?|count|responses?|percent)\s*:\s*([-+]?\d|poor\b|bad\b|good\b|excellent\b)/i;

function unique(ids: string[], name: string): void {
  if (new Set(ids).size !== ids.length)
    throw new Error(`Mock analytical contract has duplicate ${name}.`);
}
function checkItems(items: RawEntry[]): void {
  unique(
    items.map((i) => i.id),
    "item IDs",
  );
  for (const item of items) {
    if (item.id !== item.record.id || item.record.sourceId !== item.source.id)
      throw new Error("Mock analytical item/source/record IDs must match.");
    if (item.record.locator && item.record.locator.length > 1000)
      throw new Error("Mock analytical evidence locator exceeds 1,000 characters.");
  }
}
function checkCatalog(needs: Canonical[]): void {
  unique(
    needs.map((n) => n.id),
    "canonical need IDs",
  );
  unique(
    needs.flatMap((n) => n.aliasIds),
    "need aliases",
  );
}
function topicFor(need: Need): Topic | undefined {
  const labelled = TOPICS.filter((topic) => topic.words.test(need.label));
  if (labelled.length === 1) return labelled[0];
  if (labelled.length) return undefined; // Do not collapse a compound need into one keyword topic.
  const described = TOPICS.filter((topic) => topic.words.test(need.description));
  return described.length === 1 ? described[0] : undefined;
}
function description(label: string): string {
  return `[MOCK] Keyword topic: ${label}; not semantic AI assessment.`;
}
function content(item: RawEntry): string {
  for (const [name, value] of Object.entries(item.record.fields ?? {})) {
    if (
      COMMENT_FIELDS.has(name.toLowerCase().replace(/[^a-z]/g, "")) &&
      typeof value === "string" &&
      value.trim() &&
      item.record.text.includes(value.trim())
    )
      return value.trim();
  }
  return item.record.text;
}
/** Select an exact, bounded excerpt around the relevant keyword, never synthesize a quotation. */
function excerpt(text: string, words?: RegExp): string {
  const phrases = text.match(/[^.!?;\r\n]+[.!?;]?/g) ?? [];
  const phrase = (words ? phrases.find((p) => words.test(p)) : undefined) ?? text;
  const match = words?.exec(phrase);
  return phrase
    .slice(Math.max(0, (match?.index ?? 0) - 300), Math.max(0, (match?.index ?? 0) - 300) + 1000)
    .trim();
}
function evidence(item: RawEntry, quote: string) {
  if (!quote || !item.record.text.includes(quote))
    throw new Error("Mock analytical signal requires verbatim evidence.");
  return {
    sourceId: item.source.id,
    recordId: item.record.id,
    excerpt: quote,
    ...(item.record.locator !== undefined ? { locator: item.record.locator } : {}),
  };
}
function impact(quote: string): 0 | 25 | 50 | 75 | 100 | null {
  if (
    /\b(cannot|can't|unable to|unusable|unsafe|dangerous|safety concern|critical use failure)\b/i.test(
      quote,
    )
  )
    return 100;
  if (/\b(fail|fails|failed|failure|broken|workaround|restart|reboot|not working)\b/i.test(quote))
    return 75;
  if (
    /\b(every (trip|day|time|journey)|daily|recurring|repeatedly|frequently|constantly|regularly|always)\b/i.test(
      quote,
    )
  )
    return 50;
  if (/\b(minor|slight|slightly|small inconvenience|a little)\b/i.test(quote)) return 25;
  if (/\b(neutral impact|no impact|does not affect|doesn't affect|not affected)\b/i.test(quote))
    return 0;
  return null;
}

const CAR_GROUPS = [
  { label: "Seats & passenger space", keys: ["seating", "space"] },
  { label: "Infotainment & controls", keys: ["infotainment", "controls"] },
  { label: "Interior & storage", keys: ["storage", "climate", "quality"] },
  { label: "Driving experience", keys: ["noise", "driving"] },
  { label: "Range & charging", keys: ["range", "charging"] },
  { label: "Exterior design", keys: ["design"] },
];

/** Versioned analytical peer only. No generic schema synthesis, model calls, or mutable session state. */
function rawObject(raw: unknown, promptLength: number): unknown {
  if (promptLength > 96000)
    throw new Error("Mock analytical prompt exceeds 96,000 characters; no input was truncated.");
  const checked = RawPayload.safeParse(raw);
  if (!checked.success)
    throw new Error("Unsupported or invalid mock analytical AI Splitter contract.");
  const p = checked.data;
  if (p.mode === "custom" && !p.instruction.trim())
    throw new Error("Mock custom analytical contract requires an instruction.");
  switch (p.contract) {
    case "reqflow.ai-splitter.discover@1": {
      checkItems(p.items);
      const needs = new Map<string, Need>();
      const items = p.items.map((item) => {
        const text = content(item);
        const opinion =
          !AGGREGATE_ROW.test(text) &&
          (SUPPORT.test(text) || OPPOSE.test(text) || NEGATED_DESIRE.test(text));
        const feedback = FEEDBACK.has(item.source.kind) && opinion;
        const topics = TOPICS.filter((topic) => topic.words.test(text));
        const candidates = topics.length
          ? topics
          : feedback
            ? [{ key: "unclassified", label: "Unclassified customer need" }]
            : [];
        const needIds = candidates.map((topic) => {
          if (!needs.has(topic.key))
            needs.set(topic.key, {
              id: `${p.needIdPrefix}${needs.size}`,
              label: topic.label,
              description: description(topic.label),
            });
          return needs.get(topic.key)!.id;
        });
        const quote = excerpt(
          text,
          feedback
            ? new RegExp(`${SUPPORT.source}|${OPPOSE.source}|${NEGATED_DESIRE.source}`, "i")
            : undefined,
        );
        return {
          id: item.id,
          kind: feedback ? "feedback" : "context",
          reason: feedback
            ? "[MOCK] Eligible source plus explicit opinion keywords; heuristic feedback classification, not AI inference."
            : "[MOCK] Non-feedback source, aggregate table, or no explicit opinion keywords; context is not a customer vote.",
          evidence: quote ? evidence(item, quote) : null,
          needIds,
        };
      });
      return { contract: p.contract, needs: [...needs.values()], items };
    }
    case "reqflow.ai-splitter.consolidate@1": {
      unique(
        p.needs.map((n) => n.id),
        "discovery need IDs",
      );
      const aliases = new Map<string, { label: string; aliasIds: string[] }>();
      for (const need of p.needs) {
        const topic = topicFor(need);
        const key = topic ? `topic:${topic.key}` : `literal:${normalized(need.label)}`;
        if (!aliases.has(key))
          aliases.set(key, { label: topic?.label ?? need.label, aliasIds: [] });
        aliases.get(key)!.aliasIds.push(need.id);
      }
      if (aliases.size > 400)
        throw new Error("Mock analytical catalog exceeds 400 canonical needs.");
      return {
        contract: p.contract,
        needs: [...aliases.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([, need], index) => ({
            id: `need_mock_${index}`,
            label: need.label,
            description: description(need.label),
            aliasIds: need.aliasIds,
          })),
      };
    }
    case "reqflow.ai-splitter.plan@1": {
      checkCatalog(p.needs);
      if (p.mode === "customer_priority")
        throw new Error("Mock customer-priority mode uses canonical needs, not a group-plan call.");
      const requested = p.instruction
        .match(/^(?:labels|groups)\s*:\s*(.+)$/is)?.[1]
        ?.split(/[;,\n]/)
        .map((s) => s.trim());
      const literalLabels =
        p.mode === "custom" &&
        requested?.length === p.branchCount &&
        requested.every((s) => s.length > 0 && s.length <= 120) &&
        new Set(requested.map((s) => s.toLowerCase())).size === requested.length
          ? requested
          : undefined;
      const groups = Array.from({ length: p.branchCount }, (_, index) => ({
        id: `group_mock_${index}`,
        label:
          p.mode === "custom"
            ? (literalLabels?.[index] ?? `Mock custom group ${index + 1}`)
            : index === p.branchCount - 1 && p.branchCount < CAR_GROUPS.length
              ? "Other vehicle needs"
              : (CAR_GROUPS[index]?.label ?? `Unused output ${index + 1}`),
        description: "[MOCK] Fixed global keyword groups; empty outputs are allowed.",
        needIds: [] as string[],
        reason:
          p.mode === "custom"
            ? "[MOCK] Literal label keywords then stable label-hash fallback; arbitrary instructions are not interpreted by AI."
            : "[MOCK] Deterministic car-part keywords; overflow/unmatched needs use the last output, not semantic AI grouping.",
      }));
      for (const need of p.needs) {
        const topic = topicFor(need);
        let index: number;
        if (p.mode === "car_parts") {
          const bucket = CAR_GROUPS.findIndex((g) => topic && g.keys.includes(topic.key));
          index = bucket < 0 ? p.branchCount - 1 : Math.min(bucket, p.branchCount - 1);
        } else {
          const match = literalLabels?.findIndex(
            (label) =>
              (topic && topic.words.test(label)) ||
              normalized(`${need.label} ${need.description}`).includes(normalized(label)),
          );
          index =
            match !== undefined && match >= 0
              ? match
              : stableIndex(normalized(need.label), p.branchCount);
        }
        groups[index]!.needIds.push(need.id);
      }
      return { contract: p.contract, groups };
    }
    case "reqflow.ai-splitter.assign@1": {
      checkItems(p.items);
      checkCatalog(p.needs);
      unique(
        p.groups.map((g) => g.id),
        "group IDs",
      );
      unique(
        p.groups.map((g) => g.label.toLowerCase()),
        "group labels",
      );
      const ids = new Set(p.needs.map((n) => n.id));
      const planned = p.groups.flatMap((g) => g.needIds);
      unique(planned, "planned need IDs");
      if (planned.length !== ids.size || planned.some((id) => !ids.has(id)))
        throw new Error("Mock analytical group plan requires complete canonical need coverage.");
      const needs = new Map(p.needs.map((n) => [n.id, n]));
      return {
        contract: p.contract,
        items: p.items.map((item) => {
          unique(item.needIds, "assigned need IDs");
          if (item.needIds.some((id) => !ids.has(id)))
            throw new Error("Mock analytical assignment references an unknown need.");
          const text = content(item);
          return {
            id: item.id,
            confidence: null,
            reason:
              "[MOCK] Complete fixed-need keyword signals; confidence is unknown, not a learned probability.",
            signals: item.needIds.map((needId) => {
              const topic = topicFor(needs.get(needId)!);
              const quote = excerpt(text, topic?.words);
              const feedback =
                item.kind === "feedback" &&
                FEEDBACK.has(item.source.kind) &&
                !AGGREGATE_ROW.test(text);
              const support = SUPPORT.test(quote);
              const oppose = OPPOSE.test(quote);
              const stance =
                !feedback || (topic && !topic.words.test(quote))
                  ? "unclear"
                  : NEGATED_DESIRE.test(quote)
                    ? "opposition"
                    : support === oppose
                      ? "unclear"
                      : support
                        ? "support"
                        : "opposition";
              const expressed = stance === "support" ? impact(quote) : null;
              return {
                needId,
                stance,
                impact: expressed,
                confidence: null,
                evidence: evidence(item, quote),
                reason: `[MOCK] ${stance} from explicit excerpt keywords; ${expressed === null ? "no supporting impact anchor; impact unknown" : `expressed keyword anchor maps to ${expressed}/100, not measured impact`}. Not semantic AI judgement.`,
              };
            }),
          };
        }),
      };
    }
  }
}

const FilterPayload = z.object({
  contract: z.literal("reqflow.ai-filter.selection@1"),
  configuration: z.object({
    criterion: z.string().trim().min(1),
    include: z.string(),
    exclude: z.string(),
    examples: z.string(),
    fields: z.array(z.string()),
  }),
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        layer: z.enum(["records", "findings", "themes", "requirements"]),
        item: z.record(z.string(), z.unknown()),
        assessed: z.record(z.string(), z.unknown()),
        missingFields: z.boolean(),
        context: z.object({ records: z.array(SourceRecord) }),
      }),
    )
    .min(1)
    .max(20),
});
const FILTER_OUTSIDE =
  /\b(pricing|price|cost|regulation|regulatory|homologation|tax|taxes|engineering spec|torque spec|emissions compliance)\b/i;
const FILTER_CUSTOMER =
  /\b(comfort|space|usability|equipment|features?|infotainment|digital services|variants?|packages?|acceleration|handling|braking|steering|ride|range|charging|quality|design|noise|visibility|safety|reliability)\b/i;
const FILTER_PURE_OUTSIDE =
  /^(?:(?:pricing|price|cost|regulation|regulatory|homologation|tax|taxes|engineering spec|torque spec|emissions compliance)|(?:and|or|is|are|too|very|high|low|expensive|unacceptable|only|purely)|[\s.,;:!?])+$/i;

function filterObject(raw: unknown, promptLength: number): unknown {
  const checked = FilterPayload.safeParse(raw);
  if (!checked.success || promptLength > 48000)
    throw new Error("Unsupported or oversized mock AI Filter selection contract.");
  const payload = checked.data;
  unique(
    payload.items.map((item) => item.id),
    "filter item IDs",
  );
  const configuration = payload.configuration;
  const supported =
    configuration.criterion === FILTER_CUSTOMER_CRITERION &&
    ((!configuration.include.trim() &&
      !configuration.exclude.trim() &&
      !configuration.examples.trim()) ||
      (configuration.include === FILTER_PRESETS["customer-facing"].include &&
        configuration.exclude === FILTER_PRESETS["customer-facing"].exclude &&
        configuration.examples === FILTER_PRESETS["customer-facing"].examples));
  return {
    contract: payload.contract,
    decisions: payload.items.map((entry) => {
      if (entry.item.id !== entry.id) throw new Error("Mock AI Filter item ID mismatch.");
      const record =
        entry.layer === "records"
          ? entry.context.records.find((r) => r.id === entry.id)
          : undefined;
      if (entry.layer === "records" && !record)
        throw new Error("Mock AI Filter record context is unavailable.");
      const values = configuration.fields.length
        ? Object.values(entry.assessed)
        : [
            entry.item.text,
            entry.item.title,
            entry.item.description,
            entry.item.statement,
            entry.item.label,
            entry.item.summary,
            entry.item.fields,
            ...entry.context.records.map((record) => record.fields),
          ];
      const text = values
        .map((v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v)))
        .join(" ");
      const relevant = FILTER_CUSTOMER.test(text) || TOPICS.some((topic) => topic.words.test(text));
      const outside = FILTER_OUTSIDE.test(text);
      const pureValue = (value: unknown) =>
        value == null ||
        (typeof value === "string" && (!value.trim() || FILTER_PURE_OUTSIDE.test(value.trim())));
      const purelyOutside = configuration.fields.length
        ? values.every(pureValue)
        : record
          ? FILTER_PURE_OUTSIDE.test(record.text.trim()) &&
            Object.entries(record.fields ?? {}).every(
              ([key, value]) =>
                /^(id|feedback id|market|country|language)$/i.test(key) || pureValue(value),
            )
          : FILTER_PURE_OUTSIDE.test(text.trim());
      const decision =
        !supported || entry.missingFields
          ? "review"
          : relevant
            ? "keep"
            : outside && purelyOutside
              ? "exclude"
              : "review";
      return {
        id: entry.id,
        decision,
        confidence: decision === "review" ? 0 : 0.8,
        reason: !supported
          ? "[OFFLINE MOCK] Custom semantic criteria are not interpreted; human review required."
          : entry.missingFields
            ? "[OFFLINE MOCK] Selected fields unavailable; review required."
            : relevant
              ? "[OFFLINE MOCK] Customer-facing vocabulary matched; positive, negative and mixed-topic content retained intact. Keyword heuristic, not semantic AI assessment."
              : outside
                ? "[OFFLINE MOCK] Only explicit out-of-scope vocabulary matched. Keyword heuristic, not semantic AI assessment."
                : "[OFFLINE MOCK] No supported vocabulary match; uncertainty requires review, not an ID-hash guess.",
        quotes: record?.text.trim() ? [{ recordId: record.id, excerpt: excerpt(record.text) }] : [],
      };
    }),
  };
}

/** Deliberately narrow offline protocol, not a generic schema synthesis engine. */
export function mockObject(prompt: string): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(prompt);
  } catch {
    throw new Error(
      "Unsupported prompt for mock provider; expected explicit AI Splitter JSON contract.",
    );
  }
  if (
    raw &&
    typeof raw === "object" &&
    "contract" in raw &&
    raw.contract === "reqflow.ai-filter.selection@1"
  )
    return filterObject(raw, prompt.length);
  if (
    raw &&
    typeof raw === "object" &&
    "contract" in raw &&
    [
      "reqflow.ai-splitter.discover@1",
      "reqflow.ai-splitter.consolidate@1",
      "reqflow.ai-splitter.plan@1",
      "reqflow.ai-splitter.assign@1",
    ].includes(String(raw.contract))
  ) {
    return rawObject(raw, prompt.length);
  }
  const checked = Payload.safeParse(raw);
  if (!checked.success) {
    throw new Error(
      "Unsupported prompt for mock provider; expected explicit AI Splitter JSON contract.",
    );
  }
  const payload = checked.data;
  if (payload.contract === "reqflow.ai-splitter.scoring@1") {
    if (payload.mode !== "priority")
      throw new Error("Mock scoring contract requires priority mode");
    return {
      scores: payload.items.map(({ id }) => ({
        id,
        factors: Object.fromEntries(
          ScoreFactor.options.map((factor) => [
            factor,
            {
              value: 2,
              note: `MOCK assumption: ${factor} fixed at 2/5 for offline routing; not measured evidence.`,
            },
          ]),
        ),
      })),
    };
  }
  if (payload.mode === "priority") throw new Error("Mock routing contract does not score priority");
  return {
    assignments: payload.items.map(({ id, item, context }) => {
      const labels = payload.branches.map(normalized);
      const text = normalized(
        [item.text, item.title, item.description, item.statement, item.summary, item.label]
          .filter((v): v is string => typeof v === "string")
          .join(" "),
      );
      let index = -1;
      let rule = "label keyword match";
      if (payload.mode === "category" && typeof item.category === "string") {
        const category = normalized(item.category);
        const title = normalized(
          CATEGORY_LABELS[item.category as keyof typeof CATEGORY_LABELS] ?? item.category,
        );
        index = labels.findIndex(
          (label) =>
            label === category || label === title || (label.length > 2 && title.includes(label)),
        );
        rule = "existing category match";
      } else if (payload.mode === "sentiment") {
        const values = [item, ...context.findings]
          .map((f) => f.sentiment)
          .filter((v): v is number => typeof v === "number");
        const value = values.length
          ? values.reduce((sum, v) => sum + v, 0) / values.length
          : /\b(love|great|excellent|praise)\b/.test(text)
            ? 1
            : /\b(fail|fails|cheap|complain|complaint|poor|bad)\b/.test(text)
              ? -1
              : 0;
        const band = value > 0.2 ? "positive" : value < -0.2 ? "negative" : "neutral";
        index = labels.findIndex((label) => label.includes(band));
        rule = values.length
          ? "existing sentiment mean"
          : "synthetic keyword sentiment rule (not inference)";
      }
      if (index < 0) index = labels.findIndex((label) => label.length > 1 && text.includes(label));
      if (index < 0) {
        index = stableIndex(id, labels.length);
        rule = "stable ID fallback, not semantic assessment";
      }
      return { id, branchIndex: index, reason: `MOCK routing: ${rule}.` };
    }),
  };
}
