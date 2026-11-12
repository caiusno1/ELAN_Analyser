import { layerTiers, listMetaVariables, type CorpusFile, type TierScheme } from "../corpus/corpus.ts";
import { datasetFromRows, type Dataset, type Row } from "../data/dataset.ts";
import { totalDuration, unionIntervals, type Interval } from "../intervals.ts";
import { gammaInv } from "../stats/distributions.ts";
import { lgamma, logSumExp } from "../stats/special.ts";
import { compileFilter, metaCells, type ValueFilter } from "./common.ts";

/**
 * Temporal structure of an event stream: is behaviour spread evenly, or does it come in
 * bursts? Does its rate change during the recording, and when?
 */

export interface Burstiness {
  n: number;
  /** Mean and SD of the inter-event intervals (ms). */
  meanInterval: number;
  sdInterval: number;
  /** Coefficient of variation; 1 for a Poisson process. */
  cv: number;
  /** Burstiness parameter B = (σ − μ)/(σ + μ) (Goh & Barabási 2008): −1 regular, 0 random, → 1 bursty. */
  b: number;
  /** B corrected for the finite number of events (Kim & Jo 2016). */
  bCorrected: number;
  /** Memory coefficient: correlation between consecutive inter-event intervals. */
  memory: number;
}

export function burstiness(times: ArrayLike<number>): Burstiness {
  const n = times.length;
  if (n < 3) return { n, meanInterval: NaN, sdInterval: NaN, cv: NaN, b: NaN, bCorrected: NaN, memory: NaN };
  const iei = new Float64Array(n - 1);
  for (let i = 1; i < n; i++) iei[i - 1] = times[i]! - times[i - 1]!;
  const m = iei.length;
  let mu = 0;
  for (let i = 0; i < m; i++) mu += iei[i]!;
  mu /= m;
  let v = 0;
  for (let i = 0; i < m; i++) v += (iei[i]! - mu) ** 2;
  const sigma = Math.sqrt(v / m);
  const r = mu > 0 ? sigma / mu : NaN;
  const b = (sigma - mu) / (sigma + mu);
  // After Kim & Jo (2016): rescaled so that the most bursty sequence possible with m
  // intervals (all but one of them zero) gets exactly 1, and a regular one −1.
  const sn1 = Math.sqrt(m + 1);
  const sn2 = Math.sqrt(m - 1);
  const bCorrected = (sn1 * r - sn2) / ((sn1 - 2) * r + sn2);
  // Memory: Pearson correlation of (τ_i, τ_{i+1}).
  let memory = NaN;
  if (m >= 3) {
    let m1 = 0;
    let m2 = 0;
    for (let i = 0; i < m - 1; i++) {
      m1 += iei[i]!;
      m2 += iei[i + 1]!;
    }
    m1 /= m - 1;
    m2 /= m - 1;
    let s12 = 0;
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < m - 1; i++) {
      s12 += (iei[i]! - m1) * (iei[i + 1]! - m2);
      s1 += (iei[i]! - m1) ** 2;
      s2 += (iei[i + 1]! - m2) ** 2;
    }
    memory = s1 > 0 && s2 > 0 ? s12 / Math.sqrt(s1 * s2) : NaN;
  }
  return { n, meanInterval: mu, sdInterval: sigma, cv: r, b, bCorrected, memory };
}

export interface AllanPoint {
  /** Window size in ms. */
  window: number;
  /** Allan factor; 1 for a Poisson process, growing with window size for clustered events. */
  af: number;
  windows: number;
}

/**
 * Allan factor AF(T) = ⟨(N_{k+1} − N_k)²⟩ / (2⟨N_k⟩) over adjacent windows of length T
 * (Abney, Paxton, Dale & Kello 2014). A power-law increase with T indicates clustering
 * across time scales; `slope` is its exponent, fitted on the log–log curve.
 */
export function allanFactor(times: ArrayLike<number>, duration: number, nScales = 12): { points: AllanPoint[]; slope: number } {
  const n = times.length;
  const points: AllanPoint[] = [];
  if (n < 8 || !(duration > 0)) return { points, slope: NaN };
  const minW = Math.max(duration / (n * 2), 100);
  const maxW = duration / 8;
  if (!(maxW > minW)) return { points, slope: NaN };
  for (let s = 0; s < nScales; s++) {
    const w = minW * Math.pow(maxW / minW, s / (nScales - 1));
    const k = Math.floor(duration / w);
    if (k < 4) continue;
    const counts = new Float64Array(k);
    for (let i = 0; i < n; i++) {
      const b = Math.floor(times[i]! / w);
      if (b >= 0 && b < k) counts[b] = counts[b]! + 1;
    }
    let diff2 = 0;
    let mean = 0;
    for (let b = 0; b < k; b++) mean += counts[b]!;
    mean /= k;
    for (let b = 0; b + 1 < k; b++) diff2 += (counts[b + 1]! - counts[b]!) ** 2;
    diff2 /= k - 1;
    if (mean > 0) points.push({ window: w, af: diff2 / (2 * mean), windows: k });
  }
  // Least-squares slope of log AF on log T.
  const usable = points.filter((p) => p.af > 0);
  let slope = NaN;
  if (usable.length >= 3) {
    const lx = usable.map((p) => Math.log(p.window));
    const ly = usable.map((p) => Math.log(p.af));
    const mx = lx.reduce((s, v) => s + v, 0) / lx.length;
    const my = ly.reduce((s, v) => s + v, 0) / ly.length;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < lx.length; i++) {
      sxy += (lx[i]! - mx) * (ly[i]! - my);
      sxx += (lx[i]! - mx) ** 2;
    }
    slope = sxx > 0 ? sxy / sxx : NaN;
  }
  return { points, slope };
}

export interface ChangePointResult {
  /** Candidate change times (ms) and their posterior probability. */
  times: Float64Array;
  posterior: Float64Array;
  /** Posterior mode and central 95% interval of the change time. */
  mode: number;
  ci: [number, number];
  /** ln BF of "one change in rate" over "constant rate". */
  logBf10: number;
  /** Posterior mean rates (events per minute) before and after the change. */
  rateBefore: number;
  rateAfter: number;
  /** Overall rate (events per minute). */
  rate: number;
}

/**
 * Bayesian single change-point analysis of an event rate. Events are a Poisson process
 * whose rate is constant (H0) or switches once at an unknown time τ (H1, τ uniform).
 * Rates get a Gamma(1, T/N) prior, i.e. an exponential prior centred on the overall rate.
 */
export function changePoint(times: ArrayLike<number>, duration: number, grid = 400): ChangePointResult | undefined {
  const n = times.length;
  if (n < 4 || !(duration > 0)) return undefined;
  const a = 1;
  const b = duration / n;
  // ln ∫ λ^k e^{−λ d} Gamma(λ; a, b) dλ
  const logM = (k: number, d: number) => a * Math.log(b) + lgamma(k + a) - lgamma(a) - (k + a) * Math.log(b + d);
  const ts = new Float64Array(grid);
  const lp = new Float64Array(grid);
  let idx = 0;
  for (let g = 0; g < grid; g++) {
    const tau = ((g + 0.5) / grid) * duration;
    while (idx < n && times[idx]! <= tau) idx++;
    ts[g] = tau;
    lp[g] = logM(idx, tau) + logM(n - idx, duration - tau);
  }
  const norm = logSumExp(lp);
  const posterior = new Float64Array(grid);
  let mode = 0;
  let cum = 0;
  let lo = ts[0]!;
  let hi = ts[grid - 1]!;
  let rateBefore = 0;
  let rateAfter = 0;
  let loSet = false;
  let hiSet = false;
  idx = 0;
  for (let g = 0; g < grid; g++) {
    const p = Math.exp(lp[g]! - norm);
    posterior[g] = p;
    if (p > posterior[mode]!) mode = g;
    cum += p;
    if (!loSet && cum >= 0.025) {
      lo = ts[g]!;
      loSet = true;
    }
    if (!hiSet && cum >= 0.975) {
      hi = ts[g]!;
      hiSet = true;
    }
    while (idx < n && times[idx]! <= ts[g]!) idx++;
    rateBefore += p * ((idx + a) / (b + ts[g]!));
    rateAfter += p * ((n - idx + a) / (b + duration - ts[g]!));
  }
  return {
    times: ts,
    posterior,
    mode: ts[mode]!,
    ci: [lo, hi],
    logBf10: norm - Math.log(grid) - logM(n, duration),
    rateBefore: rateBefore * 60000,
    rateAfter: rateAfter * 60000,
    rate: (n / duration) * 60000,
  };
}

export interface Block {
  start: number;
  end: number;
  events: number;
  /** Events per minute. */
  rate: number;
}

/**
 * Bayesian Blocks (Scargle, Norris, Jackson & Chiang 2013): the most probable piecewise
 * constant rate for a stream of events. The prior on the number of blocks is geometric;
 * `p0` is the paper's calibration of that prior (roughly the chance of a spurious change
 * point in pure noise).
 */
export function bayesianBlocks(times: ArrayLike<number>, duration: number, p0 = 0.05): Block[] {
  const n = times.length;
  if (n === 0) return [{ start: 0, end: duration, events: 0, rate: 0 }];
  // Cell edges: the recording limits and the midpoints between events.
  const edges = new Float64Array(n + 1);
  edges[0] = 0;
  for (let i = 1; i < n; i++) edges[i] = 0.5 * (times[i - 1]! + times[i]!);
  edges[n] = Math.max(duration, times[n - 1]!);
  const ncpPrior = 4 - Math.log(73.53 * p0 * Math.pow(n, -0.478));
  const best = new Float64Array(n);
  const last = new Int32Array(n);
  for (let r = 0; r < n; r++) {
    let bestVal = -Infinity;
    let bestIdx = 0;
    for (let k = 0; k <= r; k++) {
      // Block made of cells k..r.
      const width = edges[r + 1]! - edges[k]!;
      const count = r - k + 1;
      const fit = width > 0 ? count * (Math.log(count) - Math.log(width)) : -Infinity;
      const val = fit - ncpPrior + (k > 0 ? best[k - 1]! : 0);
      if (val > bestVal) {
        bestVal = val;
        bestIdx = k;
      }
    }
    best[r] = bestVal;
    last[r] = bestIdx;
  }
  const starts: number[] = [];
  let r = n - 1;
  while (r >= 0) {
    starts.push(last[r]!);
    r = last[r]! - 1;
  }
  starts.reverse();
  const blocks: Block[] = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s]!;
    const to = s + 1 < starts.length ? starts[s + 1]! : n;
    const start = edges[from]!;
    const end = edges[to]!;
    const events = to - from;
    blocks.push({ start, end, events, rate: end > start ? (events / (end - start)) * 60000 : NaN });
  }
  return blocks;
}

export interface TemporalOptions {
  layer: string;
  filter?: ValueFilter;
  participants?: ReadonlySet<string>;
  /** Width of the bins of the activity curve, in ms. */
  bin: number;
}

export interface TierTemporal {
  fileId: string;
  fileName: string;
  tierId: string;
  participant: string;
  duration: number;
  /** Event onsets (ms). */
  times: Float64Array;
  burst: Burstiness;
  allan: { points: AllanPoint[]; slope: number };
  change: ChangePointResult | undefined;
  blocks: Block[];
  /** Activity per bin: number of onsets and share of the bin covered by annotations. */
  activity: { start: number; count: number; coverage: number }[];
}

export interface TemporalResult {
  tiers: TierTemporal[];
  /** Mean rate (events/min, with 95% credible band) by decile of the recording, pooled over tiers. */
  timeCourse: { from: number; to: number; rate: number; lower: number; upper: number }[];
  dataset: Dataset;
  error?: string;
}

function coverageInBins(cov: Interval[], bin: number, nBins: number): Float64Array {
  const out = new Float64Array(nBins);
  for (const c of cov) {
    let b = Math.max(0, Math.floor(c.start / bin));
    while (b < nBins && b * bin < c.end) {
      const s = Math.max(c.start, b * bin);
      const e = Math.min(c.end, (b + 1) * bin);
      if (e > s) out[b] = out[b]! + (e - s) / bin;
      b++;
    }
  }
  return out;
}

export function analyseTemporal(files: CorpusFile[], scheme: TierScheme, opts: TemporalOptions): TemporalResult {
  const { test, error } = compileFilter(opts.filter);
  const metaVars = listMetaVariables(files);
  const tiers: TierTemporal[] = [];
  const rows: Row[] = [];
  const decEvents = new Float64Array(10);
  const decExposure = new Float64Array(10);
  const tierOpts = opts.participants ? { participants: opts.participants } : {};
  for (const lt of layerTiers(files, scheme, opts.layer, tierOpts)) {
    const anns = lt.tier.annotations.filter((a) => test(a.value));
    const T = lt.file.doc.duration;
    if (anns.length === 0 || T <= 0) continue;
    const times = Float64Array.from(anns, (a) => a.start);
    const burst = burstiness(times);
    const allan = allanFactor(times, T);
    const change = changePoint(times, T);
    const blocks = bayesianBlocks(times, T);
    const nBins = Math.max(1, Math.ceil(T / opts.bin));
    const counts = new Float64Array(nBins);
    for (const t of times) counts[Math.min(nBins - 1, Math.floor(t / opts.bin))] += 1;
    const cov = coverageInBins(unionIntervals(anns), opts.bin, nBins);
    const activity = Array.from({ length: nBins }, (_, b) => ({ start: b * opts.bin, count: counts[b]!, coverage: Math.min(1, cov[b]!) }));
    for (const t of times) decEvents[Math.min(9, Math.floor((t / T) * 10))] += 1;
    for (let d = 0; d < 10; d++) decExposure[d] = decExposure[d]! + T / 10;
    tiers.push({ fileId: lt.file.id, fileName: lt.file.name, tierId: lt.tier.id, participant: lt.participant, duration: T, times, burst, allan, change, blocks, activity });
    rows.push({
      file: lt.file.name, ...metaCells(lt.file, metaVars), participant: lt.participant, tier: lt.tier.id,
      n: anns.length, rate_per_min: (anns.length / T) * 60000,
      coverage: totalDuration(unionIntervals(anns)) / T,
      mean_interval_s: burst.meanInterval / 1000, cv_interval: burst.cv,
      burstiness: burst.b, burstiness_corrected: burst.bCorrected, memory: burst.memory,
      allan_slope: allan.slope,
      change_log_bf: change ? change.logBf10 : NaN,
      change_time_rel: change ? change.mode / T : NaN,
      rate_before: change ? change.rateBefore : NaN,
      rate_after: change ? change.rateAfter : NaN,
      blocks: blocks.length,
      duration_min: T / 60000,
    });
  }
  const timeCourse: TemporalResult["timeCourse"] = [];
  for (let d = 0; d < 10; d++) {
    const exposureMin = decExposure[d]! / 60000;
    const k = decEvents[d]!;
    timeCourse.push({
      from: d / 10,
      to: (d + 1) / 10,
      rate: exposureMin > 0 ? k / exposureMin : NaN,
      lower: exposureMin > 0 ? gammaInv(0.025, k + 0.5, exposureMin) : NaN,
      upper: exposureMin > 0 ? gammaInv(0.975, k + 0.5, exposureMin) : NaN,
    });
  }
  const dataset = datasetFromRows(
    `Temporal structure: ${opts.layer}`,
    "one tier",
    "Burstiness, clustering and rate changes of the events on each tier.",
    rows,
    [
      { name: "file", type: "string" }, ...metaVars.map((v) => ({ name: v, type: "string" as const, label: "file variable" })),
      { name: "participant", type: "string" }, { name: "tier", type: "string" },
      { name: "n", type: "number" }, { name: "rate_per_min", type: "number" }, { name: "coverage", type: "number" },
      { name: "mean_interval_s", type: "number", label: "mean time between onsets" },
      { name: "cv_interval", type: "number", label: "coefficient of variation of the intervals (1 = Poisson)" },
      { name: "burstiness", type: "number", label: "B of Goh & Barabási (−1 regular … 0 random … 1 bursty)" },
      { name: "burstiness_corrected", type: "number", label: "B corrected for the number of events (Kim & Jo)" },
      { name: "memory", type: "number", label: "correlation of consecutive intervals" },
      { name: "allan_slope", type: "number", label: "exponent of the Allan factor curve (0 = no clustering)" },
      { name: "change_log_bf", type: "number", label: "ln BF for one change in rate vs. constant rate" },
      { name: "change_time_rel", type: "number", label: "most probable change time (0–1 of the recording)" },
      { name: "rate_before", type: "number" }, { name: "rate_after", type: "number" },
      { name: "blocks", type: "number", label: "number of Bayesian blocks" },
      { name: "duration_min", type: "number" },
    ],
  );
  const result: TemporalResult = { tiers, timeCourse, dataset };
  if (error) result.error = error;
  return result;
}
