import { describe, expect, it } from "vitest";
import { detectKind, inferScheme, layerTiers, listLayers, listParticipants, stripExtension, uniqueName, type CorpusFile } from "../src/core/corpus/corpus.ts";
import { parseEaf } from "../src/core/eaf/parser.ts";
import { writeEaf } from "../src/core/eaf/writer.ts";
import { generateDemoCorpus, DEMO_DYADS } from "../src/core/demo/demoCorpus.ts";
import { chainGroups, complementCoverage, forEachOverlap, intersectCoverage, sampleIndices, totalDuration, unionIntervals } from "../src/core/intervals.ts";

function fileWithTiers(name: string, tiers: { id: string; participant?: string; type?: string }[]): CorpusFile {
  const types = [...new Set(tiers.map((t) => t.type ?? "default-lt"))];
  const xml = writeEaf({
    linguisticTypes: types.map((id) => ({ id })),
    tiers: tiers.map((t) => ({ id: t.id, linguisticType: t.type ?? "default-lt", participant: t.participant, annotations: [{ start: 0, end: 100, value: "x" }] })),
  });
  return { id: name, name, doc: parseEaf(xml, `${name}.eaf`), meta: {} };
}

describe("inferScheme", () => {
  const role = (files: CorpusFile[], tier: string) => {
    const r = inferScheme(files)[tier]!;
    return [r.layer, r.participant];
  };

  it("detects participant prefixes and suffixes", () => {
    const pre = [fileWithTiers("f", [{ id: "A_speech" }, { id: "B_speech" }, { id: "A_gesture" }, { id: "B_gesture" }, { id: "notes" }])];
    expect(role(pre, "A_speech")).toEqual(["speech", "A"]);
    expect(role(pre, "B_gesture")).toEqual(["gesture", "B"]);
    expect(role(pre, "notes")).toEqual(["notes", ""]);
    const suf = [fileWithTiers("f", [{ id: "Speech-S1" }, { id: "Speech-S2" }, { id: "Gaze-S1" }, { id: "Gaze-S2" }])];
    expect(role(suf, "Speech-S2")).toEqual(["Speech", "S2"]);
    expect(role(suf, "Gaze-S1")).toEqual(["Gaze", "S1"]);
  });

  it("handles ACLEW-style layer@participant names", () => {
    const f = [fileWithTiers("f", [{ id: "CHI" }, { id: "FA1" }, { id: "xds@FA1" }, { id: "xds@MA1" }, { id: "MA1" }, { id: "vcm@CHI" }])];
    expect(role(f, "xds@FA1")).toEqual(["xds", "FA1"]);
    expect(role(f, "FA1")).toEqual(["main", "FA1"]);
    expect(role(f, "MA1")).toEqual(["main", "MA1"]);
  });

  it("prefers the PARTICIPANT attribute and falls back to the linguistic type", () => {
    const f = [fileWithTiers("f", [
      { id: "Speech1", participant: "Anna", type: "Speech" },
      { id: "Speech2", participant: "Ben", type: "Speech" },
      { id: "Hands1", participant: "Anna", type: "Gesture" },
      { id: "Hands2", participant: "Ben", type: "Gesture" },
    ])];
    expect(role(f, "Speech1")).toEqual(["Speech", "Anna"]);
    expect(role(f, "Hands2")).toEqual(["Gesture", "Ben"]);
  });

  it("does not mistake hands for participants", () => {
    const f = [fileWithTiers("f", [{ id: "gesture_left" }, { id: "gesture_right" }])];
    expect(role(f, "gesture_left")).toEqual(["gesture_left", ""]);
  });

  it("finds the pattern across files with different speakers", () => {
    const files = [
      fileWithTiers("f1", [{ id: "anna_words" }, { id: "ben_words" }]),
      fileWithTiers("f2", [{ id: "carla_words" }, { id: "dave_words" }]),
    ];
    const scheme = inferScheme(files);
    expect(scheme["carla_words"]).toMatchObject({ layer: "words", participant: "carla" });
    expect(layerTiers(files, scheme, "words").map((t) => t.participant)).toEqual(["anna", "ben", "carla", "dave"]);
    expect(listParticipants(files, scheme)).toEqual(["anna", "ben", "carla", "dave"]);
  });

  it("keeps rows the user has edited", () => {
    const files = [fileWithTiers("f", [{ id: "A_speech" }, { id: "B_speech" }])];
    const edited = { A_speech: { tierName: "A_speech", layer: "talk", participant: "Director", auto: false } };
    const scheme = inferScheme(files, edited);
    expect(scheme["A_speech"]).toEqual(edited.A_speech);
    expect(scheme["B_speech"]).toMatchObject({ layer: "speech", participant: "B", auto: true });
  });
});

describe("detectKind", () => {
  it("classifies value sets", () => {
    expect(detectKind([]).kind).toBe("empty");
    expect(detectKind(["", " "]).kind).toBe("empty");
    expect(detectKind(["iconic", "beat", "iconic", "deictic"]).kind).toBe("categorical");
    expect(detectKind(Array.from({ length: 50 }, (_, i) => String(i * 1.5))).kind).toBe("numeric");
    expect(detectKind(Array.from({ length: 40 }, (_, i) => `so this is utterance number ${i}`)).kind).toBe("text");
  });
});

describe("demo corpus", () => {
  const demo = generateDemoCorpus();
  const files: CorpusFile[] = demo.map((d, i) => ({ id: `f${i}`, name: stripExtension(d.fileName), doc: parseEaf(d.xml, d.fileName), meta: d.meta }));

  it("is deterministic and parses without warnings", () => {
    expect(demo).toHaveLength(DEMO_DYADS);
    expect(generateDemoCorpus()[3]!.xml).toBe(demo[3]!.xml);
    expect(generateDemoCorpus(7)[3]!.xml).not.toBe(demo[3]!.xml);
    for (const f of files) expect(f.doc.warnings).toEqual([]);
  });

  it("has well-formed tiers", () => {
    for (const f of files) {
      for (const t of f.doc.tiers) {
        for (let i = 0; i < t.annotations.length; i++) {
          const a = t.annotations[i]!;
          expect(a.end).toBeGreaterThan(a.start);
          expect(a.start).toBeGreaterThanOrEqual(0);
          if (i > 0) expect(a.start).toBeGreaterThanOrEqual(t.annotations[i - 1]!.end);
        }
      }
    }
  });

  it("yields the expected layers", () => {
    const scheme = inferScheme(files);
    const layers = listLayers(files, scheme);
    const byName = Object.fromEntries(layers.map((l) => [l.name, l]));
    expect(Object.keys(byName).sort()).toEqual(["gaze", "gesture", "gesture_R2", "gesture_phase", "head", "round", "speech"]);
    expect(byName.speech!.kind).toBe("text");
    expect(byName.gesture!.kind).toBe("categorical");
    expect(byName.speech!.participants).toEqual(["A", "B"]);
    expect(byName.speech!.fileCount).toBe(DEMO_DYADS);
    expect(byName.gesture_R2!.fileCount).toBe(2);
  });
});

describe("helpers", () => {
  it("names files", () => {
    expect(stripExtension("a.b.eaf")).toBe("a.b");
    expect(uniqueName(new Set(["x", "x (2)"]), "x")).toBe("x (3)");
  });
});

describe("intervals", () => {
  const iv = (start: number, end: number) => ({ start, end });

  it("unions, intersects and complements coverage", () => {
    const u = unionIntervals([iv(5, 8), iv(0, 2), iv(1, 3), iv(8, 9)]);
    expect(u).toEqual([iv(0, 3), iv(5, 9)]);
    expect(totalDuration(u)).toBe(7);
    expect(unionIntervals([iv(0, 1), iv(1.5, 2)], 0.5)).toEqual([iv(0, 2)]);
    expect(intersectCoverage([iv(0, 3), iv(5, 9)], [iv(2, 6), iv(8, 12)])).toEqual([iv(2, 3), iv(5, 6), iv(8, 9)]);
    expect(complementCoverage([iv(0, 3), iv(5, 9)], 0, 10)).toEqual([iv(3, 5), iv(9, 10)]);
    expect(complementCoverage([], 2, 4)).toEqual([iv(2, 4)]);
    expect(complementCoverage([iv(-5, 20)], 0, 10)).toEqual([]);
  });

  it("finds all overlapping pairs, matching a brute-force check", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let rep = 0; rep < 30; rep++) {
      const mk = (n: number, allowOverlap: boolean) => {
        const xs: { start: number; end: number }[] = [];
        let t = 0;
        for (let i = 0; i < n; i++) {
          const s = allowOverlap ? rnd() * 100 : t + Math.floor(rnd() * 5);
          const e = s + Math.floor(rnd() * 8) * (rnd() < 0.15 ? 0 : 1);
          xs.push(iv(Math.floor(s), Math.floor(e)));
          t = Math.floor(e);
        }
        return xs.sort((p, q) => p.start - q.start || p.end - q.end);
      };
      const a = mk(25, rep % 2 === 0);
      const b = mk(25, rep % 3 === 0);
      const got: string[] = [];
      forEachOverlap(a, b, (i, j, s, e) => got.push(`${i}-${j}:${s}-${e}`));
      const want: string[] = [];
      for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
        if (b[j]!.start < a[i]!.end && b[j]!.end > a[i]!.start) want.push(`${i}-${j}:${Math.max(a[i]!.start, b[j]!.start)}-${Math.min(a[i]!.end, b[j]!.end)}`);
      }
      expect(got.sort()).toEqual(want.sort());
    }
  });

  it("treats touching intervals as non-overlapping", () => {
    const got: number[][] = [];
    forEachOverlap([iv(0, 10)], [iv(9, 12), iv(10, 20)], (i, j) => got.push([i, j]));
    expect(got).toEqual([[0, 0]]);
  });

  it("samples states and chains close intervals", () => {
    const xs = [iv(0, 10), iv(20, 30)];
    expect([...sampleIndices(xs, 0, 5, 7)]).toEqual([0, 0, -1, -1, 1, 1, -1]);
    expect(chainGroups([iv(0, 1), iv(1.1, 2), iv(5, 6), iv(6.2, 7), iv(9, 10)], 0.3)).toEqual([[0, 1], [2, 3], [4, 4]]);
  });
});
