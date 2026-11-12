/** Descriptive statistics and small numeric helpers shared by the analyses. */

export function sum(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return s;
}

export function mean(xs: ArrayLike<number>): number {
  return xs.length === 0 ? NaN : sum(xs) / xs.length;
}

/** Sample variance (n − 1 denominator). */
export function variance(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i]! - m;
    s += d * d;
  }
  return s / (n - 1);
}

export function sd(xs: ArrayLike<number>): number {
  return Math.sqrt(variance(xs));
}

export function sortedCopy(xs: ArrayLike<number>): Float64Array {
  const out = Float64Array.from(xs as ArrayLike<number>);
  out.sort();
  return out;
}

/** Quantile of sorted data with linear interpolation (R type 7). */
export function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (p <= 0) return sorted[0]!;
  if (p >= 1) return sorted[n - 1]!;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const frac = h - lo;
  return lo + 1 < n ? sorted[lo]! + frac * (sorted[lo + 1]! - sorted[lo]!) : sorted[lo]!;
}

export function quantile(xs: ArrayLike<number>, p: number): number {
  return quantileSorted(sortedCopy(xs), p);
}

export function median(xs: ArrayLike<number>): number {
  return quantile(xs, 0.5);
}

/** Median absolute deviation, scaled to be consistent with the SD for normal data. */
export function mad(xs: ArrayLike<number>): number {
  const m = median(xs);
  const dev = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) dev[i] = Math.abs(xs[i]! - m);
  return 1.4826 * median(dev);
}

export interface Summary {
  n: number;
  mean: number;
  sd: number;
  se: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  sum: number;
}

export function summarize(xs: ArrayLike<number>): Summary {
  const n = xs.length;
  if (n === 0) {
    return { n: 0, mean: NaN, sd: NaN, se: NaN, min: NaN, q1: NaN, median: NaN, q3: NaN, max: NaN, sum: 0 };
  }
  const s = sortedCopy(xs);
  const m = mean(xs);
  const sdev = n > 1 ? sd(xs) : NaN;
  return {
    n,
    mean: m,
    sd: sdev,
    se: sdev / Math.sqrt(n),
    min: s[0]!,
    q1: quantileSorted(s, 0.25),
    median: quantileSorted(s, 0.5),
    q3: quantileSorted(s, 0.75),
    max: s[n - 1]!,
    sum: sum(xs),
  };
}

/** Shortest interval containing `mass` of the samples (highest-density interval). */
export function hdi(samples: ArrayLike<number>, mass = 0.95): [number, number] {
  const s = sortedCopy(samples);
  const n = s.length;
  if (n === 0) return [NaN, NaN];
  const k = Math.max(1, Math.ceil(mass * n));
  if (k >= n) return [s[0]!, s[n - 1]!];
  let best = 0;
  let width = Infinity;
  for (let i = 0; i + k < n; i++) {
    const w = s[i + k]! - s[i]!;
    if (w < width) {
      width = w;
      best = i;
    }
  }
  return [s[best]!, s[best + k]!];
}

/** Equal-tailed interval from samples. */
export function eti(samples: ArrayLike<number>, mass = 0.95): [number, number] {
  const s = sortedCopy(samples);
  const a = (1 - mass) / 2;
  return [quantileSorted(s, a), quantileSorted(s, 1 - a)];
}

export function pearson(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const n = Math.min(x.length, y.length);
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

/** Ranks with ties given their average rank (1-based). */
export function ranks(xs: ArrayLike<number>): Float64Array {
  const n = xs.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
  const out = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && xs[idx[j + 1]!]! === xs[idx[i]!]!) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]!] = r;
    i = j + 1;
  }
  return out;
}

export function linspace(a: number, b: number, n: number): Float64Array {
  const out = new Float64Array(n);
  if (n === 1) {
    out[0] = a;
    return out;
  }
  const step = (b - a) / (n - 1);
  for (let i = 0; i < n; i++) out[i] = a + i * step;
  out[n - 1] = b; // exact endpoint, free of accumulated rounding
  return out;
}

/** Gaussian kernel density estimate on a regular grid (Silverman's rule of thumb). */
export function kde(
  xs: ArrayLike<number>,
  opts: { points?: number; lo?: number; hi?: number; bandwidth?: number } = {},
): { x: Float64Array; y: Float64Array; bandwidth: number } {
  const n = xs.length;
  const points = opts.points ?? 200;
  if (n === 0) return { x: new Float64Array(0), y: new Float64Array(0), bandwidth: NaN };
  const s = sortedCopy(xs);
  const sdev = n > 1 ? sd(xs) : 0;
  const iqr = quantileSorted(s, 0.75) - quantileSorted(s, 0.25);
  let spread = Math.min(sdev || Infinity, iqr > 0 ? iqr / 1.349 : Infinity);
  if (!Number.isFinite(spread) || spread === 0) spread = sdev || Math.abs(s[0]!) * 0.1 || 1;
  const h = opts.bandwidth ?? 0.9 * spread * Math.pow(n, -0.2);
  const lo = opts.lo ?? s[0]! - 3 * h;
  const hi = opts.hi ?? s[n - 1]! + 3 * h;
  const x = linspace(lo, hi, points);
  const y = new Float64Array(points);
  const norm = 1 / (n * h * Math.sqrt(2 * Math.PI));
  // Sorted data lets each grid point touch only the samples within 5 bandwidths.
  let start = 0;
  for (let i = 0; i < points; i++) {
    const xi = x[i]!;
    while (start < n && s[start]! < xi - 5 * h) start++;
    let acc = 0;
    for (let j = start; j < n && s[j]! <= xi + 5 * h; j++) {
      const z = (xi - s[j]!) / h;
      acc += Math.exp(-0.5 * z * z);
    }
    y[i] = acc * norm;
  }
  return { x, y, bandwidth: h };
}

/** Trapezoid cumulative integral of y over x; returns an array of the same length. */
export function cumulativeTrapezoid(x: ArrayLike<number>, y: ArrayLike<number>): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  for (let i = 1; i < n; i++) out[i] = out[i - 1]! + 0.5 * (y[i]! + y[i - 1]!) * (x[i]! - x[i - 1]!);
  return out;
}

/** Invert a tabulated, non-decreasing CDF by linear interpolation. */
export function invertCdf(x: ArrayLike<number>, cdf: ArrayLike<number>, p: number): number {
  const n = x.length;
  if (p <= cdf[0]!) return x[0]!;
  if (p >= cdf[n - 1]!) return x[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (cdf[mid]! <= p) lo = mid;
    else hi = mid;
  }
  const span = cdf[hi]! - cdf[lo]!;
  return span > 0 ? x[lo]! + ((p - cdf[lo]!) / span) * (x[hi]! - x[lo]!) : x[lo]!;
}
