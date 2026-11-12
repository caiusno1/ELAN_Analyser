import { describe, expect, it } from "vitest";
import { analyseAlignment, alignmentAnnotations, alignmentSurrogates, DEFAULT_ALIGNMENT, F_ALIGNED, F_SELF, type AlignmentOptions } from "../src/core/analysis/alignment.ts";
import { allenRelation, cooccurrence, cooccurrenceSurrogates, NONE } from "../src/core/analysis/cooccurrence.ts";
import { describeLayer, corpusOverview } from "../src/core/analysis/descriptives.ts";
import { compileFilter, formatDuration, formatTime, normalizeValue } from "../src/core/analysis/common.ts";
import { numberColumn, stringColumn } from "../src/core/data/dataset.ts";
import { DEFAULT_TOKENIZER, STOP_WORDS, tokenizeText, topFrequentTypes } from "../src/core/text/tokenize.ts";
import { mean } from "../src/core/stats/describe.ts";
import { corpus, demoCorpus, makeFile } from "./helpers.ts";

describe("tokenizer", () => {
  it("normalises, drops bracketed material and filler patterns", () => {
    const t = tokenizeText("Well, (laughs) the RED one — isn't it? [noise] xxx &uh", DEFAULT_TOKENIZER).map((x) => x.norm);
    expect(t).toEqual(["well", "the", "red", "one", "isn't", "it"]);
    expect(tokenizeText("Äpfel-Kuchen 日本 語", { ...DEFAULT_TOKENIZER, lowercase: false }).map((x) => x.norm)).toEqual(["Äpfel-Kuchen", "日本", "語"]);
    expect(tokenizeText("a b", { ...DEFAULT_TOKENIZER, dropPattern: "([" }).length).toBe(2);
    expect(topFrequentTypes(["a", "b", "a", "c", "b", "a"], 2)).toEqual(["a", "b"]);
  });
});

describe("common helpers", () => {
  it("formats times like ELAN", () => {
    expect(formatTime(83456)).toBe("1:23.456");
    expect(formatTime(3723004)).toBe("1:02:03.004");
    expect(formatTime(-500)).toBe("-0:00.500");
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(2500)).toBe("2.50 s");
    expect(formatDuration(150000)).toBe("2.5 min");
  });
  it("filters and normalises values", () => {
    expect(compileFilter({ mode: "regex", pattern: "^ic" }).test(" Iconic")).toBe(true);
    expect(compileFilter({ mode: "regex", pattern: "^ic", negate: true }).test("beat")).toBe(true);
    expect(compileFilter({ mode: "values", values: ["beat"] }).test("beat ")).toBe(true);
    const bad = compileFilter({ mode: "regex", pattern: "(" });
    expect(bad.error).toMatch(/Invalid regular expression/);
    expect(bad.test("x")).toBe(false);
    expect(normalizeValue("  a   b ")).toBe("a b");
    expect(normalizeValue("  ")).toBe("(empty)");
  });
});

describe("descriptives", () => {
  const { files, scheme } = corpus([
    makeFile("f1", {
      A_gesture: [[0, 1000, "iconic"], [2000, 2500, "beat"], [3000, 5000, "iconic"]],
      B_gesture: [[1000, 1400, "beat"]],
      A_speech: [[0, 60000, "one two three"]],
    }, { condition: "x" }),
  ]);

  it("computes counts, durations, rates and coverage", () => {
    const res = describeLayer(files, scheme, { layer: "gesture", byValue: false });
    const a = res.rows.find((r) => r.participant === "A")!;
    expect(a.n).toBe(3);
    expect(a.totalDuration).toBeCloseTo(3.5, 10);
    expect(a.meanDuration).toBeCloseTo(3.5 / 3, 10);
    expect(a.medianDuration).toBeCloseTo(1, 10);
    expect(a.ratePerMin).toBeCloseTo(3, 10);
    expect(a.coverage).toBeCloseTo(3.5 / 60, 10);
    expect(a.latency).toBe(0);
    expect(a.rateCi[0]).toBeLessThan(3);
    expect(a.rateCi[1]).toBeGreaterThan(3);
    expect(stringColumn(res.dataset, "condition")).toEqual(["x", "x"]);
    expect(res.annotations.rowCount).toBe(4);
  });

  it("splits by value and applies filters", () => {
    const res = describeLayer(files, scheme, { layer: "gesture", byValue: true, filter: { mode: "regex", pattern: "iconic" } });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ value: "iconic", n: 2, participant: "A" });
    const words = describeLayer(files, scheme, { layer: "speech", byValue: false });
    expect(numberColumn(words.annotations, "words")[0]).toBe(3);
    const ov = corpusOverview(files, scheme);
    expect(ov).toMatchObject({ files: 1, tiers: 3, annotations: 5, participants: 2, layers: 2, duration: 60000 });
  });
});

describe("co-occurrence", () => {
  const { files, scheme } = corpus([
    makeFile("f1", {
      A_gesture: [[0, 1000, "iconic"], [2000, 3000, "beat"], [5000, 6000, "iconic"], [8000, 9000, "iconic"]],
      A_speech: [[500, 2500, "talk"], [5000, 6000, "talk"], [9500, 10000, "hum"]],
      B_speech: [[8200, 8800, "talk"]],
    }),
  ]);

  it("counts overlapping pairs, durations and anchored cases", () => {
    const res = cooccurrence(files, scheme, { layerX: "gesture", layerY: "speech", pairing: "same", minOverlap: 0 });
    expect(res.tierPairs).toBe(1);
    expect(res.xValues).toEqual(["iconic", "beat"]);
    expect(res.yValues).toEqual(["talk", "hum", NONE]);
    expect(res.pairCounts).toEqual([[2, 0], [1, 0]]);
    expect(res.overlapMs).toEqual([[1500, 0], [500, 0]]);
    // iconic: 2 with talk, 1 without any speech; beat: 1 with talk.
    expect(res.anchored).toEqual([[2, 0, 1], [1, 0, 0]]);
    expect(res.xCounts).toEqual([3, 1]);
    expect(res.totalInstances).toBe(3);
    expect(res.relations.equals).toBe(1);
    expect(res.relations.overlaps).toBe(1);
    expect(res.relations["overlapped by"]).toBe(1);
    expect([...res.onsetLags].sort((a, b) => a - b)).toEqual([-1500, 0, 500]);
  });

  it("computes time-based association", () => {
    const res = cooccurrence(files, scheme, { layerX: "gesture", layerY: "speech", pairing: "same", minOverlap: 0 });
    const a = res.association.find((x) => x.xValue === "iconic" && x.yValue === "talk")!;
    expect(a.joint).toBe(1500);
    expect(a.xTime).toBe(3000);
    expect(a.yTime).toBe(3000);
    expect(a.expected).toBeCloseTo((3000 * 3000) / 10000, 8);
    expect(a.lift).toBeCloseTo(1500 / 900, 8);
    expect(a.pYgivenX).toBeCloseTo(0.5, 10);
    expect(a.jaccard).toBeCloseTo(1500 / 4500, 10);
    expect(a.yuleQ).toBeGreaterThan(0);
  });

  it("respects the pairing rule and the minimum overlap", () => {
    const other = cooccurrence(files, scheme, { layerX: "gesture", layerY: "speech", pairing: "other", minOverlap: 0 });
    expect(other.tierPairs).toBe(1);
    expect(other.pairCounts).toEqual([[1], [0]]);
    const any = cooccurrence(files, scheme, { layerX: "gesture", layerY: "speech", pairing: "any", minOverlap: 0 });
    expect(any.tierPairs).toBe(2);
    const strict = cooccurrence(files, scheme, { layerX: "gesture", layerY: "speech", pairing: "same", minOverlap: 600 });
    expect(strict.pairCounts).toEqual([[1, 0], [0, 0]]);
    const self = cooccurrence(files, scheme, { layerX: "speech", layerY: "speech", pairing: "other", minOverlap: 0 });
    expect(self.tierPairs).toBe(2);
  });

  it("classifies Allen relations with tolerance", () => {
    expect(allenRelation(0, 10, 0, 10, 0)).toBe("equals");
    expect(allenRelation(0, 10, 1, 9, 2)).toBe("equals");
    expect(allenRelation(0, 5, 0, 10, 0)).toBe("starts");
    expect(allenRelation(0, 15, 0, 10, 0)).toBe("started by");
    expect(allenRelation(5, 10, 0, 10, 0)).toBe("finishes");
    expect(allenRelation(0, 10, 5, 10, 0)).toBe("finished by");
    expect(allenRelation(2, 8, 0, 10, 0)).toBe("during");
    expect(allenRelation(0, 10, 2, 8, 0)).toBe("contains");
    expect(allenRelation(0, 6, 4, 10, 0)).toBe("overlaps");
    expect(allenRelation(4, 10, 0, 6, 0)).toBe("overlapped by");
    expect(allenRelation(0, 5, 5, 10, 0)).toBe("meets");
    expect(allenRelation(5, 10, 0, 5, 0)).toBe("met by");
    expect(allenRelation(0, 4, 6, 10, 0)).toBe("before");
    expect(allenRelation(6, 10, 0, 4, 0)).toBe("after");
  });

  it("finds the built-in gesture–speech coupling in the demo corpus, above the shift baseline", () => {
    const { files: demo, scheme: ds } = demoCorpus();
    const opts = { layerX: "gesture", layerY: "speech", pairing: "same" as const, minOverlap: 0 };
    const res = cooccurrence(demo, ds, opts);
    const withSpeech = res.anchored.reduce((s, row) => s + row.slice(0, -1).reduce((a, b) => a + b, 0), 0);
    const total = res.xCounts.reduce((a, b) => a + b, 0);
    expect(withSpeech / total).toBeGreaterThan(0.9);
    const sur = cooccurrenceSurrogates(demo, ds, opts, 40, 3);
    const observed = res.pairCounts.flat().reduce((a, b) => a + b, 0);
    const chance = sur.counts.mean.flat().reduce((a, b) => a + b, 0);
    expect(observed).toBeGreaterThan(1.15 * chance);
    expect(cooccurrenceSurrogates(demo, ds, opts, 5, 3).counts.mean).toEqual(cooccurrenceSurrogates(demo, ds, opts, 5, 3).counts.mean);
  });
});

describe("lexical alignment", () => {
  const base = (layer = "speech"): AlignmentOptions => ({ ...DEFAULT_ALIGNMENT, layer, tokenizer: DEFAULT_TOKENIZER });
  const { files, scheme } = corpus([
    makeFile("d1", {
      A_speech: [[0, 1000, "the red triangle is big"], [3000, 4000, "yes the red triangle"], [6000, 7000, "a blue circle"]],
      B_speech: [[1500, 2500, "the red triangle?"], [4500, 5500, "okay big one"], [7500, 8500, "blue circle got it"]],
    }),
  ]);

  it("finds maximal re-used expressions and their primes", () => {
    const res = analyseAlignment(files, scheme, base());
    const f = res.files[0]!;
    expect(f.speakers).toEqual(["A", "B"]);
    expect(f.units.map((u) => u.speaker).join("")).toBe("ABABAB");
    const inst = f.instances.map((i) => `${i.speaker}:${i.expression}<${i.primeSpeaker}@${i.primeUnit}:${i.kind}`);
    expect(inst).toEqual([
      "B:the red triangle<A@0:adoption",
      "A:the red triangle<B@1:reuse",
      "B:big<A@0:adoption",
      "B:blue circle<A@4:adoption",
    ]);
    expect(f.instances[0]).toMatchObject({ unit: 1, from: 0, to: 3, n: 3, distanceUnits: 1 });
    // Unit 2 "yes the red triangle": tokens 1..3 are aligned and also self-repetitions.
    expect([...f.units[2]!.flags]).toEqual([0, F_ALIGNED | F_SELF, F_ALIGNED | F_SELF, F_ALIGNED | F_SELF]);
    expect([...f.units[5]!.flags]).toEqual([F_ALIGNED, F_ALIGNED, 0, 0]);
  });

  it("derives lexicon and speaker measures", () => {
    const f = analyseAlignment(files, scheme, base()).files[0]!;
    expect(f.lexicon.map((e) => e.expression)).toEqual(["the red triangle", "blue circle", "big"]);
    const tri = f.lexicon[0]!;
    expect(tri).toMatchObject({ initiator: "A", establishedBy: "B", instances: 2, n: 3, establishedUnit: 1 });
    expect(tri.uses).toEqual({ A: 2, B: 1 });
    const b = f.bySpeaker.find((m) => m.speaker === "B")!;
    expect(b.tokens).toBe(10);
    expect(b.alignedTokens).toBe(6);
    expect(b.er).toBeCloseTo(0.6, 12);
    expect(b.adoptions).toBe(3);
    expect(b.initiated).toBe(0);
    const a = f.bySpeaker.find((m) => m.speaker === "A")!;
    expect(a.initiated).toBe(3);
    expect(a.instances).toBe(1);
    expect(a.selfTokens).toBe(3);
    expect(f.overall).toMatchObject({ tokens: 22, instances: 4, alignedTokens: 9, els: 3, maxLength: 3 });
    expect(f.overall.meanLength).toBeCloseTo(9 / 4, 12);
  });

  it("honours minimum length, stop words and the look-back window", () => {
    const min2 = analyseAlignment(files, scheme, { ...base(), minN: 2 }).files[0]!;
    expect(min2.instances.map((i) => i.expression)).toEqual(["the red triangle", "the red triangle", "blue circle"]);
    const stop = analyseAlignment(files, scheme, { ...base(), tokenizer: { ...DEFAULT_TOKENIZER, stopWords: new Set(["big", "the"]) } }).files[0]!;
    expect(stop.instances.map((i) => i.expression)).toEqual(["the red triangle", "the red triangle", "blue circle"]);
    const near = analyseAlignment(files, scheme, { ...base(), lookBack: { kind: "turns", n: 1 } }).files[0]!;
    expect(near.instances.map((i) => i.expression)).toEqual(["the red triangle", "the red triangle", "blue circle"]);
    const secs = analyseAlignment(files, scheme, { ...base(), lookBack: { kind: "seconds", s: 2 } }).files[0]!;
    expect(secs.instances.map((i) => i.expression)).toEqual(["the red triangle", "the red triangle", "blue circle"]);
  });

  it("computes turn-by-turn similarity", () => {
    const f = analyseAlignment(files, scheme, base()).files[0]!;
    const ab = f.directions.find((d) => d.from === "A" && d.to === "B")!;
    expect(ab.pairs).toBe(3);
    // Pair 1: prime 5 tokens, target 3 tokens all shared → LLA 3/15; cosine 3/sqrt(5·3).
    // Pair 2: "yes the red triangle" → "okay big one": nothing shared. Pair 3: 2 of 4 shared.
    expect(ab.lla).toBeCloseTo((3 / 15 + 0 + 2 / 12) / 3, 12);
    expect(ab.cosine).toBeCloseTo((3 / Math.sqrt(15) + 0 + 2 / Math.sqrt(12)) / 3, 12);
    expect(f.lagProfile[0]!.lag).toBe(1);
    expect(f.lagProfile[0]!.nOther).toBe(5);
  });

  it("skips files without two speakers and exports instances as annotations", () => {
    const solo = corpus([makeFile("solo", { A_speech: [[0, 1000, "hello hello"]], B_speech: [] })]);
    const res = analyseAlignment(solo.files, solo.scheme, base());
    expect(res.files).toHaveLength(0);
    expect(res.skipped).toEqual(["solo"]);
    const f = analyseAlignment(files, scheme, base()).files[0]!;
    const anns = alignmentAnnotations(f);
    expect(anns.get("B")!.map((a) => a.value)).toEqual(["the red triangle ← A", "big ← A", "blue circle ← A"]);
    expect(anns.get("B")![0]!.start).toBe(1500);
  });

  it("recovers the built-in condition difference in the demo corpus", () => {
    const { files: demo, scheme: ds } = demoCorpus();
    const res = analyseAlignment(demo, ds, { ...base(), minN: 1, tokenizer: { ...DEFAULT_TOKENIZER, stopWords: new Set(STOP_WORDS.English) } });
    expect(res.files).toHaveLength(12);
    expect(res.totals.instances).toBeGreaterThan(300);
    const er = numberColumn(res.dataset, "er");
    const cond = stringColumn(res.dataset, "condition");
    const f2f = mean(er.filter((_, i) => cond[i] === "f2f"));
    const screen = mean(er.filter((_, i) => cond[i] === "screen"));
    expect(f2f).toBeGreaterThan(screen);
    // Real dialogues align more than fake pairs and than shuffled dialogues.
    const fake = alignmentSurrogates(demo, ds, { ...base(), tokenizer: { ...DEFAULT_TOKENIZER, stopWords: new Set(STOP_WORDS.English) } }, "fake-pairs", 20, 2);
    const above = fake.rows.filter((r) => r.cosine > r.cosineSurrogate).length;
    expect(above).toBeGreaterThanOrEqual(10);
    const shuffled = alignmentSurrogates(demo, ds, base(), "shuffle", 20, 2);
    expect(shuffled.rows.filter((r) => r.cosine > r.cosineSurrogate).length).toBeGreaterThanOrEqual(10);
    expect(shuffled.dataset.rowCount).toBe(12);
  });
});
