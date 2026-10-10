import { test } from "vitest";
import assert from "node:assert/strict";
import {
  computeSignals,
  confidenceScores,
  evidenceStrength,
  problemPriority,
  rankActions,
  wilson,
  type FeedbackCell,
  type ProblemDef,
  type Segment,
  type SourceInfo,
  type StudyObservation,
} from "./scoring";

// Synthetic numbers only.
const problems: ProblemDef[] = [
  { key: "seats|noise", component: "seats", aspect: "noise", relevance: 1 },
  { key: "seats|comfort", component: "seats", aspect: "comfort", relevance: 1 },
  { key: "interior|quality", component: "interior", aspect: "quality", relevance: 0.5 },
];
const segments: Segment[] = [
  { derivative: "X1", market: "EU", sales: 100_000 },
  { derivative: "X1", market: "US", sales: 50_000 },
  { derivative: "X1", market: "CN", sales: 50_000 },
];
const fb: SourceInfo = { id: "fb_a", kind: "feedback", family: "customer_feedback", weight: 0.75 };
const st: SourceInfo = { id: "study", kind: "study", family: "market_research", weight: 0.25 };
const totals = { fb_a: { "X1/EU": 100, "X1/US": 1000 } };
const cell = (
  problemKey: string,
  market: string,
  negative: number,
  request = 0,
  positive = 0,
): FeedbackCell => ({
  sourceId: "fb_a",
  problemKey,
  derivative: "X1",
  market,
  negative,
  request,
  positive,
  unknown: 0,
  certaintySum: negative + request,
});
const cells = [
  cell("seats|noise", "EU", 10),
  cell("seats|noise", "US", 10),
  cell("seats|comfort", "US", 40, 0, 120),
  cell("interior|quality", "EU", 2),
];
const studies: StudyObservation[] = [
  {
    sourceId: "study",
    problemKey: "seats|comfort",
    dimension: "Seat comfort",
    derivative: "X1",
    market: "EU",
    marketResolved: true,
    metric: "mean_10pt",
    value: 7.0,
    columnMean: 8.0,
    columnSd: 0.5,
    mapWeight: 1,
  },
];

test("wilson interval brackets the rate", () => {
  const { lo, hi } = wilson(10, 100);
  assert.ok(lo < 0.1 && hi > 0.1 && lo > 0 && hi < 0.2);
});

test("feedback signal is weighted by sales share, so a quiet big market is not drowned out", () => {
  const sig = computeSignals(problems, [fb, st], segments, totals, cells, studies, []);
  // seats|noise: EU rate 10/100 = 0.1 (2/3 of covered sales), US 10/1000 = 0.01 (1/3)
  assert.ok(Math.abs(sig.raw.fb_a!["seats|noise"]! - ((2 / 3) * 0.1 + (1 / 3) * 0.01)) < 1e-12);
  assert.equal(sig.norm.fb_a!["seats|noise"], 1);
  assert.deepEqual(sig.coveredSegments.fb_a, ["X1/EU", "X1/US"]); // CN has no feedback
  assert.equal(sig.norm.study!["seats|comfort"], 1);
  assert.equal(sig.norm.study!["seats|noise"], 0);
});

test("priority = relevance × severity × weighted signal, with per-source contributions", () => {
  const sig = computeSignals(problems, [fb, st], segments, totals, cells, studies, []);
  const p = problemPriority(problems[0]!, [fb, st], sig);
  assert.ok(Math.abs(p.score - 100 * 1 * 0.8 * 0.75) < 1e-9);
  assert.ok(Math.abs(p.perSource.reduce((a, s) => a + s.contribution, 0) - p.score) < 1e-9);
});

test("changing source weights changes the ranking as expected", () => {
  const actions = [
    { id: "A1", problemKey: "seats|noise", coverage: 1, pinned: false },
    { id: "A2", problemKey: "seats|comfort", coverage: 1, pinned: false },
  ];
  const fbFirst = computeSignals(problems, [fb, st], segments, totals, cells, studies, []);
  assert.equal(rankActions(actions, problems, [fb, st], fbFirst, 50)[0]!.id, "A1");
  const studyFirst = [
    { ...fb, weight: 0.25 },
    { ...st, weight: 0.75 },
  ];
  const sig2 = computeSignals(problems, studyFirst, segments, totals, cells, studies, []);
  const ranked = rankActions(actions, problems, studyFirst, sig2, 50);
  assert.equal(ranked[0]!.id, "A2");
  assert.ok(ranked[0]!.rankRange[0] <= 1 && ranked[0]!.rankRange[1] >= 1);
});

test("rank ranges are reproducible (seeded)", () => {
  const sig = computeSignals(problems, [fb, st], segments, totals, cells, studies, []);
  const actions = problems.map((p, i) => ({
    id: `A${i}`,
    problemKey: p.key,
    coverage: 0.5,
    pinned: false,
  }));
  assert.deepEqual(
    rankActions(actions, problems, [fb, st], sig),
    rankActions(actions, problems, [fb, st], sig),
  );
});

test("evidence strength reports market gaps and praise conflicts, independent of source weights", () => {
  const sig = computeSignals(problems, [fb, st], segments, totals, cells, studies, []);
  const e = evidenceStrength(problems[1]!, [fb, st], segments, totals, cells, studies, [], sig);
  assert.ok(e.gaps.some((g) => g.includes("CN")));
  assert.ok(e.conflicts.some((c) => c.type === "praise_vs_complaints"));
  assert.deepEqual(e.supportingFamilies.sort(), ["customer_feedback", "market_research"]);
  assert.ok(Math.abs(e.factors.coverage - 0.75) < 1e-9); // EU + US sales of 200k
  const reweighted = [
    { ...fb, weight: 0.01 },
    { ...st, weight: 0.99 },
  ];
  const e2 = evidenceStrength(problems[1]!, reweighted, segments, totals, cells, studies, [], sig);
  assert.equal(e2.strength, e.strength);
});

test("study-only evidence is capped", () => {
  const sig = computeSignals(problems, [st], segments, {}, [], studies, []);
  const e = evidenceStrength(problems[1]!, [st], segments, {}, [], studies, [], sig);
  assert.equal(e.cap, 0.6);
  assert.ok(e.strength <= 0.6);
});

test("a problem no source family supports is capped low", () => {
  const sig = computeSignals(problems, [fb, st], segments, totals, cells, studies, []);
  const e = evidenceStrength(problems[2]!, [fb, st], segments, totals, cells, studies, [], sig); // 2 mentions only
  assert.deepEqual(e.supportingFamilies, []);
  assert.ok(e.strength <= 0.2);
});

test("confidence: solution is never above problem confidence", () => {
  const c = confidenceScores(0.8, { confirmed: 9, checked: 10 }, "weak");
  assert.ok(Math.abs(c.problem - 72) < 1e-9);
  assert.ok(c.solution < c.problem);
});
