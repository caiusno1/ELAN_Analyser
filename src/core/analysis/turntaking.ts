import { layerTiers, listMetaVariables, type CorpusFile, type TierScheme } from "../corpus/corpus.ts";
import { datasetFromRows, type Dataset, type Row } from "../data/dataset.ts";
import { unionIntervals, type Interval } from "../intervals.ts";
import { summarize } from "../stats/describe.ts";
import { compileFilter, metaCells, type ValueFilter } from "./common.ts";

/**
 * Turn-taking from speech tiers, after Heldner & Edlund (2010).
 *
 * Each speaker's annotations are merged into talkspurts (stretches of speech with no
 * silence longer than `minPause`). The recording is then cut into intervals in which the
 * set of talking speakers is constant, and every silence and every stretch of overlap is
 * classified by who was talking before and after it:
 *
 *   gap     – silence between different speakers          (floor transfer, offset > 0)
 *   pause   – silence within one speaker's talk
 *   between-speaker overlap – overlap that ends in a speaker change (offset < 0)
 *   within-speaker overlap  – overlap after which the same speaker continues
 *
 * The floor transfer offset (FTO) is the duration of a gap, or minus the duration of a
 * between-speaker overlap (Sacks, Schegloff & Jefferson 1974; Stivers et al. 2009).
 */

export interface TurnTakingOptions {
  layer: string;
  filter?: ValueFilter;
  /** Silences shorter than this (ms) inside one speaker's talk do not split a talkspurt. */
  minPause: number;
  /** Annotations shorter than this (ms) are ignored, e.g. to leave out brief backchannels. */
  minDuration: number;
}

export const DEFAULT_TURN_TAKING: Omit<TurnTakingOptions, "layer"> = { minPause: 180, minDuration: 0 };

export type FloorKind = "speech" | "gap" | "pause" | "overlap-between" | "overlap-within" | "silence";

export const FLOOR_LABEL: Record<FloorKind, string> = {
  speech: "one speaker",
  gap: "gap (between speakers)",
  pause: "pause (within speaker)",
  "overlap-between": "overlap with speaker change",
  "overlap-within": "overlap without speaker change",
  silence: "silence at start/end",
};

export interface FloorSegment extends Interval {
  kind: FloorKind;
  /** Speakers talking during the segment. */
  speakers: string[];
}

export interface FloorTransfer {
  fileId: string;
  from: string;
  to: string;
  /** Floor transfer offset in ms: positive = gap, negative = overlap, 0 = latched. */
  fto: number;
  /** Time at which the incoming speaker starts. */
  time: number;
  kind: "gap" | "overlap" | "latched";
}

export interface SpeakerFloor {
  speaker: string;
  /** Number of talkspurts and their total / mean duration (ms). */
  talkspurts: number;
  speakingTime: number;
  meanTalkspurt: number;
  /** Share of all speaking time. */
  share: number;
  /** Floor transfers to this speaker. */
  turnsTaken: number;
  medianFto: number;
}

export interface FileTurnTaking {
  fileId: string;
  fileName: string;
  speakers: string[];
  segments: FloorSegment[];
  transfers: FloorTransfer[];
  bySpeaker: SpeakerFloor[];
  /** Time (ms) spent in each floor state. */
  stateTime: Record<FloorKind, number>;
}

export interface TurnTakingResult {
  files: FileTurnTaking[];
  skipped: string[];
  /** All floor transfer offsets (ms). */
  ftos: Float64Array;
  summary: {
    transfers: number;
    median: number;
    mean: number;
    sd: number;
    /** Share of transfers that are overlaps, gaps, or within ±200 ms. */
    overlapShare: number;
    gapShare: number;
    within200: number;
  };
  /** One row per floor transfer. */
  dataset: Dataset;
  /** One row per speaker and file. */
  speakerDataset: Dataset;
  error?: string;
}

function analyseFile(file: CorpusFile, scheme: TierScheme, opts: TurnTakingOptions, test: (v: string) => boolean): FileTurnTaking | undefined {
  const spurts = new Map<string, Interval[]>();
  for (const lt of layerTiers([file], scheme, opts.layer)) {
    const speaker = lt.participant || lt.tier.id;
    const anns = lt.tier.annotations.filter((a) => test(a.value) && a.end - a.start >= opts.minDuration);
    const merged = unionIntervals(anns, opts.minPause);
    spurts.set(speaker, [...(spurts.get(speaker) ?? []), ...merged]);
  }
  const speakers = [...spurts.keys()].filter((s) => spurts.get(s)!.length > 0).sort();
  if (speakers.length < 2) return undefined;

  // Sweep over talkspurt boundaries.
  const events: { t: number; speaker: number; delta: number }[] = [];
  speakers.forEach((sp, si) => {
    for (const iv of unionIntervals(spurts.get(sp)!)) {
      events.push({ t: iv.start, speaker: si, delta: 1 });
      events.push({ t: iv.end, speaker: si, delta: -1 });
    }
  });
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);
  const active = new Int32Array(speakers.length);
  const raw: { start: number; end: number; speakers: number[] }[] = [];
  let prevT = 0;
  let i = 0;
  while (i < events.length) {
    const t = events[i]!.t;
    if (t > prevT) {
      const who: number[] = [];
      for (let s = 0; s < speakers.length; s++) if (active[s]! > 0) who.push(s);
      raw.push({ start: prevT, end: t, speakers: who });
    }
    while (i < events.length && events[i]!.t === t) {
      active[events[i]!.speaker] = active[events[i]!.speaker]! + events[i]!.delta;
      i++;
    }
    prevT = t;
  }
  if (file.doc.duration > prevT) raw.push({ start: prevT, end: file.doc.duration, speakers: [] });

  // The single speaker holding the floor before / after a position, skipping overlaps and silences.
  const soloBefore = (k: number): number => {
    for (let j = k - 1; j >= 0; j--) if (raw[j]!.speakers.length === 1) return raw[j]!.speakers[0]!;
    return -1;
  };
  const soloAfter = (k: number): number => {
    for (let j = k + 1; j < raw.length; j++) if (raw[j]!.speakers.length === 1) return raw[j]!.speakers[0]!;
    return -1;
  };
  // For a silence: who stopped last before it and who starts first after it.
  const lastBefore = (k: number): number[] => (k > 0 ? raw[k - 1]!.speakers : []);
  const firstAfter = (k: number): number[] => (k + 1 < raw.length ? raw[k + 1]!.speakers : []);

  const segments: FloorSegment[] = [];
  const transfers: FloorTransfer[] = [];
  const stateTime: Record<FloorKind, number> = { speech: 0, gap: 0, pause: 0, "overlap-between": 0, "overlap-within": 0, silence: 0 };
  raw.forEach((seg, k) => {
    let kind: FloorKind;
    const dur = seg.end - seg.start;
    if (seg.speakers.length === 1) {
      kind = "speech";
      // A direct hand-over with neither gap nor overlap.
      if (k > 0 && raw[k - 1]!.speakers.length === 1 && raw[k - 1]!.speakers[0] !== seg.speakers[0]) {
        transfers.push({ fileId: file.id, from: speakers[raw[k - 1]!.speakers[0]!]!, to: speakers[seg.speakers[0]!]!, fto: 0, time: seg.start, kind: "latched" });
      }
    } else if (seg.speakers.length === 0) {
      const before = lastBefore(k);
      const after = firstAfter(k);
      if (before.length === 0 || after.length === 0) kind = "silence";
      else {
        // A pause if someone who was talking right before continues right after.
        const continues = after.some((s) => before.includes(s));
        kind = continues ? "pause" : "gap";
        if (!continues) {
          transfers.push({ fileId: file.id, from: speakers[before[before.length - 1]!]!, to: speakers[after[0]!]!, fto: dur, time: seg.end, kind: "gap" });
        }
      }
    } else {
      const before = soloBefore(k);
      const after = soloAfter(k);
      // Only the overlap segment adjacent to the incoming solo stretch closes the transfer.
      const next = k + 1 < raw.length ? raw[k + 1]! : undefined;
      const prev = k > 0 ? raw[k - 1]! : undefined;
      const change = before !== -1 && after !== -1 && before !== after;
      kind = change ? "overlap-between" : "overlap-within";
      if (change && next && next.speakers.length === 1 && prev) {
        // Measure the whole run of overlap leading up to the change of speaker.
        let startK = k;
        while (startK > 0 && raw[startK - 1]!.speakers.length >= 2) startK--;
        transfers.push({
          fileId: file.id, from: speakers[before]!, to: speakers[after]!,
          fto: -(seg.end - raw[startK]!.start), time: raw[startK]!.start, kind: "overlap",
        });
      }
    }
    stateTime[kind] += dur;
    segments.push({ start: seg.start, end: seg.end, kind, speakers: seg.speakers.map((s) => speakers[s]!) });
  });
  transfers.sort((a, b) => a.time - b.time);

  let totalSpeaking = 0;
  const speaking = speakers.map((sp) => {
    const ivs = unionIntervals(spurts.get(sp)!);
    const t = ivs.reduce((s, iv) => s + (iv.end - iv.start), 0);
    totalSpeaking += t;
    return { ivs, t };
  });
  const bySpeaker: SpeakerFloor[] = speakers.map((sp, si) => {
    const mine = transfers.filter((t) => t.to === sp);
    const ftos = Float64Array.from(mine, (t) => t.fto);
    return {
      speaker: sp,
      talkspurts: speaking[si]!.ivs.length,
      speakingTime: speaking[si]!.t,
      meanTalkspurt: speaking[si]!.ivs.length ? speaking[si]!.t / speaking[si]!.ivs.length : NaN,
      share: totalSpeaking ? speaking[si]!.t / totalSpeaking : NaN,
      turnsTaken: mine.length,
      medianFto: summarize(ftos).median,
    };
  });
  return { fileId: file.id, fileName: file.name, speakers, segments, transfers, bySpeaker, stateTime };
}

export function analyseTurnTaking(files: CorpusFile[], scheme: TierScheme, opts: TurnTakingOptions): TurnTakingResult {
  const { test, error } = compileFilter(opts.filter);
  const metaVars = listMetaVariables(files);
  const out: FileTurnTaking[] = [];
  const skipped: string[] = [];
  const rows: Row[] = [];
  const spRows: Row[] = [];
  const all: number[] = [];
  for (const file of files) {
    const ft = analyseFile(file, scheme, opts, test);
    if (!ft) {
      skipped.push(file.name);
      continue;
    }
    out.push(ft);
    const meta = metaCells(file, metaVars);
    for (const t of ft.transfers) {
      all.push(t.fto);
      rows.push({
        file: file.name, ...meta, from: t.from, to: t.to, direction: `${t.from}→${t.to}`,
        fto_ms: t.fto, kind: t.kind, time_s: t.time / 1000,
        relative_time: file.doc.duration ? t.time / file.doc.duration : NaN,
      });
    }
    const total = Object.values(ft.stateTime).reduce((s, v) => s + v, 0);
    for (const s of ft.bySpeaker) {
      spRows.push({
        file: file.name, ...meta, speaker: s.speaker,
        talkspurts: s.talkspurts, speaking_time_s: s.speakingTime / 1000, mean_talkspurt_s: s.meanTalkspurt / 1000,
        speaking_share: s.share, turns_taken: s.turnsTaken, median_fto_ms: s.medianFto,
        overlap_share: total ? (ft.stateTime["overlap-between"] + ft.stateTime["overlap-within"]) / total : NaN,
        gap_share: total ? ft.stateTime.gap / total : NaN,
        duration_min: file.doc.duration / 60000,
      });
    }
  }
  const ftos = Float64Array.from(all);
  const s = summarize(ftos);
  const n = ftos.length;
  const metaSpec = metaVars.map((v) => ({ name: v, type: "string" as const, label: "file variable" }));
  const dataset = datasetFromRows(
    `Floor transfers: ${opts.layer}`,
    "one change of speaker",
    "Floor transfer offsets: positive = gap, negative = overlap.",
    rows,
    [
      { name: "file", type: "string" }, ...metaSpec,
      { name: "from", type: "string" }, { name: "to", type: "string" }, { name: "direction", type: "string" },
      { name: "fto_ms", type: "number", label: "floor transfer offset in ms (gap > 0, overlap < 0)" },
      { name: "kind", type: "string" }, { name: "time_s", type: "number" },
      { name: "relative_time", type: "number", label: "position in the recording (0–1)" },
    ],
  );
  const speakerDataset = datasetFromRows(
    `Speaking time: ${opts.layer}`,
    "one speaker in one file",
    "Talkspurts, speaking time and turns taken per speaker.",
    spRows,
    [
      { name: "file", type: "string" }, ...metaSpec, { name: "speaker", type: "string" },
      { name: "talkspurts", type: "number" }, { name: "speaking_time_s", type: "number" },
      { name: "mean_talkspurt_s", type: "number" }, { name: "speaking_share", type: "number", label: "share of all speaking time" },
      { name: "turns_taken", type: "number", label: "floor transfers to this speaker" },
      { name: "median_fto_ms", type: "number", label: "median offset when taking the floor" },
      { name: "overlap_share", type: "number", label: "share of the recording with overlapping speech" },
      { name: "gap_share", type: "number", label: "share of the recording that is a between-speaker gap" },
      { name: "duration_min", type: "number" },
    ],
  );
  const result: TurnTakingResult = {
    files: out,
    skipped,
    ftos,
    summary: {
      transfers: n,
      median: s.median,
      mean: s.mean,
      sd: s.sd,
      overlapShare: n ? all.filter((v) => v < 0).length / n : NaN,
      gapShare: n ? all.filter((v) => v > 0).length / n : NaN,
      within200: n ? all.filter((v) => Math.abs(v) <= 200).length / n : NaN,
    },
    dataset,
    speakerDataset,
  };
  if (error) result.error = error;
  return result;
}

/** Floor states as annotations, for the timeline overlay and for export to ELAN. */
export function floorAnnotations(ft: FileTurnTaking): { start: number; end: number; value: string }[] {
  return ft.segments
    .filter((s) => s.kind !== "speech" && s.kind !== "silence")
    .map((s) => ({ start: Math.round(s.start), end: Math.round(s.end), value: s.kind }));
}
