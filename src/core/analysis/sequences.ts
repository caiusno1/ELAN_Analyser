import { layerTiers, type CorpusFile, type TierScheme } from "../corpus/corpus.ts";
import { datasetFromRows, type Dataset, type Row } from "../data/dataset.ts";
import { betaInv, betaSf } from "../stats/distributions.ts";
import { lgamma, logSumExp } from "../stats/special.ts";
import { compileFilter, DEFAULT_NORMALIZATION, normalizeValue, sortedByCount, type ValueFilter, type ValueNormalization } from "./common.ts";

/**
 * Sequential structure of annotation values: which value follows which. Events from one
 * or more layers are merged into one stream per file, ordered by onset.
 */

export interface SequenceOptions {
  layers: string[];
  /**
   * "tier": every tier is a sequence of its own (what one participant does next);
   * "file": all selected tiers of a file are merged into one stream, ordered by onset
   * (who does what after whom).
   */
  stream: "tier" | "file";
  filter?: ValueFilter;
  normalization?: ValueNormalization;
  /** Prefix each label with the participant (A:nod) so that who did it is part of the event. */
  labelParticipant: boolean;
  /** Treat immediate repetitions of the same label as one event. */
  collapseRepeats: boolean;
  /** Start a new sequence when the silence between two events exceeds this many ms (0 = never). */
  breakGap: number;
}

export interface EventItem {
  label: string;
  start: number;
  end: number;
  tierId: string;
}

export interface SequenceResult {
  /** Labels, most frequent first. */
  symbols: string[];
  counts: number[];
  /** Per file: list of uninterrupted sequences. */
  sequences: { fileId: string; fileName: string; runs: EventItem[][] }[];
  /** transitions[i][j]: how often symbol j directly follows symbol i. */
  transitions: number[][];
  totalEvents: number;
  totalTransitions: number;
  error?: string;
}

export function buildSequences(files: CorpusFile[], scheme: TierScheme, opts: SequenceOptions): SequenceResult {
  const { test, error } = compileFilter(opts.filter);
  const norm = opts.normalization ?? DEFAULT_NORMALIZATION;
  const multiLayer = opts.layers.length > 1;
  const sequences: SequenceResult["sequences"] = [];
  const countMap = new Map<string, number>();
  let totalEvents = 0;
  for (const file of files) {
    const streams: EventItem[][] = [];
    const merged: EventItem[] = [];
    for (const layer of opts.layers) {
      for (const lt of layerTiers([file], scheme, layer)) {
        const events: EventItem[] = opts.stream === "tier" ? [] : merged;
        for (const a of lt.tier.annotations) {
          if (!test(a.value)) continue;
          let label = normalizeValue(a.value, norm);
          if (multiLayer) label = `${layer}=${label}`;
          if (opts.labelParticipant && lt.participant) label = `${lt.participant}:${label}`;
          events.push({ label, start: a.start, end: a.end, tierId: lt.tier.id });
        }
        if (opts.stream === "tier" && events.length) streams.push(events);
      }
    }
    if (opts.stream === "file" && merged.length) streams.push(merged);
    if (streams.length === 0) continue;
    const runs: EventItem[][] = [];
    for (const events of streams) {
      events.sort((a, b) => a.start - b.start || a.end - b.end);
      let cur: EventItem[] = [];
      let lastEnd = -Infinity;
      for (const e of events) {
        if (cur.length && opts.breakGap > 0 && e.start - lastEnd > opts.breakGap) {
          runs.push(cur);
          cur = [];
        }
        if (opts.collapseRepeats && cur.length && cur[cur.length - 1]!.label === e.label) {
          cur[cur.length - 1] = { ...cur[cur.length - 1]!, end: Math.max(cur[cur.length - 1]!.end, e.end) };
        } else cur.push(e);
        lastEnd = Math.max(lastEnd, e.end);
      }
      if (cur.length) runs.push(cur);
    }
    for (const run of runs) for (const e of run) {
      countMap.set(e.label, (countMap.get(e.label) ?? 0) + 1);
      totalEvents++;
    }
    sequences.push({ fileId: file.id, fileName: file.name, runs });
  }
  const symbols = sortedByCount(countMap);
  const index = new Map(symbols.map((s, i) => [s, i]));
  const k = symbols.length;
  const transitions = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  let totalTransitions = 0;
  for (const f of sequences) {
    for (const run of f.runs) {
      for (let i = 1; i < run.length; i++) {
        const a = index.get(run[i - 1]!.label)!;
        const b = index.get(run[i]!.label)!;
        transitions[a]![b] = transitions[a]![b]! + 1;
        totalTransitions++;
      }
    }
  }
  const result: SequenceResult = { symbols, counts: symbols.map((s) => countMap.get(s)!), sequences, transitions, totalEvents, totalTransitions };
  if (error) result.error = error;
  return result;
}

export interface NGramRow {
  gram: string[];
  count: number;
  /** Number of files in which the n-gram occurs. */
  files: number;
  /** First occurrence, for jumping to an example. */
  example: { fileId: string; start: number; end: number };
}

export function ngrams(result: SequenceResult, n: number, minCount = 1): NGramRow[] {
  const acc = new Map<string, NGramRow & { fileSet: Set<string> }>();
  for (const f of result.sequences) {
    for (const run of f.runs) {
      for (let i = 0; i + n <= run.length; i++) {
        const gram = run.slice(i, i + n).map((e) => e.label);
        const key = gram.join("\u0001");
        let row = acc.get(key);
        if (!row) {
          row = { gram, count: 0, files: 0, fileSet: new Set(), example: { fileId: f.fileId, start: run[i]!.start, end: run[i + n - 1]!.end } };
          acc.set(key, row);
        }
        row.count++;
        row.fileSet.add(f.fileId);
      }
    }
  }
  return [...acc.values()]
    .filter((r) => r.count >= minCount)
    .map((r) => ({ gram: r.gram, count: r.count, files: r.fileSet.size, example: r.example }))
    .sort((a, b) => b.count - a.count || a.gram.join(" ").localeCompare(b.gram.join(" ")));
}

export interface TransitionCell {
  from: string;
  to: string;
  count: number;
  /** Posterior mean and 95% credible interval of P(to | from) with a Dirichlet(1) prior on each row. */
  probability: number;
  ci: [number, number];
  /** Unconditional probability of `to` being the next event. */
  baseRate: number;
  /** probability / baseRate. */
  lift: number;
  /** Posterior probability that P(to | from) exceeds the base rate. */
  pAboveBase: number;
}

/** Transition probabilities with credible intervals (a Bayesian take on lag-sequential analysis). */
export function transitionTable(result: SequenceResult): TransitionCell[] {
  const k = result.symbols.length;
  const colTotals = new Array<number>(k).fill(0);
  let total = 0;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
    colTotals[j] = colTotals[j]! + result.transitions[i]![j]!;
    total += result.transitions[i]![j]!;
  }
  const cells: TransitionCell[] = [];
  for (let i = 0; i < k; i++) {
    const rowTotal = result.transitions[i]!.reduce((s, v) => s + v, 0);
    if (rowTotal === 0) continue;
    for (let j = 0; j < k; j++) {
      const c = result.transitions[i]![j]!;
      const a = c + 1;
      const b = rowTotal - c + (k - 1);
      const base = total > 0 ? colTotals[j]! / total : NaN;
      const probability = a / (a + b);
      cells.push({
        from: result.symbols[i]!,
        to: result.symbols[j]!,
        count: c,
        probability,
        ci: [betaInv(0.025, a, b), betaInv(0.975, a, b)],
        baseRate: base,
        lift: base > 0 ? probability / base : NaN,
        pAboveBase: base > 0 && base < 1 ? betaSf(base, a, b) : NaN,
      });
    }
  }
  return cells;
}

export interface MarkovOrderResult {
  order: number;
  /** ln marginal likelihood with a symmetric Dirichlet(alpha) prior on every row. */
  logMarginal: number;
  /** Posterior probability among the compared orders (equal prior odds). */
  posterior: number;
  /** Number of free parameters. */
  parameters: number;
}

/**
 * Bayesian comparison of Markov orders (Strelioff, Crutchfield & Hübler 2007): order 0
 * means events are independent draws, order 1 that the next event depends on the current
 * one, and so on. All orders are scored on the same events (those with a full context of
 * `maxOrder` predecessors).
 */
export function markovOrders(result: SequenceResult, maxOrder = 2, alpha = 1): MarkovOrderResult[] {
  const k = result.symbols.length;
  if (k < 2) return [];
  const index = new Map(result.symbols.map((s, i) => [s, i]));
  const logMl: number[] = [];
  for (let order = 0; order <= maxOrder; order++) {
    const contexts = new Map<string, Float64Array>();
    for (const f of result.sequences) {
      for (const run of f.runs) {
        for (let i = maxOrder; i < run.length; i++) {
          let ctx = "";
          for (let o = order; o >= 1; o--) ctx += `${index.get(run[i - o]!.label)!},`;
          let row = contexts.get(ctx);
          if (!row) contexts.set(ctx, (row = new Float64Array(k)));
          const s = index.get(run[i]!.label)!;
          row[s] = row[s]! + 1;
        }
      }
    }
    let lm = 0;
    for (const row of contexts.values()) {
      let n = 0;
      for (let s = 0; s < k; s++) {
        n += row[s]!;
        lm += lgamma(row[s]! + alpha) - lgamma(alpha);
      }
      lm += lgamma(k * alpha) - lgamma(n + k * alpha);
    }
    logMl.push(lm);
  }
  const norm = logSumExp(logMl);
  return logMl.map((lm, order) => ({
    order,
    logMarginal: lm,
    posterior: Math.exp(lm - norm),
    parameters: Math.pow(k, order) * (k - 1),
  }));
}

/** P(`to` occurs exactly `lag` events after `from`), for lag 1..maxLag, with the base rate. */
export function lagProfile(result: SequenceResult, from: string, to: string, maxLag = 8): { lag: number; probability: number; n: number }[] {
  const out: { lag: number; probability: number; n: number }[] = [];
  for (let lag = 1; lag <= maxLag; lag++) {
    let hits = 0;
    let n = 0;
    for (const f of result.sequences) {
      for (const run of f.runs) {
        for (let i = 0; i + lag < run.length; i++) {
          if (run[i]!.label !== from) continue;
          n++;
          if (run[i + lag]!.label === to) hits++;
        }
      }
    }
    out.push({ lag, probability: n ? hits / n : NaN, n });
  }
  return out;
}

/** Shannon entropy (bits) of the event distribution and of the next event given the current one. */
export function sequenceEntropy(result: SequenceResult): { entropy: number; conditional: number; maxEntropy: number } {
  const total = result.counts.reduce((s, v) => s + v, 0);
  let h = 0;
  for (const c of result.counts) {
    if (c > 0) h -= (c / total) * Math.log2(c / total);
  }
  let hc = 0;
  const tTotal = result.totalTransitions;
  for (const row of result.transitions) {
    const rowTotal = row.reduce((s, v) => s + v, 0);
    for (const c of row) {
      if (c > 0) hc -= (c / tTotal) * Math.log2(c / rowTotal);
    }
  }
  return { entropy: h, conditional: tTotal ? hc : NaN, maxEntropy: Math.log2(Math.max(result.symbols.length, 1)) };
}

/** Transitions as a dataset (one row per ordered pair of events). */
export function transitionDataset(result: SequenceResult, name: string): Dataset {
  const rows: Row[] = transitionTable(result).map((c) => ({
    from: c.from, to: c.to, count: c.count, probability: c.probability,
    ci_lower: c.ci[0], ci_upper: c.ci[1], base_rate: c.baseRate, lift: c.lift, p_above_base: c.pAboveBase,
  }));
  return datasetFromRows(name, "one ordered pair of event types", "Transition counts and probabilities.", rows, [
    { name: "from", type: "string" }, { name: "to", type: "string" }, { name: "count", type: "number" },
    { name: "probability", type: "number", label: "posterior mean of P(to | from)" },
    { name: "ci_lower", type: "number" }, { name: "ci_upper", type: "number" },
    { name: "base_rate", type: "number", label: "share of all transitions that lead to this event" },
    { name: "lift", type: "number", label: "probability / base rate" },
    { name: "p_above_base", type: "number", label: "posterior probability that the transition is more likely than the base rate" },
  ]);
}
