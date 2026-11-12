import { layerTiers, listMetaVariables, type CorpusFile, type LayerTier, type TierScheme } from "../corpus/corpus.ts";
import { datasetFromRows, type Dataset, type Row } from "../data/dataset.ts";
import type { Annotation } from "../eaf/model.ts";
import { forEachOverlap, intersectCoverage, totalDuration, unionIntervals, type Interval } from "../intervals.ts";
import { quantile } from "../stats/describe.ts";
import { Rng } from "../stats/rng.ts";
import { compileFilter, DEFAULT_NORMALIZATION, metaCells, normalizeValue, sortedByCount, type ValueFilter, type ValueNormalization } from "./common.ts";

/**
 * Co-occurrence of two layers: which values of layer X overlap in time with which
 * values of layer Y, how often, for how long, and how that compares with chance.
 */

export type Pairing = "same" | "other" | "any";

export const PAIRING_LABEL: Record<Pairing, string> = {
  same: "same participant",
  other: "different participants",
  any: "all tier pairs",
};

export interface CooccurrenceOptions {
  layerX: string;
  layerY: string;
  filterX?: ValueFilter;
  filterY?: ValueFilter;
  pairing: Pairing;
  /** Overlaps shorter than this (ms) are ignored. */
  minOverlap: number;
  normalization?: ValueNormalization;
  /** Tolerance (ms) when classifying temporal relations; one video frame is typical. */
  tolerance?: number;
  /** Keep at most this many instances for browsing. */
  maxInstances?: number;
}

export const NONE = "(none)";

export interface CoocInstance {
  fileId: string;
  xTier: string;
  yTier: string;
  xValue: string;
  yValue: string;
  xStart: number;
  xEnd: number;
  yStart: number;
  yEnd: number;
  /** Overlap duration in ms. */
  overlap: number;
  relation: AllenRelation;
}

export const ALLEN_RELATIONS = [
  "equals", "starts", "started by", "finishes", "finished by", "during", "contains",
  "overlaps", "overlapped by", "meets", "met by",
] as const;
export type AllenRelation = (typeof ALLEN_RELATIONS)[number];

export const ALLEN_DESCRIPTION: Record<AllenRelation, string> = {
  equals: "X and Y start and end together",
  starts: "X and Y start together, X ends first",
  "started by": "X and Y start together, Y ends first",
  finishes: "X starts later, both end together",
  "finished by": "Y starts later, both end together",
  during: "X lies inside Y",
  contains: "Y lies inside X",
  overlaps: "X starts first and ends inside Y",
  "overlapped by": "Y starts first and ends inside X",
  meets: "X ends where Y starts",
  "met by": "Y ends where X starts",
};

/** Allen's (1983) interval relation between X and Y, with a tolerance for "same time". */
export function allenRelation(xs: number, xe: number, ys: number, ye: number, tol: number): AllenRelation | "before" | "after" {
  const eq = (a: number, b: number) => Math.abs(a - b) <= tol;
  const sameStart = eq(xs, ys);
  const sameEnd = eq(xe, ye);
  if (sameStart && sameEnd) return "equals";
  if (sameStart) return xe < ye ? "starts" : "started by";
  if (sameEnd) return xs > ys ? "finishes" : "finished by";
  if (eq(xe, ys)) return "meets";
  if (eq(ye, xs)) return "met by";
  if (xe < ys) return "before";
  if (ye < xs) return "after";
  if (xs > ys && xe < ye) return "during";
  if (xs < ys && xe > ye) return "contains";
  return xs < ys ? "overlaps" : "overlapped by";
}

export interface TimeAssociation {
  xValue: string;
  yValue: string;
  /** Joint time in ms. */
  joint: number;
  /** Time (ms) with the X value / the Y value. */
  xTime: number;
  yTime: number;
  /** Joint time expected if the two were independent. */
  expected: number;
  /** Observed / expected joint time. */
  lift: number;
  /** Time-based odds ratio and Yule's Q. */
  oddsRatio: number;
  yuleQ: number;
  /** Share of X-time during which Y is present, and vice versa. */
  pYgivenX: number;
  pXgivenY: number;
  /** Intersection over union of the two coverages. */
  jaccard: number;
}

export interface CooccurrenceResult {
  xValues: string[];
  /** Y values followed by "(none)". */
  yValues: string[];
  /** Number of overlapping annotation pairs per value pair (no "(none)" column). */
  pairCounts: number[][];
  /** Summed overlap duration (ms) per value pair. */
  overlapMs: number[][];
  /**
   * X-anchored table: every X annotation is counted once, under the Y value it overlaps
   * most, or under "(none)". This is the table to test for association.
   */
  anchored: number[][];
  xCounts: number[];
  association: TimeAssociation[];
  relations: Record<AllenRelation, number>;
  /** Y onset minus X onset, and Y offset minus X offset (ms), for overlapping pairs. */
  onsetLags: Float64Array;
  offsetLags: Float64Array;
  instances: CoocInstance[];
  totalInstances: number;
  tierPairs: number;
  /** Observation time summed over the tier pairs (ms). */
  observedMs: number;
  dataset: Dataset;
  error?: string;
}

interface PreparedTier {
  lt: LayerTier;
  anns: Annotation[];
  values: string[];
}

function prepare(lts: LayerTier[], filter: ValueFilter | undefined, norm: ValueNormalization): { tiers: PreparedTier[]; error?: string } {
  const { test, error } = compileFilter(filter);
  const tiers = lts.map((lt) => {
    const anns = lt.tier.annotations.filter((a) => test(a.value));
    return { lt, anns, values: anns.map((a) => normalizeValue(a.value, norm)) };
  });
  return error ? { tiers, error } : { tiers };
}

export function pairTiers(xs: LayerTier[], ys: LayerTier[], pairing: Pairing): [number, number][] {
  const out: [number, number][] = [];
  xs.forEach((x, i) => {
    ys.forEach((y, j) => {
      if (x.file.id !== y.file.id) return;
      if (x.tier.id === y.tier.id) return;
      if (pairing === "same" && x.participant && y.participant && x.participant !== y.participant) return;
      if (pairing === "other" && (!x.participant || !y.participant || x.participant === y.participant)) return;
      out.push([i, j]);
    });
  });
  return out;
}

function assoc(xValue: string, yValue: string, joint: number, xTime: number, yTime: number, total: number): TimeAssociation {
  const expected = total > 0 ? (xTime * yTime) / total : NaN;
  const a = joint;
  const b = xTime - joint;
  const c = yTime - joint;
  const d = total - xTime - yTime + joint;
  // Half a "second" of smoothing keeps the odds ratio finite for empty cells.
  const k = 500;
  const oddsRatio = ((a + k) * (d + k)) / ((b + k) * (c + k));
  const union = xTime + yTime - joint;
  return {
    xValue,
    yValue,
    joint,
    xTime,
    yTime,
    expected,
    lift: expected > 0 ? joint / expected : NaN,
    oddsRatio,
    yuleQ: (oddsRatio - 1) / (oddsRatio + 1),
    pYgivenX: xTime > 0 ? joint / xTime : NaN,
    pXgivenY: yTime > 0 ? joint / yTime : NaN,
    jaccard: union > 0 ? joint / union : NaN,
  };
}

export function cooccurrence(files: CorpusFile[], scheme: TierScheme, opts: CooccurrenceOptions): CooccurrenceResult {
  const norm = opts.normalization ?? DEFAULT_NORMALIZATION;
  const tol = opts.tolerance ?? 40;
  const maxInstances = opts.maxInstances ?? 5000;
  const px = prepare(layerTiers(files, scheme, opts.layerX), opts.filterX, norm);
  const py = prepare(layerTiers(files, scheme, opts.layerY), opts.filterY, norm);
  const pairs = pairTiers(px.tiers.map((t) => t.lt), py.tiers.map((t) => t.lt), opts.pairing);
  const metaVars = listMetaVariables(files);

  // Value inventories over the tiers that take part.
  const xCountMap = new Map<string, number>();
  const yCountMap = new Map<string, number>();
  const usedX = new Set<number>();
  const usedY = new Set<number>();
  for (const [i, j] of pairs) {
    usedX.add(i);
    usedY.add(j);
  }
  for (const i of usedX) for (const v of px.tiers[i]!.values) xCountMap.set(v, (xCountMap.get(v) ?? 0) + 1);
  for (const j of usedY) for (const v of py.tiers[j]!.values) yCountMap.set(v, (yCountMap.get(v) ?? 0) + 1);
  const xValues = sortedByCount(xCountMap);
  const yOnly = sortedByCount(yCountMap);
  const xIndex = new Map(xValues.map((v, i) => [v, i]));
  const yIndex = new Map(yOnly.map((v, i) => [v, i]));
  const nx = xValues.length;
  const ny = yOnly.length;

  const pairCounts = Array.from({ length: nx }, () => new Array<number>(ny).fill(0));
  const overlapMs = Array.from({ length: nx }, () => new Array<number>(ny).fill(0));
  const anchored = Array.from({ length: nx }, () => new Array<number>(ny + 1).fill(0));
  const xCounts = new Array<number>(nx).fill(0);
  const relations = Object.fromEntries(ALLEN_RELATIONS.map((r) => [r, 0])) as Record<AllenRelation, number>;
  const onsetLags: number[] = [];
  const offsetLags: number[] = [];
  const instances: CoocInstance[] = [];
  let totalInstances = 0;
  let observedMs = 0;
  // Time-based sums per value pair.
  const jointT = Array.from({ length: nx }, () => new Array<number>(ny).fill(0));
  const xT = Array.from({ length: nx }, () => new Array<number>(ny).fill(0));
  const yT = Array.from({ length: nx }, () => new Array<number>(ny).fill(0));
  const dsRows: Row[] = [];

  for (const [i, j] of pairs) {
    const X = px.tiers[i]!;
    const Y = py.tiers[j]!;
    const T = X.lt.file.doc.duration;
    observedMs += T;
    // Best-overlapping Y for every X annotation.
    const best = new Int32Array(X.anns.length).fill(-1);
    const bestOv = new Float64Array(X.anns.length);
    forEachOverlap(X.anns, Y.anns, (a, b, s, e) => {
      const ov = e - s;
      if (ov < opts.minOverlap) return;
      const xa = X.anns[a]!;
      const ya = Y.anns[b]!;
      const xi = xIndex.get(X.values[a]!)!;
      const yi = yIndex.get(Y.values[b]!)!;
      pairCounts[xi]![yi] = pairCounts[xi]![yi]! + 1;
      overlapMs[xi]![yi] = overlapMs[xi]![yi]! + ov;
      if (best[a] === -1 || ov > bestOv[a]!) {
        best[a] = b;
        bestOv[a] = ov;
      }
      const rel = allenRelation(xa.start, xa.end, ya.start, ya.end, tol);
      if (rel !== "before" && rel !== "after") relations[rel]++;
      onsetLags.push(ya.start - xa.start);
      offsetLags.push(ya.end - xa.end);
      totalInstances++;
      if (instances.length < maxInstances && rel !== "before" && rel !== "after") {
        instances.push({
          fileId: X.lt.file.id, xTier: X.lt.tier.id, yTier: Y.lt.tier.id,
          xValue: X.values[a]!, yValue: Y.values[b]!,
          xStart: xa.start, xEnd: xa.end, yStart: ya.start, yEnd: ya.end, overlap: ov, relation: rel,
        });
      }
    });
    const xWithY = new Map<string, number>();
    const xN = new Map<string, number>();
    for (let a = 0; a < X.anns.length; a++) {
      const xi = xIndex.get(X.values[a]!)!;
      xCounts[xi] = xCounts[xi]! + 1;
      const col = best[a] === -1 ? ny : yIndex.get(Y.values[best[a]!]!)!;
      anchored[xi]![col] = anchored[xi]![col]! + 1;
      xN.set(X.values[a]!, (xN.get(X.values[a]!) ?? 0) + 1);
      if (best[a] !== -1) xWithY.set(X.values[a]!, (xWithY.get(X.values[a]!) ?? 0) + 1);
    }
    // Time-based coverage per value.
    const covX = coverageByValue(X);
    const covY = coverageByValue(Y);
    for (const [xv, cx] of covX) {
      const xi = xIndex.get(xv)!;
      const tx = totalDuration(cx);
      for (const [yv, cy] of covY) {
        const yi = yIndex.get(yv)!;
        const joint = totalDuration(intersectCoverage(cx, cy));
        const ty = totalDuration(cy);
        jointT[xi]![yi] = jointT[xi]![yi]! + joint;
        xT[xi]![yi] = xT[xi]![yi]! + tx;
        yT[xi]![yi] = yT[xi]![yi]! + ty;
        const m = assoc(xv, yv, joint, tx, ty, T);
        dsRows.push({
          file: X.lt.file.name,
          ...metaCells(X.lt.file, metaVars),
          x_tier: X.lt.tier.id,
          y_tier: Y.lt.tier.id,
          x_participant: X.lt.participant,
          y_participant: Y.lt.participant,
          x_value: xv,
          y_value: yv,
          x_n: xN.get(xv) ?? 0,
          x_n_with_y: countAnchored(X, Y, best, xv, yv),
          joint_s: joint / 1000,
          x_time_s: tx / 1000,
          y_time_s: ty / 1000,
          expected_joint_s: m.expected / 1000,
          log_lift: m.lift > 0 ? Math.log(m.lift) : NaN,
          log_odds_ratio: Math.log(m.oddsRatio),
          p_y_given_x: m.pYgivenX,
        });
      }
    }
  }

  const association: TimeAssociation[] = [];
  // Pooled association: the 2×2 time table is summed over tier pairs.
  for (let xi = 0; xi < nx; xi++) {
    for (let yi = 0; yi < ny; yi++) {
      if (xT[xi]![yi] === 0 && yT[xi]![yi] === 0) continue;
      association.push(assoc(xValues[xi]!, yOnly[yi]!, jointT[xi]![yi]!, xT[xi]![yi]!, yT[xi]![yi]!, observedMsFor(pairs, px, py, xValues[xi]!, yOnly[yi]!)));
    }
  }

  const metaSpec = metaVars.map((v) => ({ name: v, type: "string" as const, label: "file variable" }));
  const dataset = datasetFromRows(
    `Co-occurrence: ${opts.layerX} × ${opts.layerY}`,
    "one value pair in one tier pair",
    `Time-based association between “${opts.layerX}” and “${opts.layerY}” (${PAIRING_LABEL[opts.pairing]}).`,
    dsRows,
    [
      { name: "file", type: "string" }, ...metaSpec,
      { name: "x_tier", type: "string" }, { name: "y_tier", type: "string" },
      { name: "x_participant", type: "string" }, { name: "y_participant", type: "string" },
      { name: "x_value", type: "string" }, { name: "y_value", type: "string" },
      { name: "x_n", type: "number", label: "number of X annotations with this value" },
      { name: "x_n_with_y", type: "number", label: "of those, how many overlap this Y value most" },
      { name: "joint_s", type: "number", label: "time both are present" },
      { name: "x_time_s", type: "number" }, { name: "y_time_s", type: "number" },
      { name: "expected_joint_s", type: "number", label: "joint time expected under independence" },
      { name: "log_lift", type: "number", label: "ln(observed / expected joint time)" },
      { name: "log_odds_ratio", type: "number", label: "ln of the time-based odds ratio" },
      { name: "p_y_given_x", type: "number", label: "share of X time during which Y is present" },
    ],
  );

  const result: CooccurrenceResult = {
    xValues,
    yValues: [...yOnly, NONE],
    pairCounts,
    overlapMs,
    anchored,
    xCounts,
    association,
    relations,
    onsetLags: Float64Array.from(onsetLags),
    offsetLags: Float64Array.from(offsetLags),
    instances,
    totalInstances,
    tierPairs: pairs.length,
    observedMs,
    dataset,
  };
  const error = px.error ?? py.error;
  if (error) result.error = error;
  return result;
}

function coverageByValue(t: PreparedTier): Map<string, Interval[]> {
  const by = new Map<string, Interval[]>();
  t.anns.forEach((a, i) => {
    const v = t.values[i]!;
    let list = by.get(v);
    if (!list) by.set(v, (list = []));
    list.push(a);
  });
  const out = new Map<string, Interval[]>();
  for (const [v, list] of by) out.set(v, unionIntervals(list));
  return out;
}

function countAnchored(X: PreparedTier, Y: PreparedTier, best: Int32Array, xv: string, yv: string): number {
  let n = 0;
  for (let a = 0; a < X.anns.length; a++) {
    if (X.values[a] === xv && best[a] !== -1 && Y.values[best[a]!] === yv) n++;
  }
  return n;
}

/** Observation time of the tier pairs in which both values occur at all. */
function observedMsFor(
  pairs: [number, number][],
  px: { tiers: PreparedTier[] },
  py: { tiers: PreparedTier[] },
  xv: string,
  yv: string,
): number {
  let t = 0;
  for (const [i, j] of pairs) {
    if (px.tiers[i]!.values.includes(xv) && py.tiers[j]!.values.includes(yv)) t += px.tiers[i]!.lt.file.doc.duration;
  }
  return t;
}

export interface SurrogateBand {
  mean: number[][];
  lower: number[][];
  upper: number[][];
}

export interface CooccurrenceSurrogates {
  /** Chance reference for the pair counts. */
  counts: SurrogateBand;
  /** Chance reference for the overlap durations (ms). */
  overlap: SurrogateBand;
  n: number;
}

/**
 * Chance reference by circular time shifts: the Y tier of every tier pair is rotated by
 * a random amount, which keeps each tier's own structure (number, durations, order of
 * annotations) but destroys the temporal coupling between X and Y.
 */
export function cooccurrenceSurrogates(
  files: CorpusFile[],
  scheme: TierScheme,
  opts: CooccurrenceOptions,
  n = 200,
  seed = 1,
): CooccurrenceSurrogates {
  const norm = opts.normalization ?? DEFAULT_NORMALIZATION;
  const px = prepare(layerTiers(files, scheme, opts.layerX), opts.filterX, norm);
  const py = prepare(layerTiers(files, scheme, opts.layerY), opts.filterY, norm);
  const pairs = pairTiers(px.tiers.map((t) => t.lt), py.tiers.map((t) => t.lt), opts.pairing);
  const base = cooccurrence(files, scheme, { ...opts, maxInstances: 0 });
  const xIndex = new Map(base.xValues.map((v, i) => [v, i]));
  const yIndex = new Map(base.yValues.map((v, i) => [v, i]));
  const nx = base.xValues.length;
  const ny = base.yValues.length - 1;
  const rng = new Rng(seed);
  const countDraws = Array.from({ length: nx * ny }, () => new Float64Array(n));
  const ovDraws = Array.from({ length: nx * ny }, () => new Float64Array(n));
  for (let s = 0; s < n; s++) {
    for (const [i, j] of pairs) {
      const X = px.tiers[i]!;
      const Y = py.tiers[j]!;
      const T = X.lt.file.doc.duration;
      if (T <= 0) continue;
      const shift = rng.range(0, T);
      // Rotate Y; annotations crossing the end wrap around as two pieces of one unit.
      const pieces: { start: number; end: number; id: number }[] = [];
      Y.anns.forEach((a, id) => {
        const st = (a.start + shift) % T;
        const en = st + (a.end - a.start);
        if (en <= T) pieces.push({ start: st, end: en, id });
        else {
          pieces.push({ start: st, end: T, id });
          pieces.push({ start: 0, end: en - T, id });
        }
      });
      pieces.sort((p, q) => p.start - q.start || p.end - q.end);
      const seen = new Map<number, number>();
      forEachOverlap(X.anns, pieces, (a, b, st, en) => {
        const key = a * 1048576 + pieces[b]!.id;
        seen.set(key, (seen.get(key) ?? 0) + (en - st));
      });
      for (const [key, ov] of seen) {
        if (ov < opts.minOverlap) continue;
        const a = Math.floor(key / 1048576);
        const b = key % 1048576;
        const cell = xIndex.get(X.values[a]!)! * ny + yIndex.get(Y.values[b]!)!;
        countDraws[cell]![s] = countDraws[cell]![s]! + 1;
        ovDraws[cell]![s] = ovDraws[cell]![s]! + ov;
      }
    }
  }
  const band = (draws: Float64Array[]): SurrogateBand => {
    const mk = () => Array.from({ length: nx }, () => new Array<number>(ny).fill(0));
    const out: SurrogateBand = { mean: mk(), lower: mk(), upper: mk() };
    for (let xi = 0; xi < nx; xi++) {
      for (let yi = 0; yi < ny; yi++) {
        const d = draws[xi * ny + yi]!;
        let sum = 0;
        for (let k = 0; k < n; k++) sum += d[k]!;
        out.mean[xi]![yi] = sum / n;
        out.lower[xi]![yi] = quantile(d, 0.025);
        out.upper[xi]![yi] = quantile(d, 0.975);
      }
    }
    return out;
  };
  return { counts: band(countDraws), overlap: band(ovDraws), n };
}
