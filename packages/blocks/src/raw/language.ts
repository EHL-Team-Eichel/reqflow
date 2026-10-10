/**
 * A cheap language guess for free-text feedback when the data has no language column: CJK script
 * for Chinese, otherwise the most frequent function words. Returns undefined when unsure.
 */
const STOPWORDS: Record<string, readonly string[]> = {
  en: [
    "the",
    "and",
    "is",
    "it",
    "to",
    "of",
    "for",
    "in",
    "too",
    "not",
    "with",
    "my",
    "very",
    "car",
  ],
  de: [
    "der",
    "die",
    "das",
    "und",
    "ist",
    "nicht",
    "zu",
    "mit",
    "ein",
    "eine",
    "sehr",
    "auch",
    "für",
    "im",
  ],
  fr: [
    "le",
    "la",
    "les",
    "et",
    "est",
    "pas",
    "trop",
    "des",
    "une",
    "pour",
    "avec",
    "très",
    "du",
    "je",
  ],
  it: [
    "il",
    "la",
    "e",
    "è",
    "non",
    "per",
    "con",
    "troppo",
    "molto",
    "una",
    "della",
    "che",
    "sono",
    "del",
  ],
  es: [
    "el",
    "la",
    "y",
    "es",
    "no",
    "muy",
    "para",
    "con",
    "una",
    "los",
    "las",
    "por",
    "demasiado",
    "del",
  ],
};

export function guessLanguage(text: string): string | undefined {
  if (/[一-鿿]/.test(text)) return "zh";
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 3) return undefined;
  let best: string | undefined;
  let bestHits = 0;
  let secondHits = 0;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const hits = words.filter((w) => list.includes(w)).length;
    if (hits > bestHits) {
      secondHits = bestHits;
      bestHits = hits;
      best = lang;
    } else if (hits > secondHits) secondHits = hits;
  }
  return bestHits >= 2 && bestHits > secondHits ? best : undefined;
}

/** "DE" / "de-DE" / "German" → BCP-47-ish lowercase code, or undefined. */
export function normalizeLanguage(value: string): string | undefined {
  const v = value.trim();
  const names: Record<string, string> = {
    english: "en",
    german: "de",
    deutsch: "de",
    french: "fr",
    italian: "it",
    spanish: "es",
    chinese: "zh",
  };
  if (names[v.toLowerCase()]) return names[v.toLowerCase()];
  const m = /^([a-z]{2})(?:[-_]([a-z]{2}))?$/i.exec(v);
  return m
    ? m[2]
      ? `${m[1]!.toLowerCase()}-${m[2]!.toUpperCase()}`
      : m[1]!.toLowerCase()
    : undefined;
}
