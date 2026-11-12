import { cumulativeTrapezoid, invertCdf, linspace, mean, variance } from "../describe.ts";
import { cauchyCdf, normalCdf, normalLogPdf, tCdf, tLogPdf } from "../distributions.ts";
import { integrate, integrateInf } from "../quadrature.ts";
import { lgamma } from "../special.ts";

/**
 * Bayesian t-tests on the standardized effect size δ.
 *
 * H0: δ = 0 against H1: δ ~ prior. The default prior is the Cauchy(0, √2/2) of the "JZS"
 * test (Rouder, Speckman, Sun, Morey & Iverson 2009; Morey & Rouder 2011); normal and
 * Student-t priors with arbitrary location give the informed tests of Gronau, Ly &
 * Wagenmakers (2020). The data enter only through the t statistic, whose sampling
 * distribution given δ is a noncentral t with noncentrality δ·√n_eff.
 */

export type Alternative = "two-sided" | "greater" | "less";

export interface EffectPrior {
  family: "cauchy" | "normal" | "t";
  location: number;
  scale: number;
  /** Degrees of freedom for the Student-t family. */
  df?: number;
}

export const DEFAULT_EFFECT_PRIOR: EffectPrior = { family: "cauchy", location: 0, scale: Math.SQRT1_2 };

export interface TStatistic {
  t: number;
  df: number;
  /** n for one-sample/paired designs; n1·n2/(n1+n2) for two independent samples. */
  nEff: number;
}

export interface OneSampleStats extends TStatistic {
  n: number;
  mean: number;
  sd: number;
  /** Cohen's d. */
  d: number;
}

export interface TwoSampleStats extends TStatistic {
  n1: number;
  n2: number;
  mean1: number;
  mean2: number;
  sd1: number;
  sd2: number;
  pooledSd: number;
  d: number;
}

export function oneSampleStats(x: ArrayLike<number>, mu0 = 0): OneSampleStats {
  const n = x.length;
  const m = mean(x);
  const s = Math.sqrt(variance(x));
  const d = (m - mu0) / s;
  return { n, mean: m, sd: s, d, t: d * Math.sqrt(n), df: n - 1, nEff: n };
}

export function pairedStats(x: ArrayLike<number>, y: ArrayLike<number>): OneSampleStats {
  const n = Math.min(x.length, y.length);
  const diff = new Float64Array(n);
  for (let i = 0; i < n; i++) diff[i] = x[i]! - y[i]!;
  return oneSampleStats(diff, 0);
}

/** Student's two-sample t statistic (pooled variance). */
export function twoSampleStats(x: ArrayLike<number>, y: ArrayLike<number>): TwoSampleStats {
  const n1 = x.length;
  const n2 = y.length;
  const m1 = mean(x);
  const m2 = mean(y);
  const v1 = n1 > 1 ? variance(x) : 0;
  const v2 = n2 > 1 ? variance(y) : 0;
  const df = n1 + n2 - 2;
  const pooled = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / df);
  const nEff = (n1 * n2) / (n1 + n2);
  const d = (m1 - m2) / pooled;
  return { n1, n2, mean1: m1, mean2: m2, sd1: Math.sqrt(v1), sd2: Math.sqrt(v2), pooledSd: pooled, d, t: d * Math.sqrt(nEff), df, nEff };
}

/**
 * Log density of the noncentral t distribution, from the integral representation
 * f(t) = C ∫₀^∞ s^ν exp(−ν s²/2 − (t s − μ)²/2) ds. The integrand is log-concave, so it
 * is integrated around its mode; unlike series expansions this keeps full relative
 * accuracy when t and μ have opposite signs.
 */
export function nctLogPdf(t: number, df: number, ncp: number): number {
  if (ncp === 0) return tLogPdf(t, df);
  const v = df;
  const a = v + t * t;
  const mt = ncp * t;
  const sStar = (mt + Math.sqrt(mt * mt + 4 * v * a)) / (2 * a);
  const h = (s: number) => v * Math.log(s) - 0.5 * v * s * s - 0.5 * (t * s - ncp) * (t * s - ncp);
  const hStar = h(sStar);
  const sigma = 1 / Math.sqrt(v / (sStar * sStar) + a);
  const lo = Math.max(0, sStar - 16 * sigma);
  const hi = sStar + 16 / Math.sqrt(a);
  const res = integrate((s) => (s <= 0 ? 0 : Math.exp(h(s) - hStar)), lo, hi, {
    relTol: 1e-12,
    points: [sStar - 3 * sigma, sStar, sStar + 3 * sigma],
  });
  const logC = Math.LN2 + (v / 2) * Math.log(v / 2) - lgamma(v / 2) - 0.5 * Math.log(2 * Math.PI);
  return logC + hStar + Math.log(res.value);
}

function priorLogPdf(prior: EffectPrior, d: number): number {
  switch (prior.family) {
    case "cauchy": {
      const z = (d - prior.location) / prior.scale;
      return -Math.log(Math.PI * prior.scale) - Math.log1p(z * z);
    }
    case "normal":
      return normalLogPdf(d, prior.location, prior.scale);
    case "t":
      return tLogPdf(d, prior.df ?? 3, prior.location, prior.scale);
  }
}

function priorCdf(prior: EffectPrior, d: number): number {
  switch (prior.family) {
    case "cauchy":
      return cauchyCdf(d, prior.location, prior.scale);
    case "normal":
      return normalCdf(d, prior.location, prior.scale);
    case "t":
      return tCdf(d, prior.df ?? 3, prior.location, prior.scale);
  }
}

export function effectPriorPdf(prior: EffectPrior, d: number, alternative: Alternative = "two-sided"): number {
  const base = Math.exp(priorLogPdf(prior, d));
  if (alternative === "two-sided") return base;
  const massPos = 1 - priorCdf(prior, 0);
  if (alternative === "greater") return d >= 0 ? base / massPos : 0;
  return d <= 0 ? base / (1 - massPos) : 0;
}

/** Approximate standard error of the effect size estimate t/√n_eff. */
function effectSe(stat: TStatistic): number {
  const dHat = stat.t / Math.sqrt(stat.nEff);
  return Math.sqrt(1 / stat.nEff + (dHat * dHat) / (2 * Math.max(stat.df, 1)));
}

/** ln ∫ L(δ) π(δ) dδ over [a, b] (bounds may be infinite). */
function logMarginal(stat: TStatistic, prior: EffectPrior, a: number, b: number): number {
  const root = Math.sqrt(stat.nEff);
  const logf = (d: number) => nctLogPdf(stat.t, stat.df, d * root) + priorLogPdf(prior, d);
  const dHat = stat.t / root;
  const se = effectSe(stat);
  const candidates = [dHat, prior.location, 0];
  for (const k of [-8, -4, -2, -1, 1, 2, 4, 8]) candidates.push(dHat + k * se);
  for (const k of [-3, -1, 1, 3]) candidates.push(prior.location + k * prior.scale);
  const inside = candidates
    .map((c) => Math.min(Math.max(c, a === -Infinity ? c : a), b === Infinity ? c : b))
    .filter((c) => Number.isFinite(c));
  let lmax = -Infinity;
  for (const c of inside) {
    const l = logf(c);
    if (l > lmax) lmax = l;
  }
  if (lmax === -Infinity) return -Infinity;
  const res = integrateInf((d) => Math.exp(logf(d) - lmax), a, b, { relTol: 1e-9, points: inside });
  return lmax + Math.log(res.value);
}

export interface TTestBayesFactors {
  /** ln BF of H1 (two-sided) over H0. */
  logBf10: number;
  /** ln BF of H+ (δ > 0) over H0. */
  logBfPlus0: number;
  /** ln BF of H− (δ < 0) over H0. */
  logBfMinus0: number;
}

export function tTestBayesFactors(stat: TStatistic, prior: EffectPrior = DEFAULT_EFFECT_PRIOR): TTestBayesFactors {
  const logM0 = tLogPdf(stat.t, stat.df);
  const lpos = logMarginal(stat, prior, 0, Infinity);
  const lneg = logMarginal(stat, prior, -Infinity, 0);
  const massPos = 1 - priorCdf(prior, 0);
  // Two-sided marginal = sum of the two halves (each already weighted by the prior).
  const m = Math.max(lpos, lneg);
  const logM1 = m === -Infinity ? -Infinity : m + Math.log(Math.exp(lpos - m) + Math.exp(lneg - m));
  return {
    logBf10: logM1 - logM0,
    logBfPlus0: lpos - Math.log(massPos) - logM0,
    logBfMinus0: lneg - Math.log(1 - massPos) - logM0,
  };
}

/** ln BF10 for one alternative. */
export function tTestLogBf(stat: TStatistic, prior: EffectPrior, alternative: Alternative): number {
  const b = tTestBayesFactors(stat, prior);
  return alternative === "two-sided" ? b.logBf10 : alternative === "greater" ? b.logBfPlus0 : b.logBfMinus0;
}

export interface EffectPosterior {
  /** Grid of effect sizes and the posterior density on it. */
  x: Float64Array;
  density: Float64Array;
  cdf: Float64Array;
  median: number;
  mean: number;
  /** Central credible interval. */
  ci: [number, number];
  ciMass: number;
  /** Posterior probability that δ > 0. */
  pPositive: number;
}

/** Posterior of δ under H1 (or under a one-sided alternative), tabulated on a grid. */
export function effectPosterior(
  stat: TStatistic,
  prior: EffectPrior = DEFAULT_EFFECT_PRIOR,
  alternative: Alternative = "two-sided",
  ciMass = 0.95,
  gridPoints = 1601,
): EffectPosterior {
  const root = Math.sqrt(stat.nEff);
  const dHat = stat.t / root;
  const se = effectSe(stat);
  let lo = Math.min(dHat, prior.location) - 12 * se;
  let hi = Math.max(dHat, prior.location) + 12 * se;
  // The posterior sits between the estimate and the prior location; trim the far side.
  lo = Math.max(lo, Math.min(dHat - 12 * se, prior.location - 12 * se));
  hi = Math.min(hi, Math.max(dHat + 12 * se, prior.location + 12 * se));
  if (alternative === "greater") lo = Math.max(lo, 0);
  if (alternative === "less") hi = Math.min(hi, 0);
  if (!(hi > lo)) {
    // The data point far into the excluded side: the posterior piles up at the bound.
    if (alternative === "greater") {
      lo = 0;
      hi = 12 * se;
    } else {
      hi = 0;
      lo = -12 * se;
    }
  }
  const x = linspace(lo, hi, gridPoints);
  const logd = new Float64Array(gridPoints);
  let lmax = -Infinity;
  for (let i = 0; i < gridPoints; i++) {
    logd[i] = nctLogPdf(stat.t, stat.df, x[i]! * root) + priorLogPdf(prior, x[i]!);
    if (logd[i]! > lmax) lmax = logd[i]!;
  }
  const density = new Float64Array(gridPoints);
  for (let i = 0; i < gridPoints; i++) density[i] = Math.exp(logd[i]! - lmax);
  const cdf = cumulativeTrapezoid(x, density);
  const total = cdf[gridPoints - 1]!;
  let meanAcc = 0;
  for (let i = 0; i < gridPoints; i++) {
    density[i] = density[i]! / total;
    cdf[i] = cdf[i]! / total;
  }
  for (let i = 1; i < gridPoints; i++) {
    meanAcc += 0.5 * (x[i]! * density[i]! + x[i - 1]! * density[i - 1]!) * (x[i]! - x[i - 1]!);
  }
  const tail = (1 - ciMass) / 2;
  let pPositive: number;
  if (alternative === "greater") pPositive = 1;
  else if (alternative === "less") pPositive = 0;
  else if (lo >= 0) pPositive = 1;
  else if (hi <= 0) pPositive = 0;
  else {
    // Interpolate the CDF at zero.
    let i = 0;
    while (i + 1 < gridPoints && x[i + 1]! < 0) i++;
    const f = (0 - x[i]!) / (x[i + 1]! - x[i]!);
    pPositive = 1 - (cdf[i]! + f * (cdf[i + 1]! - cdf[i]!));
  }
  return {
    x,
    density,
    cdf,
    median: invertCdf(x, cdf, 0.5),
    mean: meanAcc,
    ci: [invertCdf(x, cdf, tail), invertCdf(x, cdf, 1 - tail)],
    ciMass,
    pPositive,
  };
}

/** Bayes factor as a function of the prior scale (robustness check). */
export function tTestRobustness(
  stat: TStatistic,
  prior: EffectPrior,
  alternative: Alternative,
  scales: ArrayLike<number>,
): Float64Array {
  const out = new Float64Array(scales.length);
  for (let i = 0; i < scales.length; i++) {
    out[i] = tTestLogBf(stat, { ...prior, scale: scales[i]! }, alternative);
  }
  return out;
}

export interface SequentialPoint {
  n: number;
  logBf: number;
}

/**
 * Bayes factor after each additional observation, in the order given (sequential
 * analysis). `groups` marks, for a two-sample design, which sample (0 or 1) each
 * observation belongs to; omit it for one-sample or paired differences.
 */
export function tTestSequential(
  values: ArrayLike<number>,
  prior: EffectPrior,
  alternative: Alternative,
  opts: { groups?: ArrayLike<number>; mu0?: number; maxPoints?: number } = {},
): SequentialPoint[] {
  const n = values.length;
  const maxPoints = opts.maxPoints ?? 150;
  const step = Math.max(1, Math.ceil(n / maxPoints));
  const out: SequentialPoint[] = [];
  // Running sums allow O(1) updates of the t statistic.
  const cnt = [0, 0];
  const s1 = [0, 0];
  const s2 = [0, 0];
  for (let i = 0; i < n; i++) {
    const g = opts.groups ? opts.groups[i]! : 0;
    const v = values[i]! - (opts.groups ? 0 : opts.mu0 ?? 0);
    cnt[g] = cnt[g]! + 1;
    s1[g] = s1[g]! + v;
    s2[g] = s2[g]! + v * v;
    const isLast = i === n - 1;
    if (!isLast && (i + 1) % step !== 0) continue;
    let stat: TStatistic | undefined;
    if (opts.groups) {
      const [n1, n2] = [cnt[0]!, cnt[1]!];
      if (n1 >= 2 && n2 >= 2) {
        const m1 = s1[0]! / n1;
        const m2 = s1[1]! / n2;
        const ss = s2[0]! - n1 * m1 * m1 + (s2[1]! - n2 * m2 * m2);
        const df = n1 + n2 - 2;
        const pooled = Math.sqrt(Math.max(ss, 0) / df);
        const nEff = (n1 * n2) / (n1 + n2);
        if (pooled > 0) stat = { t: ((m1 - m2) / pooled) * Math.sqrt(nEff), df, nEff };
      }
    } else {
      const k = cnt[0]!;
      if (k >= 2) {
        const m = s1[0]! / k;
        const sdev = Math.sqrt(Math.max(s2[0]! - k * m * m, 0) / (k - 1));
        if (sdev > 0) stat = { t: (m / sdev) * Math.sqrt(k), df: k - 1, nEff: k };
      }
    }
    if (stat) out.push({ n: i + 1, logBf: tTestLogBf(stat, prior, alternative) });
  }
  return out;
}

/**
 * The classic JZS integral over g (Rouder et al. 2009, eq. 1), kept as an independent
 * cross-check of the noncentral-t route for the zero-centred Cauchy prior.
 */
export function jzsLogBf10ByGIntegral(stat: TStatistic, scale: number): number {
  const { t, df, nEff } = stat;
  const logM0 = -((df + 1) / 2) * Math.log1p((t * t) / df);
  // Substitute g = exp(u) and integrate the log-scaled integrand.
  const logf = (u: number) => {
    const g = Math.exp(u);
    const ng = 1 + nEff * g;
    return (
      -0.5 * Math.log(ng) -
      ((df + 1) / 2) * Math.log1p((t * t) / (ng * df)) +
      Math.log(scale) - 0.5 * Math.log(2 * Math.PI) - 1.5 * u - (scale * scale) / (2 * g) +
      u
    );
  };
  let lmax = -Infinity;
  let uMax = 0;
  for (let u = -30; u <= 30; u += 0.25) {
    const l = logf(u);
    if (l > lmax) {
      lmax = l;
      uMax = u;
    }
  }
  const res = integrateInf((u) => Math.exp(logf(u) - lmax), -Infinity, Infinity, {
    relTol: 1e-10,
    points: [uMax - 4, uMax - 1, uMax, uMax + 1, uMax + 4],
  });
  return lmax + Math.log(res.value) - logM0;
}
