import { cumulativeTrapezoid, invertCdf, linspace } from "../describe.ts";
import { betaCdf, betaInv, betaSf, binomialLogPmf, gammaInv, normalLogPdf } from "../distributions.ts";
import { integrateInf } from "../quadrature.ts";
import { lbeta, lgamma } from "../special.ts";

/** Bayesian tests for proportions and event rates. */

export interface BetaSummary {
  a: number;
  b: number;
  mean: number;
  median: number;
  ci: [number, number];
  ciMass: number;
}

export function betaSummary(a: number, b: number, ciMass = 0.95): BetaSummary {
  const tail = (1 - ciMass) / 2;
  return { a, b, mean: a / (a + b), median: betaInv(0.5, a, b), ci: [betaInv(tail, a, b), betaInv(1 - tail, a, b)], ciMass };
}

export interface BinomialTestResult {
  k: number;
  n: number;
  theta0: number;
  logBf10: number;
  /** H+: θ > θ0 against H0. */
  logBfPlus0: number;
  /** H−: θ < θ0 against H0. */
  logBfMinus0: number;
  posterior: BetaSummary;
}

/**
 * Bayesian binomial test: H0: θ = θ0 against H1: θ ~ Beta(a, b)
 * (Jeffreys 1961; Wagenmakers et al. 2018, as in JASP).
 */
export function binomialTest(k: number, n: number, theta0 = 0.5, a = 1, b = 1, ciMass = 0.95): BinomialTestResult {
  const logM1 = lbeta(k + a, n - k + b) - lbeta(a, b);
  const logM0 = k * Math.log(theta0) + (n - k) * Math.log1p(-theta0);
  const logBf10 = logM1 - logM0;
  const postA = a + k;
  const postB = b + n - k;
  const priorPlus = betaSf(theta0, a, b);
  const postPlus = betaSf(theta0, postA, postB);
  const priorMinus = betaCdf(theta0, a, b);
  const postMinus = betaCdf(theta0, postA, postB);
  return {
    k,
    n,
    theta0,
    logBf10,
    logBfPlus0: logBf10 + Math.log(postPlus) - Math.log(priorPlus),
    logBfMinus0: logBf10 + Math.log(postMinus) - Math.log(priorMinus),
    posterior: betaSummary(postA, postB, ciMass),
  };
}

export interface MultinomialTestResult {
  counts: number[];
  expected: number[];
  logBf10: number;
  /** Marginal Beta posterior of each category's proportion. */
  posteriors: BetaSummary[];
}

/**
 * Bayesian multinomial (goodness-of-fit) test: H0: θ = expected proportions against
 * H1: θ ~ Dirichlet(α). With expected proportions set to exposure shares this tests
 * whether several event rates are equal.
 */
export function multinomialTest(counts: number[], expected?: number[], alpha = 1, ciMass = 0.95): MultinomialTestResult {
  const k = counts.length;
  const n = counts.reduce((s, v) => s + v, 0);
  const raw = expected ?? counts.map(() => 1);
  const tot = raw.reduce((s, v) => s + v, 0);
  const theta0 = raw.map((v) => v / tot);
  let logM1 = lgamma(k * alpha) - lgamma(n + k * alpha);
  let logM0 = 0;
  for (let i = 0; i < k; i++) {
    logM1 += lgamma(counts[i]! + alpha) - lgamma(alpha);
    if (counts[i]! > 0) logM0 += counts[i]! * Math.log(theta0[i]!);
  }
  return {
    counts,
    expected: theta0,
    logBf10: logM1 - logM0,
    posteriors: counts.map((c) => betaSummary(alpha + c, (k - 1) * alpha + n - c, ciMass)),
  };
}

export interface RateSummary {
  events: number;
  /** Exposure (observation time). */
  exposure: number;
  rate: number;
  /** Posterior median and credible interval under the Jeffreys prior Gamma(1/2, 0). */
  median: number;
  ci: [number, number];
}

export function rateSummary(events: number, exposure: number, ciMass = 0.95): RateSummary {
  const tail = (1 - ciMass) / 2;
  const shape = events + 0.5;
  return {
    events,
    exposure,
    rate: events / exposure,
    median: gammaInv(0.5, shape, exposure),
    ci: [gammaInv(tail, shape, exposure), gammaInv(1 - tail, shape, exposure)],
  };
}

export interface RateComparisonResult {
  rate1: RateSummary;
  rate2: RateSummary;
  /** Posterior of the rate ratio λ1/λ2 under H1. */
  ratio: { median: number; ci: [number, number] };
  logRatio: { x: Float64Array; density: Float64Array };
  /** P(λ1 > λ2 | data, H1). */
  pGreater: number;
  logBf10: number;
  logBfPlus0: number;
  logBfMinus0: number;
  priorSd: number;
  ciMass: number;
}

/**
 * Compare two Poisson rates (events per unit of exposure). Conditional on the total
 * number of events, the count in sample 1 is binomial with success probability
 * θ = λ1·T1 / (λ1·T1 + λ2·T2), i.e. logit θ = φ + ln(T1/T2) with φ = ln(λ1/λ2).
 * H0: φ = 0 against H1: φ ~ Normal(0, priorSd) — the analogue of the logit-normal
 * A/B test of Kass & Vaidyanathan (1992).
 */
export function compareRates(k1: number, t1: number, k2: number, t2: number, priorSd = 1, ciMass = 0.95): RateComparisonResult {
  const n = k1 + k2;
  const offset = Math.log(t1 / t2);
  const logLik = (phi: number) => {
    const eta = phi + offset;
    // ln θ and ln(1 − θ) without overflow
    const logTheta = eta >= 0 ? -Math.log1p(Math.exp(-eta)) : eta - Math.log1p(Math.exp(eta));
    const log1mTheta = eta >= 0 ? -eta - Math.log1p(Math.exp(-eta)) : -Math.log1p(Math.exp(eta));
    return k1 * logTheta + k2 * log1mTheta;
  };
  const logPost = (phi: number) => logLik(phi) + normalLogPdf(phi, 0, priorSd);
  // Locate the posterior mode by Newton iterations on φ.
  let mode = 0;
  for (let it = 0; it < 60; it++) {
    const theta = 1 / (1 + Math.exp(-(mode + offset)));
    const grad = k1 - n * theta - mode / (priorSd * priorSd);
    const hess = -n * theta * (1 - theta) - 1 / (priorSd * priorSd);
    const step = grad / hess;
    mode -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  const thetaM = 1 / (1 + Math.exp(-(mode + offset)));
  const sdPost = 1 / Math.sqrt(n * thetaM * (1 - thetaM) + 1 / (priorSd * priorSd));
  const lmax = logPost(mode);
  const pts = [-8, -4, -2, -1, 0, 1, 2, 4, 8].map((k) => mode + k * sdPost);
  const mass = (a: number, b: number) =>
    integrateInf((phi) => Math.exp(logPost(phi) - lmax), a, b, { relTol: 1e-10, points: [...pts, 0] }).value;
  const mPos = mass(0, Infinity);
  const mNeg = mass(-Infinity, 0);
  const logM1 = lmax + Math.log(mPos + mNeg);
  const logM0 = logLik(0);
  const logBf10 = logM1 - logM0;

  const grid = 1201;
  const x = linspace(mode - 10 * sdPost, mode + 10 * sdPost, grid);
  const density = new Float64Array(grid);
  for (let i = 0; i < grid; i++) density[i] = Math.exp(logPost(x[i]!) - lmax);
  const cdf = cumulativeTrapezoid(x, density);
  const total = cdf[grid - 1]!;
  for (let i = 0; i < grid; i++) {
    density[i] = density[i]! / total;
    cdf[i] = cdf[i]! / total;
  }
  const tail = (1 - ciMass) / 2;
  return {
    rate1: rateSummary(k1, t1, ciMass),
    rate2: rateSummary(k2, t2, ciMass),
    ratio: {
      median: Math.exp(invertCdf(x, cdf, 0.5)),
      ci: [Math.exp(invertCdf(x, cdf, tail)), Math.exp(invertCdf(x, cdf, 1 - tail))],
    },
    logRatio: { x, density },
    pGreater: mPos / (mPos + mNeg),
    logBf10,
    // The prior is symmetric around 0, so each direction has prior mass 1/2.
    logBfPlus0: lmax + Math.log(2 * mPos) - logM0,
    logBfMinus0: lmax + Math.log(2 * mNeg) - logM0,
    priorSd,
    ciMass,
  };
}

/** ln of the binomial probability, re-exported for convenience in tests. */
export { binomialLogPmf };

/** Verbal label for the strength of evidence (Lee & Wagenmakers 2013, after Jeffreys 1961). */
export function evidenceLabel(logBf10: number): { strength: string; favours: "H1" | "H0" | "neither" } {
  const abs = Math.abs(logBf10);
  const bf = Math.exp(abs);
  const favours = logBf10 > 0 ? "H1" : logBf10 < 0 ? "H0" : "neither";
  let strength: string;
  if (!Number.isFinite(logBf10) && !Number.isNaN(logBf10)) strength = "extreme";
  else if (Number.isNaN(logBf10)) strength = "undefined";
  else if (bf < 1.0000001) strength = "no";
  else if (bf < 3) strength = "anecdotal";
  else if (bf < 10) strength = "moderate";
  else if (bf < 30) strength = "strong";
  else if (bf < 100) strength = "very strong";
  else strength = "extreme";
  return { strength, favours: strength === "no" ? "neither" : favours };
}
