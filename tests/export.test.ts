import { describe, expect, it } from "vitest";
import { addDerivedLayer, derive } from "../src/core/analysis/tieralgebra.ts";
import { derivedTiersToEaf } from "../src/core/eaf/export.ts";
import { parseEaf } from "../src/core/eaf/parser.ts";
import { crc32, zipStore } from "../src/core/zip.ts";
import { corpus, makeFile } from "./helpers.ts";

describe("derivedTiersToEaf", () => {
  const { files, scheme } = corpus([
    makeFile("rec", {
      A_speech: [[0, 1000, "one two"], [1500, 2500, "three"], [4000, 5000, "four <five> & six"]],
      B_speech: [[900, 1600, "yes"]],
    }),
  ]);

  it("returns nothing without derived tiers", () => {
    expect(derivedTiersToEaf(files[0]!, scheme)).toBeUndefined();
  });

  it("writes derived tiers that ELAN-style parsing reads back unchanged", () => {
    const gaps = derive(files, scheme, { kind: "gaps", layer: "speech", label: "silence", minDuration: 200 });
    const added = addDerivedLayer(files, scheme, gaps.tiers, "silence");
    const xml = derivedTiersToEaf(added.files[0]!, added.scheme, undefined, "2026-01-01T00:00:00Z")!;
    const back = parseEaf(xml, "rec_derived.eaf");
    expect(back.warnings).toEqual([]);
    expect(back.tiers.map((t) => t.id)).toEqual(["A_silence", "B_silence"]);
    expect(back.tiers[0]!.participant).toBe("A");
    expect(back.tiers[0]!.annotations.map((a) => [a.start, a.end, a.value])).toEqual([[1000, 1500, "silence"], [2500, 4000, "silence"]]);
    // Only the chosen layers are exported.
    expect(derivedTiersToEaf(added.files[0]!, added.scheme, new Set(["other"]))).toBeUndefined();
  });

  it("spreads overlapping annotations over several tiers", () => {
    const windows = derive(files, scheme, { kind: "window", layer: "speech", anchor: "span", before: 400, after: 400 });
    const added = addDerivedLayer(files, scheme, windows.tiers, "window");
    const source = added.files[0]!.doc.tiers.find((t) => t.id === "A_window")!;
    // 0–1400 and 1100–2900 overlap; 3600–5000 does not (clipped at the end of the recording).
    expect(source.annotations.map((a) => [a.start, a.end])).toEqual([[0, 1400], [1100, 2900], [3600, 5000]]);
    const back = parseEaf(derivedTiersToEaf(added.files[0]!, added.scheme)!, "x.eaf");
    expect(back.tiers.map((t) => t.id)).toEqual(["A_window", "A_window_2", "B_window"]);
    const lane1 = back.tiers[0]!.annotations.map((a) => [a.start, a.end]);
    const lane2 = back.tiers[1]!.annotations.map((a) => [a.start, a.end]);
    expect(lane1).toEqual([[0, 1400], [3600, 5000]]);
    expect(lane2).toEqual([[1100, 2900]]);
    // Special characters survive the round trip.
    expect(back.tiers[0]!.annotations[1]!.value).toBe("four <five> & six");
  });
});

describe("zipStore", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("writes an archive with a consistent directory", () => {
    const enc = new TextEncoder();
    const entries = [
      { name: "dyad01_derived.eaf", data: enc.encode("<a/>") },
      { name: "Gespräch ä.eaf", data: enc.encode("zweite Datei") },
      { name: "empty.txt", data: new Uint8Array(0) },
    ];
    const zip = zipStore(entries, new Date(2026, 0, 2, 3, 4, 6));
    const view = new DataView(zip.buffer);
    // End of central directory record: 22 bytes at the end.
    const eocd = zip.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(3);
    const centralSize = view.getUint32(eocd + 12, true);
    let pos = view.getUint32(eocd + 16, true);
    expect(pos + centralSize).toBe(eocd);
    const dec = new TextDecoder();
    for (const e of entries) {
      expect(view.getUint32(pos, true)).toBe(0x02014b50);
      const size = view.getUint32(pos + 24, true);
      const nameLen = view.getUint16(pos + 28, true);
      const local = view.getUint32(pos + 42, true);
      expect(dec.decode(zip.subarray(pos + 46, pos + 46 + nameLen))).toBe(e.name);
      expect(size).toBe(e.data.length);
      // The local header points at the same bytes.
      expect(view.getUint32(local, true)).toBe(0x04034b50);
      const localNameLen = view.getUint16(local + 26, true);
      const data = zip.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size);
      expect(Array.from(data)).toEqual(Array.from(e.data));
      expect(view.getUint32(pos + 16, true)).toBe(crc32(e.data));
      // 2026-01-02 03:04:06
      expect(view.getUint16(pos + 14, true)).toBe(((2026 - 1980) << 9) | (1 << 5) | 2);
      expect(view.getUint16(pos + 12, true)).toBe((3 << 11) | (4 << 5) | 3);
      pos += 46 + nameLen;
    }
    expect(pos).toBe(eocd);
  });
});
