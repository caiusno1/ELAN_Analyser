/**
 * Interval algebra on time-aligned annotations. All functions expect half-open reading of
 * intervals: [0,10] and [10,20] touch but do not overlap.
 */

export interface Interval {
  start: number;
  end: number;
}

export function byStart(a: Interval, b: Interval): number {
  return a.start - b.start || a.end - b.end;
}

export function totalDuration(xs: readonly Interval[]): number {
  let s = 0;
  for (const x of xs) s += x.end - x.start;
  return s;
}

/** Merge overlapping or touching intervals. Input need not be sorted. */
export function unionIntervals(xs: readonly Interval[], maxGap = 0): Interval[] {
  if (xs.length === 0) return [];
  const sorted = [...xs].sort(byStart);
  const out: Interval[] = [{ start: sorted[0]!.start, end: sorted[0]!.end }];
  for (let i = 1; i < sorted.length; i++) {
    const x = sorted[i]!;
    const last = out[out.length - 1]!;
    if (x.start <= last.end + maxGap) {
      if (x.end > last.end) last.end = x.end;
    } else {
      out.push({ start: x.start, end: x.end });
    }
  }
  return out;
}

/** Intersection of two interval sets, each given as disjoint sorted intervals. */
export function intersectCoverage(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i]!.start, b[j]!.start);
    const e = Math.min(a[i]!.end, b[j]!.end);
    if (e > s) out.push({ start: s, end: e });
    if (a[i]!.end < b[j]!.end) i++;
    else j++;
  }
  return out;
}

/** The parts of [lo, hi] not covered by `xs` (disjoint, sorted). */
export function complementCoverage(xs: readonly Interval[], lo: number, hi: number): Interval[] {
  const out: Interval[] = [];
  let cur = lo;
  for (const x of xs) {
    if (x.end <= lo) continue;
    if (x.start >= hi) break;
    if (x.start > cur) out.push({ start: cur, end: Math.min(x.start, hi) });
    if (x.end > cur) cur = x.end;
  }
  if (cur < hi) out.push({ start: cur, end: hi });
  return out;
}

/** Duration of the overlap of two intervals (0 if none). */
export function overlapDuration(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * Report every overlapping pair between two interval lists (each sorted by start).
 * Runs in O(n + m + k) for well-behaved tiers; intervals within a list may overlap.
 * Zero-length annotations count as overlapping an interval that strictly contains them.
 */
export function forEachOverlap<A extends Interval, B extends Interval>(
  a: readonly A[],
  b: readonly B[],
  cb: (i: number, j: number, start: number, end: number) => void,
): void {
  if (a.length === 0 || b.length === 0) return;
  // prefixMaxEnd[j] = max end of b[0..j]; non-decreasing, so the lower bound can advance.
  const prefixMaxEnd = new Float64Array(b.length);
  let m = -Infinity;
  for (let j = 0; j < b.length; j++) {
    if (b[j]!.end > m) m = b[j]!.end;
    prefixMaxEnd[j] = m;
  }
  // x and y overlap iff y.start < x.end && y.end > x.start. For a zero-length x this
  // reduces to "strictly inside y", and two zero-length annotations never overlap.
  let lo = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    while (lo < b.length && prefixMaxEnd[lo]! <= x.start) lo++;
    for (let j = lo; j < b.length; j++) {
      const y = b[j]!;
      if (y.start >= x.end) break;
      if (y.end > x.start) cb(i, j, Math.max(x.start, y.start), Math.min(x.end, y.end));
    }
  }
}

/** Index of the first interval with start >= t (intervals sorted by start). */
export function lowerBoundStart(xs: readonly Interval[], t: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]!.start < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Sample a tier at regular time steps. Returns, for each sample time t0 + k*dt, the index
 * of the annotation covering it (the latest-starting one if several) or -1 for none.
 */
export function sampleIndices(xs: readonly Interval[], t0: number, dt: number, n: number): Int32Array {
  const out = new Int32Array(n).fill(-1);
  let j = 0;
  // Disjoint tiers are the common case; fall back to a scan for overlapping ones.
  for (let k = 0; k < n; k++) {
    const t = t0 + k * dt;
    while (j < xs.length && xs[j]!.end <= t) j++;
    let best = -1;
    for (let q = j; q < xs.length && xs[q]!.start <= t; q++) {
      if (xs[q]!.end > t) best = q;
    }
    out[k] = best;
  }
  return out;
}

/**
 * Group consecutive intervals (sorted by start) whose silent gap is at most `maxGap` ms.
 * Returns index ranges [from, to] (inclusive).
 */
export function chainGroups(xs: readonly Interval[], maxGap: number): [number, number][] {
  const out: [number, number][] = [];
  if (xs.length === 0) return out;
  let from = 0;
  let end = xs[0]!.end;
  for (let i = 1; i < xs.length; i++) {
    const x = xs[i]!;
    if (x.start - end <= maxGap) {
      if (x.end > end) end = x.end;
    } else {
      out.push([from, i - 1]);
      from = i;
      end = x.end;
    }
  }
  out.push([from, xs.length - 1]);
  return out;
}
