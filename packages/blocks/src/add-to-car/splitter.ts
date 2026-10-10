import type { SourceRecord } from "@reqflow/core";
import {
  ASPECTS,
  COMPONENTS,
  GENERAL_ASPECT,
  GENERAL_VFC,
  NEGATIVE_CUES,
  POSITIVE_CUES,
  REQUEST_CUES,
  type AspectRule,
  type ComponentRule,
  type Polarity,
} from "./taxonomy";

/** Lowercase, unify quotes, expand "n't", and glue phrases that would mislead word rules. */
export function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[‘’´`]/g, "'")
    .replace(/(\p{L})n't\b/gu, "$1 not")
    .replace(/\bsteering wheels?\b/g, "steering_wheel")
    .replace(/\bseat ?belts?\b/g, "seat_belt")
    .replace(/\b(?:child|car|baby|booster) seats?\b/g, "child_seat")
    .replace(/\brear seat entertainment\b/g, "rear_seat_entertainment")
    .replace(/\b(?:ride quality|quality of (?:the )?ride)\b/g, "ride_quality")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Clause {
  /** Verbatim slice of the record text: usable as an evidence excerpt as is. */
  text: string;
  norm: string;
}

const MIN_CLAUSE_WORDS = 3;
const BREAK = /(?<=[.!?;])\s+|\n+|\s+(?=(?:but|however|although|except that|aber|jedoch)\b)/giu;

/**
 * Split a comment into clauses at sentence ends, semicolons, line breaks and contrast words
 * ("but", "however"), which usually separate praise from complaints. Fragments shorter than
 * three words join the previous clause. Every clause is an exact substring of `text`.
 */
export function splitClauses(text: string): Clause[] {
  const spans: [number, number][] = [];
  let start = 0;
  for (const m of text.matchAll(BREAK)) {
    spans.push([start, m.index]);
    start = m.index + m[0].length;
  }
  spans.push([start, text.length]);
  const merged: [number, number][] = [];
  for (const [a, b] of spans) {
    const slice = text.slice(a, b);
    const lead = slice.length - slice.trimStart().length;
    const s = a + lead;
    const e = a + slice.trimEnd().length;
    if (e <= s) continue;
    const wordCount = text.slice(s, e).split(/\s+/).length;
    const prev = merged.at(-1);
    if (prev && wordCount < MIN_CLAUSE_WORDS) prev[1] = e;
    else merged.push([s, e]);
  }
  return merged.map(([s, e]) => {
    const t = text.slice(s, e);
    return { text: t, norm: normalize(t) };
  });
}

export type Method = "bmw_tag" | "text_rule";

/** One placement of a record into component › aspect. */
export interface Mention {
  component: string;
  aspect: string;
  /** null = the text names the topic but says nothing clear about it. */
  polarity: Polarity | null;
  method: Method;
  /** Verbatim from the record text, at most 1000 characters. */
  excerpt: string;
  rule: string;
}

export interface Classified {
  mentions: Mention[];
  /** BMW classification names that no rule maps; reported so nothing is dropped silently. */
  unmappedTags: string[];
}

const MAX_EXCERPT = 1000;

function count(re: RegExp, s: string): number {
  return s.match(re)?.length ?? 0;
}

export function polarityFromText(norm: string): Polarity | null {
  if (count(REQUEST_CUES, norm) > 0) return "request";
  const neg = count(NEGATIVE_CUES, norm);
  const pos = count(POSITIVE_CUES, norm);
  if (neg > pos) return "negative";
  if (pos > neg) return "positive";
  return null;
}

/** Polarity from BMW's labels: the feedback type when it's unambiguous, else the level-3 name. */
export function polarityFromTag(feedbackType: string | null, vfcL3: string): Polarity | null {
  switch (feedbackType) {
    case "Likes":
      return "positive";
    case "Wants":
      return "request";
    case "Defect":
    case "Difficult to Use":
      return "negative";
  }
  if (!vfcL3) return null;
  if (/^(?:like|likes|look \/ design appeals|workmanship appeals)/i.test(vfcL3)) return "positive";
  if (/^(?:customer request|vehicle equipment: not available)/i.test(vfcL3)) return "request";
  return "negative";
}

export function componentForVfc(l2: string): ComponentRule | undefined {
  return COMPONENTS.find((c) => c.vfc?.test(l2));
}

export function aspectForVfc(l3: string): AspectRule {
  if (!l3 || GENERAL_VFC.test(l3)) return GENERAL_ASPECT;
  return ASPECTS.find((a) => a.vfc?.test(l3)) ?? GENERAL_ASPECT;
}

// ---------------------------------------------------------------- BMW classification fields

const UNTAGGED = new Set(["", "no_class_found"]);
const keyOf = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const valuesOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v])
    .map((x) =>
      String(x)
        .replace(/\u00a0/g, " ")
        .trim(),
    )
    .filter((x) => !UNTAGGED.has(x));

interface Tags {
  pairs: { l2: string; l3: string }[];
  feedbackType: string | null;
}

/**
 * BMW's feedback export classifies each comment with VFC level 2 (component) and level 3 (aspect).
 * The Raw block merges the repeated rows, so these columns arrive as lists. The combined
 * "level 2 : level 3" column keeps the pairs together; the separate columns are a fallback.
 */
export function bmwTags(fields: Record<string, unknown> | undefined): Tags {
  if (!fields) return { pairs: [], feedbackType: null };
  let combined: string[] = [];
  let l2s: string[] = [];
  let l3s: string[] = [];
  let types: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const key = keyOf(k);
    if (/level2_?3|level23/.test(key)) combined = valuesOf(v);
    else if (/level2(?:name)?$/.test(key)) l2s = valuesOf(v);
    else if (/level3(?:name)?$/.test(key)) l3s = valuesOf(v);
    else if (/^(?:feedbacktype|sentiment|intent)$/.test(key)) types = valuesOf(v);
  }
  let pairs: { l2: string; l3: string }[];
  if (combined.length) {
    pairs = combined.map((c) => {
      const at = c.indexOf(" : ");
      return at === -1 ? { l2: c, l3: "" } : { l2: c.slice(0, at), l3: c.slice(at + 3) };
    });
  } else if (l2s.length === 1) {
    pairs = (l3s.length ? l3s : [""]).map((l3) => ({ l2: l2s[0]!, l3 }));
  } else if (l3s.length === 1 || l2s.length === l3s.length) {
    pairs = l2s.map((l2, i) => ({ l2, l3: l3s.length === 1 ? l3s[0]! : l3s[i]! }));
  } else {
    pairs = l2s.map((l2) => ({ l2, l3: "" }));
  }
  return { pairs, feedbackType: types.length === 1 ? types[0]! : null };
}

// ---------------------------------------------------------------- classification

function excerptFor(text: string, clauses: Clause[], c: ComponentRule, a: AspectRule): string {
  const hit =
    clauses.find((cl) => c.text?.test(cl.norm) && a.text?.test(cl.norm)) ??
    clauses.find((cl) => c.text?.test(cl.norm) || a.text?.test(cl.norm));
  return (hit?.text ?? text).slice(0, MAX_EXCERPT);
}

/**
 * Places one record into component › aspect themes. BMW's own tags come first; untagged text is
 * matched clause by clause with keyword rules. A clause that names only an aspect ("they squeak
 * constantly") inherits the component of the previous clause.
 */
export function classifyRecord(record: SourceRecord): Classified {
  const text = record.text;
  const clauses = splitClauses(text);
  const tags = bmwTags(record.fields);
  const mentions: Mention[] = [];
  const unmappedTags: string[] = [];
  const seen = new Set<string>();
  const add = (m: Mention) => {
    const key = `${m.component}|${m.aspect}|${m.polarity}`;
    if (seen.has(key)) return;
    seen.add(key);
    mentions.push(m);
  };

  for (const { l2, l3 } of tags.pairs) {
    const component = componentForVfc(l2);
    if (!component) {
      unmappedTags.push(l2);
      continue;
    }
    const aspect = aspectForVfc(l3);
    add({
      component: component.id,
      aspect: aspect.id,
      polarity: polarityFromTag(tags.feedbackType, l3) ?? polarityFromText(normalize(text)),
      method: "bmw_tag",
      excerpt: excerptFor(text, clauses, component, aspect),
      rule: `vfc: ${l3 ? `${l2} : ${l3}` : l2}`,
    });
  }
  if (mentions.length > 0) return { mentions, unmappedTags };

  const typePolarity = polarityFromTag(tags.feedbackType, "");
  let carry: ComponentRule[] = [];
  for (const clause of clauses) {
    let components = COMPONENTS.filter((c) => c.text?.test(clause.norm));
    const aspects = ASPECTS.filter((a) => a.text?.test(clause.norm));
    const polarity = typePolarity ?? polarityFromText(clause.norm);
    let rule = "text";
    if (components.length === 0 && aspects.length > 0) {
      if (carry.length > 0) {
        components = carry;
        rule = "text, component from the previous clause";
      } else if (polarity) {
        components = COMPONENTS.filter((c) => c.id === "vehicle_general");
        rule = "text, no component named";
      }
    }
    if (components.length > 0 && rule === "text") carry = components;
    for (const c of components) {
      for (const a of aspects.length > 0 ? aspects : [GENERAL_ASPECT]) {
        add({
          component: c.id,
          aspect: a.id,
          polarity,
          method: "text_rule",
          excerpt: clause.text.slice(0, MAX_EXCERPT),
          rule: `${rule}: ${c.label} › ${a.label}`,
        });
      }
    }
  }
  return { mentions, unmappedTags };
}
