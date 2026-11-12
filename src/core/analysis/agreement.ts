import { layerTiers, type CorpusFile, type TierScheme } from "../corpus/corpus.ts";
import { datasetFromRows, type Dataset, type Row } from "../data/dataset.ts";
import { forEachOverlap, intersectCoverage, totalDuration, unionIntervals, type Interval } from "../intervals.ts";
import { eti, median, summarize } from "../stats/describe.ts";
import { Rng } from "../stats/rng.ts";
import { DEFAULT_NORMALIZATION, normalizeValue, sortedByCount } from "./common.ts";
import { pairTiers } from "./cooccurrence.ts";

/**
 * Inter-annotator agreement for time-aligned annotations.
 *
 * Annotations of two raters are first *linked*: a pair counts as the same unit when the
 * overlap covers at least `minOverlap` of the longer annotation (the linking idea of
 * Holle & Rein 2015). Linked pairs and unlinked annotations fill a confusion matrix, from
 * which Cohen's κ is computed — with a posterior distribution rather than a point value.
 * A second, time-based κ compares what the raters coded at every moment.
 */

export interface AgreementOptions {
  /** Layer coded by rater 1 and by rater 2. */
  layerA: string;
  layerB: string;
  /** Required overlap as a share of the longer annotation (0–1). */
  minOverlap: number;
}

export const UNLINKED = "(no annotation)";

export interface KappaPosterior {
  kappa: number;
  observed: number;
  expected: number;
  /** Posterior median and 95% credible interval (Dirichlet prior on the cell probabilities). */
  median: number;
  ci: [number, number];
  /** Posterior probabilities that κ exceeds common benchmarks. */
  pAbove06: number;
  pAbove08: number;
}

export interface AgreementResult {
  categories: string[];
  /** confusion[i][j]: rater 1 chose category i, rater 2 category j (last = unlinked). */
  confusion: number[][];
  linked: number;
  unlinkedA: number;
  unlinkedB: number;
  /** κ over all units, unlinked ones included as their own category. */
  unitKappa: KappaPosterior;
  /** κ over linked units only: agreement on the label, given agreement on the segmentation. */
  labelKappa: KappaPosterior;
  /** Time-based κ: categories compared moment by moment, "nothing" included. */
  timeKappa: { kappa: number; observed: number; expected: number };
  /** Durations (ms) both raters assigned to each pair of categories. */
  timeConfusion: number[][];
  /** Rater 2 minus rater 1 boundary differences (ms) of linked units. */
  onsetDiff: Float64Array;
  offsetDiff: Float64Array;
  boundary: { onsetMean: number; onsetSd: number; offsetMean: number; offsetSd: number; medianAbs: number };
  perCategory: { category: string; n1: number; n2: number; both: number; kappa: number }[];
  /** Disagreements for browsing. */
  disagreements: { fileId: string; tierA: string; tierB: string; start: number; end: number; a: string; b: string }[];
  tierPairs: number;
  dataset: Dataset;
}

function kappaOf(table: number[][]): { kappa: number; observed: number; expected: number } {
  const k = table.length;
  let n = 0;
  const row = new Array<number>(k).fill(0);
  const col = new Array<number>(k).fill(0);
  let diag = 0;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
    const v = table[i]![j]!;
    n += v;
    row[i] = row[i]! + v;
    col[j] = col[j]! + v;
    if (i === j) diag += v;
  }
  if (n === 0) return { kappa: NaN, observed: NaN, expected: NaN };
  const po = diag / n;
  let pe = 0;
  for (let i = 0; i < k; i++) pe += (row[i]! / n) * (col[i]! / n);
  return { kappa: pe < 1 ? (po - pe) / (1 - pe) : NaN, observed: po, expected: pe };
}

/**
 * Posterior of Cohen's κ: the cell probabilities of the confusion matrix get a
 * Dirichlet(1/K²·K) prior (one pseudo-observation spread over the table per category),
 * and κ is computed for each posterior draw.
 */
export function kappaPosterior(table: number[][], draws = 6000, seed = 1): KappaPosterior {
  const point = kappaOf(table);
  const k = table.length;
  const prior = 1 / k;
  const alpha = table.flat().map((v) => v + prior);
  const rng = new Rng(seed);
  const p = new Float64Array(alpha.length);
  const ks = new Float64Array(draws);
  for (let d = 0; d < draws; d++) {
    rng.dirichlet(alpha, p);
    let po = 0;
    let pe = 0;
    for (let i = 0; i < k; i++) {
      let r = 0;
      let c = 0;
      for (let j = 0; j < k; j++) {
        r += p[i * k + j]!;
        c += p[j * k + i]!;
      }
      po += p[i * k + i]!;
      pe += r * c;
    }
    ks[d] = (po - pe) / (1 - pe);
  }
  let a6 = 0;
  let a8 = 0;
  for (let d = 0; d < draws; d++) {
    if (ks[d]! > 0.6) a6++;
    if (ks[d]! > 0.8) a8++;
  }
  return { ...point, median: median(ks), ci: eti(ks, 0.95), pAbove06: a6 / draws, pAbove08: a8 / draws };
}

export function analyseAgreement(files: CorpusFile[], scheme: TierScheme, opts: AgreementOptions): AgreementResult {
  const as = layerTiers(files, scheme, opts.layerA);
  const bs = layerTiers(files, scheme, opts.layerB);
  const pairs = pairTiers(as, bs, "same");
  const norm = DEFAULT_NORMALIZATION;
  const countMap = new Map<string, number>();
  for (const [i, j] of pairs) {
    for (const a of as[i]!.tier.annotations) countMap.set(normalizeValue(a.value, norm), (countMap.get(normalizeValue(a.value, norm)) ?? 0) + 1);
    for (const b of bs[j]!.tier.annotations) countMap.set(normalizeValue(b.value, norm), (countMap.get(normalizeValue(b.value, norm)) ?? 0) + 1);
  }
  const cats = sortedByCount(countMap);
  const categories = [...cats, UNLINKED];
  const idx = new Map(categories.map((c, i) => [c, i]));
  const K = categories.length;
  const none = K - 1;
  const confusion = Array.from({ length: K }, () => new Array<number>(K).fill(0));
  const timeConfusion = Array.from({ length: K }, () => new Array<number>(K).fill(0));
  const onset: number[] = [];
  const offset: number[] = [];
  const disagreements: AgreementResult["disagreements"] = [];
  let linked = 0;
  let unlinkedA = 0;
  let unlinkedB = 0;
  const rows: Row[] = [];

  for (const [i, j] of pairs) {
    const A = as[i]!;
    const B = bs[j]!;
    const a = A.tier.annotations;
    const b = B.tier.annotations;
    // Candidate links, best overlap first; each annotation is linked at most once.
    const cand: { ai: number; bi: number; ratio: number }[] = [];
    forEachOverlap(a, b, (ai, bi, s, e) => {
      const longer = Math.max(a[ai]!.end - a[ai]!.start, b[bi]!.end - b[bi]!.start);
      const ratio = longer > 0 ? (e - s) / longer : 0;
      if (ratio >= opts.minOverlap) cand.push({ ai, bi, ratio });
    });
    cand.sort((x, y) => y.ratio - x.ratio);
    const linkA = new Int32Array(a.length).fill(-1);
    const linkB = new Int32Array(b.length).fill(-1);
    for (const c of cand) {
      if (linkA[c.ai] !== -1 || linkB[c.bi] !== -1) continue;
      linkA[c.ai] = c.bi;
      linkB[c.bi] = c.ai;
    }
    let pairLinked = 0;
    let pairAgree = 0;
    for (let ai = 0; ai < a.length; ai++) {
      const va = normalizeValue(a[ai]!.value, norm);
      if (linkA[ai] === -1) {
        confusion[idx.get(va)!]![none] = confusion[idx.get(va)!]![none]! + 1;
        unlinkedA++;
        if (disagreements.length < 2000) disagreements.push({ fileId: A.file.id, tierA: A.tier.id, tierB: B.tier.id, start: a[ai]!.start, end: a[ai]!.end, a: va, b: UNLINKED });
        continue;
      }
      const bb = b[linkA[ai]!]!;
      const vb = normalizeValue(bb.value, norm);
      confusion[idx.get(va)!]![idx.get(vb)!] = confusion[idx.get(va)!]![idx.get(vb)!]! + 1;
      linked++;
      pairLinked++;
      if (va === vb) pairAgree++;
      else if (disagreements.length < 2000) disagreements.push({ fileId: A.file.id, tierA: A.tier.id, tierB: B.tier.id, start: Math.min(a[ai]!.start, bb.start), end: Math.max(a[ai]!.end, bb.end), a: va, b: vb });
      onset.push(bb.start - a[ai]!.start);
      offset.push(bb.end - a[ai]!.end);
    }
    for (let bi = 0; bi < b.length; bi++) {
      if (linkB[bi] !== -1) continue;
      const vb = normalizeValue(b[bi]!.value, norm);
      confusion[none]![idx.get(vb)!] = confusion[none]![idx.get(vb)!]! + 1;
      unlinkedB++;
      if (disagreements.length < 2000) disagreements.push({ fileId: A.file.id, tierA: A.tier.id, tierB: B.tier.id, start: b[bi]!.start, end: b[bi]!.end, a: UNLINKED, b: vb });
    }

    // Time-based comparison: joint duration of every pair of categories.
    const T = A.file.doc.duration;
    const covA = coverageByCategory(a, norm);
    const covB = coverageByCategory(b, norm);
    const anyA = unionIntervals(a);
    const anyB = unionIntervals(b);
    for (const [ca, ia] of covA) {
      for (const [cb, ib] of covB) {
        const d = totalDuration(intersectCoverage(ia, ib));
        timeConfusion[idx.get(ca)!]![idx.get(cb)!] = timeConfusion[idx.get(ca)!]![idx.get(cb)!]! + d;
      }
      // Time rater 1 coded this category while rater 2 coded nothing.
      timeConfusion[idx.get(ca)!]![none] = timeConfusion[idx.get(ca)!]![none]! + totalDuration(ia) - totalDuration(intersectCoverage(ia, anyB));
    }
    for (const [cb, ib] of covB) {
      timeConfusion[none]![idx.get(cb)!] = timeConfusion[none]![idx.get(cb)!]! + totalDuration(ib) - totalDuration(intersectCoverage(ib, anyA));
    }
    const unionAB = totalDuration(unionIntervals([...anyA, ...anyB]));
    timeConfusion[none]![none] = timeConfusion[none]![none]! + Math.max(0, T - unionAB);

    rows.push({
      file: A.file.name, participant: A.participant, tier_1: A.tier.id, tier_2: B.tier.id,
      n_1: a.length, n_2: b.length, linked: pairLinked,
      label_agreement: pairLinked ? pairAgree / pairLinked : NaN,
      linked_share: a.length + b.length ? (2 * pairLinked) / (a.length + b.length) : NaN,
    });
  }

  const labelTable = confusion.slice(0, none).map((r) => r.slice(0, none));
  const perCategory = cats.map((c, ci) => {
    // One-vs-rest κ for this category over all units.
    let both = 0;
    let n1 = 0;
    let n2 = 0;
    let total = 0;
    for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
      const v = confusion[i]![j]!;
      total += v;
      if (i === ci) n1 += v;
      if (j === ci) n2 += v;
      if (i === ci && j === ci) both += v;
    }
    const table = [[both, n1 - both], [n2 - both, total - n1 - n2 + both]];
    return { category: c, n1, n2, both, kappa: kappaOf(table).kappa };
  });
  const on = Float64Array.from(onset);
  const off = Float64Array.from(offset);
  const so = summarize(on);
  const sf = summarize(off);
  const absAll = Float64Array.from([...onset, ...offset], Math.abs);
  const dataset = datasetFromRows(
    `Agreement: ${opts.layerA} vs ${opts.layerB}`,
    "one pair of tiers",
    "Linking and label agreement between two raters, per tier pair.",
    rows,
    [
      { name: "file", type: "string" }, { name: "participant", type: "string" },
      { name: "tier_1", type: "string" }, { name: "tier_2", type: "string" },
      { name: "n_1", type: "number" }, { name: "n_2", type: "number" },
      { name: "linked", type: "number", label: "annotations both raters made" },
      { name: "label_agreement", type: "number", label: "share of linked annotations with the same value" },
      { name: "linked_share", type: "number", label: "2·linked / (n_1 + n_2)" },
    ],
  );
  return {
    categories,
    confusion,
    linked,
    unlinkedA,
    unlinkedB,
    unitKappa: kappaPosterior(confusion),
    labelKappa: kappaPosterior(labelTable.length ? labelTable : [[0]]),
    timeKappa: kappaOf(timeConfusion),
    timeConfusion,
    onsetDiff: on,
    offsetDiff: off,
    boundary: { onsetMean: so.mean, onsetSd: so.sd, offsetMean: sf.mean, offsetSd: sf.sd, medianAbs: absAll.length ? median(absAll) : NaN },
    perCategory,
    disagreements,
    tierPairs: pairs.length,
    dataset,
  };
}

function coverageByCategory(anns: { start: number; end: number; value: string }[], norm: typeof DEFAULT_NORMALIZATION): Map<string, Interval[]> {
  const by = new Map<string, Interval[]>();
  for (const a of anns) {
    const v = normalizeValue(a.value, norm);
    let list = by.get(v);
    if (!list) by.set(v, (list = []));
    list.push(a);
  }
  const out = new Map<string, Interval[]>();
  for (const [v, list] of by) out.set(v, unionIntervals(list));
  return out;
}
