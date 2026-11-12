/**
 * Special functions needed by the Bayesian tests. Implementations aim at close to double
 * precision over the ranges the app uses; tests/special.test.ts checks them against
 * reference values computed with SciPy/mpmath.
 */

const LN_SQRT_2PI = 0.9189385332046727418;
export const SQRT2 = Math.SQRT2;
export const LN2 = Math.LN2;

const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** Natural log of the gamma function for real x (not a non-positive integer). */
export function lgamma(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x < 0.5) {
    // Reflection: Γ(x)Γ(1−x) = π / sin(πx)
    const s = Math.sin(Math.PI * x);
    if (s === 0) return Infinity;
    return Math.log(Math.PI / Math.abs(s)) - lgamma(1 - x);
  }
  if (x > 1e7) {
    // Stirling series; the Lanczos sum loses nothing here but this is cheaper.
    return (x - 0.5) * Math.log(x) - x + LN_SQRT_2PI + 1 / (12 * x) - 1 / (360 * x * x * x);
  }
  const xm = x - 1;
  let a = LANCZOS_C[0]!;
  const t = xm + LANCZOS_G + 0.5;
  for (let i = 1; i < 9; i++) a += LANCZOS_C[i]! / (xm + i);
  return LN_SQRT_2PI + (xm + 0.5) * Math.log(t) - t + Math.log(a);
}

export function gammaFn(x: number): number {
  if (x > 171.6) return Infinity;
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gammaFn(1 - x));
  return Math.exp(lgamma(x));
}

/** ln B(a, b). */
export function lbeta(a: number, b: number): number {
  return lgamma(a) + lgamma(b) - lgamma(a + b);
}

/** ln of the binomial coefficient C(n, k) for real n >= k >= 0. */
export function lchoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

/** Digamma function ψ(x). */
export function digamma(x: number): number {
  if (x <= 0 && Math.floor(x) === x) return NaN;
  if (x < 0) return digamma(1 - x) - Math.PI / Math.tan(Math.PI * x);
  let result = 0;
  let y = x;
  while (y < 10) {
    result -= 1 / y;
    y += 1;
  }
  const f = 1 / (y * y);
  return (
    result +
    Math.log(y) -
    0.5 / y -
    f * (1 / 12 - f * (1 / 120 - f * (1 / 252 - f * (1 / 240 - f * (1 / 132)))))
  );
}

/** log(1 + exp(x)) without overflow. */
export function log1pExp(x: number): number {
  if (x > 35) return x;
  if (x < -35) return Math.exp(x);
  return Math.log1p(Math.exp(x));
}

/** log(exp(a) + exp(b)). */
export function logAddExp(a: number, b: number): number {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

export function logSumExp(xs: ArrayLike<number>): number {
  let m = -Infinity;
  for (let i = 0; i < xs.length; i++) if (xs[i]! > m) m = xs[i]!;
  if (m === -Infinity || m === Infinity) return m;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += Math.exp(xs[i]! - m);
  return m + Math.log(s);
}

export function logistic(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

// ---- incomplete gamma ---------------------------------------------------------------

const EPS = 1e-16;
const TINY = 1e-300;

function gammaSeries(a: number, x: number): number {
  // P(a, x) by its power series; converges quickly for x < a + 1.
  let ap = a;
  let del = 1 / a;
  let sum = del;
  for (let n = 0; n < 100000; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
}

function gammaContinuedFraction(a: number, x: number): number {
  // Q(a, x) by Lentz's continued fraction; converges quickly for x > a + 1.
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 100000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}

/** Regularized lower incomplete gamma P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x === Infinity) return 1;
  if (x < a + 1) return gammaSeries(a, x);
  return 1 - gammaContinuedFraction(a, x);
}

/** Regularized upper incomplete gamma Q(a, x) = 1 − P(a, x). */
export function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  if (x === Infinity) return 0;
  if (x < a + 1) return 1 - gammaSeries(a, x);
  return gammaContinuedFraction(a, x);
}

export function erf(x: number): number {
  if (x === 0) return 0;
  const p = gammaP(0.5, x * x);
  return x > 0 ? p : -p;
}

export function erfc(x: number): number {
  if (x >= 0) return gammaQ(0.5, x * x);
  return 1 + gammaP(0.5, x * x);
}

// ---- incomplete beta ----------------------------------------------------------------

function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < 200000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function betaI(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront = a * Math.log(x) + b * Math.log1p(-x) - lbeta(a, b);
  if (x < (a + 1) / (a + b + 2)) {
    return (Math.exp(lnFront) * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (Math.exp(lnFront) * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Complement 1 − I_x(a, b), accurate when the result is tiny. */
export function betaIc(a: number, b: number, x: number): number {
  if (x <= 0) return 1;
  if (x >= 1) return 0;
  const lnFront = a * Math.log(x) + b * Math.log1p(-x) - lbeta(a, b);
  if (x < (a + 1) / (a + b + 2)) {
    return 1 - (Math.exp(lnFront) * betaContinuedFraction(a, b, x)) / a;
  }
  return (Math.exp(lnFront) * betaContinuedFraction(b, a, 1 - x)) / b;
}

// ---- hypergeometric series ----------------------------------------------------------

/**
 * ln ₁F₁(a; b; z) for a, b > 0 and z >= 0 (all series terms positive, so the sum is
 * numerically stable; evaluated in a scaled form to avoid overflow).
 */
export function logHyp1f1(a: number, b: number, z: number): number {
  if (z === 0) return 0;
  if (z < 0) throw new RangeError("logHyp1f1 requires z >= 0");
  let term = 1;
  let sum = 1;
  let logScale = 0;
  for (let k = 0; k < 2000000; k++) {
    term *= ((a + k) / (b + k)) * (z / (k + 1));
    sum += term;
    if (sum > 1e250) {
      sum *= 1e-250;
      term *= 1e-250;
      logScale += 250 * Math.LN10;
    }
    // Terms rise until k ≈ z and then fall; stop once they are negligible.
    if (term < sum * 1e-17 && k + 1 > z) break;
  }
  return Math.log(sum) + logScale;
}

/**
 * Gauss hypergeometric ₂F₁(a, b; c; z) for 0 <= z < 1 by the defining series. Callers
 * should arrange for positive parameters (e.g. via Euler's transformation).
 */
export function hyp2f1(a: number, b: number, c: number, z: number): number {
  if (z === 0) return 1;
  if (z < 0 || z >= 1) throw new RangeError("hyp2f1 requires 0 <= z < 1");
  let term = 1;
  let sum = 1;
  for (let k = 0; k < 5000000; k++) {
    term *= (((a + k) * (b + k)) / ((c + k) * (k + 1))) * z;
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-16 && k > 3) break;
  }
  return sum;
}

// ---- root finding helpers -----------------------------------------------------------

/**
 * Find x in [lo, hi] with f(x) = 0 for a monotone increasing f, by bisection with
 * secant acceleration (Illinois variant of regula falsi). Robust and derivative-free.
 */
export function solveMonotone(f: (x: number) => number, lo: number, hi: number, tol = 1e-13, maxIter = 300): number {
  let a = lo;
  let b = hi;
  let fa = f(a);
  let fb = f(b);
  if (fa >= 0) return a;
  if (fb <= 0) return b;
  let side = 0;
  for (let i = 0; i < maxIter; i++) {
    let x = (a * fb - b * fa) / (fb - fa);
    if (!(x > a && x < b)) x = 0.5 * (a + b);
    const fx = f(x);
    if (Math.abs(b - a) <= tol * Math.max(1, Math.abs(x)) || fx === 0) return x;
    if (fx < 0) {
      a = x;
      fa = fx;
      if (side === -1) fb /= 2;
      side = -1;
    } else {
      b = x;
      fb = fx;
      if (side === 1) fa /= 2;
      side = 1;
    }
  }
  return 0.5 * (a + b);
}

/**
 * Root of a monotone increasing f on (0, hi], located on the log scale so that roots
 * many orders of magnitude below 1 keep full relative precision.
 */
export function solveMonotoneLog(f: (x: number) => number, hi: number, tol = 1e-14): number {
  const lx = solveMonotone((l) => f(Math.exp(l)), -744, Math.log(hi), tol, 400);
  return Math.exp(lx);
}
