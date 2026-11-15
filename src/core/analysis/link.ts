import { layerTiers, type CorpusFile, type TierScheme } from "../corpus/corpus.ts";
import { column, numberColumn, stringColumn, type Dataset, type StringColumn } from "../data/dataset.ts";
import { lowerBoundStart } from "../intervals.ts";
import { compileFilter, DEFAULT_NORMALIZATION, normalizeValue, type ValueFilter } from "./common.ts";

/**
 * Link the rows of a table back to the corpus: what was annotated on some layer at the
 * time of each row? Any table that knows its recording and a time — single annotations,
 * changes of speaker, alignment instances, timing lags, search results — can be given a
 * new variable in this way ("was there a gesture during the two seconds before this
 * change of speaker?"), which turns cross-modal questions into ordinary regression.
 */

export const NO_ANNOTATION = "(none)";

export interface LinkOptions {
  layer: string;
  filter?: ValueFilter;
  /** Variable with the name of the recording. */
  fileColumn: string;
  /** Variable with the time of the row in seconds. */
  timeColumn: string;
  /** Whose tiers to look at, relative to the participant named in `participantColumn`. */
  participant: "any" | "same" | "other";
  participantColumn?: string;
  /** Window around the time of the row, in ms. With 0 and 0 the annotation at that instant is taken. */
  before: number;
  after: number;
  /** "value": the value of the annotation; "present": yes / no. */
  output: "value" | "present";
}

export interface LinkResult {
  column: StringColumn;
  /** Rows for which an annotation was found. */
  matched: number;
  /** Rows whose recording is not in the corpus, or that have no time (left empty). */
  unlinked: number;
  error?: string;
}

/**
 * For every row: the annotation of the layer that overlaps the window around the row's
 * time the longest (the earliest one on ties). Rows without such an annotation get
 * "(none)" — a category of its own, so that they stay in later analyses.
 */
export function linkLayer(ds: Dataset, files: CorpusFile[], scheme: TierScheme, opts: LinkOptions, name: string): LinkResult {
  const { test, error } = compileFilter(opts.filter);
  const fileNames = stringColumn(ds, opts.fileColumn);
  const times = numberColumn(ds, opts.timeColumn);
  const who = opts.participant !== "any" && opts.participantColumn && column(ds, opts.participantColumn) ? stringColumn(ds, opts.participantColumn) : undefined;
  const byName = new Map(files.map((f) => [f.name, f]));
  // Tiers of the layer per recording, with their annotations filtered once.
  const tiersOf = new Map<string, { participant: string; annotations: { start: number; end: number; value: string }[]; maxDuration: number }[]>();
  const values: string[] = new Array<string>(ds.rowCount).fill("");
  let matched = 0;
  let unlinked = 0;
  for (let i = 0; i < ds.rowCount; i++) {
    const file = byName.get(fileNames[i]!.trim());
    const t = times[i]! * 1000;
    if (!file || !Number.isFinite(t)) {
      unlinked++;
      continue;
    }
    let tiers = tiersOf.get(file.id);
    if (!tiers) {
      tiers = layerTiers([file], scheme, opts.layer).map((lt) => {
        const annotations = lt.tier.annotations.filter((a) => test(a.value));
        return { participant: lt.participant, annotations, maxDuration: annotations.reduce((m, a) => Math.max(m, a.end - a.start), 0) };
      });
      tiersOf.set(file.id, tiers);
    }
    const from = t - opts.before;
    const to = t + opts.after;
    const person = who?.[i]?.trim() ?? "";
    let best: { value: string; overlap: number; start: number } | undefined;
    for (const tier of tiers) {
      if (who && opts.participant === "same" && tier.participant !== person) continue;
      if (who && opts.participant === "other" && (tier.participant === person || tier.participant === "")) continue;
      const anns = tier.annotations;
      // Annotations are sorted by start: begin with the first one that can still reach the window.
      for (let k = lowerBoundStart(anns, from - tier.maxDuration); k < anns.length; k++) {
        const a = anns[k]!;
        if (a.start > to) break;
        // A window of zero width is an instant: the annotation must contain it.
        const overlap = to > from ? Math.min(a.end, to) - Math.max(a.start, from) : a.start <= t && t < a.end ? 1 : 0;
        if (overlap <= 0) continue;
        if (!best || overlap > best.overlap || (overlap === best.overlap && a.start < best.start)) best = { value: a.value, overlap, start: a.start };
      }
    }
    if (best) matched++;
    values[i] = opts.output === "present" ? (best ? "yes" : "no") : best ? normalizeValue(best.value, DEFAULT_NORMALIZATION) : NO_ANNOTATION;
  }
  const window = opts.before || opts.after ? `${opts.before} ms before to ${opts.after} ms after` : "at";
  const result: LinkResult = { column: { name, type: "string", values, label: `layer “${opts.layer}” ${window} ${opts.timeColumn}` }, matched, unlinked };
  if (error) result.error = error;
  return result;
}
