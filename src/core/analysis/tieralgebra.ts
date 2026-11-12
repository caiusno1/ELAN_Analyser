import { layerTiers, roleOf, type CorpusFile, type TierScheme } from "../corpus/corpus.ts";
import type { Annotation, Tier } from "../eaf/model.ts";
import { complementCoverage, forEachOverlap, unionIntervals } from "../intervals.ts";
import { compileDropPattern, tokenizeAnnotation, type TokenizerOptions } from "../text/tokenize.ts";
import { analyseAlignment, alignmentAnnotations, type AlignmentOptions } from "./alignment.ts";
import { compileFilter, DEFAULT_NORMALIZATION, normalizeValue, type ValueFilter } from "./common.ts";
import { pairTiers, type Pairing } from "./cooccurrence.ts";
import { analyseTurnTaking, floorAnnotations, type TurnTakingOptions } from "./turntaking.ts";

/**
 * Tier algebra: new tiers computed from existing ones. Derived tiers behave like any
 * other tier (they can be viewed, analysed, combined again and exported to ELAN), which
 * turns the fixed analyses into a workbench: "gestures that overlap partner-directed
 * gaze", "pauses longer than a second", "the 500 ms before every turn end" ...
 */

export type DeriveOp =
  | { kind: "filter"; layer: string; filter: ValueFilter; minDuration: number; maxDuration: number }
  | { kind: "recode"; layer: string; pattern: string; replacement: string }
  | { kind: "overlap"; layerX: string; layerY: string; pairing: Pairing; label: "x" | "y" | "both"; filterX?: ValueFilter; filterY?: ValueFilter }
  | { kind: "exclude"; layerX: string; layerY: string; pairing: Pairing; filterY?: ValueFilter }
  | { kind: "union"; layers: string[]; label: string }
  | { kind: "gaps"; layer: string; label: string; minDuration: number }
  | { kind: "chain"; layer: string; maxGap: number; join: "text" | "count" | "first" }
  | { kind: "tokens"; layer: string; tokenizer: TokenizerOptions }
  | { kind: "window"; layer: string; anchor: "start" | "end" | "span"; before: number; after: number }
  | { kind: "floor"; options: TurnTakingOptions }
  | { kind: "alignment"; options: AlignmentOptions };

export const DERIVE_LABEL: Record<DeriveOp["kind"], { title: string; description: string }> = {
  filter: { title: "Filter", description: "Keep annotations by value or duration." },
  recode: { title: "Recode values", description: "Rewrite values with a search-and-replace pattern, e.g. to merge categories." },
  overlap: { title: "Overlap (AND)", description: "The stretches where annotations of two layers overlap." },
  exclude: { title: "Without (AND NOT)", description: "Annotations of one layer that do not overlap another layer." },
  union: { title: "Merge layers (OR)", description: "Combine several layers into one: any activity on any of them." },
  gaps: { title: "Gaps (NOT)", description: "The stretches with no annotation, e.g. silent pauses." },
  chain: { title: "Join neighbours", description: "Merge annotations separated by short gaps, e.g. utterances into turns." },
  tokens: { title: "Split into words", description: "One annotation per word of a transcription tier (times interpolated)." },
  window: { title: "Time windows", description: "A window around the start or end of each annotation." },
  floor: { title: "Gaps, pauses and overlaps", description: "Turn-taking states computed from speech tiers." },
  alignment: { title: "Alignment instances", description: "Every re-use of the other speaker's expressions." },
};

export interface DerivedTier {
  fileId: string;
  participant: string;
  annotations: { start: number; end: number; value: string }[];
}

let idCounter = 0;

function clean(anns: { start: number; end: number; value: string }[]): { start: number; end: number; value: string }[] {
  return anns
    .filter((a) => a.end > a.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Compute the derived tiers of an operation (without adding them to the corpus). */
export function derive(files: CorpusFile[], scheme: TierScheme, op: DeriveOp): { tiers: DerivedTier[]; error?: string } {
  const out: DerivedTier[] = [];
  let error: string | undefined;
  const norm = DEFAULT_NORMALIZATION;
  switch (op.kind) {
    case "filter": {
      const f = compileFilter(op.filter);
      error = f.error;
      for (const lt of layerTiers(files, scheme, op.layer)) {
        const anns = lt.tier.annotations.filter((a) => {
          const d = a.end - a.start;
          return f.test(a.value) && d >= op.minDuration && (op.maxDuration <= 0 || d <= op.maxDuration);
        });
        out.push({ fileId: lt.file.id, participant: lt.participant, annotations: anns.map((a) => ({ start: a.start, end: a.end, value: a.value })) });
      }
      break;
    }
    case "recode": {
      let re: RegExp | undefined;
      try {
        re = new RegExp(op.pattern, "giu");
      } catch (e) {
        error = `Invalid regular expression: ${(e as Error).message}`;
      }
      for (const lt of layerTiers(files, scheme, op.layer)) {
        out.push({
          fileId: lt.file.id,
          participant: lt.participant,
          annotations: lt.tier.annotations.map((a) => ({ start: a.start, end: a.end, value: re ? a.value.replace(re, op.replacement) : a.value })),
        });
      }
      break;
    }
    case "overlap":
    case "exclude": {
      const fx = compileFilter(op.kind === "overlap" ? op.filterX : undefined);
      const fy = compileFilter(op.filterY);
      error = fx.error ?? fy.error;
      const xs = layerTiers(files, scheme, op.layerX);
      const ys = layerTiers(files, scheme, op.layerY);
      const pairs = pairTiers(xs, ys, op.pairing);
      // Group the Y partners of each X tier.
      const byX = new Map<number, number[]>();
      for (const [i, j] of pairs) byX.set(i, [...(byX.get(i) ?? []), j]);
      for (const [i, js] of byX) {
        const X = xs[i]!;
        const xa = X.tier.annotations.filter((a) => fx.test(a.value));
        const anns: { start: number; end: number; value: string }[] = [];
        if (op.kind === "overlap") {
          for (const j of js) {
            const ya = ys[j]!.tier.annotations.filter((a) => fy.test(a.value));
            forEachOverlap(xa, ya, (a, b, s, e) => {
              const xv = normalizeValue(xa[a]!.value, norm);
              const yv = normalizeValue(ya[b]!.value, norm);
              anns.push({ start: s, end: e, value: op.label === "x" ? xv : op.label === "y" ? yv : `${xv} + ${yv}` });
            });
          }
        } else {
          const hit = new Uint8Array(xa.length);
          for (const j of js) {
            const ya = ys[j]!.tier.annotations.filter((a) => fy.test(a.value));
            forEachOverlap(xa, ya, (a) => {
              hit[a] = 1;
            });
          }
          xa.forEach((a, k) => {
            if (!hit[k]) anns.push({ start: a.start, end: a.end, value: a.value });
          });
        }
        out.push({ fileId: X.file.id, participant: X.participant, annotations: clean(anns) });
      }
      break;
    }
    case "union": {
      const groups = new Map<string, DerivedTier & { raw: { start: number; end: number }[] }>();
      for (const layer of op.layers) {
        for (const lt of layerTiers(files, scheme, layer)) {
          const key = `${lt.file.id}\u0001${lt.participant}`;
          let g = groups.get(key);
          if (!g) groups.set(key, (g = { fileId: lt.file.id, participant: lt.participant, annotations: [], raw: [] }));
          g.raw.push(...lt.tier.annotations);
        }
      }
      for (const g of groups.values()) {
        out.push({ fileId: g.fileId, participant: g.participant, annotations: unionIntervals(g.raw).map((iv) => ({ ...iv, value: op.label })) });
      }
      break;
    }
    case "gaps": {
      for (const lt of layerTiers(files, scheme, op.layer)) {
        const cov = unionIntervals(lt.tier.annotations);
        const gaps = complementCoverage(cov, 0, lt.file.doc.duration).filter((g) => g.end - g.start >= op.minDuration);
        out.push({ fileId: lt.file.id, participant: lt.participant, annotations: gaps.map((g) => ({ ...g, value: op.label })) });
      }
      break;
    }
    case "chain": {
      for (const lt of layerTiers(files, scheme, op.layer)) {
        const anns: { start: number; end: number; value: string }[] = [];
        let cur: { start: number; end: number; parts: string[] } | undefined;
        const flush = () => {
          if (!cur) return;
          const value = op.join === "text" ? cur.parts.join(" ") : op.join === "count" ? String(cur.parts.length) : cur.parts[0]!;
          anns.push({ start: cur.start, end: cur.end, value });
        };
        for (const a of lt.tier.annotations) {
          if (cur && a.start - cur.end <= op.maxGap) {
            cur.end = Math.max(cur.end, a.end);
            cur.parts.push(a.value);
          } else {
            flush();
            cur = { start: a.start, end: a.end, parts: [a.value] };
          }
        }
        flush();
        out.push({ fileId: lt.file.id, participant: lt.participant, annotations: anns });
      }
      break;
    }
    case "tokens": {
      const drop = compileDropPattern(op.tokenizer.dropPattern);
      for (const lt of layerTiers(files, scheme, op.layer)) {
        const anns: { start: number; end: number; value: string }[] = [];
        for (const a of lt.tier.annotations) {
          for (const t of tokenizeAnnotation(a, op.tokenizer, drop)) anns.push({ start: Math.round(t.start), end: Math.round(t.end), value: t.norm });
        }
        out.push({ fileId: lt.file.id, participant: lt.participant, annotations: clean(anns) });
      }
      break;
    }
    case "window": {
      for (const lt of layerTiers(files, scheme, op.layer)) {
        const T = lt.file.doc.duration;
        const anns = lt.tier.annotations.map((a) => {
          const from = op.anchor === "end" ? a.end : a.start;
          const to = op.anchor === "start" ? a.start : a.end;
          return { start: Math.max(0, from - op.before), end: Math.min(T, to + op.after), value: a.value };
        });
        out.push({ fileId: lt.file.id, participant: lt.participant, annotations: clean(anns) });
      }
      break;
    }
    case "floor": {
      const res = analyseTurnTaking(files, scheme, op.options);
      error = res.error;
      for (const f of res.files) out.push({ fileId: f.fileId, participant: "", annotations: floorAnnotations(f) });
      break;
    }
    case "alignment": {
      const res = analyseAlignment(files, scheme, op.options);
      for (const f of res.files) {
        for (const [speaker, annotations] of alignmentAnnotations(f)) out.push({ fileId: f.fileId, participant: speaker, annotations });
      }
      break;
    }
  }
  return error ? { tiers: out, error } : { tiers: out };
}

/**
 * Add derived tiers to the corpus under a new layer name. Returns new file and scheme
 * objects; the originals are not modified.
 */
export function addDerivedLayer(
  files: CorpusFile[],
  scheme: TierScheme,
  derived: DerivedTier[],
  layerName: string,
): { files: CorpusFile[]; scheme: TierScheme; added: number } {
  const byFile = new Map<string, DerivedTier[]>();
  for (const d of derived) byFile.set(d.fileId, [...(byFile.get(d.fileId) ?? []), d]);
  const newScheme: TierScheme = { ...scheme };
  let added = 0;
  const newFiles = files.map((file) => {
    const list = byFile.get(file.id);
    if (!list) return file;
    const existing = new Set(file.doc.tiers.map((t) => t.id));
    const tiers: Tier[] = [...file.doc.tiers];
    for (const d of list) {
      let id = d.participant ? `${d.participant}_${layerName}` : layerName;
      let n = 2;
      while (existing.has(id)) id = `${d.participant ? `${d.participant}_` : ""}${layerName}_${n++}`;
      existing.add(id);
      const annotations: Annotation[] = d.annotations.map((a) => ({ id: `d${++idCounter}`, start: a.start, end: a.end, value: a.value }));
      tiers.push({ id, linguisticTypeRef: "derived", participant: d.participant, annotator: "ELAN Analyser", timeAlignable: true, annotations, derived: true });
      newScheme[id] = { tierName: id, layer: layerName, participant: d.participant, auto: false };
      added++;
    }
    let duration = file.doc.duration;
    for (const t of tiers) for (const a of t.annotations) if (a.end > duration) duration = a.end;
    return { ...file, doc: { ...file.doc, tiers, duration } };
  });
  return { files: newFiles, scheme: newScheme, added };
}

/** Remove all tiers of a derived layer. */
export function removeDerivedLayer(files: CorpusFile[], scheme: TierScheme, layerName: string): { files: CorpusFile[]; scheme: TierScheme } {
  const newScheme: TierScheme = { ...scheme };
  const newFiles = files.map((file) => {
    const keep = file.doc.tiers.filter((t) => !(t.derived && roleOf(scheme, t.id).layer === layerName));
    if (keep.length === file.doc.tiers.length) return file;
    for (const t of file.doc.tiers) if (!keep.includes(t)) delete newScheme[t.id];
    return { ...file, doc: { ...file.doc, tiers: keep } };
  });
  // A tier name may be shared across files; keep the scheme row if it is still in use.
  for (const f of newFiles) for (const t of f.doc.tiers) if (scheme[t.id] && !newScheme[t.id]) newScheme[t.id] = scheme[t.id]!;
  return { files: newFiles, scheme: newScheme };
}

/**
 * Split recordings at the annotations of a layer (task phases, trials, topics ...).
 * Each annotation becomes a recording of its own, with time starting at zero and the
 * annotation value stored in a new file variable — so that phases can be compared like
 * conditions, with the original file as a grouping factor.
 */
export function splitByLayer(
  files: CorpusFile[],
  scheme: TierScheme,
  layer: string,
  filter: ValueFilter | undefined,
  variable: string,
): { files: CorpusFile[]; error?: string } {
  const f = compileFilter(filter);
  const out: CorpusFile[] = [];
  const usedNames = new Set<string>();
  for (const file of files) {
    const windows = layerTiers([file], scheme, layer)
      .flatMap((lt) => lt.tier.annotations.filter((a) => f.test(a.value)))
      .sort((a, b) => a.start - b.start);
    windows.forEach((w, k) => {
      const value = normalizeValue(w.value, DEFAULT_NORMALIZATION);
      let name = `${file.name} · ${value}`;
      if (usedNames.has(name)) name = `${name} (${k + 1})`;
      usedNames.add(name);
      const tiers: Tier[] = file.doc.tiers.map((t) => {
        const annotations: Annotation[] = [];
        for (const a of t.annotations) {
          if (a.end <= w.start || a.start >= w.end) continue;
          const start = Math.max(a.start, w.start) - w.start;
          const end = Math.min(a.end, w.end) - w.start;
          if (end <= start && a.end > a.start) continue;
          annotations.push({ ...a, start, end });
        }
        return { ...t, annotations };
      });
      out.push({
        id: `${file.id}#${k}`,
        name,
        doc: { ...file.doc, tiers, duration: w.end - w.start },
        meta: { ...file.meta, [variable]: value, source_file: file.name },
      });
    });
  }
  return f.error ? { files: out, error: f.error } : { files: out };
}
