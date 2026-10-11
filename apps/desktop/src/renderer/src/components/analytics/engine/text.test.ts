import { describe, expect, it } from "vitest";
import {
  contentTokens,
  distinctiveTerms,
  excerpt,
  foldText,
  matchesPhrase,
  parsePhrase,
  phraseRanges,
  STOPWORDS,
  tokenize,
  topTerms,
  words,
} from "./text";
import type { PhraseQuery } from "./text";

/** Parses a query that the test expects to be valid. */
function query(raw: string): PhraseQuery {
  const parsed = parsePhrase(raw);
  if (!parsed) throw new Error(`no phrase query in ${JSON.stringify(raw)}`);
  return parsed;
}

describe("foldText", () => {
  it("lowercases, strips diacritics and expands ß", () => {
    expect(foldText("Müller")).toBe("muller");
    expect(foldText("Straße")).toBe("strasse");
    expect(foldText("ÄUSSERST Café")).toBe("ausserst cafe");
    expect(foldText("ẞ")).toBe("ss");
  });

  it("normalizes curly quotes and collapses whitespace", () => {
    expect(foldText("don’t  stop\t\nnow")).toBe("don't stop now");
    expect(foldText("“quoted”")).toBe('"quoted"');
    expect(foldText("   ")).toBe("");
  });
});

describe("words and tokens", () => {
  it("keeps original character ranges across emoji, umlauts and punctuation", () => {
    const s = "😀 Der Müller-Sitz ist super, don’t worry! Größe 2";
    const ws = words(s);
    for (const w of ws) expect(s.slice(w.start, w.end)).toBe(w.text);
    expect(ws.map((w) => w.text)).toEqual([
      "Der",
      "Müller-Sitz",
      "ist",
      "super",
      "don’t",
      "worry",
      "Größe",
      "2",
    ]);
    expect(ws.map((w) => w.folded)).toEqual([
      "der",
      "muller-sitz",
      "ist",
      "super",
      "don't",
      "worry",
      "grosse",
      "2",
    ]);
  });

  it("tokenizes into folded words of at least two characters", () => {
    expect(tokenize("A seat für 2 Kinder, e-mail head-up")).toEqual([
      "seat",
      "fur",
      "kinder",
      "e-mail",
      "head-up",
    ]);
  });

  it("drops stopwords and digit-only tokens from content tokens", () => {
    expect(contentTokens("The seat is very comfortable and the model is 2024 and quiet")).toEqual([
      "seat",
      "comfortable",
      "model",
      "quiet",
    ]);
  });

  it("has function words in both languages but keeps domain words out", () => {
    for (const w of ["the", "and", "is", "der", "und", "nicht", "dont"]) {
      expect(STOPWORDS.has(w)).toBe(true);
    }
    for (const w of ["car", "seat", "auto", "sitz", "lenkrad", "comfortable"]) {
      expect(STOPWORDS.has(w)).toBe(false);
    }
    expect(STOPWORDS.size).toBeGreaterThan(400);
    expect(STOPWORDS.size).toBeLessThan(700);
  });
});

describe("phrase queries", () => {
  it("parses alternatives separated by |, OR or commas, and ignores quotes", () => {
    expect(parsePhrase("Sitz|Lenkrad")?.alternatives).toHaveLength(2);
    expect(parsePhrase("seat or steering")?.alternatives).toHaveLength(2);
    expect(parsePhrase("seat OR steering, roof")?.alternatives).toHaveLength(3);
    expect(parsePhrase('"seat heating"')?.alternatives).toEqual([
      [
        { word: "seat", prefix: false },
        { word: "heating", prefix: false },
      ],
    ]);
    expect(parsePhrase("charg*")?.alternatives).toEqual([[{ word: "charg", prefix: true }]]);
    expect(parsePhrase('  | , "" ')).toBeNull();
    expect(parsePhrase("orange")?.alternatives).toHaveLength(1);
  });

  it("matches consecutive words, prefixes and folded forms", () => {
    expect(matchesPhrase("The seat heating is off", query('"seat heating"'))).toBe(true);
    expect(matchesPhrase("heating of the seat", query('"seat heating"'))).toBe(false);
    expect(matchesPhrase("Lenkrad ist toll", query("Sitz|Lenkrad"))).toBe(true);
    expect(matchesPhrase("steering wheel", query("seat or steering"))).toBe(true);
    expect(matchesPhrase("Charging takes long", query("charg*"))).toBe(true);
    expect(matchesPhrase("The charger is slow", query("charg*"))).toBe(true);
    expect(matchesPhrase("Discharge warning", query("charg*"))).toBe(false);
    expect(matchesPhrase("Herr Müller sagt", query("muller"))).toBe(true);
    expect(matchesPhrase("Herr Muller sagt", query("Müller"))).toBe(true);
  });

  it("returns ranges in the original text and merges overlaps", () => {
    const text = "Müller 😀 charging ist gut, charger";
    const ranges = phraseRanges(text, query("charg*"));
    expect(ranges.map(([a, b]) => text.slice(a, b))).toEqual(["charging", "charger"]);
    expect(phraseRanges("the seat heating", query("seat heating|heating"))).toEqual([[4, 16]]);
    expect(phraseRanges("nothing here", query("seat"))).toEqual([]);
  });
});

describe("topTerms", () => {
  const texts = [
    "The seat heating is great",
    "Seat heating works, seat heating rocks",
    "Heating of the seat is slow",
    "Charging takes long",
  ];

  it("counts each text once per term and sorts by documents, then term", () => {
    const top = topTerms(texts, { minDocs: 2 });
    expect(top.map((t) => t.term)).toEqual(["heating", "seat"]);
    expect(top[0]).toEqual({ term: "heating", docs: 3, share: 3 / 4 });
    expect(topTerms(texts)).toEqual(topTerms(texts));
  });

  it("builds bigrams only from adjacent content tokens", () => {
    expect(topTerms(texts, { ngram: 2, minDocs: 2 }).map((t) => t.term)).toEqual(["seat heating"]);
    const all = topTerms(texts, { ngram: 2, minDocs: 1, limit: 100 }).map((t) => t.term);
    expect(all).not.toContain("heating great");
    expect(all).not.toContain("is great");
    expect(all).toContain("charging takes");
  });
});

describe("distinctiveTerms", () => {
  const a = [
    ...Array.from({ length: 30 }, () => "The heated seat is wonderful on long drives"),
    "Rarity pedal",
    "Rarity pedal",
  ];
  const b = Array.from({ length: 30 }, () => "The steering wheel is hard to grip");

  it("finds terms that only group A uses, with document counts and shares", () => {
    const out = distinctiveTerms(a, b);
    const heated = out.find((t) => t.term === "heated");
    expect(heated).toBeDefined();
    expect(heated?.docsA).toBe(30);
    expect(heated?.docsB).toBe(0);
    expect(heated?.shareA).toBeCloseTo(30 / 32);
    expect(heated?.shareB).toBe(0);
    expect(heated?.z).toBeGreaterThan(1.96);
    expect(out.map((t) => t.term)).not.toContain("steering");
    expect(out.map((t) => t.term)).not.toContain("rarity");
    expect(distinctiveTerms([], [])).toEqual([]);
  });
});

describe("excerpt", () => {
  const text =
    "Lorem ipsum dolor sit amet, the heated seat works well on cold mornings, and then the battery warms up quickly over long winter drives.";

  it("cuts around the first match at word boundaries and marks both cuts", () => {
    const ex = excerpt(text, query("heated seat"), 20);
    expect(ex.text).toBe("…dolor sit amet, the heated seat works well on cold…");
    expect(ex.ranges).toEqual([[21, 32]]);
    expect(ex.text.slice(21, 32)).toBe("heated seat");
  });

  it("keeps the whole text when it is short and cuts without a match at a word boundary", () => {
    expect(excerpt("Seat heating is nice", query("seat heating"), 90)).toEqual({
      text: "Seat heating is nice",
      ranges: [[0, 12]],
    });
    expect(excerpt(text, query("nonexistent"), 10)).toEqual({
      text: "Lorem ipsum dolor…",
      ranges: [],
    });
    expect(excerpt(text, null, 10).text).toBe("Lorem ipsum dolor…");
  });
});
