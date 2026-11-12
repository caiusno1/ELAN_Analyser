import type { CorpusFile } from "../corpus/corpus.ts";
import type { Row } from "../data/dataset.ts";

/** A pointer to a stretch of a recording, used to jump from results to the timeline. */
export interface TimeRef {
  fileId: string;
  start: number;
  end: number;
  /** Tier the instance lives on, when there is one. */
  tierId?: string;
}

/** Restrict annotations by value. */
export interface ValueFilter {
  mode: "all" | "regex" | "values";
  /** For mode "regex": a regular expression matched against the (trimmed) value. */
  pattern?: string;
  /** For mode "values": exact values to keep. */
  values?: string[];
  negate?: boolean;
  caseSensitive?: boolean;
}

export const ALL_VALUES: ValueFilter = { mode: "all" };

export type ValuePredicate = (value: string) => boolean;

/** Compile a filter; an invalid regular expression matches nothing and reports an error. */
export function compileFilter(filter: ValueFilter | undefined): { test: ValuePredicate; error?: string } {
  if (!filter || filter.mode === "all") return { test: () => true };
  if (filter.mode === "values") {
    const set = new Set(filter.values ?? []);
    return { test: (v) => set.has(v.trim()) !== !!filter.negate };
  }
  try {
    const re = new RegExp(filter.pattern ?? "", filter.caseSensitive ? "u" : "iu");
    return { test: (v) => re.test(v.trim()) !== !!filter.negate };
  } catch (e) {
    return { test: () => false, error: `Invalid regular expression: ${(e as Error).message}` };
  }
}

/** How annotation values are turned into category labels. */
export interface ValueNormalization {
  trim: boolean;
  lowercase: boolean;
  /** Label used for empty values. */
  emptyLabel: string;
}

export const DEFAULT_NORMALIZATION: ValueNormalization = { trim: true, lowercase: false, emptyLabel: "(empty)" };

export function normalizeValue(v: string, norm: ValueNormalization = DEFAULT_NORMALIZATION): string {
  let s = norm.trim ? v.trim().replace(/\s+/g, " ") : v;
  if (norm.lowercase) s = s.toLocaleLowerCase();
  return s === "" ? norm.emptyLabel : s;
}

/** File-level variables as dataset cells. */
export function metaCells(file: CorpusFile, variables: string[]): Row {
  const row: Row = {};
  for (const v of variables) row[v] = file.meta[v] ?? "";
  return row;
}

/** Format milliseconds as m:ss.mmm (or h:mm:ss.mmm), the way ELAN shows time. */
export function formatTime(ms: number, withMillis = true): string {
  if (!Number.isFinite(ms)) return "–";
  const sign = ms < 0 ? "-" : "";
  const t = Math.abs(Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const milli = t % 1000;
  const core = h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
  return withMillis ? `${sign}${core}.${String(milli).padStart(3, "0")}` : `${sign}${core}`;
}

/** Format a duration given in ms with a sensible unit. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "–";
  const a = Math.abs(ms);
  if (a < 1000) return `${Math.round(ms)} ms`;
  if (a < 60000) return `${(ms / 1000).toFixed(a < 10000 ? 2 : 1)} s`;
  if (a < 3600000) return `${(ms / 60000).toFixed(1)} min`;
  return `${(ms / 3600000).toFixed(2)} h`;
}

/** Count occurrences. */
export function countBy<T>(items: Iterable<T>, key: (item: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/** Keys of a count map, most frequent first (ties alphabetical). */
export function sortedByCount(counts: Map<string, number>): string[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true })).map((e) => e[0]);
}
