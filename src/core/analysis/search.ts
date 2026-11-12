import { roleOf, type CorpusFile, type TierScheme } from "../corpus/corpus.ts";
import { forEachOverlap } from "../intervals.ts";
import { compileFilter, type ValueFilter } from "./common.ts";

/** Search annotations by value, duration and what they overlap with. */

export interface SearchOptions {
  /** Layers to search; empty = all layers. */
  layers: string[];
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  /** Duration limits in ms (0 = no limit). */
  minDuration: number;
  maxDuration: number;
  /** Optional condition on another layer of the same file. */
  overlap?: { layer: string; filter?: ValueFilter; mode: "overlaps" | "does not overlap"; sameParticipant: boolean };
}

export interface SearchHit {
  fileId: string;
  fileName: string;
  tierId: string;
  layer: string;
  participant: string;
  start: number;
  end: number;
  value: string;
  /** Values of the previous and next annotation on the same tier. */
  before: string;
  after: string;
}

export function searchAnnotations(files: CorpusFile[], scheme: TierScheme, opts: SearchOptions, limit = 5000): { hits: SearchHit[]; total: number; error?: string } {
  let test: (v: string) => boolean;
  if (opts.pattern === "") test = () => true;
  else if (opts.regex) {
    try {
      const re = new RegExp(opts.pattern, opts.caseSensitive ? "u" : "iu");
      test = (v) => re.test(v);
    } catch (e) {
      return { hits: [], total: 0, error: `Invalid regular expression: ${(e as Error).message}` };
    }
  } else {
    const needle = opts.caseSensitive ? opts.pattern : opts.pattern.toLocaleLowerCase();
    test = (v) => (opts.caseSensitive ? v : v.toLocaleLowerCase()).includes(needle);
  }
  const layerSet = new Set(opts.layers);
  const of = opts.overlap ? compileFilter(opts.overlap.filter) : undefined;
  if (of?.error) return { hits: [], total: 0, error: of.error };
  const hits: SearchHit[] = [];
  let total = 0;
  for (const file of files) {
    for (const tier of file.doc.tiers) {
      const role = roleOf(scheme, tier.id);
      if (layerSet.size > 0 && !layerSet.has(role.layer)) continue;
      const anns = tier.annotations;
      let overlapped: Uint8Array | undefined;
      if (opts.overlap && of) {
        overlapped = new Uint8Array(anns.length);
        for (const other of file.doc.tiers) {
          if (other.id === tier.id) continue;
          const r2 = roleOf(scheme, other.id);
          if (r2.layer !== opts.overlap.layer) continue;
          if (opts.overlap.sameParticipant && role.participant && r2.participant && role.participant !== r2.participant) continue;
          const ya = other.annotations.filter((a) => of.test(a.value));
          forEachOverlap(anns, ya, (a) => {
            overlapped![a] = 1;
          });
        }
      }
      for (let i = 0; i < anns.length; i++) {
        const a = anns[i]!;
        const d = a.end - a.start;
        if (d < opts.minDuration || (opts.maxDuration > 0 && d > opts.maxDuration)) continue;
        if (!test(a.value)) continue;
        if (overlapped && opts.overlap) {
          const want = opts.overlap.mode === "overlaps" ? 1 : 0;
          if (overlapped[i] !== want) continue;
        }
        total++;
        if (hits.length < limit) {
          hits.push({
            fileId: file.id, fileName: file.name, tierId: tier.id, layer: role.layer, participant: role.participant,
            start: a.start, end: a.end, value: a.value,
            before: i > 0 ? anns[i - 1]!.value : "", after: i + 1 < anns.length ? anns[i + 1]!.value : "",
          });
        }
      }
    }
  }
  return { hits, total };
}
