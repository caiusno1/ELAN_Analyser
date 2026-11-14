import { roleOf, type CorpusFile, type TierScheme } from "../corpus/corpus.ts";
import { writeEaf, type WriteTier } from "./writer.ts";

/**
 * Export the derived tiers of a recording as an .eaf file of their own.
 *
 * The user's original file is never rewritten: the export holds only the computed tiers
 * (as independent, time-aligned tiers) plus the media links, and can be combined with the
 * original in ELAN (File › Merge Transcriptions). ELAN expects the annotations of a tier
 * not to overlap, so a derived tier with overlapping annotations (time windows, alignment
 * instances …) is spread over as many tiers as needed: "name", "name_2", "name_3" …
 *
 * Returns undefined if the recording has no derived tier (in the chosen layers).
 */
export function derivedTiersToEaf(file: CorpusFile, scheme: TierScheme, layers?: ReadonlySet<string>, date = new Date().toISOString()): string | undefined {
  const derived = file.doc.tiers.filter((t) => t.derived && (!layers || layers.has(roleOf(scheme, t.id).layer)));
  if (derived.length === 0) return undefined;
  const used = new Set(derived.map((t) => t.id));
  const tiers: WriteTier[] = [];
  for (const t of derived) {
    // Greedy interval colouring: each annotation goes to the first lane that is free at its start.
    const lanes: { end: number; annotations: { start: number; end: number; value: string }[] }[] = [];
    const sorted = [...t.annotations].sort((a, b) => a.start - b.start || a.end - b.end);
    for (const a of sorted) {
      if (!(a.end > a.start)) continue;
      let lane = lanes.find((l) => l.end <= a.start);
      if (!lane) lanes.push((lane = { end: 0, annotations: [] }));
      lane.annotations.push({ start: a.start, end: a.end, value: a.value });
      lane.end = a.end;
    }
    if (lanes.length === 0) lanes.push({ end: 0, annotations: [] });
    lanes.forEach((lane, k) => {
      let id = t.id;
      if (k > 0) {
        let n = k + 1;
        do id = `${t.id}_${n++}`;
        while (used.has(id));
        used.add(id);
      }
      const tier: WriteTier = { id, linguisticType: "derived", annotator: "ELAN Analyser", annotations: lane.annotations };
      if (t.participant) tier.participant = t.participant;
      tiers.push(tier);
    });
  }
  return writeEaf({
    author: "ELAN Analyser",
    date,
    media: file.doc.media.map((m) => ({ url: m.url, ...(m.mimeType ? { mimeType: m.mimeType } : {}), ...(m.relativeUrl ? { relativeUrl: m.relativeUrl } : {}) })),
    linguisticTypes: [{ id: "derived" }],
    tiers,
  });
}
