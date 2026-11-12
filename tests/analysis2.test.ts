import { describe, expect, it } from "vitest";
import { analyseAgreement, kappaPosterior, UNLINKED } from "../src/core/analysis/agreement.ts";
import { concordance, collectTokens, countTypes, frequencyList, keyness, lexicalDiversity } from "../src/core/analysis/lexicon.ts";
import { analyseRecurrence, DEFAULT_RECURRENCE } from "../src/core/analysis/recurrence.ts";
import { searchAnnotations } from "../src/core/analysis/search.ts";
import { buildSequences, lagProfile, markovOrders, ngrams, sequenceEntropy, transitionTable } from "../src/core/analysis/sequences.ts";
import { allanFactor, analyseTemporal, bayesianBlocks, burstiness, changePoint } from "../src/core/analysis/temporal.ts";
import { addDerivedLayer, derive, removeDerivedLayer, splitByLayer } from "../src/core/analysis/tieralgebra.ts";
import { analyseLags, stateProfile } from "../src/core/analysis/timing.ts";
import { analyseTurnTaking, DEFAULT_TURN_TAKING, floorAnnotations } from "../src/core/analysis/turntaking.ts";
import { DEFAULT_ALIGNMENT } from "../src/core/analysis/alignment.ts";
import { listLayers } from "../src/core/corpus/corpus.ts";
import { numberColumn, stringColumn } from "../src/core/data/dataset.ts";
import { tierById } from "../src/core/eaf/model.ts";
import { mean, median } from "../src/core/stats/describe.ts";
import { Rng } from "../src/core/stats/rng.ts";
import { DEFAULT_TOKENIZER } from "../src/core/text/tokenize.ts";
import { corpus, demoCorpus, makeFile } from "./helpers.ts";

describe("turn-taking", () => {
  // A: 0–1000, 1100–2000 (pause 100 → one talkspurt), 5000–6000, 9000–12000
  // B: 2500–4000 (gap 500), 5800–7000 (overlap 200, speaker change), 10000–10500 (inside A), 12000–13000 (latched)
  const { files, scheme } = corpus([
    makeFile("d", {
      A_speech: [[0, 1000, "a"], [1100, 2000, "b"], [5000, 6000, "c"], [9000, 12000, "d"]],
      B_speech: [[2500, 4000, "e"], [5800, 7000, "f"], [10000, 10500, "mhm"], [12000, 13000, "g"]],
    }),
  ]);
  const res = analyseTurnTaking(files, scheme, { ...DEFAULT_TURN_TAKING, layer: "speech" });
  const f = res.files[0]!;

  it("classifies gaps, pauses and overlaps", () => {
    const kinds = f.segments.map((s) => `${s.kind}:${s.start}-${s.end}`);
    expect(kinds).toEqual([
      "speech:0-2000", "gap:2000-2500", "speech:2500-4000", "gap:4000-5000", "speech:5000-5800",
      "overlap-between:5800-6000", "speech:6000-7000", "gap:7000-9000", "speech:9000-10000",
      "overlap-within:10000-10500", "speech:10500-12000", "speech:12000-13000",
    ]);
    expect(f.stateTime.gap).toBe(3500);
    expect(f.stateTime["overlap-between"]).toBe(200);
    expect(f.stateTime["overlap-within"]).toBe(500);
    expect(f.stateTime.pause).toBe(0);
  });

  it("measures floor transfer offsets", () => {
    expect(f.transfers.map((t) => `${t.from}>${t.to}:${t.fto}:${t.kind}`)).toEqual([
      "A>B:500:gap", "B>A:1000:gap", "A>B:-200:overlap", "B>A:2000:gap", "A>B:0:latched",
    ]);
    expect(res.summary.transfers).toBe(5);
    expect(res.summary.median).toBe(500);
    expect(res.summary.overlapShare).toBeCloseTo(0.2, 12);
    expect(res.summary.within200).toBeCloseTo(0.4, 12);
    const b = f.bySpeaker.find((s) => s.speaker === "B")!;
    expect(b.turnsTaken).toBe(3);
    expect(b.talkspurts).toBe(4);
    expect(b.speakingTime).toBe(4200);
    expect(stringColumn(res.dataset, "direction")).toEqual(["A→B", "B→A", "A→B", "B→A", "A→B"]);
    expect(floorAnnotations(f).map((a) => a.value)).toEqual(["gap", "gap", "overlap-between", "gap", "overlap-within"]);
  });

  it("uses the pause threshold and the duration filter", () => {
    const strict = analyseTurnTaking(files, scheme, { layer: "speech", minPause: 50, minDuration: 0 }).files[0]!;
    expect(strict.stateTime.pause).toBe(100);
    const noBackchannel = analyseTurnTaking(files, scheme, { layer: "speech", minPause: 180, minDuration: 600 }).files[0]!;
    expect(noBackchannel.stateTime["overlap-within"]).toBe(0);
    const solo = corpus([makeFile("s", { A_speech: [[0, 10, "x"]], B_speech: [] })]);
    expect(analyseTurnTaking(solo.files, solo.scheme, { ...DEFAULT_TURN_TAKING, layer: "speech" }).skipped).toEqual(["s"]);
  });

  it("recovers shorter transfer offsets face-to-face in the demo corpus", () => {
    const { files: demo, scheme: ds } = demoCorpus();
    const r = analyseTurnTaking(demo, ds, { ...DEFAULT_TURN_TAKING, layer: "speech" });
    const fto = numberColumn(r.dataset, "fto_ms");
    const cond = stringColumn(r.dataset, "condition");
    expect(median(fto.filter((_, i) => cond[i] === "f2f"))).toBeLessThan(median(fto.filter((_, i) => cond[i] === "screen")));
    expect(r.summary.transfers).toBeGreaterThan(600);
  });
});

describe("timing", () => {
  const { files, scheme } = corpus([
    makeFile("t", {
      A_gesture: [[1000, 1500, "g"], [5000, 5500, "g"], [9000, 9500, "g"]],
      A_word: [[1200, 1300, "w"], [5300, 5400, "w"], [8900, 9000, "w"], [20000, 20100, "w"]],
      A_gaze: [[0, 1100, "partner"], [4000, 6000, "partner"], [15000, 20100, "away"]],
      B_gaze: [],
    }),
  ]);

  it("collects lags between reference and target events", () => {
    const all = analyseLags(files, scheme, { layerX: "gesture", anchorX: "start", layerY: "word", anchorY: "start", pairing: "same", mode: "all", window: 1000, binWidth: 250 });
    expect([...all.lags]).toEqual([200, 300, -100]);
    expect(all.references).toBe(3);
    expect(all.referencesWithTarget).toBe(3);
    expect(all.bins).toHaveLength(8);
    expect(all.bins.map((b) => b.count)).toEqual([0, 0, 0, 1, 1, 1, 0, 0]);
    // 3 references × (4 targets / 20100 ms) × 250 ms
    expect(all.bins[0]!.expected).toBeCloseTo((3 * 4 * 250) / 20100, 10);
    expect(all.summary.median).toBe(200);
    expect(all.summary.shareBefore).toBeCloseTo(1 / 3, 12);
    const next = analyseLags(files, scheme, { layerX: "gesture", anchorX: "end", layerY: "word", anchorY: "start", pairing: "same", mode: "next", window: 20000, binWidth: 1000 });
    expect([...next.lags]).toEqual([3800, 3400, 10500]);
    const nearest = analyseLags(files, scheme, { layerX: "word", anchorX: "middle", layerY: "gesture", anchorY: "middle", pairing: "same", mode: "nearest", window: 500, binWidth: 100 });
    expect([...nearest.lags]).toEqual([0, -100, 300]);
    expect(nearest.referencesWithTarget).toBe(3);
  });

  it("computes event-locked state probabilities", () => {
    const p = stateProfile(files, scheme, { layerX: "gesture", anchorX: "start", layerY: "gaze", filterY: { mode: "values", values: ["partner"] }, pairing: "same", window: 200, step: 100 });
    expect([...p.t]).toEqual([-200, -100, 0, 100, 200]);
    // gaze=partner at 800..1200 → yes,yes,yes,no(1100 end),no ; at 4800..5200 → all yes ; at 8800..9200 → none
    expect([...p.p].map((v) => Math.round(v * 300) / 300)).toEqual([2 / 3, 2 / 3, 2 / 3, 1 / 3, 1 / 3].map((v) => Math.round(v * 300) / 300));
    expect(p.baseline).toBeCloseTo(3100 / 20100, 12);
    expect(p.lower[0]).toBeLessThan(p.p[0]!);
    expect(p.upper[0]).toBeGreaterThan(p.p[0]!);
  });

  it("finds gesture strokes preceding their affiliates and gaze returning at turn ends (demo)", () => {
    const { files: demo, scheme: ds } = demoCorpus();
    // Stroke onsets relative to the start of the speaker's own overlapping speech are noisy;
    // the robust built-in effect: listeners nod around the end of the partner's utterance.
    const nod = analyseLags(demo, ds, { layerX: "speech", anchorX: "end", layerY: "head", filterY: { mode: "values", values: ["nod"] }, anchorY: "start", pairing: "other", mode: "all", window: 2000, binWidth: 250 });
    const peak = nod.bins.reduce((a, b) => (b.count > a.count ? b : a));
    expect(peak.from).toBeGreaterThanOrEqual(-500);
    expect(peak.to).toBeLessThanOrEqual(250);
    expect(peak.count).toBeGreaterThan(3 * peak.expected);
    const f2f = demo.filter((f) => f.meta.condition === "f2f");
    const gaze = stateProfile(f2f, ds, { layerX: "speech", anchorX: "end", layerY: "gaze", filterY: { mode: "values", values: ["partner"] }, pairing: "same", window: 2000, step: 100 });
    const at = (ms: number) => gaze.p[gaze.t.indexOf(ms)]!;
    // Kendon's pattern: gaze away during the turn, back at the partner by its end.
    expect(at(-100)).toBeGreaterThan(at(-800) + 0.1);
    expect(at(-100)).toBeGreaterThan(gaze.baseline);
  });
});

describe("sequences", () => {
  const { files, scheme } = corpus([
    makeFile("s1", { phase: [[0, 1, "prep"], [1, 2, "stroke"], [2, 3, "retr"], [10, 11, "prep"], [11, 12, "stroke"], [12, 13, "hold"], [13, 14, "retr"]] }),
    makeFile("s2", { phase: [[0, 1, "prep"], [1, 2, "stroke"], [2, 3, "retr"]] }),
  ]);
  const opts = { layers: ["phase"], stream: "file" as const, labelParticipant: false, collapseRepeats: false, breakGap: 5 };

  it("builds sequences, n-grams and transitions", () => {
    const seq = buildSequences(files, scheme, opts);
    expect(seq.symbols).toEqual(["prep", "retr", "stroke", "hold"]);
    expect(seq.sequences[0]!.runs.map((r) => r.length)).toEqual([3, 4]);
    expect(seq.totalTransitions).toBe(7);
    const bi = ngrams(seq, 2);
    expect(bi[0]).toMatchObject({ gram: ["prep", "stroke"], count: 3, files: 2 });
    expect(ngrams(seq, 3, 2).map((g) => g.gram.join(">"))).toEqual(["prep>stroke>retr"]);
    const cells = transitionTable(seq);
    const ps = cells.find((c) => c.from === "prep" && c.to === "stroke")!;
    expect(ps.count).toBe(3);
    expect(ps.probability).toBeCloseTo(4 / 7, 12);
    expect(ps.baseRate).toBeCloseTo(3 / 7, 12);
    expect(ps.ci[0]).toBeLessThan(ps.probability);
    expect(ps.pAboveBase).toBeGreaterThan(0.5);
    const nb = buildSequences(files, scheme, { ...opts, breakGap: 0 });
    expect(nb.totalTransitions).toBe(8);
    const lp = lagProfile(seq, "prep", "retr", 3);
    expect(lp.map((l) => l.probability)).toEqual([0, 2 / 3, 1]);
    const h = sequenceEntropy(seq);
    expect(h.entropy).toBeLessThanOrEqual(h.maxEntropy);
    expect(h.conditional).toBeLessThan(h.entropy);
  });

  it("identifies the Markov order of simulated sequences", () => {
    const rng = new Rng(5);
    const mk = (order1: boolean) => {
      const anns: [number, number, string][] = [];
      let prev = 0;
      for (let i = 0; i < 600; i++) {
        const s = order1 ? (rng.uniform() < 0.8 ? (prev + 1) % 3 : rng.int(3)) : rng.int(3);
        anns.push([i * 10, i * 10 + 5, "abc"[s]!]);
        prev = s;
      }
      return corpus([makeFile("m", { tier: anns })]);
    };
    const dep = mk(true);
    const o1 = markovOrders(buildSequences(dep.files, dep.scheme, { layers: ["tier"], stream: "file", labelParticipant: false, collapseRepeats: false, breakGap: 0 }), 2);
    expect(o1[1]!.posterior).toBeGreaterThan(0.95);
    expect(o1.map((o) => o.parameters)).toEqual([2, 6, 18]);
    const ind = mk(false);
    const o0 = markovOrders(buildSequences(ind.files, ind.scheme, { layers: ["tier"], stream: "file", labelParticipant: false, collapseRepeats: false, breakGap: 0 }), 2);
    expect(o0[0]!.posterior).toBeGreaterThan(0.9);
  });

  it("merges layers and labels participants; finds gesture phase order in the demo", () => {
    const { files: demo, scheme: ds } = demoCorpus();
    const seq = buildSequences(demo, ds, { layers: ["gesture_phase"], stream: "tier", labelParticipant: false, collapseRepeats: false, breakGap: 100 });
    const cells = transitionTable(seq);
    expect(cells.find((c) => c.from === "preparation" && c.to === "stroke")!.probability).toBeGreaterThan(0.95);
    expect(cells.find((c) => c.from === "stroke" && c.to === "preparation")!.count).toBe(0);
    const multi = buildSequences(demo, ds, { layers: ["gesture", "head"], stream: "file", labelParticipant: true, collapseRepeats: false, breakGap: 0 });
    expect(multi.symbols.some((s) => s === "B:head=nod")).toBe(true);
  });
});

describe("recurrence", () => {
  it("computes recurrence rate, lines and the diagonal profile", () => {
    // y repeats x two events later: x = a b c d e f, y = z z a b c d
    const mk = (labels: string, offset: number): [number, number, string][] => [...labels].map((ch, i) => [i * 10 + offset, i * 10 + offset + 5, ch]);
    const { files, scheme } = corpus([makeFile("r", { A_act: mk("abcdef", 0), B_act: mk("zzabcd", 1) })]);
    const res = analyseRecurrence(files, scheme, { ...DEFAULT_RECURRENCE, layerX: "act", layerY: "act", maxLag: 3 });
    const ab = res.pairs.find((p) => p.xLabel === "A" && p.yLabel === "B")!;
    expect(ab.peakLag).toBe(2);
    expect(ab.profile.find((p) => p.lag === 2)!.rr).toBe(1);
    expect(ab.profile.find((p) => p.lag === 0)!.rr).toBe(0);
    expect(ab.maxLine).toBe(4);
    expect(ab.det).toBe(1);
    expect(ab.asymmetry).toBeGreaterThan(0);
    const ba = res.pairs.find((p) => p.xLabel === "B" && p.yLabel === "A")!;
    expect(ba.peakLag).toBe(-2);
    expect(res.meanProfile).toHaveLength(7);
    expect(ab.expectedRr).toBeCloseTo(4 / 36, 12);
  });

  it("samples state tiers in time and handles words", () => {
    const { files, scheme } = corpus([
      makeFile("g", { A_gaze: [[0, 1000, "p"], [1000, 2000, "t"], [3000, 4000, "p"]], B_gaze: [[500, 1500, "p"], [1500, 2500, "t"], [3500, 4000, "p"]] }),
    ]);
    const res = analyseRecurrence(files, scheme, { ...DEFAULT_RECURRENCE, layerX: "gaze", layerY: "gaze", unit: "time", step: 250, maxLag: 4 });
    const ab = res.pairs.find((p) => p.xLabel === "A")!;
    expect(ab.nx).toBe(16);
    expect(res.lagUnitMs).toBe(250);
    expect(ab.peakLag).toBe(2);
    const { files: demo, scheme: ds } = demoCorpus();
    const words = analyseRecurrence(demo.slice(0, 2), ds, { ...DEFAULT_RECURRENCE, layerX: "speech", layerY: "speech", tokenizer: DEFAULT_TOKENIZER, maxLag: 30 });
    expect(words.pairs).toHaveLength(4);
    expect(words.pairs[0]!.rr).toBeGreaterThan(0);
    expect(words.dataset.rowCount).toBe(4);
  });
});

describe("temporal structure", () => {
  it("measures burstiness of regular, random and clustered streams", () => {
    const regular = Array.from({ length: 200 }, (_, i) => i * 1000);
    expect(burstiness(regular).b).toBeCloseTo(-1, 10);
    expect(burstiness(regular).bCorrected).toBeCloseTo(-1, 10);
    const rng = new Rng(2);
    const poisson: number[] = [];
    let t = 0;
    for (let i = 0; i < 3000; i++) {
      t += rng.exponential(1 / 1000);
      poisson.push(t);
    }
    const poissonDuration = t;
    expect(Math.abs(burstiness(poisson).b)).toBeLessThan(0.05);
    expect(Math.abs(burstiness(poisson).memory)).toBeLessThan(0.06);
    const bursty: number[] = [];
    t = 0;
    for (let i = 0; i < 300; i++) {
      t += rng.exponential(1 / 20000);
      for (let k = 0; k < 8; k++) bursty.push(t + k * 50 + rng.range(0, 10));
    }
    bursty.sort((a, b) => a - b);
    expect(burstiness(bursty).b).toBeGreaterThan(0.4);
    // All events at once: the corrected measure reaches its maximum of 1.
    expect(burstiness([0, 0, 0, 0, 0, 1000]).bCorrected).toBeCloseTo(1, 10);
    expect(Number.isNaN(burstiness([1, 2]).b)).toBe(true);
    const afP = allanFactor(poisson, poissonDuration);
    expect(Math.abs(afP.slope)).toBeLessThan(0.15);
    const afB = allanFactor(bursty, bursty[bursty.length - 1]!);
    expect(afB.points[afB.points.length - 1]!.af).toBeGreaterThan(3);
  });

  it("locates a change in rate and stays calm without one", () => {
    const rng = new Rng(7);
    const events: number[] = [];
    let t = 0;
    while (t < 60000) {
      t += rng.exponential(1 / 2000);
      if (t < 60000) events.push(t);
    }
    while (t < 120000) {
      t += rng.exponential(1 / 400);
      if (t < 120000) events.push(t);
    }
    const cp = changePoint(events, 120000)!;
    expect(cp.logBf10).toBeGreaterThan(10);
    expect(cp.ci[0]).toBeGreaterThan(52000);
    expect(cp.ci[1]).toBeLessThan(68000);
    expect(Math.abs(cp.mode - 60000)).toBeLessThan(8000);
    expect(cp.rateAfter / cp.rateBefore).toBeGreaterThan(3);
    expect([...cp.posterior].reduce((s, v) => s + v, 0)).toBeCloseTo(1, 10);
    const blocks = bayesianBlocks(events, 120000);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks[0]!.start).toBe(0);
    expect(blocks[blocks.length - 1]!.end).toBe(120000);
    expect(blocks.reduce((s, b) => s + b.events, 0)).toBe(events.length);
    expect(blocks[blocks.length - 1]!.rate).toBeGreaterThan(2 * blocks[0]!.rate);
    const flat: number[] = [];
    t = 0;
    while (t < 120000) {
      t += rng.exponential(1 / 1000);
      if (t < 120000) flat.push(t);
    }
    expect(changePoint(flat, 120000)!.logBf10).toBeLessThan(1);
    expect(bayesianBlocks(flat, 120000).length).toBeLessThanOrEqual(2);
    expect(changePoint([1, 2], 10)).toBeUndefined();
    expect(bayesianBlocks([], 100)).toEqual([{ start: 0, end: 100, events: 0, rate: 0 }]);
  });

  it("summarises tiers and finds the declining gesture rate in the demo", () => {
    const { files: demo, scheme: ds } = demoCorpus();
    const res = analyseTemporal(demo, ds, { layer: "gesture", participants: new Set(["A"]), bin: 10000 });
    expect(res.tiers).toHaveLength(12);
    expect(res.timeCourse).toHaveLength(10);
    // Gestures become rarer in the later rounds (which are also shorter).
    const early = mean(res.timeCourse.slice(0, 5).map((d) => d.rate));
    const late = mean(res.timeCourse.slice(8).map((d) => d.rate));
    expect(early).toBeGreaterThan(1.5 * late);
    expect(res.timeCourse[0]!.lower).toBeLessThan(res.timeCourse[0]!.rate);
    expect(res.tiers[0]!.activity.reduce((s, a) => s + a.count, 0)).toBe(res.tiers[0]!.times.length);
    expect(res.dataset.rowCount).toBe(12);
  });
});

describe("lexicon", () => {
  const { files, scheme } = corpus([
    makeFile("l1", { A_speech: [[0, 1000, "the cat sat on the mat"], [2000, 3000, "the cat ran"]], B_speech: [[1000, 2000, "a dog sat"]] }),
    makeFile("l2", { A_speech: [[0, 1000, "the the the"]], B_speech: [[1000, 2000, "dog dog bird"]] }),
  ]);
  const tokens = collectTokens(files, scheme, "speech", DEFAULT_TOKENIZER);

  it("counts types with dispersion", () => {
    expect(tokens).toHaveLength(18);
    const freq = frequencyList(tokens);
    expect(freq[0]).toMatchObject({ type: "the", count: 6, files: 2, speakers: 2 });
    expect(freq[0]!.perThousand).toBeCloseTo(6000 / 18, 10);
    const cat = freq.find((f) => f.type === "cat")!;
    // cat occurs only in l1 (12 of 18 tokens): DP = (|1 − 12/18| + |0 − 6/18|)/2 = 1/3
    expect(cat.dp).toBeCloseTo(1 / 3, 12);
  });

  it("measures lexical diversity", () => {
    const d = lexicalDiversity(["a", "b", "a", "c", "a", "b"]);
    expect(d).toMatchObject({ tokens: 6, types: 3, hapax: 1 });
    expect(d.ttr).toBeCloseTo(0.5, 12);
    expect(d.guiraud).toBeCloseTo(3 / Math.sqrt(6), 12);
    expect(d.yuleK).toBeCloseTo((1e4 * (9 + 4 + 1 - 6)) / 36, 10);
    const rng = new Rng(1);
    const rich = Array.from({ length: 400 }, () => `w${rng.int(300)}`);
    const poor = Array.from({ length: 400 }, () => `w${rng.int(12)}`);
    expect(lexicalDiversity(rich).mattr).toBeGreaterThan(lexicalDiversity(poor).mattr + 0.3);
    expect(lexicalDiversity(rich).mtld).toBeGreaterThan(lexicalDiversity(poor).mtld * 3);
  });

  it("ranks key words with shrinkage", () => {
    const a = countTypes(tokens.filter((t) => t.participant === "A"));
    const b = countTypes(tokens.filter((t) => t.participant === "B"));
    const key = keyness(a, b, 10);
    expect(key[0]!.type).toBe("the");
    expect(key[key.length - 1]!.type).toBe("dog");
    expect(key[0]!.pA).toBeGreaterThan(0.9);
    expect(key[0]!.ci[0]).toBeLessThan(key[0]!.logOdds);
    // A stronger prior shrinks the estimates towards zero.
    expect(Math.abs(keyness(a, b, 1000)[0]!.logOdds)).toBeLessThan(Math.abs(key[0]!.logOdds));
    expect(keyness(new Map(), b)).toEqual([]);
  });

  it("builds concordances", () => {
    const c = concordance(tokens, "cat");
    expect(c.total).toBe(2);
    expect(c.lines[0]).toMatchObject({ left: "the", match: "cat", right: "sat on the mat the cat" });
    expect(concordance(tokens, "the cat").total).toBe(2);
    expect(concordance(tokens, "d.g|bird").total).toBe(4);
    expect(concordance(tokens, "(").error).toMatch(/Invalid/);
    expect(concordance(tokens, "sat dog").total).toBe(0);
  });
});

describe("agreement", () => {
  const { files, scheme } = corpus([
    makeFile("a", {
      A_gesture: [[0, 1000, "iconic"], [2000, 3000, "beat"], [4000, 5000, "iconic"], [6000, 7000, "deictic"]],
      A_gesture_R2: [[50, 1050, "iconic"], [2100, 2900, "iconic"], [4000, 4300, "iconic"], [8000, 9000, "beat"]],
      B_gesture: [[0, 100, "beat"]],
      B_gesture_R2: [[0, 100, "beat"]],
    }),
  ]);

  it("links units and computes κ with a posterior", () => {
    const res = analyseAgreement(files, scheme, { layerA: "gesture", layerB: "gesture_R2", minOverlap: 0.6 });
    expect(res.tierPairs).toBe(2);
    expect(res.categories).toEqual(["iconic", "beat", "deictic", UNLINKED]);
    // linked: iconic–iconic, beat–iconic (A), beat–beat (B); unlinked: A's 3rd iconic (30% overlap), deictic; R2's short iconic, late beat
    expect(res.linked).toBe(3);
    expect(res.unlinkedA).toBe(2);
    expect(res.unlinkedB).toBe(2);
    expect(res.confusion).toEqual([[1, 0, 0, 1], [1, 1, 0, 0], [0, 0, 0, 1], [1, 1, 0, 0]]);
    expect(res.unitKappa.observed).toBeCloseTo(2 / 7, 12);
    expect(res.labelKappa.observed).toBeCloseTo(2 / 3, 12);
    expect(res.unitKappa.ci[0]).toBeLessThan(res.unitKappa.ci[1]);
    expect([...res.onsetDiff]).toEqual([50, 100, 0]);
    expect(res.disagreements).toHaveLength(5);
    expect(res.perCategory.find((c) => c.category === "iconic")).toMatchObject({ n1: 2, n2: 3, both: 1 });
    const loose = analyseAgreement(files, scheme, { layerA: "gesture", layerB: "gesture_R2", minOverlap: 0.2 });
    expect(loose.linked).toBe(4);
  });

  it("computes time-based agreement", () => {
    const res = analyseAgreement(files, scheme, { layerA: "gesture", layerB: "gesture_R2", minOverlap: 0.6 });
    const total = res.timeConfusion.flat().reduce((s, v) => s + v, 0);
    expect(total).toBe(18000);
    expect(res.timeConfusion[0]![0]).toBe(950 + 300);
    expect(res.timeKappa.kappa).toBeGreaterThan(0);
    expect(res.timeKappa.kappa).toBeLessThan(1);
  });

  it("κ posterior is centred on the estimate and narrows with data", () => {
    const small = kappaPosterior([[8, 2], [2, 8]]);
    const large = kappaPosterior([[800, 200], [200, 800]]);
    expect(small.kappa).toBeCloseTo(0.6, 12);
    expect(Math.abs(large.median - 0.6)).toBeLessThan(0.02);
    expect(large.ci[1] - large.ci[0]).toBeLessThan((small.ci[1] - small.ci[0]) / 4);
    expect(large.pAbove08).toBeLessThan(0.01);
    expect(kappaPosterior([[50, 0], [0, 50]]).pAbove08).toBeGreaterThan(0.95);
  });

  it("finds good but imperfect agreement in the demo corpus", () => {
    const { files: demo, scheme: ds } = demoCorpus();
    const res = analyseAgreement(demo, ds, { layerA: "gesture", layerB: "gesture_R2", minOverlap: 0.6 });
    expect(res.tierPairs).toBe(4);
    expect(res.labelKappa.kappa).toBeGreaterThan(0.6);
    expect(res.unitKappa.kappa).toBeLessThan(res.labelKappa.kappa);
    expect(res.boundary.medianAbs).toBeLessThan(200);
  });
});

describe("tier algebra", () => {
  const { files, scheme } = corpus([
    makeFile("x", {
      A_gesture: [[0, 1000, "iconic"], [2000, 3000, "beat"], [5000, 5200, "beat"]],
      A_speech: [[500, 2500, "the red one"], [2600, 2700, "yes"], [6000, 7000, "okay"]],
      B_speech: [[2800, 4000, "which one"]],
      phase: [[0, 3000, "one"], [3000, 7000, "two"]],
    }, { dyad: "1" }),
  ]);

  it("filters, recodes, intersects and subtracts", () => {
    const filt = derive(files, scheme, { kind: "filter", layer: "gesture", filter: { mode: "values", values: ["beat"] }, minDuration: 500, maxDuration: 0 });
    expect(filt.tiers[0]!.annotations).toEqual([{ start: 2000, end: 3000, value: "beat" }]);
    const rec = derive(files, scheme, { kind: "recode", layer: "gesture", pattern: "^(iconic|beat)$", replacement: "gesture" });
    expect(rec.tiers[0]!.annotations.map((a) => a.value)).toEqual(["gesture", "gesture", "gesture"]);
    expect(derive(files, scheme, { kind: "recode", layer: "gesture", pattern: "(", replacement: "" }).error).toMatch(/Invalid/);
    const and = derive(files, scheme, { kind: "overlap", layerX: "gesture", layerY: "speech", pairing: "same", label: "both" });
    expect(and.tiers[0]!.annotations).toEqual([
      { start: 500, end: 1000, value: "iconic + the red one" },
      { start: 2000, end: 2500, value: "beat + the red one" },
      { start: 2600, end: 2700, value: "beat + yes" },
    ]);
    const other = derive(files, scheme, { kind: "overlap", layerX: "gesture", layerY: "speech", pairing: "other", label: "x" });
    expect(other.tiers[0]!.annotations).toEqual([{ start: 2800, end: 3000, value: "beat" }]);
    const not = derive(files, scheme, { kind: "exclude", layerX: "gesture", layerY: "speech", pairing: "same" });
    expect(not.tiers[0]!.annotations).toEqual([{ start: 5000, end: 5200, value: "beat" }]);
  });

  it("merges, complements, chains, tokenises and windows", () => {
    const union = derive(files, scheme, { kind: "union", layers: ["gesture", "speech"], label: "active" });
    expect(union.tiers.find((t) => t.participant === "A")!.annotations.map((a) => [a.start, a.end])).toEqual([[0, 3000], [5000, 5200], [6000, 7000]]);
    const gaps = derive(files, scheme, { kind: "gaps", layer: "speech", label: "silence", minDuration: 200 });
    expect(gaps.tiers.find((t) => t.participant === "A")!.annotations.map((a) => [a.start, a.end])).toEqual([[0, 500], [2700, 6000]]);
    const chain = derive(files, scheme, { kind: "chain", layer: "speech", maxGap: 150, join: "text" });
    expect(chain.tiers.find((t) => t.participant === "A")!.annotations).toEqual([
      { start: 500, end: 2700, value: "the red one yes" },
      { start: 6000, end: 7000, value: "okay" },
    ]);
    expect(derive(files, scheme, { kind: "chain", layer: "speech", maxGap: 150, join: "count" }).tiers.find((t) => t.participant === "A")!.annotations[0]!.value).toBe("2");
    const tok = derive(files, scheme, { kind: "tokens", layer: "speech", tokenizer: DEFAULT_TOKENIZER });
    expect(tok.tiers.find((t) => t.participant === "B")!.annotations.map((a) => a.value)).toEqual(["which", "one"]);
    const win = derive(files, scheme, { kind: "window", layer: "gesture", anchor: "start", before: 300, after: 200 });
    expect(win.tiers[0]!.annotations.map((a) => [a.start, a.end])).toEqual([[0, 200], [1700, 2200], [4700, 5200]]);
    const end = derive(files, scheme, { kind: "window", layer: "gesture", anchor: "end", before: 100, after: 0 });
    expect(end.tiers[0]!.annotations[0]).toMatchObject({ start: 900, end: 1000 });
  });

  it("adds, uses and removes derived layers without touching the originals", () => {
    const d = derive(files, scheme, { kind: "overlap", layerX: "gesture", layerY: "speech", pairing: "same", label: "x" });
    const added = addDerivedLayer(files, scheme, d.tiers, "gesture_with_speech");
    expect(added.added).toBe(1);
    expect(files[0]!.doc.tiers).toHaveLength(4);
    const tier = tierById(added.files[0]!.doc, "A_gesture_with_speech")!;
    expect(tier.derived).toBe(true);
    expect(tier.annotations).toHaveLength(3);
    expect(listLayers(added.files, added.scheme).map((l) => l.name)).toContain("gesture_with_speech");
    const again = addDerivedLayer(added.files, added.scheme, d.tiers, "gesture_with_speech");
    expect(tierById(again.files[0]!.doc, "A_gesture_with_speech_2")).toBeDefined();
    const removed = removeDerivedLayer(again.files, again.scheme, "gesture_with_speech");
    expect(removed.files[0]!.doc.tiers).toHaveLength(4);
    expect(removed.scheme["A_gesture_with_speech"]).toBeUndefined();
    const floor = derive(files, scheme, { kind: "floor", options: { layer: "speech", minPause: 180, minDuration: 0 } });
    expect(floor.tiers[0]!.annotations.map((a) => a.value)).toContain("gap");
    const al = derive(files, scheme, { kind: "alignment", options: { ...DEFAULT_ALIGNMENT, layer: "speech", tokenizer: DEFAULT_TOKENIZER } });
    expect(al.tiers.find((t) => t.participant === "B")!.annotations[0]!.value).toBe("one ← A");
  });

  it("splits recordings by a phase tier", () => {
    const split = splitByLayer(files, scheme, "phase", undefined, "phase");
    expect(split.files.map((f) => f.name)).toEqual(["x · one", "x · two"]);
    expect(split.files[1]!.meta).toEqual({ dyad: "1", phase: "two", source_file: "x" });
    expect(split.files[1]!.doc.duration).toBe(4000);
    expect(tierById(split.files[1]!.doc, "A_gesture")!.annotations.map((a) => [a.start, a.end, a.value])).toEqual([[2000, 2200, "beat"]]);
    // An annotation crossing the boundary is trimmed on both sides.
    expect(tierById(split.files[0]!.doc, "B_speech")!.annotations.map((a) => [a.start, a.end])).toEqual([[2800, 3000]]);
    expect(tierById(split.files[1]!.doc, "B_speech")!.annotations.map((a) => [a.start, a.end])).toEqual([[0, 1000]]);
    const only = splitByLayer(files, scheme, "phase", { mode: "values", values: ["two"] }, "p");
    expect(only.files).toHaveLength(1);
  });
});

describe("search", () => {
  const { files, scheme } = corpus([
    makeFile("q", {
      A_speech: [[0, 1000, "The red one"], [2000, 2500, "yes"], [4000, 6000, "a RED triangle"]],
      A_gesture: [[300, 800, "iconic"], [4100, 4500, "beat"]],
      B_gesture: [[2000, 2400, "iconic"]],
    }),
  ]);

  it("finds annotations by text, regex, duration and overlap", () => {
    const base = { layers: [], pattern: "red", regex: false, caseSensitive: false, minDuration: 0, maxDuration: 0 };
    const r = searchAnnotations(files, scheme, base);
    expect(r.total).toBe(2);
    expect(r.hits[0]).toMatchObject({ value: "The red one", before: "", after: "yes", layer: "speech", participant: "A" });
    expect(searchAnnotations(files, scheme, { ...base, caseSensitive: true }).total).toBe(1);
    expect(searchAnnotations(files, scheme, { ...base, pattern: "^(yes|iconic)$", regex: true }).total).toBe(3);
    expect(searchAnnotations(files, scheme, { ...base, pattern: "", layers: ["gesture"] }).total).toBe(3);
    expect(searchAnnotations(files, scheme, { ...base, pattern: "", minDuration: 1500 }).total).toBe(1);
    expect(searchAnnotations(files, scheme, { ...base, pattern: "", maxDuration: 450 }).total).toBe(2);
    expect(searchAnnotations(files, scheme, { ...base, pattern: "(", regex: true }).error).toMatch(/Invalid/);
    const withIconic = searchAnnotations(files, scheme, { ...base, pattern: "", layers: ["speech"], overlap: { layer: "gesture", filter: { mode: "values", values: ["iconic"] }, mode: "overlaps", sameParticipant: true } });
    expect(withIconic.hits.map((h) => h.value)).toEqual(["The red one"]);
    const anyone = searchAnnotations(files, scheme, { ...base, pattern: "", layers: ["speech"], overlap: { layer: "gesture", mode: "overlaps", sameParticipant: false } });
    expect(anyone.total).toBe(3);
    const without = searchAnnotations(files, scheme, { ...base, pattern: "", layers: ["speech"], overlap: { layer: "gesture", mode: "does not overlap", sameParticipant: true } });
    expect(without.hits.map((h) => h.value)).toEqual(["yes"]);
    expect(searchAnnotations(files, scheme, { ...base, pattern: "" }, 2).hits).toHaveLength(2);
  });
});
