/**
 * Globally adaptive Gauss–Kronrod (G7/K15) quadrature, in the style of QUADPACK's QAG.
 */

const XGK = [
  0.991455371120812639206854697526329, 0.949107912342758524526189684047851,
  0.864864423359769072789712788640926, 0.741531185599394439863864773280788,
  0.586087235467691130294144838258730, 0.405845151377397166906606412076961,
  0.207784955007898467600689403773245, 0.0,
];
const WGK = [
  0.022935322010529224963732008058970, 0.063092092629978553290700663189204,
  0.104790010322250183839876322541518, 0.140653259715525918745189590510238,
  0.169004726639267902826583426598550, 0.190350578064785409913256402421014,
  0.204432940075298892414161999234649, 0.209482141084727828012999174891714,
];
const WG = [
  0.129484966168869693270611432679082, 0.279705391489276667901467771423780,
  0.381830050505118944950369775488975, 0.417959183673469387755102040816327,
];

export interface IntegrationResult {
  value: number;
  /** Estimated absolute error. */
  error: number;
  evaluations: number;
  converged: boolean;
}

export interface IntegrationOptions {
  relTol?: number;
  absTol?: number;
  maxIntervals?: number;
  /** Interior points where the range is split up front (e.g. around a known peak). */
  points?: number[];
}

function gk15(f: (x: number) => number, a: number, b: number): { value: number; error: number } {
  const c = 0.5 * (a + b);
  const h = 0.5 * (b - a);
  const fc = f(c);
  let resK = fc * WGK[7]!;
  let resG = fc * WG[3]!;
  for (let j = 0; j < 7; j++) {
    const dx = h * XGK[j]!;
    const f1 = f(c - dx);
    const f2 = f(c + dx);
    resK += WGK[j]! * (f1 + f2);
    if (j % 2 === 1) resG += WG[(j - 1) / 2]! * (f1 + f2);
  }
  return { value: resK * h, error: Math.abs((resK - resG) * h) };
}

/** Integrate f over the finite interval [a, b]. */
export function integrate(f: (x: number) => number, a: number, b: number, opts: IntegrationOptions = {}): IntegrationResult {
  const relTol = opts.relTol ?? 1e-10;
  const absTol = opts.absTol ?? 1e-300;
  const maxIntervals = opts.maxIntervals ?? 2000;
  if (a === b) return { value: 0, error: 0, evaluations: 0, converged: true };
  if (a > b) {
    const r = integrate(f, b, a, opts);
    return { ...r, value: -r.value };
  }
  const safe = (x: number) => {
    const v = f(x);
    return Number.isFinite(v) ? v : 0;
  };
  const cuts = [a, ...(opts.points ?? []).filter((p) => p > a && p < b).sort((x, y) => x - y), b];
  const lo: number[] = [];
  const hi: number[] = [];
  const val: number[] = [];
  const err: number[] = [];
  let evaluations = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    if (cuts[i + 1]! <= cuts[i]!) continue;
    const r = gk15(safe, cuts[i]!, cuts[i + 1]!);
    evaluations += 15;
    lo.push(cuts[i]!);
    hi.push(cuts[i + 1]!);
    val.push(r.value);
    err.push(r.error);
  }
  let total = 0;
  let totalErr = 0;
  for (let i = 0; i < val.length; i++) {
    total += val[i]!;
    totalErr += err[i]!;
  }
  let converged = totalErr <= Math.max(absTol, relTol * Math.abs(total));
  while (!converged && lo.length < maxIntervals) {
    // Bisect the interval with the largest error estimate.
    let worst = 0;
    for (let i = 1; i < err.length; i++) if (err[i]! > err[worst]!) worst = i;
    const m = 0.5 * (lo[worst]! + hi[worst]!);
    if (m <= lo[worst]! || m >= hi[worst]!) break; // interval too small to split
    const left = gk15(safe, lo[worst]!, m);
    const right = gk15(safe, m, hi[worst]!);
    evaluations += 30;
    total += left.value + right.value - val[worst]!;
    totalErr += left.error + right.error - err[worst]!;
    const oldHi = hi[worst]!;
    hi[worst] = m;
    val[worst] = left.value;
    err[worst] = left.error;
    lo.push(m);
    hi.push(oldHi);
    val.push(right.value);
    err.push(right.error);
    converged = totalErr <= Math.max(absTol, relTol * Math.abs(total));
  }
  // Recompute the sums to remove accumulated rounding.
  total = 0;
  totalErr = 0;
  for (let i = 0; i < val.length; i++) {
    total += val[i]!;
    totalErr += err[i]!;
  }
  return { value: total, error: totalErr, evaluations, converged };
}

/**
 * Integrate f over [a, b] where either bound may be infinite. Infinite ranges are mapped
 * to finite ones with x = c + t/(1 − t) (half-line) or x = t/(1 − t²) (whole line).
 * `points` are given in the original variable.
 */
export function integrateInf(f: (x: number) => number, a: number, b: number, opts: IntegrationOptions = {}): IntegrationResult {
  const aInf = a === -Infinity;
  const bInf = b === Infinity;
  if (!aInf && !bInf) return integrate(f, a, b, opts);
  if (aInf && bInf) {
    const g = (t: number) => {
      const d = 1 - t * t;
      return f(t / d) * ((1 + t * t) / (d * d));
    };
    // Inverse of x = t/(1−t²): t = (sqrt(1+4x²) − 1)/(2x)
    const inv = (x: number) => (x === 0 ? 0 : (Math.sqrt(1 + 4 * x * x) - 1) / (2 * x));
    return integrate(g, -1, 1, { ...opts, points: (opts.points ?? []).map(inv) });
  }
  if (bInf) {
    const g = (t: number) => {
      const d = 1 - t;
      return f(a + t / d) / (d * d);
    };
    const inv = (x: number) => (x - a) / (1 + x - a);
    return integrate(g, 0, 1, { ...opts, points: (opts.points ?? []).map(inv) });
  }
  // (−∞, b]
  const g = (t: number) => {
    const d = 1 - t;
    return f(b - t / d) / (d * d);
  };
  const inv = (x: number) => (b - x) / (1 + b - x);
  return integrate(g, 0, 1, { ...opts, points: (opts.points ?? []).map(inv) });
}
