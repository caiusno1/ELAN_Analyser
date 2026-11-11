import type { Stereotype } from "./model.ts";

/**
 * Minimal EAF writer. It is used to (a) generate the bundled demo corpus and (b) export
 * tiers computed by the analyser (alignment instances, gaps, overlaps ...) so that they
 * can be opened or merged in ELAN. It never rewrites a user's original file.
 */

export interface WriteAnnotation {
  start: number;
  end: number;
  value: string;
  /**
   * For reference annotations (symbolic association / subdivision): index of the parent
   * annotation in the parent tier's `annotations` array. Start/end are then ignored.
   */
  parent?: number;
}

export interface WriteTier {
  id: string;
  linguisticType: string;
  participant?: string;
  annotator?: string;
  parentRef?: string;
  annotations: WriteAnnotation[];
}

export interface WriteLinguisticType {
  id: string;
  stereotype?: Stereotype;
  cvRef?: string;
}

export interface WriteCv {
  id: string;
  description?: string;
  entries: { value: string; description?: string }[];
}

export interface WriteDocument {
  author?: string;
  date?: string;
  media?: { url: string; mimeType?: string; relativeUrl?: string }[];
  tiers: WriteTier[];
  linguisticTypes: WriteLinguisticType[];
  controlledVocabularies?: WriteCv[];
}

const CONSTRAINT_TEXT: Record<Stereotype, string> = {
  Time_Subdivision:
    "Time subdivision of parent annotation's time interval, no time gaps allowed within this interval",
  Symbolic_Subdivision:
    "Symbolic subdivision of a parent annotation. Annotations refering to the same parent are ordered",
  Symbolic_Association: "1-1 association with a parent annotation",
  Included_In:
    "Time alignable annotations within the parent annotation's time interval, gaps are allowed",
};

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Characters that are not allowed in XML 1.0 documents.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");
}

export function writeEaf(doc: WriteDocument): string {
  const ltById = new Map(doc.linguisticTypes.map((lt) => [lt.id, lt]));
  const isRefTier = (t: WriteTier) => {
    const st = ltById.get(t.linguisticType)?.stereotype;
    return st === "Symbolic_Association" || st === "Symbolic_Subdivision";
  };

  // Collect time points of all time-aligned annotations, sorted, one slot per boundary.
  interface SlotRef {
    time: number;
    tier: number;
    ann: number;
    which: 0 | 1;
  }
  const slotRefs: SlotRef[] = [];
  doc.tiers.forEach((t, ti) => {
    if (isRefTier(t)) return;
    t.annotations.forEach((a, ai) => {
      slotRefs.push({ time: Math.round(a.start), tier: ti, ann: ai, which: 0 });
      slotRefs.push({ time: Math.round(a.end), tier: ti, ann: ai, which: 1 });
    });
  });
  slotRefs.sort((x, y) => x.time - y.time || x.which - y.which);
  const slotIdOf = new Map<string, string>();
  const slotLines: string[] = [];
  slotRefs.forEach((s, i) => {
    const id = `ts${i + 1}`;
    slotIdOf.set(`${s.tier}:${s.ann}:${s.which}`, id);
    slotLines.push(`        <TIME_SLOT TIME_SLOT_ID="${id}" TIME_VALUE="${s.time}"/>`);
  });

  // Annotation ids, assigned tier by tier.
  let nextId = 1;
  const annId: string[][] = doc.tiers.map((t) => t.annotations.map(() => `a${nextId++}`));
  const tierIndex = new Map(doc.tiers.map((t, i) => [t.id, i]));

  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    `<ANNOTATION_DOCUMENT AUTHOR="${escapeXml(doc.author ?? "")}" DATE="${escapeXml(
      doc.date ?? "2026-01-01T00:00:00+00:00",
    )}" FORMAT="3.0" VERSION="3.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.mpi.nl/tools/elan/EAFv3.0.xsd">`,
  );
  out.push('    <HEADER MEDIA_FILE="" TIME_UNITS="milliseconds">');
  for (const m of doc.media ?? []) {
    const rel = m.relativeUrl ? ` RELATIVE_MEDIA_URL="${escapeXml(m.relativeUrl)}"` : "";
    out.push(
      `        <MEDIA_DESCRIPTOR MEDIA_URL="${escapeXml(m.url)}" MIME_TYPE="${escapeXml(
        m.mimeType ?? "video/mp4",
      )}"${rel}/>`,
    );
  }
  out.push(`        <PROPERTY NAME="lastUsedAnnotationId">${nextId - 1}</PROPERTY>`);
  out.push("    </HEADER>");
  out.push("    <TIME_ORDER>");
  out.push(...slotLines);
  out.push("    </TIME_ORDER>");

  doc.tiers.forEach((t, ti) => {
    const attrs = [`LINGUISTIC_TYPE_REF="${escapeXml(t.linguisticType)}"`];
    if (t.parentRef) attrs.push(`PARENT_REF="${escapeXml(t.parentRef)}"`);
    if (t.participant) attrs.push(`PARTICIPANT="${escapeXml(t.participant)}"`);
    if (t.annotator) attrs.push(`ANNOTATOR="${escapeXml(t.annotator)}"`);
    attrs.push(`TIER_ID="${escapeXml(t.id)}"`);
    if (t.annotations.length === 0) {
      out.push(`    <TIER ${attrs.join(" ")}/>`);
      return;
    }
    out.push(`    <TIER ${attrs.join(" ")}>`);
    const ref = isRefTier(t);
    const parentTi = t.parentRef !== undefined ? tierIndex.get(t.parentRef) : undefined;
    const prevByParent = new Map<number, string>();
    t.annotations.forEach((a, ai) => {
      const id = annId[ti]![ai]!;
      out.push("        <ANNOTATION>");
      if (ref) {
        if (parentTi === undefined || a.parent === undefined) {
          throw new Error(`Reference annotation on tier "${t.id}" needs a parent tier and parent index.`);
        }
        const parentId = annId[parentTi]?.[a.parent];
        if (!parentId) throw new Error(`Tier "${t.id}": parent annotation ${a.parent} does not exist.`);
        const prev = prevByParent.get(a.parent);
        const prevAttr = prev ? ` PREVIOUS_ANNOTATION="${prev}"` : "";
        prevByParent.set(a.parent, id);
        out.push(
          `            <REF_ANNOTATION ANNOTATION_ID="${id}" ANNOTATION_REF="${parentId}"${prevAttr}>`,
        );
        out.push(`                <ANNOTATION_VALUE>${escapeXml(a.value)}</ANNOTATION_VALUE>`);
        out.push("            </REF_ANNOTATION>");
      } else {
        const s1 = slotIdOf.get(`${ti}:${ai}:0`)!;
        const s2 = slotIdOf.get(`${ti}:${ai}:1`)!;
        out.push(
          `            <ALIGNABLE_ANNOTATION ANNOTATION_ID="${id}" TIME_SLOT_REF1="${s1}" TIME_SLOT_REF2="${s2}">`,
        );
        out.push(`                <ANNOTATION_VALUE>${escapeXml(a.value)}</ANNOTATION_VALUE>`);
        out.push("            </ALIGNABLE_ANNOTATION>");
      }
      out.push("        </ANNOTATION>");
    });
    out.push("    </TIER>");
  });

  for (const lt of doc.linguisticTypes) {
    const alignable = !(lt.stereotype === "Symbolic_Association" || lt.stereotype === "Symbolic_Subdivision");
    const attrs = [];
    if (lt.stereotype) attrs.push(`CONSTRAINTS="${lt.stereotype}"`);
    if (lt.cvRef) attrs.push(`CONTROLLED_VOCABULARY_REF="${escapeXml(lt.cvRef)}"`);
    attrs.push('GRAPHIC_REFERENCES="false"');
    attrs.push(`LINGUISTIC_TYPE_ID="${escapeXml(lt.id)}"`);
    attrs.push(`TIME_ALIGNABLE="${alignable}"`);
    out.push(`    <LINGUISTIC_TYPE ${attrs.join(" ")}/>`);
  }
  // Element order follows the EAF schema: LANGUAGE precedes CONSTRAINT.
  if ((doc.controlledVocabularies ?? []).length > 0) {
    out.push(
      '    <LANGUAGE LANG_DEF="http://cdb.iso.org/lg/CDB-00130975-001" LANG_ID="und" LANG_LABEL="undetermined (und)"/>',
    );
  }
  for (const st of Object.keys(CONSTRAINT_TEXT) as Stereotype[]) {
    out.push(`    <CONSTRAINT DESCRIPTION="${escapeXml(CONSTRAINT_TEXT[st])}" STEREOTYPE="${st}"/>`);
  }
  let cveId = 0;
  for (const cv of doc.controlledVocabularies ?? []) {
    out.push(`    <CONTROLLED_VOCABULARY CV_ID="${escapeXml(cv.id)}">`);
    out.push(`        <DESCRIPTION LANG_REF="und">${escapeXml(cv.description ?? "")}</DESCRIPTION>`);
    for (const e of cv.entries) {
      out.push(`        <CV_ENTRY_ML CVE_ID="cveid${cveId++}">`);
      out.push(
        `            <CVE_VALUE DESCRIPTION="${escapeXml(e.description ?? "")}" LANG_REF="und">${escapeXml(
          e.value,
        )}</CVE_VALUE>`,
      );
      out.push("        </CV_ENTRY_ML>");
    }
    out.push("    </CONTROLLED_VOCABULARY>");
  }
  out.push("</ANNOTATION_DOCUMENT>");
  return out.join("\n") + "\n";
}
