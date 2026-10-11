import { describe, expect, it } from "vitest";
import { looksLikeSentimentColumn, scoreSentiment, sentimentFromLabel } from "./sentiment";

describe("scoreSentiment", () => {
  it("scores English praise and complaints", () => {
    const praise = scoreSentiment("The seat is comfortable and the ride is smooth and quiet");
    expect(praise).toEqual({ score: 1, label: "positive", positive: 3, negative: 0 });

    const complaint = scoreSentiment(
      "Engine is noisy and the seats are uncomfortable, the rattle is annoying",
    );
    expect(complaint.label).toBe("negative");
    expect(complaint.negative).toBe(4);
    expect(complaint.score).toBe(-1);
  });

  it("flips polarity after a negator, also in contractions", () => {
    expect(scoreSentiment("not comfortable").label).toBe("negative");
    expect(scoreSentiment("The seat isn't comfortable").label).toBe("negative");
    expect(scoreSentiment("Not bad, but the seats are comfortable").positive).toBe(2);
    expect(scoreSentiment("without problems").label).toBe("positive");
  });

  it("applies a negator to the next three words only", () => {
    expect(scoreSentiment("not one two three comfortable")).toMatchObject({
      positive: 1,
      negative: 0,
    });
    expect(scoreSentiment("not one two comfortable").negative).toBe(1);
  });

  it("multiplies the next word by 1.5 for intensifiers, and too only for negative words", () => {
    expect(scoreSentiment("very comfortable").positive).toBe(1.5);
    expect(scoreSentiment("too noisy").negative).toBe(1.5);
    expect(scoreSentiment("too comfortable").positive).toBe(1);
    expect(scoreSentiment("comfortable but noisy").label).toBe("neutral");
  });

  it("scores German words, negation and the umlaut in schön", () => {
    expect(scoreSentiment("Der Sitz ist bequem und der Motor ist leise").label).toBe("positive");
    expect(scoreSentiment("Die Bremse ist kaputt und die Software ist langsam").label).toBe(
      "negative",
    );
    expect(scoreSentiment("sehr bequem").positive).toBe(1.5);
    expect(scoreSentiment("nicht bequem").label).toBe("negative");
    expect(scoreSentiment("nicht schlecht").label).toBe("positive");
    expect(scoreSentiment("kein Problem").label).toBe("positive");
    expect(scoreSentiment("Das Radio ist schön").positive).toBe(1);
    expect(scoreSentiment("Das Radio ist schon kaputt").positive).toBe(0);
  });

  it("matches prefix stems", () => {
    expect(scoreSentiment("Ich bin enttäuscht").label).toBe("negative");
    expect(scoreSentiment("very disappointing").label).toBe("negative");
  });

  it("keeps -free and -less compounds positive although their stem is negative", () => {
    expect(scoreSentiment("stress-free and trouble-free").label).toBe("positive");
    expect(scoreSentiment("Der Motor ist lautlos und stressfrei").label).toBe("positive");
    expect(scoreSentiment("Die Bremse ist kratzfest").label).toBe("positive");
  });

  it("is neutral when no lexicon word occurs, and leaves ambiguous words out", () => {
    expect(scoreSentiment("The car has four doors and a trunk")).toEqual({
      score: 0,
      label: "neutral",
      positive: 0,
      negative: 0,
    });
    expect(scoreSentiment("This is hard and fast").label).toBe("neutral");
    expect(scoreSentiment("")).toMatchObject({ score: 0, label: "neutral" });
  });

  it("is deterministic and keeps the score within -1 … 1", () => {
    const text = "Sehr bequem, aber der Motor ist laut und nicht gut genug. Not bad at all.";
    expect(scoreSentiment(text)).toEqual(scoreSentiment(text));
    const { score } = scoreSentiment(text);
    expect(score).toBeGreaterThanOrEqual(-1);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe("sentimentFromLabel", () => {
  it("maps English and German labels, also inside longer values", () => {
    expect(sentimentFromLabel("Complaint")).toBe("negative");
    expect(sentimentFromLabel("Negative feedback")).toBe("negative");
    expect(sentimentFromLabel("Complaint – product")).toBe("negative");
    expect(sentimentFromLabel("Praise")).toBe("positive");
    expect(sentimentFromLabel("Lob")).toBe("positive");
    expect(sentimentFromLabel("Suggestion")).toBe("neutral");
    expect(sentimentFromLabel("Vorschlag")).toBe("neutral");
    expect(sentimentFromLabel("  Frage ")).toBe("neutral");
  });

  it("returns null for anything that is not a label", () => {
    expect(sentimentFromLabel("42")).toBeNull();
    expect(sentimentFromLabel("Country")).toBeNull();
    expect(sentimentFromLabel("")).toBeNull();
  });
});

describe("looksLikeSentimentColumn", () => {
  it("accepts a feedback-type column by its header or by its values", () => {
    expect(
      looksLikeSentimentColumn("Feedback Type", ["Complaint", "Praise", "Suggestion", "Praise"]),
    ).toBe(true);
    expect(
      looksLikeSentimentColumn("Remark", ["Complaint", "Complaint", "Praise", "Praise", "x"]),
    ).toBe(true);
    expect(looksLikeSentimentColumn("Remark", ["Complaint", "Praise", "x", "y", "z"])).toBe(false);
  });

  it("rejects a column of country codes and columns with too many distinct values", () => {
    expect(looksLikeSentimentColumn("Country", ["DE", "FR", "US", "CN", "IT", "DE"])).toBe(false);
    const many = Array.from({ length: 13 }, (_, i) => `Complaint ${i}`);
    expect(looksLikeSentimentColumn("Sentiment", many)).toBe(false);
  });
});
