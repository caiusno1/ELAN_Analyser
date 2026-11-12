import { cumulativeTrapezoid, invertCdf, linspace } from "../describe.ts";
import { integrate } from "../quadrature.ts";
import { hyp2f1, lbeta, lgamma } from "../special.ts";
import type { Alternative } from "./ttest.ts";

/**
 * Bayesian test for a Pearson correlation (Jeffreys 1961; Ly, Marsman & Wagenmakers 2018).
 *
 * H0: ρ = 0 against H1: ρ ~ stretched Beta(1/κ, 1/κ) on (−1, 1); κ = 1 is the uniform
 * prior. Means and variances are integrated out with right-Haar priors, which leaves a
 * "reduced likelihood" that depends on the data only through n and the sample r.
 */

/** ln of the stretched-beta prior density at ρ. */
export function correlationPriorLogPdf(rho: number, kappa = 1): number {
  if (rho <= -1 || rho >= 1) return -Infinity;
  const alpha = 1 / kappa;
  return (1 - 2 * alpha) * Math.LN2 - lbeta(alpha, alpha) + (alpha - 1) * Math.log1p(-rho * rho);
}

/** ln of the reduced likelihood h(n, r | ρ), up to a constant that does not depend on ρ. */
export function reducedLogLikelihood(rho: number, r: number, n: number): number {
  return (
    ((n - 1) / 2) * Math.log1p(-rho * rho) -
    (n - 1.5) * Math.log1p(-rho * r) +
    Math.log(hyp2f1(0.5, 0.5, n - 0.5, (1 + rho * r) / 2))
  );
}

/** ln BF10 (two-sided) in closed form (Ly et al. 2018). */
export function correlationLogBf10(r: number, n: number, kappa = 1): number {
  if (n < 3) return 0;
  const r2 = r * r;
  if (r2 >= 1) return Infinity;
  const alpha = 1 / kappa;
  const c = alpha + n / 2;
  // Euler transformation keeps every series term positive:
  // 2F1((n−1)/2, (n−1)/2; c; r²) = (1 − r²)^(α + 1 − n/2) · 2F1(α + ½, α + ½; c; r²)
  const logF = (alpha + 1 - n / 2) * Math.log1p(-r2) + Math.log(hyp2f1(alpha + 0.5, alpha + 0.5, c, r2));
  return (
    (1 - 2 * alpha) * Math.LN2 + 0.5 * Math.log(Math.PI) - lbeta(alpha, alpha) +
    lgamma(alpha + (n - 1) / 2) - lgamma(c) + logF
  );
}

/** ln ∫ h(ρ) π(ρ) dρ over [a, b] ⊂ [−1, 1]. */
function logMass(r: number, n: number, kappa: number, a: number, b: number): number {
  const logf = (rho: number) => reducedLogLikelihood(rho, r, n) + correlationPriorLogPdf(rho, kappa);
  const sdApprox = (1 - r * r) / Math.sqrt(Math.max(n - 1, 1));
  const eps = 1e-12;
  const lo = Math.max(a, -1 + eps);
  const hi = Math.min(b, 1 - eps);
  const pts: number[] = [];
  for (const k of [-8, -4, -2, -1, 0, 1, 2, 4, 8]) {
    const p = r + k * sdApprox;
    if (p > lo && p < hi) pts.push(p);
  }
  let lmax = -Infinity;
  for (const p of [...pts, lo + 1e-9, hi - 1e-9, (lo + hi) / 2]) {
    const l = logf(p);
    if (l > lmax) lmax = l;
  }
  if (lmax === -Infinity) return -Infinity;
  const res = integrate((rho) => Math.exp(logf(rho) - lmax), lo, hi, { relTol: 1e-10, points: pts });
  return lmax + Math.log(res.value);
}

export interface CorrelationBayesFactors {
  logBf10: number;
  /** H+: ρ > 0 against H0. */
  logBfPlus0: number;
  /** H−: ρ < 0 against H0. */
  logBfMinus0: number;
}

export function correlationBayesFactors(r: number, n: number, kappa = 1): CorrelationBayesFactors {
  const logBf10 = correlationLogBf10(r, n, kappa);
  if (!Number.isFinite(logBf10)) {
    return { logBf10, logBfPlus0: r > 0 ? Infinity : -Infinity, logBfMinus0: r < 0 ? Infinity : -Infinity };
  }
  const lpos = logMass(r, n, kappa, 0, 1);
  const lneg = logMass(r, n, kappa, -1, 0);
  const m = Math.max(lpos, lneg);
  const ltot = m + Math.log(Math.exp(lpos - m) + Math.exp(lneg - m));
  // The prior is symmetric, so each half has prior mass 1/2.
  return {
    logBf10,
    logBfPlus0: logBf10 + Math.LN2 + (lpos - ltot),
    logBfMinus0: logBf10 + Math.LN2 + (lneg - ltot),
  };
}

/** The same Bayes factor by direct numerical integration (used to cross-check the closed form). */
export function correlationLogBf10Numeric(r: number, n: number, kappa = 1): number {
  const lpos = logMass(r, n, kappa, 0, 1);
  const lneg = logMass(r, n, kappa, -1, 0);
  const m = Math.max(lpos, lneg);
  return m + Math.log(Math.exp(lpos - m) + Math.exp(lneg - m)) - reducedLogLikelihood(0, r, n);
}

export interface CorrelationPosterior {
  x: Float64Array;
  density: Float64Array;
  cdf: Float64Array;
  median: number;
  ci: [number, number];
  ciMass: number;
  pPositive: number;
}

export function correlationPosterior(
  r: number,
  n: number,
  kappa = 1,
  alternative: Alternative = "two-sided",
  ciMass = 0.95,
  gridPoints = 1601,
): CorrelationPosterior {
  const sdApprox = (1 - r * r) / Math.sqrt(Math.max(n - 1, 1));
  let lo = Math.max(-1 + 1e-9, r - 14 * sdApprox - 0.02);
  let hi = Math.min(1 - 1e-9, r + 14 * sdApprox + 0.02);
  if (n < 30) {
    lo = -1 + 1e-9;
    hi = 1 - 1e-9;
  }
  if (alternative === "greater") lo = Math.max(lo, 0);
  if (alternative === "less") hi = Math.min(hi, 0);
  if (!(hi > lo)) {
    if (alternative === "greater") {
      lo = 0;
      hi = Math.min(1 - 1e-9, 14 * sdApprox);
    } else {
      hi = 0;
      lo = Math.max(-1 + 1e-9, -14 * sdApprox);
    }
  }
  const x = linspace(lo, hi, gridPoints);
  const logd = new Float64Array(gridPoints);
  let lmax = -Infinity;
  for (let i = 0; i < gridPoints; i++) {
    logd[i] = reducedLogLikelihood(x[i]!, r, n) + correlationPriorLogPdf(x[i]!, kappa);
    if (logd[i]! > lmax) lmax = logd[i]!;
  }
  const density = new Float64Array(gridPoints);
  for (let i = 0; i < gridPoints; i++) density[i] = Math.exp(logd[i]! - lmax);
  const cdf = cumulativeTrapezoid(x, density);
  const total = cdf[gridPoints - 1]!;
  for (let i = 0; i < gridPoints; i++) {
    density[i] = density[i]! / total;
    cdf[i] = cdf[i]! / total;
  }
  const tail = (1 - ciMass) / 2;
  let pPositive: number;
  if (lo >= 0) pPositive = 1;
  else if (hi <= 0) pPositive = 0;
  else {
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
    ci: [invertCdf(x, cdf, tail), invertCdf(x, cdf, 1 - tail)],
    ciMass,
    pPositive,
  };
}
