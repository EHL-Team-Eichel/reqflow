import { CLASSIFIABLE_PARTS } from "./modelSwitcher/powertrains";
import type { Requirement, RequirementCategory } from "@reqflow/core";
import { PARTS_BY_ID, WHOLE_CAR, type CarPart } from "./parts";

/**
 * Auto classifier: puts every requirement on the part of the car it is about, so the 3D car can
 * show it there. Deterministic and explainable, no AI: it scores each part by the words of its
 * vocabulary (`parts.ts`) found in the requirement, and reports which words decided it.
 *
 * - Title words count 3, description 2, targets 1 (the title says what the requirement is about).
 * - Longest match first: once "rear seats" matched, the same words can't also count as "seats".
 * - The category only breaks ties, or places a requirement when no word matched at all and the
 *   category points at exactly one part. That is reported as low confidence.
 * - Nothing matched and no unambiguous category → "Whole car", never a guess.
 *
 * It only decides where a requirement is *shown*. It never changes the requirement itself.
 */

export type Confidence = "high" | "medium" | "low";
export type MatchField = "title" | "description" | "targets";

export interface PartMatch {
  partId: string;
  term: string;
  field: MatchField;
}

export interface PartAssignment {
  /** A part id from CAR_PARTS, or WHOLE_CAR.id. */
  partId: string;
  confidence: Confidence;
  /** Winning part's share of all weighted keyword matches (0 if none). Not a probability. */
  confidencePercent: number;
  /** One sentence a PM can read: why this part. */
  reason: string;
  score: number;
  /** The words that counted for the chosen part. */
  matches: PartMatch[];
  /** Other parts that scored, best first (for "could also be…"). */
  alternatives: { partId: string; score: number }[];
}

const FIELD_WEIGHT: Record<MatchField, number> = { title: 3, description: 2, targets: 1 };

/** Categories that point at exactly one part, used only when no word matched. */
const CATEGORY_FALLBACK: Partial<Record<RequirementCategory, string>> = {
  exterior_design: "body",
  interior_quality: "dashboard",
  infotainment_digital: "curved_display",
  driver_assistance: "driver_assistance",
  range_charging: "drivetrain",
  driving_experience: "suspension",
};

interface CompiledKeyword {
  partId: string;
  pattern: RegExp;
}

/** Whole-word, case-insensitive, Unicode-aware (umlauts count as letters). */
function wordPattern(fragment: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${fragment})(?![\\p{L}\\p{N}_])`, "giu");
}

function compile(parts: readonly CarPart[]): CompiledKeyword[] {
  return parts.flatMap((part) =>
    part.keywords.map((k) => ({ partId: part.id, pattern: wordPattern(k) })),
  );
}

const COMPILED = compile(CLASSIFIABLE_PARTS);

interface Hit {
  partId: string;
  start: number;
  end: number;
  term: string;
}

/** All keyword hits in one text, longest first, without overlaps. */
function matchText(text: string, keywords: readonly CompiledKeyword[]): Hit[] {
  const hits: Hit[] = [];
  for (const { partId, pattern } of keywords) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      if (m[0].length === 0 || m.index === undefined) continue;
      hits.push({ partId, start: m.index, end: m.index + m[0].length, term: m[0] });
    }
  }
  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const taken: Hit[] = [];
  for (const hit of hits) {
    if (taken.some((t) => hit.start < t.end && t.start < hit.end)) continue;
    taken.push(hit);
  }
  return taken;
}

type Classifiable = Pick<Requirement, "title" | "description" | "category" | "targets">;

export function classifyRequirement(req: Classifiable): PartAssignment {
  const fields: [MatchField, string][] = [
    ["title", req.title],
    ["description", req.description],
    ["targets", req.targets.map((t) => `${t.metric}. ${t.target}. ${t.acceptance}`).join(" ")],
  ];

  const scores = new Map<string, number>();
  const matches: PartMatch[] = [];
  for (const [field, text] of fields) {
    for (const hit of matchText(text, COMPILED)) {
      scores.set(hit.partId, (scores.get(hit.partId) ?? 0) + FIELD_WEIGHT[field]);
      matches.push({ partId: hit.partId, term: hit.term.toLowerCase(), field });
    }
  }

  const fitsCategory = (partId: string) =>
    PARTS_BY_ID.get(partId)?.categories?.includes(req.category) ?? false;
  const ranked = [...scores.entries()]
    .map(([partId, score]) => ({ partId, score }))
    // Ties: the part whose categories include the requirement's category comes first.
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(fitsCategory(b.partId)) - Number(fitsCategory(a.partId)) ||
        a.partId.localeCompare(b.partId),
    );

  const best = ranked[0];
  if (!best) {
    const fallback = CATEGORY_FALLBACK[req.category];
    if (fallback) {
      return {
        partId: fallback,
        confidence: "low",
        confidencePercent: 0,
        reason: `No part named in the text; placed by its category alone.`,
        score: 0,
        matches: [],
        alternatives: [],
      };
    }
    return {
      partId: WHOLE_CAR.id,
      confidence: "low",
      confidencePercent: 0,
      reason: "No part named in the text, and its category doesn't point at a single part.",
      score: 0,
      matches: [],
      alternatives: [],
    };
  }

  const runnerUp = ranked[1]?.score ?? 0;
  const tied = runnerUp === best.score;
  const confidence: Confidence =
    !tied && best.score >= 4 && best.score >= 2 * runnerUp
      ? "high"
      : !tied && best.score >= 2
        ? "medium"
        : "low";
  const own = matches.filter((m) => m.partId === best.partId);
  const terms = [...new Set(own.map((m) => `"${m.term}"`))].slice(0, 4).join(", ");
  const where = own.some((m) => m.field === "title") ? "the title" : `its ${own[0]?.field}`;
  return {
    partId: best.partId,
    confidence,
    confidencePercent: Math.round(
      (100 * best.score) / ranked.reduce((total, part) => total + part.score, 0),
    ),
    reason: !tied
      ? `Named in ${where}: ${terms}.`
      : fitsCategory(best.partId) && !fitsCategory(ranked[1]!.partId)
        ? `Tied with ${label(ranked[1]!.partId)}; its category decided (${terms}).`
        : `Tied with ${label(ranked[1]!.partId)} on ${terms}; please check.`,
    score: best.score,
    matches: own,
    alternatives: ranked.slice(1, 4),
  };
}

export function label(partId: string): string {
  return PARTS_BY_ID.get(partId)?.label ?? WHOLE_CAR.label;
}

export interface ClassifiedRequirement {
  requirement: Requirement;
  assignment: PartAssignment;
}

/** Classifies a list and groups it by part id (WHOLE_CAR.id for the rest), keeping input order. */
export function groupByPart(
  requirements: readonly Requirement[],
): Map<string, ClassifiedRequirement[]> {
  const groups = new Map<string, ClassifiedRequirement[]>();
  for (const requirement of requirements) {
    const assignment = classifyRequirement(requirement);
    const list = groups.get(assignment.partId) ?? [];
    list.push({ requirement, assignment });
    groups.set(assignment.partId, list);
  }
  return groups;
}
