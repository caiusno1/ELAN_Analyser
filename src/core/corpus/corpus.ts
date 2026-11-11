import type { Annotation, EafDocument, Tier } from "../eaf/model.ts";

/**
 * A corpus is a set of EAF files plus a "tier scheme": a table that says, for every tier
 * name, which analysis *layer* it belongs to (speech, gesture, gaze ...) and which
 * *participant* it describes. Analyses address layers, so that "A_gesture" in one file
 * and "B_gesture" in another are treated as the same kind of annotation.
 */

export interface CorpusFile {
  /** Stable internal id. */
  id: string;
  /** Display name (file name without extension), unique within the corpus. */
  name: string;
  doc: EafDocument;
  /** File-level variables (condition, dyad, language ...). */
  meta: Record<string, string>;
}

export interface TierRole {
  tierName: string;
  layer: string;
  participant: string;
  /** False once the user has edited the row; automatic re-detection then leaves it alone. */
  auto: boolean;
}

export type TierScheme = Record<string, TierRole>;

export interface LayerTier {
  file: CorpusFile;
  fileIndex: number;
  tier: Tier;
  participant: string;
}

export type ValueKind = "text" | "categorical" | "numeric" | "empty";

export interface LayerInfo {
  name: string;
  tierNames: string[];
  participants: string[];
  fileCount: number;
  tierCount: number;
  annotationCount: number;
  kind: ValueKind;
  distinctValues: number;
}

const SEP = /[_\-@.:|/\\\s[\]()]+/;
const SEP_EDGE_START = /^[_\-@.:|/\\\s[\]()]+/;
const SEP_EDGE_END = /[_\-@.:|/\\\s[\]()]+$/;

/** Tokens that vary between sibling tiers but do not name a participant. */
const NOT_PARTICIPANT = new Set([
  "left", "right", "lh", "rh", "l", "r", "dh", "ndh", "both", "hand", "hands", "head",
  "face", "mouth", "eyes", "gaze", "manual", "nonmanual", "orth", "phon", "ipa", "gloss",
  "translation", "trans", "notes", "comment", "comments", "pos", "lemma", "words", "word",
]);

export function stripExtension(fileName: string): string {
  return fileName.replace(/\.(eaf|xml|textgrid)$/i, "");
}

/** Classify the values of a set of annotations as free text, categories, numbers or empty. */
export function detectKind(values: Iterable<string>): { kind: ValueKind; distinct: number } {
  let n = 0;
  let nonEmpty = 0;
  let numeric = 0;
  let multiWord = 0;
  const distinct = new Set<string>();
  for (const raw of values) {
    n++;
    const v = raw.trim();
    if (v === "") continue;
    nonEmpty++;
    if (distinct.size <= 5000) distinct.add(v);
    if (/^[-+]?(\d+([.,]\d*)?|[.,]\d+)([eE][-+]?\d+)?$/.test(v)) numeric++;
    if (/\s/.test(v)) multiWord++;
  }
  if (n === 0 || nonEmpty === 0) return { kind: "empty", distinct: 0 };
  if (numeric / nonEmpty > 0.9 && distinct.size > 6) return { kind: "numeric", distinct: distinct.size };
  // Free text: many distinct values, or values that are mostly multi-word utterances.
  const distinctRatio = distinct.size / nonEmpty;
  if (multiWord / nonEmpty > 0.4 && distinct.size > 12) return { kind: "text", distinct: distinct.size };
  if (distinct.size > 60 && distinctRatio > 0.2) return { kind: "text", distinct: distinct.size };
  return { kind: "categorical", distinct: distinct.size };
}

interface NameStats {
  name: string;
  /** PARTICIPANT attribute values seen for this tier name. */
  participants: Map<string, number>;
  linguisticTypes: Map<string, number>;
  files: number;
}

function majority(m: Map<string, number>): string {
  let best = "";
  let bestN = 0;
  for (const [k, n] of m) {
    if (n > bestN && k !== "") {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function splitEdge(name: string, position: "first" | "last"): { token: string; rest: string } | undefined {
  const tokens = name.split(SEP).filter((t) => t !== "");
  if (tokens.length < 2) return undefined;
  if (position === "first") {
    const token = tokens[0]!;
    const idx = name.indexOf(token);
    const rest = name.slice(idx + token.length).replace(SEP_EDGE_START, "").replace(SEP_EDGE_END, "");
    return rest ? { token, rest } : undefined;
  }
  const token = tokens[tokens.length - 1]!;
  const idx = name.lastIndexOf(token);
  const rest = name.slice(0, idx).replace(SEP_EDGE_END, "").replace(SEP_EDGE_START, "");
  return rest ? { token, rest } : undefined;
}

/**
 * Find the naming pattern "participant + layer" (e.g. A_speech / B_speech, or xds@CHI).
 * A token position counts as the participant slot when, inside a single file, the same
 * remainder occurs with at least two different tokens.
 */
function detectNamePattern(files: CorpusFile[]): Map<string, { participant: string; layer: string }> {
  const result = new Map<string, { participant: string; layer: string }>();
  let best: { position: "first" | "last"; support: number } | undefined;
  const supported: Record<"first" | "last", Map<string, { participant: string; layer: string }>> = {
    first: new Map(),
    last: new Map(),
  };
  for (const position of ["first", "last"] as const) {
    const out = supported[position];
    for (const f of files) {
      const groups = new Map<string, { name: string; token: string }[]>();
      for (const t of f.doc.tiers) {
        const sp = splitEdge(t.id, position);
        if (!sp) continue;
        let g = groups.get(sp.rest);
        if (!g) groups.set(sp.rest, (g = []));
        g.push({ name: t.id, token: sp.token });
      }
      for (const [rest, members] of groups) {
        const tokens = new Set(members.map((m) => m.token));
        if (tokens.size < 2) continue;
        if ([...tokens].some((tk) => NOT_PARTICIPANT.has(tk.toLowerCase()))) continue;
        for (const m of members) out.set(m.name, { participant: m.token, layer: rest });
      }
    }
    const support = out.size;
    if (support >= 2 && (!best || support > best.support)) best = { position, support };
  }
  if (!best) return result;
  const chosen = supported[best.position];
  for (const [k, v] of chosen) result.set(k, v);
  return result;
}

/**
 * Propose a tier scheme for the corpus. Rows the user has edited (auto === false) in
 * `previous` are kept unchanged.
 */
export function inferScheme(files: CorpusFile[], previous?: TierScheme): TierScheme {
  const stats = new Map<string, NameStats>();
  for (const f of files) {
    for (const t of f.doc.tiers) {
      let s = stats.get(t.id);
      if (!s) {
        s = { name: t.id, participants: new Map(), linguisticTypes: new Map(), files: 0 };
        stats.set(t.id, s);
      }
      s.files++;
      s.participants.set(t.participant, (s.participants.get(t.participant) ?? 0) + 1);
      s.linguisticTypes.set(t.linguisticTypeRef, (s.linguisticTypes.get(t.linguisticTypeRef) ?? 0) + 1);
    }
  }
  const pattern = detectNamePattern(files);
  const patternParticipants = new Set([...pattern.values()].map((p) => p.participant));

  // Does (participant attribute, linguistic type) identify one tier per file? Then the
  // linguistic type is a good layer name for tiers whose names do not encode the layer.
  const typeIsLayer = (() => {
    let attrTiers = 0;
    let clashes = 0;
    for (const f of files) {
      const seen = new Set<string>();
      for (const t of f.doc.tiers) {
        if (!t.participant) continue;
        attrTiers++;
        const key = `${t.participant}\u0000${t.linguisticTypeRef}`;
        if (seen.has(key)) clashes++;
        seen.add(key);
      }
    }
    return attrTiers > 0 && clashes === 0;
  })();

  const scheme: TierScheme = {};
  for (const s of stats.values()) {
    const prev = previous?.[s.name];
    if (prev && !prev.auto) {
      scheme[s.name] = prev;
      continue;
    }
    const attr = majority(s.participants);
    const lt = majority(s.linguisticTypes);
    const pat = pattern.get(s.name);
    let participant = "";
    let layer = s.name;
    if (attr) {
      participant = attr;
      if (pat && pat.participant === attr) layer = pat.layer;
      else {
        // Remove the participant label from the tier name if it occurs as a token.
        const tokens = s.name.split(SEP).filter((t) => t !== "");
        if (tokens.length >= 2 && tokens[0] === attr) layer = splitEdge(s.name, "first")?.rest ?? s.name;
        else if (tokens.length >= 2 && tokens[tokens.length - 1] === attr) layer = splitEdge(s.name, "last")?.rest ?? s.name;
        else if (s.name === attr) layer = lt && lt !== "default-lt" ? lt : "main";
        else if (typeIsLayer && lt && lt !== "default-lt") layer = lt;
        else if (pat) layer = pat.layer;
      }
    } else if (pat) {
      participant = pat.participant;
      layer = pat.layer;
    } else if (patternParticipants.has(s.name)) {
      // e.g. ACLEW: the tier "CHI" holds CHI's utterances, "xds@CHI" a dependent layer.
      participant = s.name;
      layer = lt && lt !== "default-lt" ? lt : "main";
    }
    scheme[s.name] = { tierName: s.name, layer, participant, auto: true };
  }
  return scheme;
}

export function roleOf(scheme: TierScheme, tierName: string): TierRole {
  return scheme[tierName] ?? { tierName, layer: tierName, participant: "", auto: true };
}

/** All tiers that belong to a layer, optionally restricted to some participants or files. */
export function layerTiers(
  files: CorpusFile[],
  scheme: TierScheme,
  layer: string,
  opts: { participants?: ReadonlySet<string>; fileIds?: ReadonlySet<string> } = {},
): LayerTier[] {
  const out: LayerTier[] = [];
  files.forEach((file, fileIndex) => {
    if (opts.fileIds && !opts.fileIds.has(file.id)) return;
    for (const tier of file.doc.tiers) {
      const role = roleOf(scheme, tier.id);
      if (role.layer !== layer) continue;
      if (opts.participants && !opts.participants.has(role.participant)) continue;
      out.push({ file, fileIndex, tier, participant: role.participant });
    }
  });
  return out;
}

export function listLayers(files: CorpusFile[], scheme: TierScheme): LayerInfo[] {
  interface Acc {
    tierNames: Set<string>;
    participants: Set<string>;
    files: Set<string>;
    tierCount: number;
    annotationCount: number;
    sample: string[];
  }
  const acc = new Map<string, Acc>();
  for (const f of files) {
    for (const t of f.doc.tiers) {
      const role = roleOf(scheme, t.id);
      let a = acc.get(role.layer);
      if (!a) {
        a = { tierNames: new Set(), participants: new Set(), files: new Set(), tierCount: 0, annotationCount: 0, sample: [] };
        acc.set(role.layer, a);
      }
      a.tierNames.add(t.id);
      if (role.participant) a.participants.add(role.participant);
      a.files.add(f.id);
      a.tierCount++;
      a.annotationCount += t.annotations.length;
      // Bounded sample for kind detection.
      const room = 4000 - a.sample.length;
      if (room > 0) {
        const step = Math.max(1, Math.floor(t.annotations.length / Math.min(room, 800)));
        for (let i = 0; i < t.annotations.length && a.sample.length < 4000; i += step) {
          a.sample.push(t.annotations[i]!.value);
        }
      }
    }
  }
  const out: LayerInfo[] = [];
  for (const [name, a] of acc) {
    const { kind, distinct } = detectKind(a.sample);
    out.push({
      name,
      tierNames: [...a.tierNames].sort(),
      participants: [...a.participants].sort(),
      fileCount: a.files.size,
      tierCount: a.tierCount,
      annotationCount: a.annotationCount,
      kind,
      distinctValues: distinct,
    });
  }
  out.sort((x, y) => y.annotationCount - x.annotationCount || x.name.localeCompare(y.name));
  return out;
}

/** All participant labels used in the scheme, sorted. */
export function listParticipants(files: CorpusFile[], scheme: TierScheme): string[] {
  const set = new Set<string>();
  for (const f of files) for (const t of f.doc.tiers) {
    const p = roleOf(scheme, t.id).participant;
    if (p) set.add(p);
  }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Names of all file-level variables in use, in first-seen order. */
export function listMetaVariables(files: CorpusFile[]): string[] {
  const seen: string[] = [];
  for (const f of files) for (const k of Object.keys(f.meta)) if (!seen.includes(k)) seen.push(k);
  return seen;
}

/** Make a unique display name for a new file. */
export function uniqueName(existing: ReadonlySet<string>, wanted: string): string {
  if (!existing.has(wanted)) return wanted;
  let i = 2;
  while (existing.has(`${wanted} (${i})`)) i++;
  return `${wanted} (${i})`;
}

/** Observation time of a file in ms: the end of its last annotation. */
export function fileDuration(file: CorpusFile): number {
  return file.doc.duration;
}

export type { Annotation, EafDocument, Tier };
