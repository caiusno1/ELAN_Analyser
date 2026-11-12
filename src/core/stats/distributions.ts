import { betaI, betaIc, erfc, gammaP, gammaQ, lbeta, lgamma, logHyp1f1, solveMonotoneLog } from "./special.ts";

const LN_SQRT_2PI = 0.9189385332046727418;
const SQRT_2PI = 2.5066282746310005024;

// ---- normal -------------------------------------------------------------------------

export function normalLogPdf(x: number, mean = 0, sd = 1): number {
  const z = (x - mean) / sd;
  return -0.5 * z * z - LN_SQRT_2PI - Math.log(sd);
}

export function normalPdf(x: number, mean = 0, sd = 1): number {
  const z = (x - mean) / sd;
  return Math.exp(-0.5 * z * z) / (SQRT_2PI * sd);
}

export function normalCdf(x: number, mean = 0, sd = 1): number {
  const z = (x - mean) / sd;
  return 0.5 * erfc(-z / Math.SQRT2);
}

const ACK_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const ACK_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const ACK_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const ACK_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

/** Quantile of the standard normal (Acklam's approximation + one Halley refinement). */
export function normalInv(p: number, mean = 0, sd = 1): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let x: number;
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((ACK_C[0]! * q + ACK_C[1]!) * q + ACK_C[2]!) * q + ACK_C[3]!) * q + ACK_C[4]!) * q + ACK_C[5]!) /
      ((((ACK_D[0]! * q + ACK_D[1]!) * q + ACK_D[2]!) * q + ACK_D[3]!) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((ACK_A[0]! * r + ACK_A[1]!) * r + ACK_A[2]!) * r + ACK_A[3]!) * r + ACK_A[4]!) * r + ACK_A[5]!) * q) /
      (((((ACK_B[0]! * r + ACK_B[1]!) * r + ACK_B[2]!) * r + ACK_B[3]!) * r + ACK_B[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log1p(-p));
    x = -(((((ACK_C[0]! * q + ACK_C[1]!) * q + ACK_C[2]!) * q + ACK_C[3]!) * q + ACK_C[4]!) * q + ACK_C[5]!) /
      ((((ACK_D[0]! * q + ACK_D[1]!) * q + ACK_D[2]!) * q + ACK_D[3]!) * q + 1);
  }
  // Halley step on the CDF, taken on the tail that is small so that no precision is lost.
  const e = x <= 0 ? 0.5 * erfc(-x / Math.SQRT2) - p : 1 - p - 0.5 * erfc(x / Math.SQRT2);
  const u = e * SQRT_2PI * Math.exp((x * x) / 2);
  x = x - u / (1 + (x * u) / 2);
  return mean + sd * x;
}

// ---- Student t ----------------------------------------------------------------------

export function tLogPdf(x: number, df: number, loc = 0, scale = 1): number {
  const z = (x - loc) / scale;
  return (
    lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - Math.log(scale) -
    ((df + 1) / 2) * Math.log1p((z * z) / df)
  );
}

export function tPdf(x: number, df: number, loc = 0, scale = 1): number {
  return Math.exp(tLogPdf(x, df, loc, scale));
}

export function tCdf(x: number, df: number, loc = 0, scale = 1): number {
  const z = (x - loc) / scale;
  if (z === 0) return 0.5;
  const tail = 0.5 * betaI(df / 2, 0.5, df / (df + z * z));
  return z > 0 ? 1 - tail : tail;
}

export function tInv(p: number, df: number, loc = 0, scale = 1): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return loc;
  const tailP = p < 0.5 ? p : 1 - p;
  // tailP = 0.5 * I_w(df/2, 1/2) with w = df / (df + t^2)
  const w = betaInv(2 * tailP, df / 2, 0.5);
  const t = Math.sqrt((df * (1 - w)) / w);
  return loc + scale * (p < 0.5 ? -t : t);
}

// ---- Cauchy -------------------------------------------------------------------------

export function cauchyPdf(x: number, loc = 0, scale = 1): number {
  const z = (x - loc) / scale;
  return 1 / (Math.PI * scale * (1 + z * z));
}

export function cauchyCdf(x: number, loc = 0, scale = 1): number {
  return 0.5 + Math.atan((x - loc) / scale) / Math.PI;
}

export function cauchyInv(p: number, loc = 0, scale = 1): number {
  return loc + scale * Math.tan(Math.PI * (p - 0.5));
}

// ---- gamma / chi-square -------------------------------------------------------------

/** Gamma with shape and rate. */
export function gammaLogPdf(x: number, shape: number, rate: number): number {
  if (x < 0) return -Infinity;
  if (x === 0) return shape === 1 ? Math.log(rate) : shape < 1 ? Infinity : -Infinity;
  return shape * Math.log(rate) - lgamma(shape) + (shape - 1) * Math.log(x) - rate * x;
}

export function gammaCdf(x: number, shape: number, rate: number): number {
  return gammaP(shape, rate * x);
}

export function gammaSf(x: number, shape: number, rate: number): number {
  return gammaQ(shape, rate * x);
}

export function gammaInv(p: number, shape: number, rate: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  let hi = shape + 10 * Math.sqrt(shape) + 10;
  while (gammaP(shape, hi) < p) hi *= 2;
  const x = p <= 0.5
    ? solveMonotoneLog((v) => gammaP(shape, v) - p, hi)
    : solveMonotoneLog((v) => 1 - p - gammaQ(shape, v), hi);
  return x / rate;
}

// ---- beta ---------------------------------------------------------------------------

export function betaLogPdf(x: number, a: number, b: number): number {
  if (x < 0 || x > 1) return -Infinity;
  if (x === 0) return a === 1 ? -lbeta(a, b) : a < 1 ? Infinity : -Infinity;
  if (x === 1) return b === 1 ? -lbeta(a, b) : b < 1 ? Infinity : -Infinity;
  return (a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x) - lbeta(a, b);
}

export function betaCdf(x: number, a: number, b: number): number {
  return betaI(a, b, x);
}

export function betaSf(x: number, a: number, b: number): number {
  return betaIc(a, b, x);
}

export function betaInv(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  // Solve for the smaller tail on the log scale: x itself for p <= 1/2, otherwise
  // y = 1 − x, using I_x(a, b) = 1 − I_{1−x}(b, a).
  if (p <= 0.5) return solveMonotoneLog((x) => betaI(a, b, x) - p, 1);
  const q = 1 - p;
  return 1 - solveMonotoneLog((y) => betaI(b, a, y) - q, 1);
}

/**
 * Beta-prime (ratio of two independent gammas with unit rate): X = G(a)/G(b).
 * P(X <= x) = I_{x/(1+x)}(a, b).
 */
export function betaPrimeCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  return betaI(a, b, x / (1 + x));
}

export function betaPrimeInv(p: number, a: number, b: number): number {
  const u = betaInv(p, a, b);
  return u / (1 - u);
}

// ---- noncentral t -------------------------------------------------------------------

/**
 * Density of the noncentral t distribution with `df` degrees of freedom and
 * noncentrality `ncp`, evaluated at `t`. Uses the confluent hypergeometric form; the two
 * terms are combined on the log scale so that large arguments do not overflow.
 */
export function nctPdf(t: number, df: number, ncp: number): number {
  if (ncp === 0) return tPdf(t, df);
  const v = df;
  const d = v + t * t;
  const z = (ncp * ncp * t * t) / (2 * d);
  const logA = (v / 2) * Math.log(v) + lgamma(v + 1) - v * Math.LN2 - (ncp * ncp) / 2 - (v / 2) * Math.log(d) - lgamma(v / 2);
  const l2 = logA + logHyp1f1((v + 1) / 2, 0.5, z) - 0.5 * Math.log(d) - lgamma(v / 2 + 1);
  const mt = ncp * t;
  if (mt === 0) return Math.exp(l2);
  const l1 = logA + Math.log(Math.SQRT2 * Math.abs(mt)) + logHyp1f1(v / 2 + 1, 1.5, z) - Math.log(d) - lgamma((v + 1) / 2);
  if (mt > 0) return Math.exp(l2) + Math.exp(l1);
  // Opposite signs: the terms nearly cancel and the true density is tiny.
  const m = Math.max(l1, l2);
  const diff = Math.exp(l2 - m) - Math.exp(l1 - m);
  return diff > 1e-12 ? Math.exp(m) * diff : 0;
}

// ---- binomial / Poisson (log pmf) ---------------------------------------------------

export function binomialLogPmf(k: number, n: number, p: number): number {
  if (k < 0 || k > n) return -Infinity;
  if (p <= 0) return k === 0 ? 0 : -Infinity;
  if (p >= 1) return k === n ? 0 : -Infinity;
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log1p(-p);
}

export function poissonLogPmf(k: number, lambda: number): number {
  if (k < 0) return -Infinity;
  if (lambda <= 0) return k === 0 ? 0 : -Infinity;
  return k * Math.log(lambda) - lambda - lgamma(k + 1);
}
