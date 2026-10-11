/**
 * Text helpers of the analytics engine: folding, word splitting, tokens, stopwords, phrase
 * queries and term statistics. Rules only, deterministic, no model.
 */

/** Plain lowercase ASCII with single inner spaces: already folded, so returned as is (fast path). */
const PLAIN_FOLDED = /^[a-z0-9'"-]+(?: [a-z0-9'"-]+)*$/;

/** Lowercase, Unicode NFKD with combining marks removed (ä→a, é→e), ß→ss, curly quotes → straight, whitespace collapsed, trimmed. */
export function foldText(s: string): string {
  if (PLAIN_FOLDED.test(s)) return s;
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** A word of the original text with its character range [start, end) in the ORIGINAL string and its folded form. Words are runs of letters/digits (Unicode \p{L}\p{N}), may contain inner apostrophes or hyphens ("don't", "e-mail", "head-up"). */
export interface Word {
  text: string;
  folded: string;
  start: number;
  end: number;
}

/** Letters and digits, with inner apostrophes (straight or curly) or hyphens kept. */
const WORD_RE = /[\p{L}\p{N}]+(?:['‘’-][\p{L}\p{N}]+)*/gu;

/** Splits a text into words with their original character ranges, in reading order. */
export function words(s: string): Word[] {
  const out: Word[] = [];
  for (const m of s.matchAll(WORD_RE)) {
    const text = m[0];
    const start = m.index ?? 0;
    out.push({ text, folded: foldText(text), start, end: start + text.length });
  }
  return out;
}

/** Folded words of length ≥ 2 (pure numbers kept only if ≥ 2 chars). */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const w of words(s)) {
    if (w.folded.length >= 2) out.push(w.folded);
  }
  return out;
}

/** English function words only (articles, pronouns, auxiliaries, prepositions, conjunctions, generic adverbs). Folded; contractions with and without apostrophe. */
const EN_STOPWORDS = `a about above across after afterwards again against ago all almost alone along
already also although always am among amongst an and another any anybody anyone anything anyway
anywhere are around as at be became because become becomes been before behind being below beside
besides between beyond both but by can cannot cant could couldnt did didnt do does doesnt doing dont
done down during each either else elsewhere enough etc eg even ever every everybody everyone
everything everywhere except few for from further get gets getting got had hadnt has hasnt have
havent having he hence her here hers herself him himself his how however i id ie if ill im in indeed
instead into is isnt it its itself ive just may maybe me meanwhile might more moreover most mostly
much must mustnt my myself namely neither never nevertheless no nobody none nor not nothing now
nowhere of off often on once one only onto or other others otherwise our ours ourselves out over own
per perhaps quite rather really same several shall she should shouldnt since so some somebody someone
something sometimes somewhere still such than that thats the their theirs them themselves then
thence there thereafter thereby therefore therein thereupon these they this those though through
throughout thus till to together too toward towards under unless until up upon us very via was wasnt
we were werent what whatever when whenever where whereas whether which while who whoever whom whose
why will with within without wont would wouldnt yet you youre your yours yourself yourselves
don't doesn't didn't isn't aren't wasn't weren't can't couldn't won't wouldn't shouldn't haven't
hasn't hadn't i'm i'll i've i'd it's that's there's what's you're let's mustn't`;

/** German function words only (Artikel, Pronomen, Hilfsverben, Präpositionen, Konjunktionen, Füllwörter). Folded: ä→a, ö→o, ü→u, ß→ss. */
const DE_STOPWORDS = `der die das den dem des ein eine einen einem einer eines und oder aber doch
sondern denn weil dass ob wenn als wie so auch nur noch schon sehr sind ist bin bist seid war waren
wird werden wurde wurden worden sein seine seinen seinem seiner seines hat haben habe hast habt hatte
hatten kann kannst konnen konnte konnten muss musst musste mussen soll sollen sollte sollten will
wollen wollte wollten darf durfen mag mochte mochten ich mich mir du dich dir er ihn ihm ihr ihre
ihren ihrem ihrer ihres es wir uns unser unsere unseren unserem unserer euch euer eure man mein meine
meinen meinem meiner meines dein deine deinen deinem deiner deines jede jeder jedes jeden jedem alle
allen allem aller dieser diese dieses diesen diesem dies welche welcher welches welchen welchem was wer
wen wem wessen an auf aus bei bis durch fur gegen hinter in mit nach neben ohne seit unter uber um von
vor wahrend wegen zu zum zur zwischen im am vom beim ins dahin dabei dafur damit danach daher dann
daran darauf daraus darin darum daruber davon dazu hier hierbei hierzu da dort wo wann warum wieso
weshalb wohin woher allerdings ausserdem bzw usw zb bitte nicht kein keine keinen keinem keiner
keines nie niemals nichts niemand mehr immer ganz gar etwa eher ziemlich recht wirklich total absolut
extrem bereits jetzt nun dennoch trotzdem jedoch indem sowie sowohl weder entweder bevor nachdem
solange sobald obwohl falls eigentlich irgendwie halt mal ja eben gerade nochmal etwas`;

/** Function words of both languages (see the two lists above). Domain words such as car, seat or auto are deliberately absent. */
export const STOPWORDS: ReadonlySet<string> = new Set(
  `${EN_STOPWORDS} ${DE_STOPWORDS}`.split(/\s+/).filter((w) => w.length > 0),
);

const DIGITS_ONLY = /^\p{N}+$/u;

/** A token that can carry meaning: not a stopword and not only digits. */
function isContent(token: string): boolean {
  return !STOPWORDS.has(token) && !DIGITS_ONLY.test(token);
}

/** tokenize() minus stopwords and minus tokens that are only digits. */
export function contentTokens(s: string): string[] {
  return tokenize(s).filter(isContent);
}

/**
 * A phrase query the user types to count how many records say something.
 * Alternatives are separated by "|", " OR " (any case) or ","; the words of one alternative must
 * appear consecutively; a word ending in "*" matches any word with that prefix; double quotes are ignored.
 */
export interface PhraseQuery {
  raw: string;
  alternatives: { word: string; prefix: boolean }[][];
}

/** Parses a phrase query. Words are folded like the text, so "Muller" finds "Müller". Null when nothing is left. */
export function parsePhrase(raw: string): PhraseQuery | null {
  const alternatives: { word: string; prefix: boolean }[][] = [];
  for (const piece of raw.replace(/"/g, " ").split(/\||,|\s+or\s+/i)) {
    const seq: { word: string; prefix: boolean }[] = [];
    for (const token of piece.trim().split(/\s+/)) {
      if (token === "") continue;
      const prefix = token.endsWith("*");
      const parts = words(prefix ? token.slice(0, -1) : token);
      parts.forEach((part, i) => {
        seq.push({ word: part.folded, prefix: prefix && i === parts.length - 1 });
      });
    }
    if (seq.length > 0) alternatives.push(seq);
  }
  return alternatives.length > 0 ? { raw, alternatives } : null;
}

/** True when the alternative seq starts at word index i of ws. */
function matchesAt(
  ws: readonly Word[],
  i: number,
  seq: readonly { word: string; prefix: boolean }[],
): boolean {
  for (let j = 0; j < seq.length; j++) {
    const w = ws[i + j];
    const q = seq[j];
    if (!w || !q) return false;
    if (q.prefix ? !w.folded.startsWith(q.word) : w.folded !== q.word) return false;
  }
  return true;
}

/** True when any alternative of the query occurs in the text. */
export function matchesPhrase(text: string, query: PhraseQuery): boolean {
  const ws = words(text);
  for (const seq of query.alternatives) {
    for (let i = 0; i + seq.length <= ws.length; i++) {
      if (matchesAt(ws, i, seq)) return true;
    }
  }
  return false;
}

/** Character ranges [start, end) in the ORIGINAL text of every match (for highlighting), sorted, with overlaps merged. */
export function phraseRanges(text: string, query: PhraseQuery): [number, number][] {
  const ws = words(text);
  const found: [number, number][] = [];
  for (const seq of query.alternatives) {
    for (let i = 0; i + seq.length <= ws.length; i++) {
      if (!matchesAt(ws, i, seq)) continue;
      const first = ws[i];
      const last = ws[i + seq.length - 1];
      if (first && last) found.push([first.start, last.end]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const r of found) {
    const prev = merged[merged.length - 1];
    if (prev && r[0] < prev[1]) prev[1] = Math.max(prev[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** A term with its document frequency: in how many texts it occurs at least once. */
export interface TermCount {
  term: string;
  docs: number;
  share: number;
}

/** Ascending code-point order for terms: deterministic tie-breaking. */
function byTerm(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The distinct terms of one text: content unigrams and/or bigrams of consecutive content tokens (pairs with a stopword are skipped). */
function termsOf(text: string, unigrams: boolean, bigrams: boolean): Set<string> {
  const out = new Set<string>();
  const seq = tokenize(text);
  if (unigrams) {
    for (const t of seq) {
      if (isContent(t)) out.add(t);
    }
  }
  if (bigrams) {
    for (let i = 0; i + 1 < seq.length; i++) {
      const a = seq[i];
      const b = seq[i + 1];
      if (a !== undefined && b !== undefined && isContent(a) && isContent(b)) {
        out.add(`${a} ${b}`);
      }
    }
  }
  return out;
}

/** Document frequency per term: each text counts once per term. */
function docFrequency(
  texts: readonly string[],
  unigrams: boolean,
  bigrams: boolean,
): Map<string, number> {
  const df = new Map<string, number>();
  for (const text of texts) {
    for (const term of termsOf(text, unigrams, bigrams)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  return df;
}

/**
 * The most frequent content terms by document frequency. ngram 1 = single content tokens; ngram 2 =
 * pairs of consecutive content tokens joined by a space. Terms in fewer than minDocs texts (default 2)
 * are left out. Sorted by docs desc, then term asc. share = docs / texts.length.
 */
export function topTerms(
  texts: readonly string[],
  opts: { limit?: number; minDocs?: number; ngram?: 1 | 2 } = {},
): TermCount[] {
  const limit = opts.limit ?? 30;
  const minDocs = opts.minDocs ?? 2;
  const ngram = opts.ngram ?? 1;
  const df = docFrequency(texts, ngram === 1, ngram === 2);
  const out: TermCount[] = [];
  for (const [term, docs] of df) {
    if (docs >= minDocs) out.push({ term, docs, share: docs / texts.length });
  }
  out.sort((x, y) => y.docs - x.docs || byTerm(x.term, y.term));
  return out.slice(0, limit);
}

/** Prior weight: alpha_w = PRIOR_SHARE × (docs of w in A + docs of w in B). */
const PRIOR_SHARE = 0.01;

/** A term that sets group A apart from group B, with the document counts and the z-score of its log-odds. */
export interface DistinctiveTerm {
  term: string;
  docsA: number;
  docsB: number;
  shareA: number;
  shareB: number;
  z: number;
}

/**
 * Terms that set group A apart from group B, unigrams and bigrams together. Weighted log-odds ratio with an
 * informative Dirichlet prior (Monroe, Colaresi & Quinn 2008, "Fightin' Words"), on document frequencies:
 * alpha_w = 0.01 × (docs in A + docs in B), alpha_0 = sum of alpha_w; δ = ln((yA+α)/(nA+α0−yA−α)) −
 * ln((yB+α)/(nB+α0−yB−α)); variance 1/(yA+α) + 1/(yB+α); z = δ / √variance. Returns the terms over-represented
 * in A with z > 1.96 and at least minDocs texts in A (default 3). Sorted by z desc, then term asc.
 */
export function distinctiveTerms(
  a: readonly string[],
  b: readonly string[],
  opts: { limit?: number; minDocs?: number } = {},
): DistinctiveTerm[] {
  const limit = opts.limit ?? 15;
  const minDocs = opts.minDocs ?? 3;
  const dfA = docFrequency(a, true, true);
  const dfB = docFrequency(b, true, true);
  let nA = 0;
  let nB = 0;
  for (const v of dfA.values()) nA += v;
  for (const v of dfB.values()) nB += v;
  const alpha0 = PRIOR_SHARE * (nA + nB);
  const out: DistinctiveTerm[] = [];
  for (const [term, yA] of dfA) {
    if (yA < minDocs) continue;
    const yB = dfB.get(term) ?? 0;
    const alpha = PRIOR_SHARE * (yA + yB);
    const restA = nA + alpha0 - yA - alpha;
    const restB = nB + alpha0 - yB - alpha;
    if (restA <= 0 || restB <= 0) continue;
    const delta = Math.log((yA + alpha) / restA) - Math.log((yB + alpha) / restB);
    const z = delta / Math.sqrt(1 / (yA + alpha) + 1 / (yB + alpha));
    if (z > 1.96) {
      out.push({
        term,
        docsA: yA,
        docsB: yB,
        shareA: yA / a.length,
        shareB: b.length > 0 ? yB / b.length : 0,
        z,
      });
    }
  }
  out.sort((x, y) => y.z - x.z || byTerm(x.term, y.term));
  return out.slice(0, limit);
}

/**
 * A short excerpt around the first match: up to radius characters on each side, cut at word boundaries, with
 * "…" where text was cut. ranges are the match ranges relative to the excerpt. Without a match (or without a
 * query): the first 2 × radius characters, and no ranges.
 */
export function excerpt(
  text: string,
  query: PhraseQuery | null,
  radius = 90,
): { text: string; ranges: [number, number][] } {
  const r = Math.max(0, Math.floor(radius));
  const matches = query ? phraseRanges(text, query) : [];
  const first = matches[0];
  const isSpace = (i: number): boolean => /\s/.test(text.charAt(i));
  let start = first ? Math.max(0, first[0] - r) : 0;
  let end = first ? Math.min(text.length, first[1] + r) : Math.min(text.length, 2 * r);
  if (first && start > 0 && !isSpace(start - 1)) {
    // Move the window start past the next whitespace, but never past the match itself.
    const sp = text.slice(start, first[0]).search(/\s/);
    start = sp >= 0 ? start + sp + 1 : first[0];
  }
  if (end < text.length && !isSpace(end)) {
    // Move the window end back to the last whitespace, but never before the match ends.
    const floor = first ? first[1] : start + 1;
    let cut = -1;
    for (let i = end - 1; i >= floor; i--) {
      if (isSpace(i)) {
        cut = i;
        break;
      }
    }
    if (cut >= 0) end = cut;
    else if (first) end = first[1];
  }
  const cutBefore = start > 0;
  const cutAfter = end < text.length;
  while (start < end && isSpace(start)) start++;
  while (end > start && isSpace(end - 1)) end--;
  const prefix = cutBefore ? "…" : "";
  const ranges: [number, number][] = [];
  for (const [a0, b0] of matches) {
    const a = Math.max(a0, start);
    const b = Math.min(b0, end);
    if (b > a) ranges.push([a - start + prefix.length, b - start + prefix.length]);
  }
  const suffix = cutAfter ? "…" : "";
  return { text: `${prefix}${text.slice(start, end)}${suffix}`, ranges };
}
