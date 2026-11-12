import { median, variance } from "../describe.ts";
import { cholesky, forwardSolve, type Matrix } from "../linalg.ts";
import { Rng } from "../rng.ts";
import { effectiveSampleSize } from "./diagnostics.ts";

/**
 * Bridge sampling estimate of the log marginal likelihood (Meng & Wong 1996; Gronau et
 * al. 2017), with a multivariate normal proposal fitted to the first half of each chain
 * and the iterative scheme run on the second half — the "normal" method of the R package
 * bridgesampling.
 */

export interface BridgeResult {
  /** ln p(y | model). */
  logMarginal: number;
  iterations: number;
  converged: boolean;
  /** Approximate coefficient of variation of the marginal likelihood estimate. */
  cv: number;
}

export function bridgeSample(
  logDensity: (theta: Float64Array) => number,
  /** Unconstrained draws per chain, each row-major with `dim` columns. */
  chains: Float64Array[],
  dim: number,
  opts: { seed?: number; maxIterations?: number; tolerance?: number } = {},
): BridgeResult {
  const rng = new Rng(opts.seed ?? 7);
  const fit: Float64Array[] = [];
  const iter: Float64Array[] = [];
  const iterPerChain: number[] = [];
  for (const c of chains) {
    const s = c.length / dim;
    const half = Math.floor(s / 2);
    for (let i = 0; i < half; i++) fit.push(c.subarray(i * dim, (i + 1) * dim));
    for (let i = half; i < s; i++) iter.push(c.subarray(i * dim, (i + 1) * dim));
    iterPerChain.push(s - half);
  }
  const nFit = fit.length;
  const n1 = iter.length;
  if (nFit < 10 || n1 < 10) return { logMarginal: NaN, iterations: 0, converged: false, cv: NaN };

  // ---- proposal: mean and covariance of the fitting half ------------------------------
  const mu = new Float64Array(dim);
  for (const d of fit) for (let j = 0; j < dim; j++) mu[j] = mu[j]! + d[j]! / nFit;
  const useFull = nFit >= 5 * dim;
  let chol: Matrix | undefined;
  const cov: Matrix = Array.from({ length: dim }, () => new Array<number>(dim).fill(0));
  for (const d of fit) {
    for (let a = 0; a < dim; a++) {
      const da = d[a]! - mu[a]!;
      if (useFull) for (let b = 0; b <= a; b++) cov[a]![b] = cov[a]![b]! + da * (d[b]! - mu[b]!);
      else cov[a]![a] = cov[a]![a]! + da * da;
    }
  }
  for (let a = 0; a < dim; a++) {
    for (let b = 0; b <= a; b++) {
      cov[a]![b] = cov[a]![b]! / (nFit - 1);
      cov[b]![a] = cov[a]![b]!;
    }
    if (!(cov[a]![a]! > 0)) cov[a]![a] = 1e-12;
  }
  chol = cholesky(cov);
  if (!chol) {
    for (let a = 0; a < dim; a++) for (let b = 0; b < dim; b++) if (a !== b) cov[a]![b] = 0;
    chol = cholesky(cov)!;
  }
  let logDet = 0;
  for (let a = 0; a < dim; a++) logDet += Math.log(chol[a]![a]!);
  const logNorm = -0.5 * dim * Math.log(2 * Math.PI) - logDet;
  const proposalLogPdf = (x: ArrayLike<number>): number => {
    const diff = new Array<number>(dim);
    for (let j = 0; j < dim; j++) diff[j] = x[j]! - mu[j]!;
    const w = forwardSolve(chol!, diff);
    let q = 0;
    for (let j = 0; j < dim; j++) q += w[j]! * w[j]!;
    return logNorm - 0.5 * q;
  };

  // ---- evaluate both densities at posterior and proposal draws -----------------------
  const n2 = n1;
  const l1 = new Float64Array(n1);
  const scratch = new Float64Array(dim);
  for (let i = 0; i < n1; i++) {
    scratch.set(iter[i]!);
    l1[i] = logDensity(scratch) - proposalLogPdf(scratch);
  }
  const l2 = new Float64Array(n2);
  const z = new Array<number>(dim);
  for (let i = 0; i < n2; i++) {
    for (let j = 0; j < dim; j++) z[j] = rng.normal();
    // x = mu + L z
    for (let a = 0; a < dim; a++) {
      let s = mu[a]!;
      const row = chol[a]!;
      for (let b = 0; b <= a; b++) s += row[b]! * z[b]!;
      scratch[a] = s;
    }
    const lp = logDensity(scratch);
    let q = 0;
    for (let j = 0; j < dim; j++) q += z[j]! * z[j]!;
    l2[i] = (Number.isFinite(lp) ? lp : -Infinity) - (logNorm - 0.5 * q);
  }

  // ---- effective number of posterior draws ----------------------------------------------
  const perChain: Float64Array[] = [];
  let pos = 0;
  for (const len of iterPerChain) {
    perChain.push(l1.subarray(pos, pos + len));
    pos += len;
  }
  let neff = effectiveSampleSize(perChain);
  if (!Number.isFinite(neff) || neff <= 0) neff = n1;
  neff = Math.min(neff, n1);
  const s1 = neff / (neff + n2);
  const s2 = n2 / (neff + n2);

  // ---- iterative scheme -------------------------------------------------------------------
  const lstar = median(l1);
  const e1 = new Float64Array(n1);
  const e2 = new Float64Array(n2);
  for (let i = 0; i < n1; i++) e1[i] = Math.exp(l1[i]! - lstar);
  for (let i = 0; i < n2; i++) e2[i] = Math.exp(l2[i]! - lstar);
  let r = 1;
  let iterations = 0;
  let converged = false;
  const maxIterations = opts.maxIterations ?? 1000;
  const tol = opts.tolerance ?? 1e-10;
  for (; iterations < maxIterations; iterations++) {
    let num = 0;
    for (let i = 0; i < n2; i++) num += e2[i]! / (s1 * e2[i]! + s2 * r);
    let den = 0;
    for (let i = 0; i < n1; i++) den += 1 / (s1 * e1[i]! + s2 * r);
    const rNew = (num / n2) / (den / n1);
    if (!Number.isFinite(rNew) || rNew <= 0) break;
    const change = Math.abs(rNew - r) / rNew;
    r = rNew;
    if (change < tol) {
      converged = true;
      iterations++;
      break;
    }
  }
  const logMarginal = Math.log(r) + lstar;

  // ---- approximate relative error (Frühwirth-Schnatter 2004) ----------------------------
  const f1 = new Float64Array(n2);
  for (let i = 0; i < n2; i++) {
    const p = e2[i]! / r; // normalised posterior / proposal
    f1[i] = p / (s1 * p + s2);
  }
  const f2 = new Float64Array(n1);
  for (let i = 0; i < n1; i++) {
    const p = e1[i]! / r;
    f2[i] = 1 / (s1 * p + s2);
  }
  const meanOf = (a: Float64Array) => a.reduce((s, v) => s + v, 0) / a.length;
  const m1 = meanOf(f1);
  const m2 = meanOf(f2);
  const f2Chains: Float64Array[] = [];
  pos = 0;
  for (const len of iterPerChain) {
    f2Chains.push(f2.subarray(pos, pos + len));
    pos += len;
  }
  let essF2 = effectiveSampleSize(f2Chains);
  if (!Number.isFinite(essF2) || essF2 <= 0) essF2 = n1;
  const re2 = variance(f1) / (m1 * m1) / n2 + variance(f2) / (m2 * m2) / Math.min(essF2, n1);
  return { logMarginal, iterations, converged, cv: Math.sqrt(re2) };
}
