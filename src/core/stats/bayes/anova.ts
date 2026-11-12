import { mean, variance } from "../describe.ts";
import { tInv } from "../distributions.ts";
import { helmertBasis, matMul, matVec, symEig, transpose, zeros } from "../linalg.ts";
import { integrateInf } from "../quadrature.ts";
import { DEFAULT_EFFECT_PRIOR, tTestBayesFactors, twoSampleStats } from "./ttest.ts";

/**
 * Bayesian one-way ANOVA with the JZS prior of Rouder, Morey, Speckman & Province (2012).
 *
 * Model: y_ij = μ + σ·d_j + ε, with the standardized effects d projected onto the
 * sum-to-zero subspace and given d* | g ~ N(0, g·I), g ~ Inverse-Gamma(1/2, r²/2);
 * p(μ, σ²) ∝ 1/σ². The Bayes factor against the intercept-only model is a
 * one-dimensional integral over g, evaluated exactly (also for unbalanced designs).
 */

export interface GroupStats {
  label: string;
  n: number;
  mean: number;
  sd: number;
  /** 95% credible interval of the group mean under a reference prior (each group alone). */
  ci: [number, number];
}

export interface OneWayStats {
  groups: GroupStats[];
  n: number;
  grandMean: number;
  ssBetween: number;
  ssWithin: number;
  ssTotal: number;
  /** Proportion of variance explained (η²). */
  r2: number;
  f: number;
  dfBetween: number;
  dfWithin: number;
}

export function oneWayStats(groups: ArrayLike<number>[], labels?: string[]): OneWayStats {
  let n = 0;
  let total = 0;
  for (const g of groups) {
    n += g.length;
    for (let i = 0; i < g.length; i++) total += g[i]!;
  }
  const grandMean = total / n;
  let ssBetween = 0;
  let ssWithin = 0;
  const stats: GroupStats[] = groups.map((g, j) => {
    const m = mean(g);
    const v = g.length > 1 ? variance(g) : 0;
    ssBetween += g.length * (m - grandMean) * (m - grandMean);
    ssWithin += (g.length - 1) * v;
    const sd = Math.sqrt(v);
    const half = g.length > 1 ? (tInv(0.975, g.length - 1) * sd) / Math.sqrt(g.length) : NaN;
    return { label: labels?.[j] ?? String(j + 1), n: g.length, mean: m, sd, ci: [m - half, m + half] };
  });
  const dfBetween = groups.length - 1;
  const dfWithin = n - groups.length;
  const ssTotal = ssBetween + ssWithin;
  return {
    groups: stats,
    n,
    grandMean,
    ssBetween,
    ssWithin,
    ssTotal,
    r2: ssTotal > 0 ? ssBetween / ssTotal : 0,
    f: ssBetween / dfBetween / (ssWithin / dfWithin),
    dfBetween,
    dfWithin,
  };
}

/** ln BF10 for the effect of the grouping factor; `rscale` 0.5 = "medium", 1 = "ultrawide". */
export function anovaLogBf10(stats: OneWayStats, rscale = 0.5): number {
  const a = stats.groups.length;
  const N = stats.n;
  if (a < 2 || stats.ssTotal <= 0) return 0;
  const q = helmertBasis(a);
  const qt = transpose(q);
  // S = Qᵀ (D − n nᵀ/N) Q : cross-product of the centred, projected design matrix.
  const m = zeros(a, a);
  for (let i = 0; i < a; i++) {
    for (let j = 0; j < a; j++) {
      const ni = stats.groups[i]!.n;
      const nj = stats.groups[j]!.n;
      m[i]![j] = (i === j ? ni : 0) - (ni * nj) / N;
    }
  }
  const s = matMul(matMul(qt, m), q);
  const b = stats.groups.map((g) => g.n * (g.mean - stats.grandMean));
  const w = matVec(qt, b);
  const { values: lambda, vectors } = symEig(s);
  const u = matVec(transpose(vectors), w);
  const sst = stats.ssTotal;

  const logBfGivenG = (g: number): number => {
    let logDet = 0;
    let quad = 0;
    for (let i = 0; i < lambda.length; i++) {
      const l = Math.max(lambda[i]!, 0);
      logDet += Math.log1p(g * l);
      quad += (u[i]! * u[i]!) / (l + 1 / g);
    }
    const resid = Math.max(1 - quad / sst, 1e-300);
    return -0.5 * logDet - ((N - 1) / 2) * Math.log(resid);
  };
  // Integrate over x = ln g with the inverse-gamma(1/2, r²/2) prior on g.
  const logf = (x: number): number => {
    const g = Math.exp(x);
    const logPrior = Math.log(rscale) - 0.5 * Math.log(2 * Math.PI) - 1.5 * x - (rscale * rscale) / (2 * g);
    return logBfGivenG(g) + logPrior + x;
  };
  let lmax = -Infinity;
  let xMax = 0;
  for (let x = -40; x <= 40; x += 0.25) {
    const l = logf(x);
    if (l > lmax) {
      lmax = l;
      xMax = x;
    }
  }
  const res = integrateInf((x) => Math.exp(logf(x) - lmax), -Infinity, Infinity, {
    relTol: 1e-10,
    points: [xMax - 6, xMax - 2, xMax - 0.5, xMax, xMax + 0.5, xMax + 2, xMax + 6],
  });
  return lmax + Math.log(res.value);
}

export interface PostHocComparison {
  a: string;
  b: string;
  meanDiff: number;
  d: number;
  /** ln BF10 of the pairwise two-sample t-test, uncorrected. */
  logBf10: number;
  /** Prior odds for H1 after the multiplicity correction. */
  priorOdds: number;
  /** Posterior odds = prior odds × BF10. */
  logPosteriorOdds: number;
}

/**
 * Pairwise comparisons with default Cauchy t-tests. Following Westfall, Johnson & Utts
 * (1997), as implemented in JASP, the prior probability that *all* group means are equal
 * is fixed at 1/2, which gives each comparison the prior odds (1 − p)/p with
 * p = (1/2)^(2/k) for k groups.
 */
export function postHoc(groups: ArrayLike<number>[], labels: string[]): PostHocComparison[] {
  const k = groups.length;
  const pNull = Math.pow(0.5, 2 / k);
  const priorOdds = (1 - pNull) / pNull;
  const out: PostHocComparison[] = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      if (groups[i]!.length < 2 || groups[j]!.length < 2) continue;
      const st = twoSampleStats(groups[i]!, groups[j]!);
      const logBf10 = Number.isFinite(st.t) ? tTestBayesFactors(st, DEFAULT_EFFECT_PRIOR).logBf10 : NaN;
      out.push({
        a: labels[i]!,
        b: labels[j]!,
        meanDiff: st.mean1 - st.mean2,
        d: st.d,
        logBf10,
        priorOdds,
        logPosteriorOdds: Math.log(priorOdds) + logBf10,
      });
    }
  }
  return out;
}
