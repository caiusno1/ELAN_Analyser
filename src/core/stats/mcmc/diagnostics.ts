import { quantile, ranks } from "../describe.ts";
import { normalInv } from "../distributions.ts";

/**
 * Convergence diagnostics after Vehtari, Gelman, Simpson, Carpenter & Bürkner (2021):
 * rank-normalised split-R̂ and bulk/tail effective sample sizes.
 */

/** Split every chain in half (dropping one draw if the length is odd). */
function splitChains(chains: ArrayLike<number>[]): Float64Array[] {
  const out: Float64Array[] = [];
  for (const c of chains) {
    const half = Math.floor(c.length / 2);
    if (half < 2) continue;
    const a = new Float64Array(half);
    const b = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      a[i] = c[i]!;
      b[i] = c[c.length - half + i]!;
    }
    out.push(a, b);
  }
  return out;
}

/** Replace values by normal scores of their pooled ranks. */
function rankNormalize(chains: Float64Array[]): Float64Array[] {
  const total = chains.reduce((s, c) => s + c.length, 0);
  const pooled = new Float64Array(total);
  let pos = 0;
  for (const c of chains) {
    pooled.set(c, pos);
    pos += c.length;
  }
  const r = ranks(pooled);
  const out: Float64Array[] = [];
  pos = 0;
  for (const c of chains) {
    const z = new Float64Array(c.length);
    for (let i = 0; i < c.length; i++) z[i] = normalInv((r[pos + i]! - 0.375) / (total + 0.25));
    out.push(z);
    pos += c.length;
  }
  return out;
}

function chainMoments(chains: Float64Array[]): { means: number[]; vars: number[]; n: number } {
  const n = chains[0]!.length;
  const means: number[] = [];
  const vars: number[] = [];
  for (const c of chains) {
    let m = 0;
    for (let i = 0; i < n; i++) m += c[i]!;
    m /= n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (c[i]! - m) * (c[i]! - m);
    means.push(m);
    vars.push(v / (n - 1));
  }
  return { means, vars, n };
}

function rhatBasic(chains: Float64Array[]): number {
  const m = chains.length;
  if (m < 2) return NaN;
  const { means, vars, n } = chainMoments(chains);
  const grand = means.reduce((s, v) => s + v, 0) / m;
  let b = 0;
  for (const mu of means) b += (mu - grand) * (mu - grand);
  b = (n * b) / (m - 1);
  const w = vars.reduce((s, v) => s + v, 0) / m;
  if (w === 0) return b === 0 ? 1 : Infinity;
  const varPlus = ((n - 1) / n) * w + b / n;
  return Math.sqrt(varPlus / w);
}

/** Effective sample size of (already split) chains by Geyer's initial monotone sequence. */
function essBasic(chains: Float64Array[]): number {
  const m = chains.length;
  if (m === 0) return NaN;
  const { means, vars, n } = chainMoments(chains);
  const total = m * n;
  const w = vars.reduce((s, v) => s + v, 0) / m;
  let varPlus = ((n - 1) / n) * w;
  if (m > 1) {
    const grand = means.reduce((s, v) => s + v, 0) / m;
    let b = 0;
    for (const mu of means) b += (mu - grand) * (mu - grand);
    varPlus += b / (m - 1);
  }
  if (!(varPlus > 0)) return total;
  // Mean autocovariance across chains at a given lag, computed on demand.
  const acov = (lag: number): number => {
    let s = 0;
    for (let c = 0; c < m; c++) {
      const x = chains[c]!;
      const mu = means[c]!;
      let a = 0;
      for (let i = 0; i + lag < n; i++) a += (x[i]! - mu) * (x[i + lag]! - mu);
      s += a / n;
    }
    return s / m;
  };
  const rho = (lag: number) => 1 - (w - acov(lag)) / varPlus;
  let tau = 0;
  let prevPair = Infinity;
  for (let t = 0; t + 1 < n; t += 2) {
    const r0 = t === 0 ? 1 : rho(t);
    const r1 = rho(t + 1);
    let pair = r0 + r1;
    if (pair < 0) break;
    if (pair > prevPair) pair = prevPair; // enforce monotone decrease
    prevPair = pair;
    tau += 2 * pair;
  }
  tau -= 1;
  // Guard against super-efficient estimates blowing up (Stan caps at N·log10(N)).
  const ess = total / Math.max(tau, 1 / Math.log10(total));
  return ess;
}

export interface Convergence {
  rhat: number;
  essBulk: number;
  essTail: number;
}

/** Diagnostics for one scalar quantity given its draws from each chain. */
export function convergence(chains: ArrayLike<number>[]): Convergence {
  const split = splitChains(chains);
  if (split.length === 0) return { rhat: NaN, essBulk: NaN, essTail: NaN };
  let constant = true;
  const first = split[0]![0]!;
  for (const c of split) for (let i = 0; i < c.length && constant; i++) if (c[i]! !== first) constant = false;
  if (constant) return { rhat: NaN, essBulk: NaN, essTail: NaN };

  const z = rankNormalize(split);
  // Folded draws detect chains that differ in scale rather than location.
  const pooled: number[] = [];
  for (const c of split) for (let i = 0; i < c.length; i++) pooled.push(c[i]!);
  const med = quantile(pooled, 0.5);
  const folded = rankNormalize(split.map((c) => c.map((v) => Math.abs(v - med))));
  const rhat = Math.max(rhatBasic(z), rhatBasic(folded));
  const essBulk = essBasic(z);
  const q05 = quantile(pooled, 0.05);
  const q95 = quantile(pooled, 0.95);
  const lower = split.map((c) => c.map((v) => (v <= q05 ? 1 : 0)));
  const upper = split.map((c) => c.map((v) => (v >= q95 ? 1 : 0)));
  const essTail = Math.min(essBasic(lower), essBasic(upper));
  return { rhat, essBulk, essTail };
}

/** Effective sample size of a single series (used to correct the bridge sampler). */
export function effectiveSampleSize(chains: ArrayLike<number>[]): number {
  const split = splitChains(chains);
  return split.length ? essBasic(split) : NaN;
}
