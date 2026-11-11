import { SaxesParser } from "saxes";
import type {
  Annotation,
  ControlledVocabulary,
  CvEntry,
  EafDocument,
  LinguisticType,
  MediaDescriptor,
  Stereotype,
  Tier,
} from "./model.ts";

export class EafParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EafParseError";
  }
}

interface RawAnnotation {
  id: string;
  value: string;
  cveRef?: string;
  /** Alignable annotations. */
  ts1?: string;
  ts2?: string;
  /** Reference annotations. */
  ref?: string;
  prev?: string;
  /** Position in the file, used as a stable tie-breaker. */
  order: number;
}

interface RawTier {
  id: string;
  linguisticTypeRef: string;
  participant: string;
  annotator: string;
  parentRef?: string;
  langRef?: string;
  defaultLocale?: string;
  annotations: RawAnnotation[];
}

const STEREOTYPES: readonly Stereotype[] = [
  "Time_Subdivision",
  "Symbolic_Subdivision",
  "Symbolic_Association",
  "Included_In",
];

function asStereotype(s: string | undefined): Stereotype | undefined {
  if (!s) return undefined;
  return (STEREOTYPES as readonly string[]).includes(s) ? (s as Stereotype) : undefined;
}

/** Conversion factor from the document's time unit to milliseconds. */
function unitToMs(timeUnits: string): number {
  switch (timeUnits) {
    case "NTSC-frames":
      return 1001 / 30;
    case "PAL-frames":
      return 40;
    default:
      return 1;
  }
}

/**
 * Decode the bytes of an XML file to a string, honouring a byte-order mark or the
 * encoding named in the XML declaration (ELAN itself always writes UTF-8).
 */
export function decodeXmlBytes(bytes: Uint8Array): string {
  let encoding = "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  else {
    const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 200)));
    const m = /<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head);
    if (m?.[1]) encoding = m[1].toLowerCase();
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

/**
 * Parse the text of an .eaf file.
 *
 * @throws EafParseError when the text is not well-formed XML or not an ELAN document.
 */
export function parseEaf(xml: string, fileName = "untitled.eaf"): EafDocument {
  const warnings: string[] = [];
  const warn = (msg: string) => {
    if (warnings.length < 200) warnings.push(msg);
  };

  // ---- pass 1: SAX → raw structures -------------------------------------------------
  let rootSeen = false;
  let author = "";
  let date = "";
  let format = "";
  let version = "";
  let timeUnits = "milliseconds";
  const media: MediaDescriptor[] = [];
  const properties: Record<string, string> = {};
  const slotOrder: string[] = [];
  const slotValue = new Map<string, number | undefined>();
  const rawTiers: RawTier[] = [];
  const linguisticTypes: LinguisticType[] = [];
  const cvs: ControlledVocabulary[] = [];

  let curTier: RawTier | undefined;
  let curAnn: RawAnnotation | undefined;
  let curCv: ControlledVocabulary | undefined;
  let curCvEntry: CvEntry | undefined;
  let curProperty: string | undefined;
  let textTarget: "annotation" | "property" | "cve" | "cvdesc" | undefined;
  let textBuf = "";
  let annOrder = 0;
  let firstError: Error | undefined;

  const parser = new SaxesParser();
  parser.on("error", (e) => {
    if (!firstError) firstError = e;
  });
  parser.on("opentag", (tag) => {
    const a = tag.attributes as Record<string, string>;
    switch (tag.name) {
      case "ANNOTATION_DOCUMENT":
        rootSeen = true;
        author = a.AUTHOR ?? "";
        date = a.DATE ?? "";
        format = a.FORMAT ?? "";
        version = a.VERSION ?? "";
        break;
      case "HEADER":
        timeUnits = a.TIME_UNITS ?? "milliseconds";
        break;
      case "MEDIA_DESCRIPTOR":
        media.push({
          url: a.MEDIA_URL ?? "",
          relativeUrl: a.RELATIVE_MEDIA_URL,
          mimeType: a.MIME_TYPE,
          timeOrigin: a.TIME_ORIGIN ? Number(a.TIME_ORIGIN) || 0 : 0,
          extractedFrom: a.EXTRACTED_FROM,
        });
        break;
      case "PROPERTY":
        curProperty = a.NAME ?? "";
        textTarget = "property";
        textBuf = "";
        break;
      case "TIME_SLOT": {
        const id = a.TIME_SLOT_ID;
        if (!id) break;
        if (slotValue.has(id)) warn(`Duplicate time slot "${id}".`);
        else slotOrder.push(id);
        const raw = a.TIME_VALUE;
        const v = raw === undefined || raw === "" ? undefined : Number(raw);
        slotValue.set(id, v === undefined || Number.isNaN(v) ? undefined : v);
        break;
      }
      case "TIER":
        curTier = {
          id: a.TIER_ID ?? `tier-${rawTiers.length + 1}`,
          linguisticTypeRef: a.LINGUISTIC_TYPE_REF ?? "",
          participant: a.PARTICIPANT ?? "",
          annotator: a.ANNOTATOR ?? "",
          parentRef: a.PARENT_REF || undefined,
          langRef: a.LANG_REF || undefined,
          defaultLocale: a.DEFAULT_LOCALE || undefined,
          annotations: [],
        };
        rawTiers.push(curTier);
        break;
      case "ALIGNABLE_ANNOTATION":
        curAnn = {
          id: a.ANNOTATION_ID ?? "",
          value: "",
          ts1: a.TIME_SLOT_REF1,
          ts2: a.TIME_SLOT_REF2,
          cveRef: a.CVE_REF || undefined,
          order: annOrder++,
        };
        break;
      case "REF_ANNOTATION":
        curAnn = {
          id: a.ANNOTATION_ID ?? "",
          value: "",
          ref: a.ANNOTATION_REF,
          prev: a.PREVIOUS_ANNOTATION || undefined,
          cveRef: a.CVE_REF || undefined,
          order: annOrder++,
        };
        break;
      case "ANNOTATION_VALUE":
        textTarget = "annotation";
        textBuf = "";
        break;
      case "LINGUISTIC_TYPE":
        linguisticTypes.push({
          id: a.LINGUISTIC_TYPE_ID ?? "",
          timeAlignable: (a.TIME_ALIGNABLE ?? "true") !== "false",
          constraints: asStereotype(a.CONSTRAINTS),
          cvRef: a.CONTROLLED_VOCABULARY_REF || undefined,
          graphicReferences: a.GRAPHIC_REFERENCES === "true",
        });
        break;
      case "CONTROLLED_VOCABULARY":
        curCv = { id: a.CV_ID ?? "", description: a.DESCRIPTION || undefined, entries: [] };
        cvs.push(curCv);
        break;
      case "DESCRIPTION":
        if (curCv) {
          textTarget = "cvdesc";
          textBuf = "";
        }
        break;
      case "CV_ENTRY":
        // EAF <= 2.7: value is the element text.
        curCvEntry = { value: "", description: a.DESCRIPTION || undefined };
        textTarget = "cve";
        textBuf = "";
        break;
      case "CV_ENTRY_ML":
        curCvEntry = { id: a.CVE_ID || undefined, value: "" };
        break;
      case "CVE_VALUE":
        if (curCvEntry) {
          // Multilingual vocabularies: keep the first language as the value.
          if (curCvEntry.value === "") {
            curCvEntry.description = a.DESCRIPTION || curCvEntry.description;
            textTarget = "cve";
            textBuf = "";
          }
        }
        break;
      default:
        break;
    }
  });
  const onText = (t: string) => {
    if (textTarget) textBuf += t;
  };
  parser.on("text", onText);
  parser.on("cdata", onText);
  parser.on("closetag", (tag) => {
    switch (tag.name) {
      case "PROPERTY":
        if (curProperty !== undefined) properties[curProperty] = textBuf;
        curProperty = undefined;
        textTarget = undefined;
        break;
      case "ANNOTATION_VALUE":
        if (curAnn) curAnn.value = textBuf;
        textTarget = undefined;
        break;
      case "ALIGNABLE_ANNOTATION":
      case "REF_ANNOTATION":
        if (curAnn && curTier) curTier.annotations.push(curAnn);
        curAnn = undefined;
        break;
      case "TIER":
        curTier = undefined;
        break;
      case "DESCRIPTION":
        if (curCv && textTarget === "cvdesc") {
          if (!curCv.description) curCv.description = textBuf.trim() || undefined;
          textTarget = undefined;
        }
        break;
      case "CV_ENTRY":
        if (curCv && curCvEntry) {
          curCvEntry.value = textBuf;
          curCv.entries.push(curCvEntry);
        }
        curCvEntry = undefined;
        textTarget = undefined;
        break;
      case "CVE_VALUE":
        if (curCvEntry && textTarget === "cve") {
          curCvEntry.value = textBuf;
          textTarget = undefined;
        }
        break;
      case "CV_ENTRY_ML":
        if (curCv && curCvEntry) curCv.entries.push(curCvEntry);
        curCvEntry = undefined;
        break;
      case "CONTROLLED_VOCABULARY":
        curCv = undefined;
        break;
      default:
        break;
    }
  });

  try {
    parser.write(xml).close();
  } catch (e) {
    if (!firstError) firstError = e as Error;
  }
  if (firstError && !rootSeen) {
    throw new EafParseError(
      `"${fileName}" is not a readable XML file (${firstLine(firstError.message)}).`,
    );
  }
  if (!rootSeen) {
    throw new EafParseError(
      `"${fileName}" is not an ELAN file: no <ANNOTATION_DOCUMENT> element found.`,
    );
  }
  if (firstError) {
    warn(`The file is not well-formed XML; reading stopped early (${firstLine(firstError.message)}).`);
  }

  // ---- pass 2: resolve time slots ---------------------------------------------------
  const factor = unitToMs(timeUnits);
  const slotTime = resolveSlotTimes(slotOrder, slotValue, factor);
  const slotAligned = (id: string | undefined) => id !== undefined && slotValue.get(id) !== undefined;

  // ---- pass 3: build tiers in hierarchy order ---------------------------------------
  const ltById = new Map(linguisticTypes.map((lt) => [lt.id, lt]));
  const rawById = new Map(rawTiers.map((t) => [t.id, t]));
  const depthOf = (t: RawTier): number => {
    let d = 0;
    let cur: RawTier | undefined = t;
    const seen = new Set<string>();
    while (cur?.parentRef && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = rawById.get(cur.parentRef);
      d++;
    }
    return d;
  };
  const buildOrder = rawTiers
    .map((t, i) => ({ t, i, d: depthOf(t) }))
    .sort((x, y) => x.d - y.d || x.i - y.i);

  /** Resolved interval of every annotation seen so far. */
  const resolved = new Map<string, { start: number; end: number }>();
  const tierOut = new Map<string, Tier>();
  let badIntervals = 0;
  let missingRefs = 0;
  let missingSlots = 0;

  for (const { t: raw } of buildOrder) {
    const lt = ltById.get(raw.linguisticTypeRef);
    if (!lt && raw.linguisticTypeRef) {
      warn(`Tier "${raw.id}" refers to an unknown linguistic type "${raw.linguisticTypeRef}".`);
    }
    const annotations: Annotation[] = [];
    const refAnns: RawAnnotation[] = [];

    for (const ra of raw.annotations) {
      if (ra.ts1 !== undefined || ra.ts2 !== undefined) {
        const s = ra.ts1 !== undefined ? slotTime.get(ra.ts1) : undefined;
        const e = ra.ts2 !== undefined ? slotTime.get(ra.ts2) : undefined;
        if (s === undefined || e === undefined) {
          missingSlots++;
          continue;
        }
        let start = s;
        let end = e;
        if (end < start) {
          badIntervals++;
          [start, end] = [end, start];
        }
        const ann: Annotation = { id: ra.id, start, end, value: ra.value };
        if (ra.cveRef) ann.cveRef = ra.cveRef;
        if (!slotAligned(ra.ts1) || !slotAligned(ra.ts2)) ann.timeInferred = true;
        annotations.push(ann);
        resolved.set(ra.id, { start, end });
      } else {
        refAnns.push(ra);
      }
    }

    if (refAnns.length > 0) {
      // Group reference annotations by their parent and order each group by the
      // PREVIOUS_ANNOTATION chain (falling back to file order).
      const groups = new Map<string, RawAnnotation[]>();
      for (const ra of refAnns) {
        const key = ra.ref ?? "";
        let g = groups.get(key);
        if (!g) groups.set(key, (g = []));
        g.push(ra);
      }
      for (const [parentId, group] of groups) {
        const parent = resolved.get(parentId);
        if (!parent) {
          missingRefs += group.length;
          continue;
        }
        const ordered = orderByChain(group);
        const n = ordered.length;
        const span = parent.end - parent.start;
        ordered.forEach((ra, i) => {
          const start = n === 1 ? parent.start : parent.start + (span * i) / n;
          const end = n === 1 ? parent.end : parent.start + (span * (i + 1)) / n;
          const ann: Annotation = {
            id: ra.id,
            start,
            end,
            value: ra.value,
            parentId,
            timeInferred: true,
          };
          if (ra.cveRef) ann.cveRef = ra.cveRef;
          annotations.push(ann);
          resolved.set(ra.id, { start, end });
        });
      }
    }

    annotations.sort((x, y) => x.start - y.start || x.end - y.end);

    const stereotype = lt?.constraints;
    const tier: Tier = {
      id: raw.id,
      linguisticTypeRef: raw.linguisticTypeRef,
      participant: raw.participant,
      annotator: raw.annotator,
      timeAlignable: lt ? lt.timeAlignable : refAnns.length === 0,
      annotations,
    };
    if (raw.parentRef) tier.parentRef = raw.parentRef;
    if (raw.langRef) tier.langRef = raw.langRef;
    if (raw.defaultLocale) tier.defaultLocale = raw.defaultLocale;
    if (stereotype) tier.stereotype = stereotype;
    if (lt?.cvRef) tier.cvRef = lt.cvRef;
    tierOut.set(raw.id, tier);
  }

  // Link time-aligned annotations on dependent tiers to the parent annotation that
  // contains them (Time_Subdivision / Included_In carry no explicit reference).
  for (const tier of tierOut.values()) {
    if (!tier.parentRef) continue;
    const parent = tierOut.get(tier.parentRef);
    if (!parent) {
      warn(`Tier "${tier.id}" refers to a missing parent tier "${tier.parentRef}".`);
      continue;
    }
    linkToParents(tier.annotations, parent.annotations);
  }

  if (missingSlots > 0) warn(`${missingSlots} annotation(s) refer to undefined time slots and were skipped.`);
  if (missingRefs > 0) warn(`${missingRefs} dependent annotation(s) refer to a missing parent annotation and were skipped.`);
  if (badIntervals > 0) warn(`${badIntervals} annotation(s) had an end time before the start time; start and end were swapped.`);

  const tiers = rawTiers.map((t) => tierOut.get(t.id)!);
  let duration = 0;
  for (const t of tiers) for (const a of t.annotations) if (a.end > duration) duration = a.end;

  return {
    fileName,
    author,
    date,
    format,
    version,
    timeUnits,
    media,
    properties,
    tiers,
    linguisticTypes,
    controlledVocabularies: cvs,
    duration,
    warnings,
  };
}

function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? s;
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/**
 * Give every time slot a time. Slots without a TIME_VALUE ("unaligned" slots, which ELAN
 * creates inside time subdivisions) are placed evenly between the nearest aligned slots
 * before and after them in the TIME_ORDER list, which is how ELAN displays them.
 */
function resolveSlotTimes(
  order: string[],
  value: Map<string, number | undefined>,
  factor: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const n = order.length;
  let i = 0;
  let prevAligned: number | undefined;
  while (i < n) {
    const id = order[i]!;
    const v = value.get(id);
    if (v !== undefined) {
      out.set(id, v * factor);
      prevAligned = v * factor;
      i++;
      continue;
    }
    // A run of unaligned slots: order[i .. j-1].
    let j = i;
    while (j < n && value.get(order[j]!) === undefined) j++;
    const nextRaw = j < n ? value.get(order[j]!) : undefined;
    const nextAligned = nextRaw !== undefined ? nextRaw * factor : undefined;
    const lo = prevAligned ?? nextAligned ?? 0;
    const hi = nextAligned ?? prevAligned ?? 0;
    const count = j - i;
    for (let k = 0; k < count; k++) {
      out.set(order[i + k]!, lo + ((hi - lo) * (k + 1)) / (count + 1));
    }
    i = j;
  }
  return out;
}

/** Order sibling reference annotations by following PREVIOUS_ANNOTATION links. */
function orderByChain(group: RawAnnotation[]): RawAnnotation[] {
  if (group.length <= 1) return group;
  const ids = new Set(group.map((g) => g.id));
  const next = new Map<string, RawAnnotation>();
  const heads: RawAnnotation[] = [];
  for (const g of group) {
    if (g.prev && ids.has(g.prev) && !next.has(g.prev)) next.set(g.prev, g);
    else heads.push(g);
  }
  heads.sort((a, b) => a.order - b.order);
  const out: RawAnnotation[] = [];
  const used = new Set<string>();
  for (const h of heads) {
    let cur: RawAnnotation | undefined = h;
    while (cur && !used.has(cur.id)) {
      used.add(cur.id);
      out.push(cur);
      cur = next.get(cur.id);
    }
  }
  if (out.length < group.length) {
    // Broken or cyclic chain: append the rest in file order.
    for (const g of [...group].sort((a, b) => a.order - b.order)) if (!used.has(g.id)) out.push(g);
  }
  return out;
}

/** Set `parentId` on each child to the parent annotation that contains its midpoint. */
function linkToParents(children: Annotation[], parents: Annotation[]): void {
  if (parents.length === 0) return;
  let p = 0;
  for (const c of children) {
    if (c.parentId) continue;
    const mid = (c.start + c.end) / 2;
    while (p < parents.length - 1 && parents[p]!.end < mid) p++;
    // Parents may overlap in badly formed files; look back for a containing one.
    let q = p;
    while (q >= 0 && parents[q]!.start > mid) q--;
    if (q >= 0 && parents[q]!.start <= mid && mid <= parents[q]!.end) c.parentId = parents[q]!.id;
  }
}
