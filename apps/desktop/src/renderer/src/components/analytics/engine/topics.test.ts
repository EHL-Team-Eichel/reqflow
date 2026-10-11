import { describe, expect, it } from "vitest";
import { foldForTopics, TOPICS, topicGroup, topicLabel, topicsOf } from "./topics";

describe("topic rules", () => {
  it("has unique ids and enough keywords per topic", () => {
    expect(new Set(TOPICS.map((t) => t.id)).size).toBe(TOPICS.length);
    for (const topic of TOPICS) expect(topic.keywords.length).toBeGreaterThanOrEqual(10);
  });

  it("folds umlauts, ß and punctuation", () => {
    expect(foldForTopics("Geräusch, Größe!  Head-up")).toBe("gerausch grosse head up");
  });

  it.each([
    ["The seat is uncomfortable on long trips.", "seats"],
    ["Die Sitzheizung braucht zu lange.", "seats"],
    ["Wind noise above 120 km/h is annoying.", "noise"],
    ["Im Innenraum klappert es ständig.", "noise"],
    ["Please add wireless Apple CarPlay.", "connectivity"],
    ["Navigation lags and the screen freezes.", "navigation"],
    ["Navigation lags and the screen freezes.", "software"],
    ["Navigation lags and the screen freezes.", "infotainment"],
    ["Das Navi findet die Route nicht.", "navigation"],
    ["Also the trunk is too small.", "trunk"],
    ["Der Kofferraum ist zu klein.", "trunk"],
    ["Excellent handling and steering.", "handling"],
    ["Die Reichweite im Winter ist enttäuschend.", "range-charging"],
    ["The head-up display is great.", "infotainment"],
    ["Too expensive for what you get.", "price-value"],
    ["Der Händler war unfreundlich.", "dealer-service"],
    ["Der Verbrauch ist zu hoch.", "efficiency"],
    ["Love the design of the kidney grille.", "exterior-design"],
  ])("%s → %s", (text, topic) => {
    expect(topicsOf(text)).toContain(topic);
  });

  it("does not match unrelated text or partial words", () => {
    expect(topicsOf("The seat is fine")).not.toContain("noise");
    expect(topicsOf("Everything about it is great.")).toEqual([]);
    expect(topicsOf("Seattle trip")).not.toContain("seats"); // "seat" is a whole word, not a prefix
    expect(topicsOf("")).toEqual([]);
  });

  it("returns topics in lexicon order, each once", () => {
    const found = topicsOf("Noise from the seat, the seat rattles, and the screen freezes");
    expect(found).toEqual([...new Set(found)]);
    const order = TOPICS.map((t) => t.id);
    expect([...found].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(found);
  });

  it("labels and groups topics, and falls back for unknown ids", () => {
    expect(topicLabel("seats")).toBe("Seats");
    expect(topicGroup("seats")).toBe("Comfort & space");
    expect(topicLabel("nope")).toBe("nope");
    expect(topicGroup("nope")).toBeUndefined();
  });

  it("is fast enough for 15,000 comments", () => {
    const base =
      "The seat is uncomfortable and the navigation freezes, aber der Kofferraum ist gut. ";
    const texts = Array.from({ length: 15_000 }, (_, i) => `${base.repeat(4)} ${i}`);
    const start = performance.now();
    for (const t of texts) topicsOf(t);
    expect(performance.now() - start).toBeLessThan(3000);
  });
});
