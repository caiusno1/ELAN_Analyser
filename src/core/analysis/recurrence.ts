import { layerTiers, listMetaVariables, type CorpusFile, type LayerTier, type TierScheme } from "../corpus/corpus.ts";
import { datasetFromRows, type Dataset, type Row } from "../data/dataset.ts";
import { sampleIndices } from "../intervals.ts";
import { compileDropPattern, tokenizeAnnotation, type TokenizerOptions } from "../text/tokenize.ts";
import { compileFilter, DEFAULT_NORMALIZATION, metaCells, normalizeValue, type ValueFilter } from "./common.ts";
import { pairTiers, type Pairing } from "./cooccurrence.ts";

/**
 * Categorical (cross-)recurrence quantification (Dale & Spivey 2006; Coco & Dale 2014).
 *
 * Two symbol sequences x and y recur at (i, j) when x_i = y_j. The share of recurrent
 * points along each diagonal j − i = lag gives the diagonal cross-recurrence profile:
 * a peak right of zero means that y tends to repeat what x did a little earlier
 * (x leads), a peak left of zero the opposite.
 */

export interface RecurrenceOptions {
  layerX: string;
  layerY: string;
  filterX?: ValueFilter;
  filterY?: ValueFilter;
  pairing: Pairing;
  /**
   * "events": one symbol per annotation (or per word, if a tokenizer is given);
   * "time": the tier is sampled every `step` ms and stretches without annotation count as "none".
   */
  unit: "events" | "time";
  /** Sampling step in ms for unit "time". */
  step: number;
  tokenizer?: TokenizerOptions;
  /** Half-width of the diagonal band that is analysed, in units (events or samples). */
  maxLag: number;
  /** Shortest diagonal line that counts as deterministic structure. */
  minLine: number;
  /** In "time" mode: do two simultaneous "none" samples count as recurrence? */
  matchNone: boolean;
}

export const DEFAULT_RECURRENCE: Omit<RecurrenceOptions, "layerX" | "layerY"> = {
  pairing: "other",
  unit: "events",
  step: 250,
  maxLag: 20,
  minLine: 2,
  matchNone: false,
};

export interface RecurrencePair {
  fileId: string;
  fileName: string;
  xTier: string;
  yTier: string;
  xLabel: string;
  yLabel: string;
  nx: number;
  ny: number;
  /** Symbols as integers (−1 = none) and their labels, for plotting. */
  x: Int32Array;
  y: Int32Array;
  symbols: string[];
  /** Start time (ms) of each element, for jumping from the plot to the timeline. */
  xTimes: Float64Array;
  yTimes: Float64Array;
  /** Recurrence rate within the band, and its chance level Σ p_x(s)·p_y(s). */
  rr: number;
  expectedRr: number;
  /** Share of recurrent points on diagonal lines of at least `minLine` points. */
  det: number;
  meanLine: number;
  maxLine: number;
  /** Shannon entropy (bits) of the line-length distribution. */
  entropy: number;
  /** Recurrence rate by lag (y index − x index). */
  profile: { lag: number; rr: number }[];
  /** Lag with the highest recurrence, and (RR at positive lags − RR at negative lags). */
  peakLag: number;
  asymmetry: number;
}

export interface RecurrenceResult {
  pairs: RecurrencePair[];
  /** Profile averaged over all tier pairs. */
  meanProfile: { lag: number; rr: number; expected: number }[];
  dataset: Dataset;
  /** Duration of one lag unit in ms ("time" mode) or undefined ("events" mode). */
  lagUnitMs?: number;
  error?: string;
}

interface Series {
  symbols: string[];
  times: number[];
}

function seriesOf(lt: LayerTier, opts: RecurrenceOptions, test: (v: string) => boolean): Series {
  const anns = lt.tier.annotations.filter((a) => test(a.value));
  if (opts.unit === "time") {
    const n = Math.max(0, Math.floor(lt.file.doc.duration / opts.step));
    const idx = sampleIndices(anns, opts.step / 2, opts.step, n);
    const symbols: string[] = [];
    const times: number[] = [];
    for (let k = 0; k < n; k++) {
      symbols.push(idx[k]! === -1 ? "" : normalizeValue(anns[idx[k]!]!.value, DEFAULT_NORMALIZATION));
      times.push(opts.step / 2 + k * opts.step);
    }
    return { symbols, times };
  }
  const symbols: string[] = [];
  const times: number[] = [];
  if (opts.tokenizer) {
    const drop = compileDropPattern(opts.tokenizer.dropPattern);
    for (const a of anns) {
      for (const t of tokenizeAnnotation(a, opts.tokenizer, drop)) {
        if (t.stop) continue;
        symbols.push(t.norm);
        times.push(t.start);
      }
    }
  } else {
    for (const a of anns) {
      symbols.push(normalizeValue(a.value, DEFAULT_NORMALIZATION));
      times.push(a.start);
    }
  }
  return { symbols, times };
}

export function analyseRecurrence(files: CorpusFile[], scheme: TierScheme, opts: RecurrenceOptions): RecurrenceResult {
  const fx = compileFilter(opts.filterX);
  const fy = compileFilter(opts.filterY);
  const xs = layerTiers(files, scheme, opts.layerX);
  const ys = layerTiers(files, scheme, opts.layerY);
  // With the same layer on both axes, "other" pairs each ordered pair of participants once per direction.
  const tierPairs = opts.layerX === opts.layerY && opts.pairing === "same"
    ? xs.map((_, i) => [i, i] as [number, number])
    : pairTiers(xs, ys, opts.pairing);
  const metaVars = listMetaVariables(files);
  const W = opts.maxLag;
  const pairs: RecurrencePair[] = [];
  const rows: Row[] = [];
  const profSum = new Float64Array(2 * W + 1);
  const profN = new Float64Array(2 * W + 1);
  let expectedSum = 0;

  for (const [i, j] of tierPairs) {
    const X = xs[i]!;
    const Y = ys[j]!;
    const sx = seriesOf(X, opts, fx.test);
    const sy = seriesOf(Y, opts, fy.test);
    if (sx.symbols.length < 2 || sy.symbols.length < 2) continue;
    const auto = X.tier.id === Y.tier.id;
    const symbolIndex = new Map<string, number>();
    const symbols: string[] = [];
    const encode = (s: string): number => {
      if (s === "") return opts.matchNone ? intern("(none)") : -1;
      return intern(s);
    };
    const intern = (s: string): number => {
      let k = symbolIndex.get(s);
      if (k === undefined) {
        k = symbols.length;
        symbols.push(s);
        symbolIndex.set(s, k);
      }
      return k;
    };
    const x = Int32Array.from(sx.symbols, encode);
    const y = Int32Array.from(sy.symbols, encode);
    const nx = x.length;
    const ny = y.length;

    // Chance level of a match between a random x and a random y element.
    const px = new Float64Array(symbols.length);
    const py = new Float64Array(symbols.length);
    for (let k = 0; k < nx; k++) if (x[k]! >= 0) px[x[k]!] = px[x[k]!]! + 1 / nx;
    for (let k = 0; k < ny; k++) if (y[k]! >= 0) py[y[k]!] = py[y[k]!]! + 1 / ny;
    let expectedRr = 0;
    for (let s = 0; s < symbols.length; s++) expectedRr += px[s]! * py[s]!;

    // Scan every diagonal of the band.
    const profile: { lag: number; rr: number }[] = [];
    let points = 0;
    let cells = 0;
    let onLines = 0;
    let lineCount = 0;
    let lineSum = 0;
    let maxLine = 0;
    const lineHist = new Map<number, number>();
    for (let lag = -W; lag <= W; lag++) {
      if (auto && lag === 0) {
        profile.push({ lag, rr: NaN }); // the line of identity is trivial
        continue;
      }
      let rec = 0;
      let n = 0;
      let run = 0;
      const from = Math.max(0, -lag);
      const to = Math.min(nx, ny - lag);
      const closeRun = () => {
        if (run >= opts.minLine) {
          onLines += run;
          lineCount++;
          lineSum += run;
          if (run > maxLine) maxLine = run;
          lineHist.set(run, (lineHist.get(run) ?? 0) + 1);
        }
        run = 0;
      };
      for (let a = from; a < to; a++) {
        n++;
        if (x[a]! >= 0 && x[a] === y[a + lag]) {
          rec++;
          run++;
        } else closeRun();
      }
      closeRun();
      points += rec;
      cells += n;
      profile.push({ lag, rr: n ? rec / n : NaN });
      if (n) {
        profSum[lag + W] = profSum[lag + W]! + rec / n;
        profN[lag + W] = profN[lag + W]! + 1;
      }
    }
    let entropy = 0;
    for (const c of lineHist.values()) {
      const p = c / lineCount;
      entropy -= p * Math.log2(p);
    }
    let peakLag = 0;
    let peak = -1;
    let pos = 0;
    let neg = 0;
    let nPos = 0;
    let nNeg = 0;
    for (const p of profile) {
      if (Number.isNaN(p.rr)) continue;
      if (p.rr > peak) {
        peak = p.rr;
        peakLag = p.lag;
      }
      if (p.lag > 0) {
        pos += p.rr;
        nPos++;
      } else if (p.lag < 0) {
        neg += p.rr;
        nNeg++;
      }
    }
    const pair: RecurrencePair = {
      fileId: X.file.id,
      fileName: X.file.name,
      xTier: X.tier.id,
      yTier: Y.tier.id,
      xLabel: X.participant || X.tier.id,
      yLabel: Y.participant || Y.tier.id,
      nx,
      ny,
      x,
      y,
      symbols,
      xTimes: Float64Array.from(sx.times),
      yTimes: Float64Array.from(sy.times),
      rr: cells ? points / cells : NaN,
      expectedRr,
      det: points ? onLines / points : NaN,
      meanLine: lineCount ? lineSum / lineCount : NaN,
      maxLine,
      entropy,
      profile,
      peakLag,
      asymmetry: (nPos ? pos / nPos : 0) - (nNeg ? neg / nNeg : 0),
    };
    pairs.push(pair);
    expectedSum += expectedRr;
    rows.push({
      file: X.file.name, ...metaCells(X.file, metaVars),
      x_tier: X.tier.id, y_tier: Y.tier.id, x_participant: X.participant, y_participant: Y.participant,
      n_x: nx, n_y: ny, recurrence_rate: pair.rr, chance_rate: expectedRr,
      log_ratio: pair.rr > 0 && expectedRr > 0 ? Math.log(pair.rr / expectedRr) : NaN,
      determinism: pair.det, mean_line: pair.meanLine, max_line: pair.maxLine, line_entropy: pair.entropy,
      peak_lag: pair.peakLag, asymmetry: pair.asymmetry,
    });
  }
  const meanProfile: RecurrenceResult["meanProfile"] = [];
  for (let lag = -W; lag <= W; lag++) {
    meanProfile.push({
      lag,
      rr: profN[lag + W]! ? profSum[lag + W]! / profN[lag + W]! : NaN,
      expected: pairs.length ? expectedSum / pairs.length : NaN,
    });
  }
  const dataset = datasetFromRows(
    `Recurrence: ${opts.layerX} × ${opts.layerY}`,
    "one pair of tiers",
    "Cross-recurrence measures within the diagonal band.",
    rows,
    [
      { name: "file", type: "string" }, ...metaVars.map((v) => ({ name: v, type: "string" as const, label: "file variable" })),
      { name: "x_tier", type: "string" }, { name: "y_tier", type: "string" },
      { name: "x_participant", type: "string" }, { name: "y_participant", type: "string" },
      { name: "n_x", type: "number" }, { name: "n_y", type: "number" },
      { name: "recurrence_rate", type: "number" }, { name: "chance_rate", type: "number", label: "recurrence expected from the value frequencies alone" },
      { name: "log_ratio", type: "number", label: "ln(recurrence rate / chance rate)" },
      { name: "determinism", type: "number", label: "share of recurrent points on diagonal lines" },
      { name: "mean_line", type: "number" }, { name: "max_line", type: "number" }, { name: "line_entropy", type: "number" },
      { name: "peak_lag", type: "number", label: "lag of maximal recurrence (positive: X leads)" },
      { name: "asymmetry", type: "number", label: "mean RR at positive minus negative lags" },
    ],
  );
  const result: RecurrenceResult = { pairs, meanProfile, dataset };
  if (opts.unit === "time") result.lagUnitMs = opts.step;
  const error = fx.error ?? fy.error;
  if (error) result.error = error;
  return result;
}
