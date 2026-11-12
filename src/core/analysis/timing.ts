import { layerTiers, listMetaVariables, type CorpusFile, type TierScheme } from "../corpus/corpus.ts";
import { datasetFromRows, type Dataset, type Row } from "../data/dataset.ts";
import { lowerBoundStart, unionIntervals } from "../intervals.ts";
import { summarize } from "../stats/describe.ts";
import { betaInv } from "../stats/distributions.ts";
import { compileFilter, DEFAULT_NORMALIZATION, metaCells, normalizeValue, type ValueFilter } from "./common.ts";
import { pairTiers, type Pairing } from "./cooccurrence.ts";

/**
 * Timing of one kind of event relative to another: how long before or after a reference
 * event (e.g. a gesture stroke onset) does a target event (e.g. the onset of the word it
 * depicts, or the partner's response) occur? This is the cross-correlogram of two event
 * streams, a standard tool in neuroscience that is rarely applied to annotation data.
 */

export type Anchor = "start" | "end" | "middle";

export interface LagOptions {
  /** Reference events. */
  layerX: string;
  filterX?: ValueFilter;
  anchorX: Anchor;
  /** Target events. */
  layerY: string;
  filterY?: ValueFilter;
  anchorY: Anchor;
  pairing: Pairing;
  /**
   * "all": every target within the window of every reference (cross-correlogram);
   * "nearest": the closest target of each reference; "next": the first target after it.
   */
  mode: "all" | "nearest" | "next";
  /** Half-width of the window in ms. */
  window: number;
  /** Histogram bin width in ms. */
  binWidth: number;
}

export interface LagBin {
  from: number;
  to: number;
  count: number;
  /** Count expected if targets were unrelated to the reference events. */
  expected: number;
}

export interface LagResult {
  /** Target time minus reference time (ms). */
  lags: Float64Array;
  bins: LagBin[];
  references: number;
  /** References with at least one target in the window. */
  referencesWithTarget: number;
  targets: number;
  summary: {
    n: number;
    mean: number;
    median: number;
    sd: number;
    q1: number;
    q3: number;
    /** Share of lags below zero (target precedes reference). */
    shareBefore: number;
  };
  /** One row per lag. */
  dataset: Dataset;
  /** Sample of instances for browsing. */
  instances: { fileId: string; refTime: number; targetTime: number; lag: number; xValue: string; yValue: string; xTier: string; yTier: string }[];
  error?: string;
}

function anchorTime(a: { start: number; end: number }, anchor: Anchor): number {
  return anchor === "start" ? a.start : anchor === "end" ? a.end : (a.start + a.end) / 2;
}

export function analyseLags(files: CorpusFile[], scheme: TierScheme, opts: LagOptions): LagResult {
  const fx = compileFilter(opts.filterX);
  const fy = compileFilter(opts.filterY);
  const xs = layerTiers(files, scheme, opts.layerX);
  const ys = layerTiers(files, scheme, opts.layerY);
  const pairs = pairTiers(xs, ys, opts.pairing);
  const metaVars = listMetaVariables(files);
  const W = opts.window;
  const nBins = Math.max(1, Math.round((2 * W) / opts.binWidth));
  const width = (2 * W) / nBins;
  const counts = new Float64Array(nBins);
  const expected = new Float64Array(nBins);
  const lags: number[] = [];
  const rows: Row[] = [];
  const instances: LagResult["instances"] = [];
  let references = 0;
  let withTarget = 0;
  let targets = 0;

  for (const [i, j] of pairs) {
    const X = xs[i]!;
    const Y = ys[j]!;
    const T = X.file.doc.duration;
    const refs = X.tier.annotations.filter((a) => fx.test(a.value)).map((a) => ({ t: anchorTime(a, opts.anchorX), v: a.value }));
    const tg = Y.tier.annotations
      .filter((a) => fy.test(a.value))
      .map((a) => ({ start: anchorTime(a, opts.anchorY), end: 0, v: a.value }))
      .sort((p, q) => p.start - q.start);
    references += refs.length;
    targets += tg.length;
    const meta = metaCells(X.file, metaVars);
    // Chance level: targets spread evenly over the recording.
    const rate = T > 0 ? tg.length / T : 0;
    if (opts.mode === "all") for (let b = 0; b < nBins; b++) expected[b] = expected[b]! + refs.length * rate * width;
    for (const r of refs) {
      const lo = lowerBoundStart(tg, r.t - W);
      const found: number[] = [];
      if (opts.mode === "all") {
        for (let k = lo; k < tg.length && tg[k]!.start <= r.t + W; k++) found.push(k);
      } else if (opts.mode === "nearest") {
        let best = -1;
        for (let k = lo; k < tg.length && tg[k]!.start <= r.t + W; k++) {
          if (best === -1 || Math.abs(tg[k]!.start - r.t) < Math.abs(tg[best]!.start - r.t)) best = k;
        }
        if (best !== -1) found.push(best);
      } else {
        const k = lowerBoundStart(tg, r.t);
        // "next" excludes a target at exactly the reference time on the same tier.
        let q = k;
        while (q < tg.length && tg[q]!.start === r.t && X.tier.id === Y.tier.id) q++;
        if (q < tg.length && tg[q]!.start <= r.t + W) found.push(q);
      }
      if (found.length) withTarget++;
      for (const k of found) {
        const lag = tg[k]!.start - r.t;
        if (X.tier.id === Y.tier.id && lag === 0) continue; // an event is not its own target
        lags.push(lag);
        const b = Math.min(nBins - 1, Math.max(0, Math.floor((lag + W) / width)));
        counts[b] = counts[b]! + 1;
        rows.push({
          file: X.file.name, ...meta,
          x_participant: X.participant, y_participant: Y.participant,
          x_value: normalizeValue(r.v, DEFAULT_NORMALIZATION), y_value: normalizeValue(tg[k]!.v, DEFAULT_NORMALIZATION),
          lag_ms: lag, reference_time_s: r.t / 1000,
        });
        if (instances.length < 3000) {
          instances.push({
            fileId: X.file.id, refTime: r.t, targetTime: tg[k]!.start, lag,
            xValue: r.v, yValue: tg[k]!.v, xTier: X.tier.id, yTier: Y.tier.id,
          });
        }
      }
    }
  }
  const arr = Float64Array.from(lags);
  const s = summarize(arr);
  const bins: LagBin[] = [];
  for (let b = 0; b < nBins; b++) bins.push({ from: -W + b * width, to: -W + (b + 1) * width, count: counts[b]!, expected: expected[b]! });
  const dataset = datasetFromRows(
    `Timing: ${opts.layerY} relative to ${opts.layerX}`,
    "one target event near one reference event",
    `Lag from ${opts.anchorX} of “${opts.layerX}” to ${opts.anchorY} of “${opts.layerY}” (negative: target first).`,
    rows,
    [
      { name: "file", type: "string" }, ...metaVars.map((v) => ({ name: v, type: "string" as const, label: "file variable" })),
      { name: "x_participant", type: "string" }, { name: "y_participant", type: "string" },
      { name: "x_value", type: "string" }, { name: "y_value", type: "string" },
      { name: "lag_ms", type: "number", label: "target time − reference time" },
      { name: "reference_time_s", type: "number" },
    ],
  );
  const result: LagResult = {
    lags: arr,
    bins,
    references,
    referencesWithTarget: withTarget,
    targets,
    summary: { n: s.n, mean: s.mean, median: s.median, sd: s.sd, q1: s.q1, q3: s.q3, shareBefore: s.n ? lags.filter((l) => l < 0).length / s.n : NaN },
    dataset,
    instances,
  };
  const error = fx.error ?? fy.error;
  if (error) result.error = error;
  return result;
}

export interface StateProfileOptions {
  /** Reference events. */
  layerX: string;
  filterX?: ValueFilter;
  anchorX: Anchor;
  /** State tier: is an annotation (matching the filter) present? */
  layerY: string;
  filterY?: ValueFilter;
  pairing: Pairing;
  /** Half-width of the window and time step, in ms. */
  window: number;
  step: number;
}

export interface StateProfile {
  /** Time offsets relative to the reference event (ms). */
  t: Float64Array;
  /** Share of reference events at which the state is present at each offset. */
  p: Float64Array;
  /** 95% credible band (Jeffreys prior), treating reference events as independent. */
  lower: Float64Array;
  upper: Float64Array;
  /** Overall share of time in the state (the level expected without any coupling). */
  baseline: number;
  references: number;
  error?: string;
}

/**
 * Event-locked state probability: e.g. the probability that the speaker is gazing at the
 * partner as a function of time relative to the end of their turn (Kendon 1967).
 */
export function stateProfile(files: CorpusFile[], scheme: TierScheme, opts: StateProfileOptions): StateProfile {
  const fx = compileFilter(opts.filterX);
  const fy = compileFilter(opts.filterY);
  const xs = layerTiers(files, scheme, opts.layerX);
  const ys = layerTiers(files, scheme, opts.layerY);
  const pairs = pairTiers(xs, ys, opts.pairing);
  const nSteps = Math.floor((2 * opts.window) / opts.step) + 1;
  const t = new Float64Array(nSteps);
  for (let k = 0; k < nSteps; k++) t[k] = -opts.window + k * opts.step;
  const hits = new Float64Array(nSteps);
  const valid = new Float64Array(nSteps);
  let references = 0;
  let stateTime = 0;
  let totalTime = 0;
  for (const [i, j] of pairs) {
    const X = xs[i]!;
    const Y = ys[j]!;
    const T = X.file.doc.duration;
    const cov = unionIntervals(Y.tier.annotations.filter((a) => fy.test(a.value)));
    for (const c of cov) stateTime += c.end - c.start;
    totalTime += T;
    const refs = X.tier.annotations.filter((a) => fx.test(a.value)).map((a) => anchorTime(a, opts.anchorX));
    references += refs.length;
    for (const r of refs) {
      // Walk the coverage once per reference; offsets are increasing.
      let c = Math.max(0, lowerBoundStart(cov, r - opts.window) - 1);
      for (let k = 0; k < nSteps; k++) {
        const at = r + t[k]!;
        if (at < 0 || at > T) continue;
        while (c < cov.length && cov[c]!.end <= at) c++;
        valid[k] = valid[k]! + 1;
        if (c < cov.length && cov[c]!.start <= at) hits[k] = hits[k]! + 1;
      }
    }
  }
  const p = new Float64Array(nSteps);
  const lower = new Float64Array(nSteps);
  const upper = new Float64Array(nSteps);
  for (let k = 0; k < nSteps; k++) {
    const n = valid[k]!;
    const h = hits[k]!;
    p[k] = n > 0 ? h / n : NaN;
    lower[k] = n > 0 ? betaInv(0.025, h + 0.5, n - h + 0.5) : NaN;
    upper[k] = n > 0 ? betaInv(0.975, h + 0.5, n - h + 0.5) : NaN;
  }
  const result: StateProfile = { t, p, lower, upper, baseline: totalTime > 0 ? stateTime / totalTime : NaN, references };
  const error = fx.error ?? fy.error;
  if (error) result.error = error;
  return result;
}
