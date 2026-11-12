import { layerTiers, type CorpusFile, type TierScheme } from "../corpus/corpus.ts";
import { datasetFromRows, type Dataset, type Row } from "../data/dataset.ts";
import { normalCdf } from "../stats/distributions.ts";
import { compileDropPattern, tokenizeAnnotation, type TokenizerOptions } from "../text/tokenize.ts";
import { metaCells } from "./common.ts";

/** Word-level statistics of transcription layers. */

export interface TokenRecord {
  norm: string;
  text: string;
  stop: boolean;
  fileId: string;
  fileName: string;
  tierId: string;
  participant: string;
  start: number;
  end: number;
  /** Index of the annotation on its tier and of the token within the annotation. */
  annotation: number;
  position: number;
}

/** All tokens of a layer, in file / tier / time order. */
export function collectTokens(files: CorpusFile[], scheme: TierScheme, layer: string, tokenizer: TokenizerOptions): TokenRecord[] {
  const drop = compileDropPattern(tokenizer.dropPattern);
  const out: TokenRecord[] = [];
  for (const lt of layerTiers(files, scheme, layer)) {
    lt.tier.annotations.forEach((a, ai) => {
      tokenizeAnnotation(a, tokenizer, drop).forEach((t, ti) => {
        out.push({
          norm: t.norm, text: t.text, stop: t.stop,
          fileId: lt.file.id, fileName: lt.file.name, tierId: lt.tier.id, participant: lt.participant,
          start: t.start, end: t.end, annotation: ai, position: ti,
        });
      });
    });
  }
  return out;
}

export interface FrequencyRow {
  type: string;
  count: number;
  /** Occurrences per 1000 tokens. */
  perThousand: number;
  /** Number of files and of speakers (file × participant) that use the type. */
  files: number;
  speakers: number;
  /**
   * Gries' (2008) deviation of proportions across files: 0 = spread exactly like the
   * tokens of the corpus, towards 1 = concentrated in few files.
   */
  dp: number;
  stop: boolean;
}

export function frequencyList(tokens: TokenRecord[]): FrequencyRow[] {
  const total = tokens.length;
  const fileSizes = new Map<string, number>();
  for (const t of tokens) fileSizes.set(t.fileId, (fileSizes.get(t.fileId) ?? 0) + 1);
  const acc = new Map<string, { count: number; files: Map<string, number>; speakers: Set<string>; stop: boolean }>();
  for (const t of tokens) {
    let a = acc.get(t.norm);
    if (!a) acc.set(t.norm, (a = { count: 0, files: new Map(), speakers: new Set(), stop: t.stop }));
    a.count++;
    a.files.set(t.fileId, (a.files.get(t.fileId) ?? 0) + 1);
    a.speakers.add(`${t.fileId}\u0001${t.participant}`);
  }
  const rows: FrequencyRow[] = [];
  for (const [type, a] of acc) {
    let dp = 0;
    for (const [fileId, size] of fileSizes) {
      dp += Math.abs((a.files.get(fileId) ?? 0) / a.count - size / total);
    }
    rows.push({ type, count: a.count, perThousand: (1000 * a.count) / total, files: a.files.size, speakers: a.speakers.size, dp: dp / 2, stop: a.stop });
  }
  rows.sort((x, y) => y.count - x.count || x.type.localeCompare(y.type));
  return rows;
}

export interface Diversity {
  tokens: number;
  types: number;
  /** Type–token ratio. */
  ttr: number;
  /** Guiraud's index: types / √tokens. */
  guiraud: number;
  /** Herdan's C: ln types / ln tokens. */
  herdan: number;
  /** Moving-average TTR over windows of `window` tokens (Covington & McFall 2010). */
  mattr: number;
  /** Measure of textual lexical diversity (McCarthy & Jarvis 2010). */
  mtld: number;
  /** Yule's K. */
  yuleK: number;
  hapax: number;
}

function mtldOneWay(seq: string[], threshold: number): number {
  let factors = 0;
  let types = new Set<string>();
  let count = 0;
  for (const w of seq) {
    types.add(w);
    count++;
    if (types.size / count <= threshold) {
      factors++;
      types = new Set();
      count = 0;
    }
  }
  if (count > 0) {
    const ttr = types.size / count;
    factors += (1 - ttr) / (1 - threshold);
  }
  return factors > 0 ? seq.length / factors : NaN;
}

export function lexicalDiversity(seq: string[], window = 50): Diversity {
  const n = seq.length;
  const counts = new Map<string, number>();
  for (const w of seq) counts.set(w, (counts.get(w) ?? 0) + 1);
  const types = counts.size;
  let hapax = 0;
  let sumSq = 0;
  for (const c of counts.values()) {
    if (c === 1) hapax++;
    sumSq += c * c;
  }
  // Moving-average TTR with an incremental window.
  let mattr = NaN;
  if (n >= window) {
    const win = new Map<string, number>();
    let acc = 0;
    let k = 0;
    for (let i = 0; i < n; i++) {
      win.set(seq[i]!, (win.get(seq[i]!) ?? 0) + 1);
      if (i >= window) {
        const old = seq[i - window]!;
        const c = win.get(old)! - 1;
        if (c === 0) win.delete(old);
        else win.set(old, c);
      }
      if (i >= window - 1) {
        acc += win.size / window;
        k++;
      }
    }
    mattr = acc / k;
  }
  return {
    tokens: n,
    types,
    ttr: n ? types / n : NaN,
    guiraud: n ? types / Math.sqrt(n) : NaN,
    herdan: n > 1 ? Math.log(types) / Math.log(n) : NaN,
    mattr,
    mtld: n >= 10 ? 0.5 * (mtldOneWay(seq, 0.72) + mtldOneWay([...seq].reverse(), 0.72)) : NaN,
    yuleK: n ? (1e4 * (sumSq - n)) / (n * n) : NaN,
    hapax,
  };
}

/** Lexical diversity per speaker (file × participant). */
export function diversityDataset(files: CorpusFile[], scheme: TierScheme, layer: string, tokenizer: TokenizerOptions, metaVars: string[]): Dataset {
  const tokens = collectTokens(files, scheme, layer, tokenizer);
  const groups = new Map<string, { file: CorpusFile; participant: string; seq: string[] }>();
  const fileById = new Map(files.map((f) => [f.id, f]));
  for (const t of tokens) {
    const key = `${t.fileId}\u0001${t.participant}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { file: fileById.get(t.fileId)!, participant: t.participant, seq: [] }));
    g.seq.push(t.norm);
  }
  const rows: Row[] = [];
  for (const g of groups.values()) {
    const d = lexicalDiversity(g.seq);
    rows.push({
      file: g.file.name, ...metaCells(g.file, metaVars), participant: g.participant,
      tokens: d.tokens, types: d.types, ttr: d.ttr, guiraud: d.guiraud, herdan: d.herdan,
      mattr: d.mattr, mtld: d.mtld, yule_k: d.yuleK, hapax: d.hapax,
      tokens_per_min: g.file.doc.duration ? d.tokens / (g.file.doc.duration / 60000) : NaN,
    });
  }
  return datasetFromRows(`Lexical diversity: ${layer}`, "one speaker in one file", "Vocabulary size and diversity per speaker.", rows, [
    { name: "file", type: "string" }, ...metaVars.map((v) => ({ name: v, type: "string" as const, label: "file variable" })),
    { name: "participant", type: "string" },
    { name: "tokens", type: "number" }, { name: "types", type: "number" },
    { name: "ttr", type: "number", label: "type–token ratio (depends on text length)" },
    { name: "guiraud", type: "number", label: "types / √tokens" },
    { name: "herdan", type: "number", label: "ln types / ln tokens" },
    { name: "mattr", type: "number", label: "moving-average TTR, window 50" },
    { name: "mtld", type: "number", label: "measure of textual lexical diversity" },
    { name: "yule_k", type: "number", label: "Yule's K (higher = more repetitive)" },
    { name: "hapax", type: "number", label: "types that occur once" },
    { name: "tokens_per_min", type: "number", label: "speech rate over the whole recording" },
  ]);
}

export interface KeynessRow {
  type: string;
  countA: number;
  countB: number;
  /** Occurrences per 1000 tokens in each group. */
  rateA: number;
  rateB: number;
  /** Posterior mean of the log odds ratio (A vs. B) and its SD. */
  logOdds: number;
  sd: number;
  /** 95% credible interval of the log odds ratio. */
  ci: [number, number];
  /** Posterior probability that the type is more characteristic of A than of B. */
  pA: number;
  /** logOdds / sd — the ranking statistic of Monroe et al. */
  z: number;
}

/**
 * Keyness as a Bayesian log odds ratio with an informative Dirichlet prior (Monroe,
 * Colaresi & Quinn 2008, "Fightin' Words"). The prior is the pooled word distribution,
 * worth `priorStrength` tokens, so that rare words are shrunk towards "no difference"
 * instead of dominating the list as they do with raw ratios or log-likelihood scores.
 */
export function keyness(a: Map<string, number>, b: Map<string, number>, priorStrength = 500): KeynessRow[] {
  let nA = 0;
  let nB = 0;
  for (const v of a.values()) nA += v;
  for (const v of b.values()) nB += v;
  const total = nA + nB;
  if (nA === 0 || nB === 0) return [];
  const types = new Set([...a.keys(), ...b.keys()]);
  const rows: KeynessRow[] = [];
  for (const w of types) {
    const ya = a.get(w) ?? 0;
    const yb = b.get(w) ?? 0;
    const alpha = (priorStrength * (ya + yb)) / total;
    const la = Math.log((ya + alpha) / (nA + priorStrength - ya - alpha));
    const lb = Math.log((yb + alpha) / (nB + priorStrength - yb - alpha));
    const logOdds = la - lb;
    const sd = Math.sqrt(1 / (ya + alpha) + 1 / (yb + alpha));
    rows.push({
      type: w,
      countA: ya,
      countB: yb,
      rateA: (1000 * ya) / nA,
      rateB: (1000 * yb) / nB,
      logOdds,
      sd,
      ci: [logOdds - 1.959964 * sd, logOdds + 1.959964 * sd],
      pA: normalCdf(logOdds / sd),
      z: logOdds / sd,
    });
  }
  rows.sort((x, y) => y.z - x.z);
  return rows;
}

export function countTypes(tokens: Iterable<TokenRecord>, contentOnly = false): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tokens) {
    if (contentOnly && t.stop) continue;
    out.set(t.norm, (out.get(t.norm) ?? 0) + 1);
  }
  return out;
}

export interface ConcordanceLine {
  fileId: string;
  fileName: string;
  tierId: string;
  participant: string;
  start: number;
  end: number;
  left: string;
  match: string;
  right: string;
}

/**
 * Keyword in context. The query is a regular expression matched against whole
 * normalised tokens; a query with spaces matches a sequence of tokens.
 */
export function concordance(tokens: TokenRecord[], query: string, context = 6, limit = 2000): { lines: ConcordanceLine[]; total: number; error?: string } {
  const parts = query.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { lines: [], total: 0 };
  let res: RegExp[];
  try {
    res = parts.map((p) => new RegExp(`^(?:${p})$`, "iu"));
  } catch (e) {
    return { lines: [], total: 0, error: `Invalid search pattern: ${(e as Error).message}` };
  }
  const lines: ConcordanceLine[] = [];
  let total = 0;
  const sameStream = (i: number, j: number) => tokens[i]!.fileId === tokens[j]!.fileId && tokens[i]!.tierId === tokens[j]!.tierId;
  for (let i = 0; i + res.length <= tokens.length; i++) {
    let ok = true;
    for (let k = 0; k < res.length; k++) {
      if (!sameStream(i, i + k) || !res[k]!.test(tokens[i + k]!.norm)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    total++;
    if (lines.length >= limit) continue;
    const left: string[] = [];
    for (let k = i - 1; k >= 0 && k >= i - context && sameStream(k, i); k--) left.unshift(tokens[k]!.text);
    const right: string[] = [];
    const last = i + res.length - 1;
    for (let k = last + 1; k < tokens.length && k <= last + context && sameStream(k, i); k++) right.push(tokens[k]!.text);
    lines.push({
      fileId: tokens[i]!.fileId, fileName: tokens[i]!.fileName, tierId: tokens[i]!.tierId, participant: tokens[i]!.participant,
      start: tokens[i]!.start, end: tokens[last]!.end,
      left: left.join(" "), match: tokens.slice(i, last + 1).map((t) => t.text).join(" "), right: right.join(" "),
    });
  }
  return { lines, total };
}
