/**
 * Lexicon sentiment of a text, and the mapping of classification columns to sentiment. Rules only: word
 * lists, negation and intensifiers. No model; the same input always gives the same score.
 */
import { foldText, words } from "./text";
import type { Word } from "./text";
import type { Sentiment } from "./types";

/** Lexicon sentiment of one text: score from -1 to 1, its label, and the summed weight of each side. */
export interface SentimentScore {
  score: number; // -1 … 1
  label: Sentiment;
  positive: number; // summed weight of the positive words (after negation)
  negative: number; // summed weight of the negative words (after negation)
}

/** Positive words, English. Folded; an entry ending in "*" is a prefix stem. Car vocabulary included. */
const EN_POSITIVE = `comfort* comfy cozy quiet silent smooth responsive intuitive reliab* spacious roomy
premium luxur* elegant beautiful nice good great excellent awesome amazing fantastic wonderful
brilliant perfect best better love loved lovely enjoy* pleasant pleasing pleased happy satisf*
impress* favorite favourite fun superb solid safe secure stable powerful strong quick efficient
economical clean clear easy easily simple convenient practical useful helpful handy delight* joy*
superior sophisticated modern stylish sporty dynamic agile precise accurate sturdy durable robust
outstanding exceptional remarkable thank* appreciat* relax* calm peaceful airy bright seamless*
flawless* effortless* gorgeous stunning attractive sweet incredible ideal trustworthy dependable
top-notch first-class high-quality well-made well-designed well-engineered well-crafted superbly
fabulous marvelous marvellous splendid terrific phenomenal stellar magnificent charming plush cushy
supportive generous ample versatile flexible adaptable functional logical ergonom* snappy nimble
refined polished classy upscale exquisite lavish opulent sumptuous posh worthwhile valuable
affordable reasonable bargain thrilled excited exciting excite* fascinat* inspir* cheerful glad
grateful proud confident confiden* reassur* neat handsome sleek elegance user-friendly friendly
easy-to-use straightforward understandable long-lasting rapid rapidly speedy swift brisk protective
protected adore* beautifully nicely greatly improved happily smile* wow impeccable exemplary perfectly
stress-free trouble-free problem-free error-free fault-free hassle-free noiseless noise-free bug-free
issue-free worry-free lag-free fearless recommend* praise* well-built`;

/** Negative words, English. Folded; an entry ending in "*" is a prefix stem. Car vocabulary included. */
const EN_NEGATIVE = `noisy noise* loud annoy* uncomfort* cramped broken defect* faulty fault* fail*
malfunction* crack* rattl* squeak* creak* buzz* vibrat* vibration* shak* leak* rust* scratch* dent*
poor poorly bad badly worse worst terribl* horrible horrib* awful disgust* hate* dislik* disappoint*
frustrat* irritat* complain* problem* issue* lack* lacks slow* sluggish laggy lag* glitch* bug* buggy
crash* confus* unclear cluttered complicated difficult expensive overpriced pricey ugly bland boring
dull flimsy wobbl* harsh bumpy jerky uneven vague weak weakness* lousy mediocre unreliable unsafe
dangerous danger* hazard* unpleasant unhappy unsatisf* dissatisf* regret* sad angry anger stress*
pain painful painfully hurt useless pointless worthless unusable inferior outdated obsolete
old-fashioned unfinished sloppy drone tinny unresponsive unstable misaligned unintuitive clumsy
squeaky creaky whistl* hiss* rumbl* booming jitter* jerk* lurch* stutter* hesitat* stall* error*
dysfunction* inoperat* dead drained fatigue* tired uncomfy ache* sore numb clunky tedious tedium
cumbersome fiddly unhelpful inconsisten* unpredictable unfriendly unable impossibl* pesky nuisance
hassle* shoddy chintzy scuffed chipped peel* faded fade* discolor* stain* torn loose unpleasantly
resent* ashamed embarrass* overcharg* rip-off ripoff exorbitant unjustified unfair unacceptab*
insufficient inadequate missing absent omitted risky scary frighten* panic lame meh subpar
unimpress* underwhelm* bored* boredom tacky unattractive unappealing ugl* worr* fear* nightmare*
trouble* unnecessar* nonsense ridiculous absurd silly stupid dumb idiotic disaster* fiasco junk
garbage trash crap* rubbish pathetic dreadful atrocious abysmal appalling deplorable unfit mess
unreliab* complicat*
awkward suck* unbearable intolerable`;

/** Positive words, German. Folded (ä→a, ö→o, ü→u, ß→ss). "schön" folds to "schon": see polarityOf. */
const DE_POSITIVE = `bequem* angenehm* komfort* leise ruhig glatt reaktionsschnell intuitiv zuverlass*
geraumig praktisch nutzlich hilfreich toll* super klasse prima hervorragend ausgezeichnet exzellent
top wunderbar traumhaft herrlich fantastisch grossartig perfekt ideal gelungen vorbildlich
uberzeug* beeindruck* sauber stimmig schick edel hochwertig wertig stabil stark kraftig elegant
schnell flott gut gute guten guter gutes gern gerne freu* gefall* begeister* zufrieden* lob lobt
lobenswert empfehl* dankbar danke entspann* spass* wunderschon genial geil wohlfuhl* luxus stilvoll
modisch sportlich* dynamisch agil wendig prazise praezise exakt verlasslich langlebig haltbar solide
gediegen ubersichtlich logisch verstandlich bedienfreundlich benutzerfreundlich freundlich* zugig rasch
flink spritzig kraftvoll leistungsstark gerauscharm sanft wohlig gemutlich kuschelig luftig grosszugig
glucklich* froh bewunder* liebling* liebevoll herzlich sympathisch bewahrt fehlerfrei tadellos makellos
einwandfrei problemlos reibungslos muhelos ansprechend attraktiv hubsch chic optimal vorzuglich vorzug*
sensationell grandios bestens beste bester besten bestes uberragend erstklassig exklusiv beruhig*
schnittig aufregend spannend interessant faszinier* gelobt befriedig* erfreulich* funktionier* klappt
leichtgangig geschmeidig seidenweich harmonisch ausgewogen passt stabil* stressfrei schmerzfrei
lautlos gerauschlos gerauschfrei klapperfrei storungsfrei rostfrei kratzfest fehlerlos mangelfrei
problemfrei beschwerdefrei`;

/** Negative words, German. Folded. "laut" and "billig" are exact forms only (lautlos and billigen are not negative). */
const DE_NEGATIVE = `laut lauter larm* gerausch* klapper* quietsch* knarr* knarz* rassel* drohn*
vibrier* unbequem* eng enge beengt kaputt* defekt* mangel* fehler* ausfall* langsam* lahm trage
verzogert* ruckel* wackel* verwirr* unubersicht* teuer* uberteuert enttausch* nervig nerv* problem*
fehlt fehl* schlecht* schlimm* schrecklich* furchtbar grausam miserabel unertraglich schwach*
schwierig* unzufrieden* hass* hasslich arger* storend stort storung* schwammig hakel* rost* kratz*
delle* leck undicht beschwerde* reklamation* kritik* kritisch* kritisier* unpraktisch umstandlich
kompliziert* unzureich* ungenug* minderwertig billig billige langweil* ungenau* unzuverlass*
unsicher* gefahr gefahrlich* unangenehm* mies unbrauchbar* wertlos sinnlos verschleiss* veraltet
altmodisch unfertig schmutzig unvollstandig bedauer* unruhig* klack* pfeif* zisch* brumm* heul*
klirr* schepper* rappel* polter* zitter* ruttel* holper* ruckt stotter* stockt zogert zogerlich*
schleppend* verspann* ruckenschmerz* schmerz* mude mudigkeit eingeeng* unverstand* unlogisch*
unintuitiv* fummel* lastig* langwier* muhsam* unklar* undurchsichtig* vage antiquiert* unmodern*
anfallig* unsauber* schlamp* knirsch* spalt fleck* verkratz* zerkratz* abgenutz* verschliss*
verrost* beschad* schaden kostspielig abzock* wucher* frustrier* generv* wut* traurig* unglucklich*
ekel* abstoss* peinlich gefahrvoll riskant* bedrohlich* erschreck* katastroph* dumm dumme lacherlich*
nutzlos* uberflussig* unnotig* unsinn* muell schrott* ramsch nachteil* jammer* schade leider
unerfreulich* unerwunscht unpassend* untauglich unzulanglich* anstreng* ermud* stress* verletz*
stink* gestank muff* dreck* schmutz* unordentlich* chaot* lieblos* schrill kreisch* scheuer* versag*
absturz* abgestur* lahmt gruselig* unbefriedig*`;

/** Exact words, and prefix stems bucketed by their first two letters (fast lookup). */
interface Lexicon {
  exact: Set<string>;
  stems: Map<string, string[]>;
}

function buildLexicon(...lists: string[]): Lexicon {
  const exact = new Set<string>();
  const stems = new Map<string, string[]>();
  for (const entry of lists.join(" ").split(/\s+/)) {
    if (entry === "") continue;
    if (entry.endsWith("*")) {
      const stem = entry.slice(0, -1);
      const key = stem.slice(0, 2);
      stems.set(key, [...(stems.get(key) ?? []), stem]);
    } else {
      exact.add(entry);
    }
  }
  return { exact, stems };
}

function wordSet(list: string): Set<string> {
  return new Set(list.split(/\s+/).filter((w) => w.length > 0));
}

const POSITIVE = buildLexicon(EN_POSITIVE, DE_POSITIVE);
const NEGATIVE = buildLexicon(EN_NEGATIVE, DE_NEGATIVE);

/** Negators flip the polarity of the next NEGATION_SPAN words. Folded without apostrophes: "isn't" is "isnt". */
const NEGATORS = wordSet(
  "not no never dont doesnt didnt isnt wasnt arent cant couldnt wont wouldnt shouldnt havent hasnt " +
    "without hardly barely nicht kein keine keinen keiner keinem nie niemals ohne kaum",
);
/** Intensifiers multiply the next word by INTENSIFIER_WEIGHT. "too" does the same for negative words only. */
const INTENSIFIERS = wordSet(
  "very really extremely so absolutely sehr extrem total absolut wirklich",
);
const NEGATION_SPAN = 3;
const INTENSIFIER_WEIGHT = 1.5;

function inLexicon(lexicon: Lexicon, key: string): boolean {
  if (lexicon.exact.has(key)) return true;
  const bucket = lexicon.stems.get(key.slice(0, 2));
  return bucket !== undefined && bucket.some((stem) => key.startsWith(stem));
}

/** +1 for a positive word, -1 for a negative one, 0 for none. "schön" folds to "schon": it counts only with its umlaut. */
function polarityOf(word: Word, key: string): number {
  if (key === "schon") return /ö/.test(word.text.normalize("NFC").toLowerCase()) ? 1 : 0;
  if (inLexicon(POSITIVE, key)) return 1;
  if (inLexicon(NEGATIVE, key)) return -1;
  return 0;
}

/**
 * Lexicon sentiment, rules only. Each lexicon word adds weight 1 to the positive or the negative side. An
 * intensifier before a word multiplies its weight by 1.5 ("too" does so for negative words only). A negator
 * (not, no, never, n't, without, hardly, nicht, kein, nie, ohne, kaum …) flips the next 3 words.
 * score = (positive − negative) / max(1, positive + negative), −1 … 1. Label: positive from 0.2, negative up
 * to −0.2, neutral otherwise (also when no lexicon word occurs).
 */
export function scoreSentiment(text: string): SentimentScore {
  let positive = 0;
  let negative = 0;
  let negateLeft = 0; // words still under a negator
  let boost = false; // the previous word was an intensifier
  let tooBoost = false; // the previous word was "too"
  for (const word of words(text)) {
    const key = word.folded.includes("'") ? word.folded.replace(/'/g, "") : word.folded;
    if (NEGATORS.has(key)) {
      negateLeft = NEGATION_SPAN;
      boost = false;
      tooBoost = false;
      continue;
    }
    const flipped = negateLeft > 0; // this word is one of the NEGATION_SPAN words after a negator
    negateLeft = Math.max(0, negateLeft - 1);
    if (INTENSIFIERS.has(key)) {
      boost = true;
      continue;
    }
    if (key === "too") {
      tooBoost = true;
      boost = false;
      continue;
    }
    const polarity = polarityOf(word, key);
    if (polarity !== 0) {
      const amplified = boost || (tooBoost && polarity < 0);
      const weight = amplified ? INTENSIFIER_WEIGHT : 1;
      const effective = flipped ? -polarity : polarity;
      if (effective > 0) positive += weight;
      else negative += weight;
    }
    boost = false;
    tooBoost = false;
  }
  const score = (positive - negative) / Math.max(1, positive + negative);
  const label: Sentiment = score >= 0.2 ? "positive" : score <= -0.2 ? "negative" : "neutral";
  return { score, label, positive, negative };
}

const NEGATIVE_LABELS = wordSet(
  "negative neg complaint complaints problem issue defect criticism critique dislike detractor bad " +
    "poor beschwerde reklamation kritik mangel negativ unzufrieden",
);
const POSITIVE_LABELS = wordSet(
  "positive pos praise compliment like promoter good lob positiv zufrieden kompliment",
);
const NEUTRAL_LABELS = wordSet(
  "neutral suggestion idea request wish question info information passive other mixed vorschlag " +
    "idee wunsch anregung frage sonstiges",
);

/**
 * Maps a label of a classification column to a sentiment, or null when it is not one. The value is folded
 * and its words are checked in order: "Negative feedback" and "Complaint – product" are negative.
 */
export function sentimentFromLabel(value: string): Sentiment | null {
  for (const word of words(foldText(value))) {
    if (NEGATIVE_LABELS.has(word.folded)) return "negative";
    if (POSITIVE_LABELS.has(word.folded)) return "positive";
    if (NEUTRAL_LABELS.has(word.folded)) return "neutral";
  }
  return null;
}

/** Header names (folded, without spaces and underscores) that mark a sentiment or feedback-type column. */
const SENTIMENT_HEADERS = wordSet(
  "sentiment tonality tone polarity feedbacktype type kind art feedbackart stimmung bewertung",
);

/**
 * Whether a column looks like a sentiment or feedback-type classification: its header is one of the known
 * names, or at least 80% of its non-empty values map via sentimentFromLabel. Either way it needs at most
 * 12 distinct values.
 */
export function looksLikeSentimentColumn(header: string, values: readonly string[]): boolean {
  const distinct = new Set<string>();
  let filled = 0;
  let mapped = 0;
  for (const value of values) {
    const folded = foldText(value);
    if (folded === "") continue;
    filled++;
    if (distinct.size <= 12) distinct.add(folded);
    if (sentimentFromLabel(value) !== null) mapped++;
  }
  if (distinct.size > 12) return false;
  const key = foldText(header).replace(/[\s_-]/g, "");
  if (SENTIMENT_HEADERS.has(key)) return true;
  return filled > 0 && mapped >= 0.8 * filled;
}
