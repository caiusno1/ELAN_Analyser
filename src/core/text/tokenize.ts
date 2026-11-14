import type { Annotation } from "../eaf/model.ts";

/**
 * Turning transcription annotations into word tokens. Transcription conventions differ
 * between corpora, so every step is optional and the result is always shown to the user.
 */

export interface TokenizerOptions {
  lowercase: boolean;
  /** Strip punctuation and symbols from the edges of tokens (word-internal ' and - stay). */
  stripPunctuation: boolean;
  /** Remove material in brackets — (laughs), [noise], <comment>, {gesture} — before splitting. */
  removeBracketed: boolean;
  /** Regular expression (matched against the normalised token) for tokens to drop, e.g. fillers. */
  dropPattern: string;
  /** Tokens that are kept in the sequence but never count as content (function words). */
  stopWords: ReadonlySet<string>;
}

export const DEFAULT_TOKENIZER: TokenizerOptions = {
  lowercase: true,
  stripPunctuation: true,
  removeBracketed: true,
  dropPattern: "^(xxx|yyy|www|&.*|\\+.*)$",
  stopWords: new Set(),
};

export interface Token {
  /** Normalised form used for matching. */
  norm: string;
  /** Token as written in the annotation. */
  text: string;
  /** Interpolated start/end within the annotation (ms). */
  start: number;
  end: number;
  /** True for stop words. */
  stop: boolean;
}

const BRACKETED = /\([^()]*\)|\[[^[\]]*\]|<[^<>]*>|\{[^{}]*\}/g;
const EDGE_PUNCT = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

export function compileDropPattern(pattern: string): RegExp | undefined {
  if (!pattern.trim()) return undefined;
  try {
    return new RegExp(pattern, "iu");
  } catch {
    return undefined;
  }
}

export function normalizeToken(raw: string, opts: TokenizerOptions): string {
  let t = raw;
  if (opts.stripPunctuation) t = t.replace(EDGE_PUNCT, "");
  if (opts.lowercase) t = t.toLocaleLowerCase();
  return t.normalize("NFC");
}

/** Split text into normalised tokens (no timing). */
export function tokenizeText(text: string, opts: TokenizerOptions, drop = compileDropPattern(opts.dropPattern)): { norm: string; text: string }[] {
  let s = text;
  if (opts.removeBracketed) {
    // Repeat to remove nested brackets.
    for (let i = 0; i < 4 && BRACKETED.test(s); i++) s = s.replace(BRACKETED, " ");
    BRACKETED.lastIndex = 0;
  }
  const out: { norm: string; text: string }[] = [];
  for (const raw of s.split(/\s+/u)) {
    if (!raw) continue;
    const norm = normalizeToken(raw, opts);
    if (!norm) continue;
    // Markers such as "&uh" lose their prefix when punctuation is stripped, so the
    // pattern is tried on the raw token as well.
    if (drop && (drop.test(norm) || drop.test(raw))) continue;
    out.push({ norm, text: raw });
  }
  return out;
}

/**
 * Tokenise an annotation. Token times are interpolated inside the annotation in
 * proportion to token length — an approximation that is good enough for ordering and
 * for coarse timing, and clearly not a forced alignment.
 */
export function tokenizeAnnotation(a: Annotation, opts: TokenizerOptions, drop = compileDropPattern(opts.dropPattern)): Token[] {
  const parts = tokenizeText(a.value, opts, drop);
  if (parts.length === 0) return [];
  let total = 0;
  for (const p of parts) total += p.text.length + 1;
  const span = a.end - a.start;
  const out: Token[] = [];
  let acc = 0;
  for (const p of parts) {
    const w = p.text.length + 1;
    const start = a.start + (span * acc) / total;
    acc += w;
    const end = a.start + (span * acc) / total;
    out.push({ norm: p.norm, text: p.text, start, end, stop: opts.stopWords.has(p.norm) });
  }
  return out;
}

/** Small function-word lists for a few languages; users can paste their own. */
export const STOP_WORDS: Record<string, string[]> = {
  English: "a an the and or but if so of to in on at by for with from as is are was were be been being am do does did have has had i you he she it we they me him her us them my your his its our their this that these those there here not no yes n't 's 're 'm 've 'll can could will would shall should may might must just very also then than too what which who whom whose when where why how all any some one yeah okay ok mhm uh-huh hm hmm oh ah uh um well".split(" "),
  German: "der die das den dem des ein eine einen einem einer eines und oder aber wenn so von zu in im an am auf bei für mit aus als ist sind war waren sein bin bist hat haben hatte hatten ich du er sie es wir ihr mich mir dich dir ihn ihm uns euch mein dein nicht kein keine ja nein auch noch nur schon dann da hier dort was wer wie wo warum wann dass ob man sich um nach vor über unter durch zum zur ne nen mal halt eben doch denn okay ok mhm hm hmm äh ähm ach oh".split(" "),
  Dutch: "de het een en of maar als dus van te in op aan bij voor met uit is zijn was waren ben bent heeft hebben had hadden ik jij je hij zij ze wij we jullie mij me jou hem haar ons hun mijn jouw niet geen ja nee ook nog al dan daar hier wat wie hoe waar waarom wanneer dat die dit deze er om naar over onder door zo wel toch even oké ok okay mhm hm uh eh".split(" "),
  French: "le la les un une des et ou mais si donc de du à au aux en dans sur par pour avec sans est sont était étaient être suis es a ont avait avaient je tu il elle on nous vous ils elles me te se moi toi lui leur mon ton son ma ta sa mes tes ses ne pas non oui aussi encore déjà puis là ici que qui quoi comment où pourquoi quand ce cet cette ces y ça c' d' l' j' n' qu' s' ouais ok okay hm euh ben bah".split(" "),
  Spanish: "el la los las un una unos unas y o pero si de del a al en con por para sin es son era eran ser soy eres ha han había yo tú él ella nosotros vosotros ellos ellas me te se lo le nos les mi tu su mis tus sus no sí también ya entonces aquí allí que quien qué cómo dónde cuándo este esta estos estas ese esa eso muy más vale ok okay eh mm pues bueno".split(" "),
};

/** The `k` most frequent token types — a language-independent proxy for function words. */
export function topFrequentTypes(tokens: Iterable<string>, k: number): string[] {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, k)
    .map((e) => e[0]);
}

/**
 * Guess which stop-word list fits a sample of tokens: the language whose function words
 * cover the largest share of the tokens, if that share is substantial.
 */
export function guessStopLanguage(tokens: Iterable<string>): string | undefined {
  const sets = Object.entries(STOP_WORDS).map(([lang, words]) => ({ lang, set: new Set(words), hits: 0 }));
  let n = 0;
  for (const t of tokens) {
    n++;
    for (const s of sets) if (s.set.has(t)) s.hits++;
    if (n >= 20000) break;
  }
  if (n < 20) return undefined;
  sets.sort((a, b) => b.hits - a.hits);
  return sets[0]!.hits / n >= 0.25 ? sets[0]!.lang : undefined;
}
