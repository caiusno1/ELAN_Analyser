import { layerTiers, listMetaVariables, type CorpusFile, type TierScheme } from "../corpus/corpus.ts";
import { datasetFromRows, type Dataset, type Row } from "../data/dataset.ts";
import { quantile } from "../stats/describe.ts";
import { Rng } from "../stats/rng.ts";
import { compileDropPattern, tokenizeAnnotation, type Token, type TokenizerOptions } from "../text/tokenize.ts";
import { metaCells } from "./common.ts";

/**
 * Lexical alignment: speakers re-using expressions their interlocutor produced earlier.
 *
 * An *alignment instance* is a maximal stretch of a speaker's turn (at least `minN`
 * tokens, containing at least one content word) that another speaker produced earlier
 * within the look-back window. The set of expressions re-used in this way is the
 * dialogue's *shared expression lexicon*; the derived measures follow Dubuisson Duplessis
 * et al. (2017, 2021). Turn-by-turn overlap measures (local linguistic alignment, cosine
 * similarity) follow Fusaroli et al. (2012) and Duran, Paxton & Fusaroli (2019).
 */

export type LookBack = { kind: "all" } | { kind: "turns"; n: number } | { kind: "seconds"; s: number };

export interface AlignmentOptions {
  layer: string;
  tokenizer: TokenizerOptions;
  /** "turn": consecutive annotations of one speaker form one unit; "annotation": every annotation is a unit. */
  unit: "turn" | "annotation";
  /** Shortest expression (in tokens) that counts as an instance. */
  minN: number;
  /** Longest expression that is tracked. */
  maxN: number;
  lookBack: LookBack;
}

export const DEFAULT_ALIGNMENT: Omit<AlignmentOptions, "layer" | "tokenizer"> = {
  unit: "turn",
  minN: 1,
  maxN: 8,
  lookBack: { kind: "all" },
};

/** Token flags. */
export const F_ALIGNED = 1;
export const F_SELF = 2;

export interface AlignUnit {
  index: number;
  speaker: string;
  tierId: string;
  start: number;
  end: number;
  tokens: Token[];
  /** Per token: F_ALIGNED and/or F_SELF. */
  flags: Uint8Array;
}

export interface AlignInstance {
  fileId: string;
  unit: number;
  speaker: string;
  /** Token range [from, to) within the unit. */
  from: number;
  to: number;
  expression: string;
  n: number;
  start: number;
  end: number;
  primeSpeaker: string;
  primeUnit: number;
  primeTime: number;
  /** "adoption": the speaker uses this expression for the first time; "reuse": used it before. */
  kind: "adoption" | "reuse";
  /** Distance to the prime in units and in ms. */
  distanceUnits: number;
  distanceMs: number;
}

export interface LexiconEntry {
  expression: string;
  n: number;
  /** Speaker who produced the expression first. */
  initiator: string;
  /** Speaker who first re-used it, and when. */
  establishedBy: string;
  establishedAt: number;
  establishedUnit: number;
  /** Number of alignment instances of this expression. */
  instances: number;
  /** Total productions per speaker (in any context). */
  uses: Record<string, number>;
  firstTime: number;
  lastTime: number;
}

export interface SpeakerMeasures {
  speaker: string;
  units: number;
  tokens: number;
  contentTokens: number;
  /** Alignment instances produced by this speaker (as the one who re-uses). */
  instances: number;
  alignedTokens: number;
  /** Expression repetition: share of the speaker's tokens inside alignment instances. */
  er: number;
  adoptions: number;
  /** Shared expressions this speaker introduced. */
  initiated: number;
  selfTokens: number;
  /** Share of tokens repeating the speaker's own earlier words. */
  ser: number;
}

export interface DirectionMeasures {
  /** Prime speaker → target speaker. */
  from: string;
  to: string;
  pairs: number;
  /** Local linguistic alignment (Fusaroli et al. 2012). */
  lla: number;
  cosine: number;
  jaccard: number;
}

export interface FileAlignment {
  fileId: string;
  fileName: string;
  speakers: string[];
  units: AlignUnit[];
  instances: AlignInstance[];
  lexicon: LexiconEntry[];
  bySpeaker: SpeakerMeasures[];
  directions: DirectionMeasures[];
  overall: {
    tokens: number;
    instances: number;
    alignedTokens: number;
    er: number;
    /** Shared expression lexicon size and variety (lexicon size per token). */
    els: number;
    ev: number;
    meanLength: number;
    maxLength: number;
    /** Shannon entropy (bits) of the lengths of the shared expressions. */
    lengthEntropy: number;
  };
  /** Mean cosine similarity to the unit `lag` units earlier, by another vs. the same speaker. */
  lagProfile: { lag: number; other: number; self: number; nOther: number; nSelf: number }[];
}

export interface AlignmentResult {
  files: FileAlignment[];
  /** Files skipped because the layer has fewer than two speakers there. */
  skipped: string[];
  /** One row per file and speaker. */
  dataset: Dataset;
  /** One row per alignment instance. */
  instanceDataset: Dataset;
  totals: { instances: number; tokens: number; alignedTokens: number; er: number; adoptions: number };
}

interface Occ {
  count: number;
  firstUnit: number;
  firstTime: number;
  lastUnit: number;
  lastTime: number;
}

const SEP = "\u0001";

/** Units of one file: annotations of all speakers in temporal order, optionally merged into turns. */
export function buildUnits(file: CorpusFile, scheme: TierScheme, opts: AlignmentOptions): AlignUnit[] {
  const drop = compileDropPattern(opts.tokenizer.dropPattern);
  const raw: { speaker: string; tierId: string; start: number; end: number; tokens: Token[] }[] = [];
  for (const lt of layerTiers([file], scheme, opts.layer)) {
    const speaker = lt.participant || lt.tier.id;
    for (const a of lt.tier.annotations) {
      const tokens = tokenizeAnnotation(a, opts.tokenizer, drop);
      if (tokens.length === 0) continue;
      raw.push({ speaker, tierId: lt.tier.id, start: a.start, end: a.end, tokens });
    }
  }
  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const units: AlignUnit[] = [];
  for (const r of raw) {
    const last = units[units.length - 1];
    if (opts.unit === "turn" && last && last.speaker === r.speaker) {
      last.tokens.push(...r.tokens);
      last.end = Math.max(last.end, r.end);
    } else {
      units.push({ index: units.length, speaker: r.speaker, tierId: r.tierId, start: r.start, end: r.end, tokens: [...r.tokens], flags: new Uint8Array(0) });
    }
  }
  for (const u of units) u.flags = new Uint8Array(u.tokens.length);
  return units;
}

interface CoreUnit {
  speaker: string;
  start: number;
  tokens: Token[];
  flags?: Uint8Array;
}

interface CoreResult {
  instances: Omit<AlignInstance, "fileId">[];
  /** Per speaker: n-gram → occurrences. */
  index: Map<string, Map<string, Occ>>;
  tokensBySpeaker: Map<string, number>;
  alignedBySpeaker: Map<string, number>;
  selfBySpeaker: Map<string, number>;
}

function withinWindow(lookBack: LookBack, unitIndex: number, unitStart: number, occ: Occ): boolean {
  if (lookBack.kind === "all") return true;
  if (lookBack.kind === "turns") return unitIndex - occ.lastUnit <= lookBack.n;
  return unitStart - occ.lastTime <= lookBack.s * 1000;
}

/** The alignment computation proper, on a sequence of units. */
function alignCore(units: CoreUnit[], opts: AlignmentOptions): CoreResult {
  const index = new Map<string, Map<string, Occ>>();
  const tokensBySpeaker = new Map<string, number>();
  const alignedBySpeaker = new Map<string, number>();
  const selfBySpeaker = new Map<string, number>();
  const instances: Omit<AlignInstance, "fileId">[] = [];
  const maxN = Math.max(opts.maxN, opts.minN);

  units.forEach((u, ui) => {
    const m = u.tokens.length;
    let own = index.get(u.speaker);
    if (!own) index.set(u.speaker, (own = new Map()));
    const others: [string, Map<string, Occ>][] = [];
    for (const [sp, idx] of index) if (sp !== u.speaker) others.push([sp, idx]);
    const covered = new Uint8Array(m);
    const selfCovered = new Uint8Array(m);
    let keptEnd = 0;
    let selfEnd = 0;
    // Keys of all n-grams starting at each position, built incrementally.
    const keysAt: string[][] = new Array(m);
    for (let i = 0; i < m; i++) {
      const keys: string[] = [];
      let key = "";
      for (let L = 1; L <= maxN && i + L <= m; L++) {
        key = L === 1 ? u.tokens[i]!.norm : key + SEP + u.tokens[i + L - 1]!.norm;
        keys.push(key);
      }
      keysAt[i] = keys;
    }
    for (let i = 0; i < m; i++) {
      const keys = keysAt[i]!;
      // Longest n-gram from position i that another speaker produced within the window.
      let bestL = 0;
      let bestOcc: Occ | undefined;
      let bestSpeaker = "";
      for (let L = 1; L <= keys.length; L++) {
        let found: Occ | undefined;
        let foundSpeaker = "";
        for (const [sp, idx] of others) {
          const occ = idx.get(keys[L - 1]!);
          if (occ && withinWindow(opts.lookBack, ui, u.start, occ) && (!found || occ.lastTime > found.lastTime)) {
            found = occ;
            foundSpeaker = sp;
          }
        }
        if (!found) break;
        bestL = L;
        bestOcc = found;
        bestSpeaker = foundSpeaker;
      }
      if (bestL >= opts.minN && bestOcc && i + bestL > keptEnd) {
        let hasContent = false;
        for (let k = i; k < i + bestL; k++) if (!u.tokens[k]!.stop) hasContent = true;
        if (hasContent) {
          keptEnd = i + bestL;
          for (let k = i; k < i + bestL; k++) covered[k] = 1;
          const key = keys[bestL - 1]!;
          instances.push({
            unit: ui,
            speaker: u.speaker,
            from: i,
            to: i + bestL,
            expression: key.split(SEP).join(" "),
            n: bestL,
            start: u.tokens[i]!.start,
            end: u.tokens[i + bestL - 1]!.end,
            primeSpeaker: bestSpeaker,
            primeUnit: bestOcc.lastUnit,
            primeTime: bestOcc.lastTime,
            kind: own.has(key) ? "reuse" : "adoption",
            distanceUnits: ui - bestOcc.lastUnit,
            distanceMs: u.tokens[i]!.start - bestOcc.lastTime,
          });
        }
      }
      // Longest n-gram the speaker has produced before (self-repetition).
      let selfL = 0;
      for (let L = 1; L <= keys.length; L++) {
        const occ = own.get(keys[L - 1]!);
        if (!occ || !withinWindow(opts.lookBack, ui, u.start, occ)) break;
        selfL = L;
      }
      if (selfL >= opts.minN && i + selfL > selfEnd) {
        let hasContent = false;
        for (let k = i; k < i + selfL; k++) if (!u.tokens[k]!.stop) hasContent = true;
        if (hasContent) {
          selfEnd = i + selfL;
          for (let k = i; k < i + selfL; k++) selfCovered[k] = 1;
        }
      }
    }
    let nAligned = 0;
    let nSelf = 0;
    for (let k = 0; k < m; k++) {
      nAligned += covered[k]!;
      nSelf += selfCovered[k]!;
      if (u.flags) u.flags[k] = (covered[k]! ? F_ALIGNED : 0) | (selfCovered[k]! ? F_SELF : 0);
    }
    tokensBySpeaker.set(u.speaker, (tokensBySpeaker.get(u.speaker) ?? 0) + m);
    alignedBySpeaker.set(u.speaker, (alignedBySpeaker.get(u.speaker) ?? 0) + nAligned);
    selfBySpeaker.set(u.speaker, (selfBySpeaker.get(u.speaker) ?? 0) + nSelf);
    // Only now add this unit's n-grams, so that a unit never matches itself.
    for (let i = 0; i < m; i++) {
      const keys = keysAt[i]!;
      const t = u.tokens[i]!.start;
      for (const key of keys) {
        const occ = own.get(key);
        if (occ) {
          occ.count++;
          occ.lastUnit = ui;
          occ.lastTime = t;
        } else own.set(key, { count: 1, firstUnit: ui, firstTime: t, lastUnit: ui, lastTime: t });
      }
    }
  });
  return { instances, index, tokensBySpeaker, alignedBySpeaker, selfBySpeaker };
}

function countVector(tokens: Token[], contentOnly: boolean): Map<string, number> {
  const v = new Map<string, number>();
  for (const t of tokens) {
    if (contentOnly && t.stop) continue;
    v.set(t.norm, (v.get(t.norm) ?? 0) + 1);
  }
  return v;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const w = b.get(k);
    if (w) dot += v * w;
  }
  for (const v of b.values()) nb += v * v;
  return dot / Math.sqrt(na * nb);
}

/** Similarity of a target unit to a prime unit. */
function pairSimilarity(prime: Map<string, number>, target: Map<string, number>): { lla: number; cosine: number; jaccard: number } {
  let primeLen = 0;
  let targetLen = 0;
  let shared = 0;
  let inter = 0;
  for (const v of prime.values()) primeLen += v;
  for (const [k, v] of target) {
    targetLen += v;
    if (prime.has(k)) {
      shared += v;
      inter++;
    }
  }
  const union = prime.size + target.size - inter;
  return {
    // LLA: target tokens that also occur in the prime, normalised by both lengths.
    lla: primeLen > 0 && targetLen > 0 ? shared / (primeLen * targetLen) : NaN,
    cosine: cosine(prime, target),
    jaccard: union > 0 ? inter / union : NaN,
  };
}

function meanOf(xs: number[]): number {
  let s = 0;
  let n = 0;
  for (const x of xs) {
    if (!Number.isNaN(x)) {
      s += x;
      n++;
    }
  }
  return n ? s / n : NaN;
}

function directionMeasures(units: CoreUnit[], contentOnly: boolean): { directions: DirectionMeasures[]; vectors: Map<string, number>[] } {
  const vectors = units.map((u) => countVector(u.tokens, contentOnly));
  const acc = new Map<string, { from: string; to: string; lla: number[]; cos: number[]; jac: number[] }>();
  for (let t = 1; t < units.length; t++) {
    const p = units[t - 1]!;
    const u = units[t]!;
    if (p.speaker === u.speaker) continue;
    const key = `${p.speaker}${SEP}${u.speaker}`;
    let a = acc.get(key);
    if (!a) acc.set(key, (a = { from: p.speaker, to: u.speaker, lla: [], cos: [], jac: [] }));
    const sim = pairSimilarity(vectors[t - 1]!, vectors[t]!);
    a.lla.push(sim.lla);
    a.cos.push(sim.cosine);
    a.jac.push(sim.jaccard);
  }
  const directions = [...acc.values()].map((a) => ({
    from: a.from,
    to: a.to,
    pairs: a.lla.length,
    lla: meanOf(a.lla),
    cosine: meanOf(a.cos),
    jaccard: meanOf(a.jac),
  }));
  return { directions, vectors };
}

function analyseFile(file: CorpusFile, scheme: TierScheme, opts: AlignmentOptions): FileAlignment | undefined {
  const units = buildUnits(file, scheme, opts);
  const speakers = [...new Set(units.map((u) => u.speaker))].sort();
  if (speakers.length < 2) return undefined;
  const core = alignCore(units, opts);
  const instances: AlignInstance[] = core.instances.map((i) => ({ ...i, fileId: file.id }));

  // ---- shared expression lexicon ----------------------------------------------------
  const lex = new Map<string, LexiconEntry>();
  for (const inst of instances) {
    const key = inst.expression.split(" ").join(SEP);
    let e = lex.get(inst.expression);
    if (!e) {
      // The initiator is whoever produced the expression first.
      let initiator = inst.primeSpeaker;
      let firstTime = Infinity;
      let lastTime = -Infinity;
      const uses: Record<string, number> = {};
      for (const [sp, idx] of core.index) {
        const occ = idx.get(key);
        if (!occ) continue;
        uses[sp] = occ.count;
        if (occ.firstTime < firstTime) {
          firstTime = occ.firstTime;
          initiator = sp;
        }
        if (occ.lastTime > lastTime) lastTime = occ.lastTime;
      }
      e = {
        expression: inst.expression, n: inst.n, initiator,
        establishedBy: inst.speaker, establishedAt: inst.start, establishedUnit: inst.unit,
        instances: 0, uses, firstTime, lastTime,
      };
      lex.set(inst.expression, e);
    }
    e.instances++;
  }
  const lexicon = [...lex.values()].sort((a, b) => b.instances - a.instances || b.n - a.n || a.expression.localeCompare(b.expression));

  // ---- per-speaker measures ----------------------------------------------------------
  const bySpeaker: SpeakerMeasures[] = speakers.map((sp) => {
    const tokens = core.tokensBySpeaker.get(sp) ?? 0;
    const aligned = core.alignedBySpeaker.get(sp) ?? 0;
    const self = core.selfBySpeaker.get(sp) ?? 0;
    const mine = instances.filter((i) => i.speaker === sp);
    let content = 0;
    let nUnits = 0;
    for (const u of units) {
      if (u.speaker !== sp) continue;
      nUnits++;
      for (const t of u.tokens) if (!t.stop) content++;
    }
    return {
      speaker: sp,
      units: nUnits,
      tokens,
      contentTokens: content,
      instances: mine.length,
      alignedTokens: aligned,
      er: tokens ? aligned / tokens : NaN,
      adoptions: mine.filter((i) => i.kind === "adoption").length,
      initiated: lexicon.filter((e) => e.initiator === sp).length,
      selfTokens: self,
      ser: tokens ? self / tokens : NaN,
    };
  });

  const contentOnly = opts.tokenizer.stopWords.size > 0;
  const { directions, vectors } = directionMeasures(units, contentOnly);

  // ---- similarity by lag ---------------------------------------------------------------
  const lagProfile: FileAlignment["lagProfile"] = [];
  for (let lag = 1; lag <= 10; lag++) {
    const other: number[] = [];
    const self: number[] = [];
    for (let t = lag; t < units.length; t++) {
      const c = cosine(vectors[t - lag]!, vectors[t]!);
      if (Number.isNaN(c)) continue;
      (units[t - lag]!.speaker === units[t]!.speaker ? self : other).push(c);
    }
    lagProfile.push({ lag, other: meanOf(other), self: meanOf(self), nOther: other.length, nSelf: self.length });
  }

  const totalTokens = bySpeaker.reduce((s, m) => s + m.tokens, 0);
  const alignedTokens = bySpeaker.reduce((s, m) => s + m.alignedTokens, 0);
  const lengthCounts = new Map<number, number>();
  for (const e of lexicon) lengthCounts.set(e.n, (lengthCounts.get(e.n) ?? 0) + 1);
  let entropy = 0;
  for (const c of lengthCounts.values()) {
    const p = c / lexicon.length;
    entropy -= p * Math.log2(p);
  }
  return {
    fileId: file.id,
    fileName: file.name,
    speakers,
    units,
    instances,
    lexicon,
    bySpeaker,
    directions,
    overall: {
      tokens: totalTokens,
      instances: instances.length,
      alignedTokens,
      er: totalTokens ? alignedTokens / totalTokens : NaN,
      els: lexicon.length,
      ev: totalTokens ? lexicon.length / totalTokens : NaN,
      meanLength: instances.length ? instances.reduce((s, i) => s + i.n, 0) / instances.length : NaN,
      maxLength: instances.reduce((s, i) => Math.max(s, i.n), 0),
      lengthEntropy: entropy,
    },
    lagProfile,
  };
}

export function analyseAlignment(files: CorpusFile[], scheme: TierScheme, opts: AlignmentOptions): AlignmentResult {
  const metaVars = listMetaVariables(files);
  const out: FileAlignment[] = [];
  const skipped: string[] = [];
  const rows: Row[] = [];
  const instRows: Row[] = [];
  for (const file of files) {
    const fa = analyseFile(file, scheme, opts);
    if (!fa) {
      skipped.push(file.name);
      continue;
    }
    out.push(fa);
    const meta = metaCells(file, metaVars);
    for (const m of fa.bySpeaker) {
      const dir = fa.directions.find((d) => d.to === m.speaker);
      rows.push({
        file: file.name, ...meta, speaker: m.speaker,
        units: m.units, tokens: m.tokens, content_tokens: m.contentTokens,
        instances: m.instances, aligned_tokens: m.alignedTokens, er: m.er,
        adoptions: m.adoptions, initiated: m.initiated, self_repetition: m.ser,
        lla: dir ? dir.lla : NaN, cosine: dir ? dir.cosine : NaN,
        instances_per_100_tokens: m.tokens ? (100 * m.instances) / m.tokens : NaN,
        lexicon_size: fa.overall.els, lexicon_variety: fa.overall.ev,
        duration_min: file.doc.duration / 60000,
      });
    }
    for (const i of fa.instances) {
      instRows.push({
        file: file.name, ...meta, speaker: i.speaker, prime_speaker: i.primeSpeaker,
        expression: i.expression, n_tokens: i.n, kind: i.kind,
        time_s: i.start / 1000, distance_units: i.distanceUnits, distance_s: i.distanceMs / 1000,
        relative_time: file.doc.duration ? i.start / file.doc.duration : NaN,
      });
    }
  }
  const metaSpec = metaVars.map((v) => ({ name: v, type: "string" as const, label: "file variable" }));
  const dataset = datasetFromRows(
    `Lexical alignment: ${opts.layer}`,
    "one speaker in one file",
    "Alignment measures per speaker and file.",
    rows,
    [
      { name: "file", type: "string" }, ...metaSpec, { name: "speaker", type: "string" },
      { name: "units", type: "number", label: "number of turns / utterances" },
      { name: "tokens", type: "number" }, { name: "content_tokens", type: "number" },
      { name: "instances", type: "number", label: "alignment instances produced by the speaker" },
      { name: "aligned_tokens", type: "number", label: "tokens inside alignment instances" },
      { name: "er", type: "number", label: "expression repetition: aligned tokens / tokens" },
      { name: "adoptions", type: "number", label: "expressions taken over from the partner for the first time" },
      { name: "initiated", type: "number", label: "shared expressions this speaker introduced" },
      { name: "self_repetition", type: "number", label: "share of tokens repeating the speaker's own words" },
      { name: "lla", type: "number", label: "mean local linguistic alignment to the preceding turn of the partner" },
      { name: "cosine", type: "number", label: "mean cosine similarity to the preceding turn of the partner" },
      { name: "instances_per_100_tokens", type: "number" },
      { name: "lexicon_size", type: "number", label: "shared expressions in the dialogue" },
      { name: "lexicon_variety", type: "number", label: "shared expressions per token" },
      { name: "duration_min", type: "number", label: "length of the recording" },
    ],
  );
  const instanceDataset = datasetFromRows(
    `Alignment instances: ${opts.layer}`,
    "one alignment instance",
    "Every re-use of an expression first produced by the other speaker.",
    instRows,
    [
      { name: "file", type: "string" }, ...metaSpec,
      { name: "speaker", type: "string" }, { name: "prime_speaker", type: "string" },
      { name: "expression", type: "string" }, { name: "n_tokens", type: "number" }, { name: "kind", type: "string" },
      { name: "time_s", type: "number" },
      { name: "distance_units", type: "number", label: "turns since the partner last said it" },
      { name: "distance_s", type: "number", label: "seconds since the partner last said it" },
      { name: "relative_time", type: "number", label: "position in the recording (0–1)" },
    ],
  );
  const tokens = out.reduce((s, f) => s + f.overall.tokens, 0);
  const alignedTokens = out.reduce((s, f) => s + f.overall.alignedTokens, 0);
  return {
    files: out,
    skipped,
    dataset,
    instanceDataset,
    totals: {
      instances: out.reduce((s, f) => s + f.overall.instances, 0),
      tokens,
      alignedTokens,
      er: tokens ? alignedTokens / tokens : NaN,
      adoptions: out.reduce((s, f) => s + f.bySpeaker.reduce((t, m) => t + m.adoptions, 0), 0),
    },
  };
}

// ---- chance baselines ---------------------------------------------------------------

export type SurrogateKind = "shuffle" | "fake-pairs";

export interface SurrogateRow {
  fileId: string;
  file: string;
  /** Observed values. */
  er: number;
  cosine: number;
  lla: number;
  /** Surrogate mean and central 95% range. */
  erSurrogate: number;
  erRange: [number, number];
  cosineSurrogate: number;
  cosineRange: [number, number];
  llaSurrogate: number;
}

export interface SurrogateResult {
  kind: SurrogateKind;
  n: number;
  rows: SurrogateRow[];
  dataset: Dataset;
}

function quickMeasures(units: CoreUnit[], opts: AlignmentOptions): { er: number; cosine: number; lla: number } {
  const core = alignCore(units, opts);
  let tokens = 0;
  let aligned = 0;
  for (const v of core.tokensBySpeaker.values()) tokens += v;
  for (const v of core.alignedBySpeaker.values()) aligned += v;
  const { directions } = directionMeasures(units, opts.tokenizer.stopWords.size > 0);
  let cosSum = 0;
  let llaSum = 0;
  let pairs = 0;
  for (const d of directions) {
    if (Number.isNaN(d.cosine)) continue;
    cosSum += d.cosine * d.pairs;
    llaSum += d.lla * d.pairs;
    pairs += d.pairs;
  }
  return { er: tokens ? aligned / tokens : NaN, cosine: pairs ? cosSum / pairs : NaN, lla: pairs ? llaSum / pairs : NaN };
}

/**
 * Chance baselines for alignment.
 *
 * - "shuffle": within each dialogue, every speaker's turns are randomly re-ordered among
 *   that speaker's own slots. Vocabulary and turn structure stay, the temporal order of
 *   what was said is destroyed — a baseline for *local* (turn-by-turn) alignment.
 * - "fake-pairs": each speaker is paired with the same-role speaker of another recording
 *   (Healey, Purver & Howes 2014; Duran et al. 2019): people who did the same task but
 *   never talked to each other — a baseline for vocabulary shared through task and topic.
 */
export function alignmentSurrogates(
  files: CorpusFile[],
  scheme: TierScheme,
  opts: AlignmentOptions,
  kind: SurrogateKind,
  n = 100,
  seed = 1,
): SurrogateResult {
  const rng = new Rng(seed);
  const metaVars = listMetaVariables(files);
  const prepared = files
    .map((file) => ({ file, units: buildUnits(file, scheme, opts) }))
    .filter((p) => new Set(p.units.map((u) => u.speaker)).size >= 2);
  const rows: SurrogateRow[] = [];
  const dsRows: Row[] = [];

  prepared.forEach((p, pi) => {
    const real = quickMeasures(p.units, opts);
    const er = new Float64Array(n);
    const cos = new Float64Array(n);
    const lla = new Float64Array(n);
    const speakers = [...new Set(p.units.map((u) => u.speaker))].sort();
    for (let s = 0; s < n; s++) {
      let surrogate: CoreUnit[];
      if (kind === "shuffle") {
        const pools = new Map<string, Token[][]>();
        for (const u of p.units) {
          let pool = pools.get(u.speaker);
          if (!pool) pools.set(u.speaker, (pool = []));
          pool.push(u.tokens);
        }
        for (const pool of pools.values()) rng.shuffle(pool);
        const cursor = new Map<string, number>();
        surrogate = p.units.map((u) => {
          const k = cursor.get(u.speaker) ?? 0;
          cursor.set(u.speaker, k + 1);
          return { speaker: u.speaker, start: u.start, tokens: pools.get(u.speaker)![k]! };
        });
      } else {
        // Keep the first speaker; take every other speaker's turns from another recording.
        if (prepared.length < 2) {
          surrogate = p.units;
        } else {
          const keep = speakers[0]!;
          let other = rng.int(prepared.length - 1);
          if (other >= pi) other++;
          const donor = prepared[other]!;
          const donorSpeakers = [...new Set(donor.units.map((u) => u.speaker))].sort();
          const donated: CoreUnit[] = [];
          speakers.slice(1).forEach((sp, k) => {
            // Same label if the donor has it, otherwise the speaker in the same position.
            const from = donorSpeakers.includes(sp) ? sp : donorSpeakers[Math.min(k + 1, donorSpeakers.length - 1)]!;
            for (const u of donor.units) if (u.speaker === from) donated.push({ speaker: sp, start: u.start, tokens: u.tokens });
          });
          const own: CoreUnit[] = p.units.filter((u) => u.speaker === keep).map((u) => ({ speaker: u.speaker, start: u.start, tokens: u.tokens }));
          // Interleave by rank so that the turn-taking skeleton is preserved.
          surrogate = [];
          const maxLen = Math.max(own.length, donated.length);
          for (let k = 0; k < maxLen; k++) {
            if (k < own.length) surrogate.push(own[k]!);
            if (k < donated.length) surrogate.push(donated[k]!);
          }
          surrogate.forEach((u, k) => (u.start = k * 1000));
        }
      }
      const m = quickMeasures(surrogate, opts);
      er[s] = m.er;
      cos[s] = m.cosine;
      lla[s] = m.lla;
    }
    const mean = (a: Float64Array) => meanOf(Array.from(a));
    const row: SurrogateRow = {
      fileId: p.file.id,
      file: p.file.name,
      er: real.er,
      cosine: real.cosine,
      lla: real.lla,
      erSurrogate: mean(er),
      erRange: [quantile(er, 0.025), quantile(er, 0.975)],
      cosineSurrogate: mean(cos),
      cosineRange: [quantile(cos, 0.025), quantile(cos, 0.975)],
      llaSurrogate: mean(lla),
    };
    rows.push(row);
    dsRows.push({
      file: p.file.name, ...metaCells(p.file, metaVars),
      er: row.er, er_chance: row.erSurrogate, er_above_chance: row.er - row.erSurrogate,
      cosine: row.cosine, cosine_chance: row.cosineSurrogate, cosine_above_chance: row.cosine - row.cosineSurrogate,
      lla: row.lla, lla_chance: row.llaSurrogate, lla_above_chance: row.lla - row.llaSurrogate,
    });
  });
  const dataset = datasetFromRows(
    `Alignment vs. chance (${kind === "shuffle" ? "shuffled turns" : "fake pairs"})`,
    "one file",
    `Observed alignment and its chance level from ${n} surrogate dialogues per file.`,
    dsRows,
    [
      { name: "file", type: "string" }, ...metaVars.map((v) => ({ name: v, type: "string" as const })),
      { name: "er", type: "number", label: "observed expression repetition" },
      { name: "er_chance", type: "number", label: "mean expression repetition in the surrogates" },
      { name: "er_above_chance", type: "number", label: "observed − chance" },
      { name: "cosine", type: "number" }, { name: "cosine_chance", type: "number" }, { name: "cosine_above_chance", type: "number" },
      { name: "lla", type: "number" }, { name: "lla_chance", type: "number" }, { name: "lla_above_chance", type: "number" },
    ],
  );
  return { kind, n, rows, dataset };
}

/** Alignment instances as annotations, for the timeline overlay and for export to ELAN. */
export function alignmentAnnotations(fa: FileAlignment): Map<string, { start: number; end: number; value: string }[]> {
  const out = new Map<string, { start: number; end: number; value: string }[]>();
  for (const i of fa.instances) {
    let list = out.get(i.speaker);
    if (!list) out.set(i.speaker, (list = []));
    list.push({ start: Math.round(i.start), end: Math.max(Math.round(i.end), Math.round(i.start) + 1), value: `${i.expression} ← ${i.primeSpeaker}` });
  }
  for (const list of out.values()) list.sort((a, b) => a.start - b.start);
  return out;
}
