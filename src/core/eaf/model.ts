/**
 * In-memory model of an ELAN Annotation Format (.eaf) document.
 *
 * All times are milliseconds from the start of the annotation timeline. Annotations on
 * dependent tiers that carry no time of their own (reference annotations) get the interval
 * they are displayed with in ELAN: the parent's interval for a symbolic association, an equal
 * share of it for a symbolic subdivision. Those are flagged `timeInferred`.
 */

export type Stereotype =
  | "Time_Subdivision"
  | "Symbolic_Subdivision"
  | "Symbolic_Association"
  | "Included_In";

export interface Annotation {
  /** ANNOTATION_ID, unique within the document. */
  id: string;
  /** Start time in ms. */
  start: number;
  /** End time in ms (>= start). */
  end: number;
  /** Annotation value, exactly as stored (not trimmed). */
  value: string;
  /** For annotations on dependent tiers: id of the parent annotation. */
  parentId?: string;
  /** Reference to a controlled-vocabulary entry, if any. */
  cveRef?: string;
  /** True when the interval was derived (reference annotation or unaligned time slot). */
  timeInferred?: boolean;
}

export interface Tier {
  /** TIER_ID, unique within the document. */
  id: string;
  linguisticTypeRef: string;
  participant: string;
  annotator: string;
  parentRef?: string;
  langRef?: string;
  defaultLocale?: string;
  /** Stereotype of the tier's linguistic type; undefined for independent tiers. */
  stereotype?: Stereotype;
  /** Whether annotations on this tier carry their own time alignment. */
  timeAlignable: boolean;
  /** Controlled vocabulary attached through the linguistic type, if any. */
  cvRef?: string;
  /** Sorted by start, then end. */
  annotations: Annotation[];
}

export interface LinguisticType {
  id: string;
  timeAlignable: boolean;
  constraints?: Stereotype;
  cvRef?: string;
  graphicReferences: boolean;
}

export interface CvEntry {
  id?: string;
  value: string;
  description?: string;
}

export interface ControlledVocabulary {
  id: string;
  description?: string;
  entries: CvEntry[];
}

export interface MediaDescriptor {
  url: string;
  relativeUrl?: string;
  mimeType?: string;
  /** Offset (ms) of the media relative to the annotation timeline. */
  timeOrigin: number;
  extractedFrom?: string;
}

export interface EafDocument {
  /** File name the document was read from (no path). */
  fileName: string;
  author: string;
  date: string;
  format: string;
  version: string;
  timeUnits: string;
  media: MediaDescriptor[];
  properties: Record<string, string>;
  tiers: Tier[];
  linguisticTypes: LinguisticType[];
  controlledVocabularies: ControlledVocabulary[];
  /** Largest annotation end time (ms); 0 for an empty document. */
  duration: number;
  /** Non-fatal problems found while reading the file. */
  warnings: string[];
}

export function tierById(doc: EafDocument, id: string): Tier | undefined {
  return doc.tiers.find((t) => t.id === id);
}

export function annotationCount(doc: EafDocument): number {
  let n = 0;
  for (const t of doc.tiers) n += t.annotations.length;
  return n;
}

/** Depth of a tier in the tier hierarchy (0 = independent tier). */
export function tierDepth(doc: EafDocument, tier: Tier): number {
  let depth = 0;
  let cur: Tier | undefined = tier;
  const seen = new Set<string>();
  while (cur?.parentRef && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = tierById(doc, cur.parentRef);
    depth++;
  }
  return depth;
}
