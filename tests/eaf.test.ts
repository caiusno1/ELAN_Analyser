import { describe, expect, it } from "vitest";
import { EafParseError, decodeXmlBytes, parseEaf } from "../src/core/eaf/parser.ts";
import { writeEaf } from "../src/core/eaf/writer.ts";
import { tierById } from "../src/core/eaf/model.ts";

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<ANNOTATION_DOCUMENT AUTHOR="me" DATE="2020-01-01T00:00:00+00:00" FORMAT="2.7" VERSION="2.7">
  <HEADER MEDIA_FILE="" TIME_UNITS="milliseconds">
    <MEDIA_DESCRIPTOR MEDIA_URL="file:///x/a.wav" MIME_TYPE="audio/x-wav" RELATIVE_MEDIA_URL="./a.wav" TIME_ORIGIN="250"/>
    <PROPERTY NAME="lastUsedAnnotationId">12</PROPERTY>
  </HEADER>
  <TIME_ORDER>
    <TIME_SLOT TIME_SLOT_ID="ts1" TIME_VALUE="1000"/>
    <TIME_SLOT TIME_SLOT_ID="ts2"/>
    <TIME_SLOT TIME_SLOT_ID="ts3"/>
    <TIME_SLOT TIME_SLOT_ID="ts4" TIME_VALUE="4000"/>
    <TIME_SLOT TIME_SLOT_ID="ts5" TIME_VALUE="5000"/>
    <TIME_SLOT TIME_SLOT_ID="ts6" TIME_VALUE="6000"/>
    <TIME_SLOT TIME_SLOT_ID="ts7" TIME_VALUE="1500"/>
    <TIME_SLOT TIME_SLOT_ID="ts8" TIME_VALUE="2500"/>
  </TIME_ORDER>
  <TIER LINGUISTIC_TYPE_REF="utt" TIER_ID="A_utt" PARTICIPANT="A" ANNOTATOR="K">
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="a2" TIME_SLOT_REF1="ts5" TIME_SLOT_REF2="ts6"><ANNOTATION_VALUE>second &amp; last</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="a1" TIME_SLOT_REF1="ts1" TIME_SLOT_REF2="ts4"><ANNOTATION_VALUE>one two three</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
  </TIER>
  <TIER LINGUISTIC_TYPE_REF="words-ts" PARENT_REF="A_utt" TIER_ID="A_words_ts">
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="a3" TIME_SLOT_REF1="ts1" TIME_SLOT_REF2="ts2"><ANNOTATION_VALUE>one</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="a4" TIME_SLOT_REF1="ts2" TIME_SLOT_REF2="ts3"><ANNOTATION_VALUE>two</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="a5" TIME_SLOT_REF1="ts3" TIME_SLOT_REF2="ts4"><ANNOTATION_VALUE>three</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
  </TIER>
  <TIER LINGUISTIC_TYPE_REF="words-ss" PARENT_REF="A_utt" TIER_ID="A_words_ss">
    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="a8" ANNOTATION_REF="a1" PREVIOUS_ANNOTATION="a7"><ANNOTATION_VALUE>three</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>
    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="a6" ANNOTATION_REF="a1"><ANNOTATION_VALUE>one</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>
    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="a7" ANNOTATION_REF="a1" PREVIOUS_ANNOTATION="a6"><ANNOTATION_VALUE>two</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>
  </TIER>
  <TIER LINGUISTIC_TYPE_REF="pos" PARENT_REF="A_words_ss" TIER_ID="A_pos">
    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="a9" ANNOTATION_REF="a7" CVE_REF="cve1"><ANNOTATION_VALUE>NUM</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>
  </TIER>
  <TIER LINGUISTIC_TYPE_REF="gest" PARENT_REF="A_utt" TIER_ID="A_gest">
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="a10" TIME_SLOT_REF1="ts7" TIME_SLOT_REF2="ts8"><ANNOTATION_VALUE><![CDATA[beat <1>]]></ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
  </TIER>
  <TIER LINGUISTIC_TYPE_REF="utt" TIER_ID="empty"/>
  <LINGUISTIC_TYPE GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="utt" TIME_ALIGNABLE="true"/>
  <LINGUISTIC_TYPE CONSTRAINTS="Time_Subdivision" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="words-ts" TIME_ALIGNABLE="true"/>
  <LINGUISTIC_TYPE CONSTRAINTS="Symbolic_Subdivision" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="words-ss" TIME_ALIGNABLE="false"/>
  <LINGUISTIC_TYPE CONSTRAINTS="Symbolic_Association" CONTROLLED_VOCABULARY_REF="POS" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="pos" TIME_ALIGNABLE="false"/>
  <LINGUISTIC_TYPE CONSTRAINTS="Included_In" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="gest" TIME_ALIGNABLE="true"/>
  <CONTROLLED_VOCABULARY CV_ID="POS" DESCRIPTION="parts of speech">
    <CV_ENTRY DESCRIPTION="numeral">NUM</CV_ENTRY>
    <CV_ENTRY DESCRIPTION="noun">N</CV_ENTRY>
  </CONTROLLED_VOCABULARY>
  <CONTROLLED_VOCABULARY CV_ID="ML">
    <DESCRIPTION LANG_REF="eng">multilingual</DESCRIPTION>
    <CV_ENTRY_ML CVE_ID="cve1"><CVE_VALUE DESCRIPTION="d" LANG_REF="eng">yes</CVE_VALUE><CVE_VALUE LANG_REF="nld">ja</CVE_VALUE></CV_ENTRY_ML>
  </CONTROLLED_VOCABULARY>
</ANNOTATION_DOCUMENT>`;

describe("parseEaf", () => {
  const doc = parseEaf(FIXTURE, "fixture.eaf");

  it("reads header, media and properties", () => {
    expect(doc.format).toBe("2.7");
    expect(doc.author).toBe("me");
    expect(doc.media).toHaveLength(1);
    expect(doc.media[0]!.timeOrigin).toBe(250);
    expect(doc.properties.lastUsedAnnotationId).toBe("12");
    expect(doc.duration).toBe(6000);
    expect(doc.warnings).toEqual([]);
  });

  it("sorts annotations and decodes entities and CDATA", () => {
    const utt = tierById(doc, "A_utt")!;
    expect(utt.participant).toBe("A");
    expect(utt.annotator).toBe("K");
    expect(utt.annotations.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(utt.annotations[1]!.value).toBe("second & last");
    expect(tierById(doc, "A_gest")!.annotations[0]!.value).toBe("beat <1>");
  });

  it("interpolates unaligned time slots evenly", () => {
    const w = tierById(doc, "A_words_ts")!;
    expect(w.stereotype).toBe("Time_Subdivision");
    expect(w.annotations.map((a) => [a.start, a.end])).toEqual([
      [1000, 2000],
      [2000, 3000],
      [3000, 4000],
    ]);
    expect(w.annotations.map((a) => a.timeInferred)).toEqual([true, true, true]);
    expect(w.annotations.every((a) => a.parentId === "a1")).toBe(true);
  });

  it("orders symbolic subdivisions by PREVIOUS_ANNOTATION and shares the parent interval", () => {
    const w = tierById(doc, "A_words_ss")!;
    expect(w.timeAlignable).toBe(false);
    expect(w.annotations.map((a) => a.value)).toEqual(["one", "two", "three"]);
    expect(w.annotations.map((a) => [a.start, a.end])).toEqual([
      [1000, 2000],
      [2000, 3000],
      [3000, 4000],
    ]);
  });

  it("resolves nested reference annotations", () => {
    const pos = tierById(doc, "A_pos")!;
    expect(pos.cvRef).toBe("POS");
    expect(pos.annotations).toHaveLength(1);
    expect(pos.annotations[0]).toMatchObject({ start: 2000, end: 3000, value: "NUM", parentId: "a7", cveRef: "cve1" });
  });

  it("links included-in annotations to the containing parent", () => {
    expect(tierById(doc, "A_gest")!.annotations[0]!.parentId).toBe("a1");
  });

  it("reads both controlled-vocabulary formats", () => {
    const pos = doc.controlledVocabularies.find((c) => c.id === "POS")!;
    expect(pos.description).toBe("parts of speech");
    expect(pos.entries.map((e) => e.value)).toEqual(["NUM", "N"]);
    expect(pos.entries[0]!.description).toBe("numeral");
    const ml = doc.controlledVocabularies.find((c) => c.id === "ML")!;
    expect(ml.description).toBe("multilingual");
    expect(ml.entries).toEqual([{ id: "cve1", value: "yes", description: "d" }]);
  });

  it("keeps empty tiers", () => {
    expect(tierById(doc, "empty")!.annotations).toEqual([]);
  });

  it("rejects non-ELAN input with a clear message", () => {
    expect(() => parseEaf("<html><body/></html>", "x.eaf")).toThrow(EafParseError);
    expect(() => parseEaf("not xml at all", "x.eaf")).toThrow(/x\.eaf/);
  });

  it("reports broken references instead of failing", () => {
    const broken = FIXTURE.replace('ANNOTATION_REF="a7" CVE_REF', 'ANNOTATION_REF="nope" CVE_REF').replace(
      'TIME_SLOT_REF1="ts7"',
      'TIME_SLOT_REF1="ts99"',
    );
    const d = parseEaf(broken, "broken.eaf");
    expect(tierById(d, "A_pos")!.annotations).toHaveLength(0);
    expect(tierById(d, "A_gest")!.annotations).toHaveLength(0);
    expect(d.warnings.join(" ")).toMatch(/missing parent annotation/);
    expect(d.warnings.join(" ")).toMatch(/undefined time slots/);
  });

  it("swaps reversed intervals and converts frame units", () => {
    const rev = FIXTURE.replace('TIME_SLOT_REF1="ts5" TIME_SLOT_REF2="ts6"', 'TIME_SLOT_REF1="ts6" TIME_SLOT_REF2="ts5"');
    const d = parseEaf(rev, "rev.eaf");
    expect(tierById(d, "A_utt")!.annotations[1]).toMatchObject({ start: 5000, end: 6000 });
    expect(d.warnings.join(" ")).toMatch(/swapped/);
    const pal = parseEaf(FIXTURE.replace('TIME_UNITS="milliseconds"', 'TIME_UNITS="PAL-frames"'), "pal.eaf");
    expect(tierById(pal, "A_utt")!.annotations[0]).toMatchObject({ start: 40000, end: 160000 });
  });
});

describe("decodeXmlBytes", () => {
  it("handles UTF-8, UTF-16 with BOM and declared encodings", () => {
    const text = '<?xml version="1.0" encoding="UTF-8"?><a>ʃøß 日本</a>';
    expect(decodeXmlBytes(new TextEncoder().encode(text))).toBe(text);
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16[0] = 0xff;
    utf16[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      utf16[2 + i * 2] = text.charCodeAt(i) & 0xff;
      utf16[3 + i * 2] = text.charCodeAt(i) >> 8;
    }
    expect(decodeXmlBytes(utf16)).toBe(text);
    const latin = new Uint8Array([...'<?xml version="1.0" encoding="ISO-8859-1"?><a>'].map((c) => c.charCodeAt(0)).concat([0xe9, 0x3c, 0x2f, 0x61, 0x3e]));
    expect(decodeXmlBytes(latin)).toContain("<a>é</a>");
  });
});

describe("writeEaf", () => {
  it("round-trips through the parser, including dependent tiers and special characters", () => {
    const xml = writeEaf({
      author: 'A "quoted" <author>',
      media: [{ url: "file:///m.mp4" }],
      linguisticTypes: [
        { id: "utt" },
        { id: "tr", stereotype: "Symbolic_Association" },
        { id: "w", stereotype: "Symbolic_Subdivision" },
        { id: "g", stereotype: "Included_In", cvRef: "cv" },
      ],
      controlledVocabularies: [{ id: "cv", description: "types", entries: [{ value: "x" }, { value: "y", description: "why" }] }],
      tiers: [
        { id: "S", linguisticType: "utt", participant: "S", annotations: [
          { start: 2000, end: 3000, value: "b & c" },
          { start: 0, end: 1000.4, value: "a <1>" },
        ] },
        { id: "S_tr", linguisticType: "tr", parentRef: "S", annotations: [{ start: 0, end: 0, value: "übersetzung", parent: 0 }] },
        { id: "S_w", linguisticType: "w", parentRef: "S", annotations: [
          { start: 0, end: 0, value: "a", parent: 1 },
          { start: 0, end: 0, value: "<1>", parent: 1 },
        ] },
        { id: "S_g", linguisticType: "g", parentRef: "S", annotations: [{ start: 2100, end: 2500, value: "x" }] },
        { id: "empty", linguisticType: "utt", annotations: [] },
      ],
    });
    const doc = parseEaf(xml, "rt.eaf");
    expect(doc.warnings).toEqual([]);
    expect(doc.author).toBe('A "quoted" <author>');
    expect(tierById(doc, "S")!.annotations.map((a) => [a.start, a.end, a.value])).toEqual([
      [0, 1000, "a <1>"],
      [2000, 3000, "b & c"],
    ]);
    expect(tierById(doc, "S_tr")!.annotations[0]).toMatchObject({ start: 2000, end: 3000, value: "übersetzung" });
    expect(tierById(doc, "S_w")!.annotations.map((a) => [a.start, a.end, a.value])).toEqual([
      [0, 500, "a"],
      [500, 1000, "<1>"],
    ]);
    expect(tierById(doc, "S_g")!.stereotype).toBe("Included_In");
    expect(tierById(doc, "S_g")!.cvRef).toBe("cv");
    expect(doc.controlledVocabularies[0]!.entries.map((e) => e.value)).toEqual(["x", "y"]);
    expect(tierById(doc, "empty")!.annotations).toEqual([]);
  });
});
