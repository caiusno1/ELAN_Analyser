import { Rng } from "../stats/rng.ts";
import { writeEaf, type WriteAnnotation, type WriteDocument, type WriteTier } from "../eaf/writer.ts";

/**
 * Synthetic demo corpus: a referential communication ("tangram") task.
 *
 * Twelve dyads; a director (A) describes abstract figures to a matcher (B) over four
 * rounds. Six dyads see each other (f2f), six are separated by a screen. The simulation
 * has documented, deliberately built-in effects so that every analysis in the app has
 * something to find — see docs/DEMO_CORPUS.md. All text is invented; no real data.
 */

export interface DemoFile {
  fileName: string;
  xml: string;
  meta: Record<string, string>;
}

interface Figure {
  labels: string[];
  features: string[];
}

const FIGURES: Figure[] = [
  { labels: ["ice skater", "dancer", "ballerina"], features: ["one leg up", "arms stretched out", "a tilted head"] },
  { labels: ["monk", "praying man", "kneeling person"], features: ["hands together", "a bowed head", "a long robe"] },
  { labels: ["rabbit", "bunny", "hare"], features: ["long ears", "a small tail", "bent legs"] },
  { labels: ["boat", "sailboat", "ship"], features: ["a big sail", "a flat bottom", "a pointed front"] },
  { labels: ["candle", "torch", "lamp"], features: ["a flame on top", "a narrow base", "a tall body"] },
  { labels: ["swan", "bird", "duck"], features: ["a curved neck", "folded wings", "a small beak"] },
  { labels: ["house", "barn", "hut"], features: ["a slanted roof", "a little chimney", "a wide door"] },
  { labels: ["runner", "sprinter", "jogger"], features: ["legs apart", "swinging arms", "a bent back"] },
];

const LOCATIONS = ["top left", "top right", "bottom left", "bottom right", "middle row", "left side", "right side"];
const ACCEPT = ["okay", "got it", "yeah got it", "okay found it", "mhm got it", "yes okay", "alright"];
const BACKCHANNEL = ["mhm", "yeah", "uh-huh", "okay"];
const CONFIRM = ["yes exactly", "yeah exactly", "right", "yes that one", "exactly"];

interface Cond {
  name: "f2f" | "screen";
  /** Probability of adopting the partner's label for a figure. */
  pAlign: number;
  /** Probability of an iconic gesture with a first-round description. */
  pGesture: number;
  /** Floor transfer offset: mean and SD in ms. */
  ftoMean: number;
  ftoSd: number;
  /** Probability that a listener nods at the end of the partner's utterance. */
  pNod: number;
  /** Can the participants see each other? */
  visible: boolean;
}

const CONDITIONS: Record<"f2f" | "screen", Cond> = {
  f2f: { name: "f2f", pAlign: 0.8, pGesture: 0.75, ftoMean: 180, ftoSd: 330, pNod: 0.5, visible: true },
  screen: { name: "screen", pAlign: 0.55, pGesture: 0.4, ftoMean: 330, ftoSd: 420, pNod: 0.18, visible: false },
};

type Speaker = "A" | "B";

interface Utt {
  speaker: Speaker;
  start: number;
  end: number;
  text: string;
  /** Word onsets (ms), parallel to the words of `text`. */
  wordOnsets: number[];
  round: number;
}

interface Gesture {
  start: number;
  end: number;
  type: string;
  phases: { start: number; end: number; value: string }[];
}

function wordDuration(rng: Rng, word: string, rate: number): number {
  const syllables = Math.max(1, Math.round(word.replace(/[^a-z]/gi, "").length / 3));
  const base = 150 + 95 * syllables;
  return Math.max(110, base * rate * Math.exp(rng.normal(0, 0.18)));
}

class DyadSim {
  readonly rng: Rng;
  readonly cond: Cond;
  t = 1500;
  utts: Utt[] = [];
  gestures: Record<Speaker, Gesture[]> = { A: [], B: [] };
  head: Record<Speaker, WriteAnnotation[]> = { A: [], B: [] };
  rounds: WriteAnnotation[] = [];
  /** Last label each speaker used for each figure. */
  lastLabel: Record<Speaker, (string | undefined)[]>;
  /** Stable private preference of each speaker for each figure. */
  pref: Record<Speaker, string[]>;
  rate: Record<Speaker, number>;
  /** Dyad-level offsets, so that dyads differ (needed for honest multilevel modelling). */
  ftoShift: number;
  gestureBoost: number;
  lastSpeaker: Speaker | undefined;
  lastEnd = 0;

  constructor(seed: number, cond: Cond) {
    this.rng = new Rng(seed);
    this.cond = cond;
    const rng = this.rng;
    this.pref = {
      A: FIGURES.map((f) => f.labels[rng.categorical([0.5, 0.3, 0.2])]!),
      B: FIGURES.map((f) => f.labels[rng.categorical([0.3, 0.4, 0.3])]!),
    };
    this.lastLabel = { A: FIGURES.map(() => undefined), B: FIGURES.map(() => undefined) };
    this.rate = { A: Math.exp(rng.normal(0, 0.08)), B: Math.exp(rng.normal(0, 0.08)) };
    this.ftoShift = rng.normal(0, 60);
    this.gestureBoost = Math.exp(rng.normal(0, 0.2));
  }

  other(s: Speaker): Speaker {
    return s === "A" ? "B" : "A";
  }

  /** Choose the label a speaker uses for a figure, possibly adopting the partner's. */
  chooseLabel(s: Speaker, fig: number): string {
    const partner = this.lastLabel[this.other(s)][fig];
    const own = this.lastLabel[s][fig] ?? this.pref[s][fig]!;
    let label = own;
    if (partner && partner !== own && this.rng.bernoulli(this.cond.pAlign)) label = partner;
    this.lastLabel[s][fig] = label;
    return label;
  }

  /** Add an utterance. `gap` is the silence before it; overlap if negative. */
  say(s: Speaker, text: string, round: number, opts: { gap?: number; overlapPrev?: boolean } = {}): Utt {
    const rng = this.rng;
    let start: number;
    if (opts.gap !== undefined) start = this.lastEnd + opts.gap;
    else if (this.lastSpeaker === undefined) start = this.t;
    else if (this.lastSpeaker === s) start = this.lastEnd + rng.logNormal(320, 0.5);
    else {
      // Floor transfer offset; negative values are overlaps.
      const fto = rng.normal(this.cond.ftoMean + this.ftoShift, this.cond.ftoSd);
      start = this.lastEnd + Math.max(fto, -700);
    }
    // Never start before the same speaker's previous utterance has ended.
    for (let i = this.utts.length - 1; i >= 0 && i >= this.utts.length - 6; i--) {
      const u = this.utts[i]!;
      if (u.speaker === s && start < u.end + 120) start = u.end + 120 + rng.range(0, 150);
    }
    const words = text.split(" ");
    const wordOnsets: number[] = [];
    let cur = start;
    for (const w of words) {
      wordOnsets.push(cur);
      cur += wordDuration(rng, w, this.rate[s]);
    }
    const utt: Utt = { speaker: s, start: Math.round(start), end: Math.round(cur), text, wordOnsets, round };
    this.utts.push(utt);
    if (!opts.overlapPrev) {
      this.lastSpeaker = s;
      this.lastEnd = utt.end;
    }
    this.maybeNod(utt);
    return utt;
  }

  /** The listener may nod around the end of the partner's utterance. */
  maybeNod(utt: Utt): void {
    const listener = this.other(utt.speaker);
    const p = this.cond.pNod * (listener === "B" ? 1 : 0.5);
    if (!this.rng.bernoulli(p)) return;
    const start = utt.end + this.rng.normal(-120, 240);
    const dur = this.rng.logNormal(650, 0.3);
    const list = this.head[listener];
    const prev = list[list.length - 1];
    if (prev && start < prev.end + 100) return;
    list.push({ start: Math.round(Math.max(0, start)), end: Math.round(Math.max(0, start) + dur), value: "nod" });
  }

  /** A gesture whose stroke is timed relative to a word onset (the lexical affiliate). */
  gesture(s: Speaker, type: string, affiliateOnset: number): boolean {
    const rng = this.rng;
    // Strokes start, on average, about 200 ms before their lexical affiliate.
    const strokeStart = affiliateOnset - rng.normal(210, 150);
    const prep = rng.logNormal(type === "beat" ? 160 : 300, 0.3);
    const stroke = rng.logNormal(type === "beat" ? 260 : 620, 0.35);
    const hold = type !== "beat" && rng.bernoulli(0.25) ? rng.logNormal(380, 0.4) : 0;
    const retraction = rng.logNormal(type === "beat" ? 200 : 360, 0.3);
    const start = Math.round(strokeStart - prep);
    const list = this.gestures[s];
    const prev = list[list.length - 1];
    if (start < 0 || (prev && start < prev.end + 80)) return false;
    const p1 = Math.round(strokeStart);
    const p2 = Math.round(strokeStart + stroke);
    const p3 = Math.round(p2 + hold);
    const end = Math.round(p3 + retraction);
    const phases = [
      { start, end: p1, value: "preparation" },
      { start: p1, end: p2, value: "stroke" },
    ];
    if (hold > 0) phases.push({ start: p2, end: p3, value: "hold" });
    phases.push({ start: p3, end, value: "retraction" });
    list.push({ start, end, type, phases });
    return true;
  }

  onsetOf(utt: Utt, phrase: string): number {
    const words = utt.text.split(" ");
    const first = phrase.split(" ")[0]!;
    const idx = words.indexOf(first);
    return utt.wordOnsets[Math.max(0, idx)]!;
  }

  runTrial(round: number, fig: number): void {
    const rng = this.rng;
    const c = this.cond;
    const figure = FIGURES[fig]!;
    // Descriptions get shorter and gestures rarer over rounds (Clark & Wilkes-Gibbs 1986).
    const decay = [1, 0.7, 0.45, 0.3][round - 1]!;
    const pG = Math.min(0.95, c.pGesture * decay * this.gestureBoost);

    // --- director describes --------------------------------------------------------
    const label = this.chooseLabel("A", fig);
    const article = /^[aeiou]/.test(label) ? "an" : "a";
    let intro: string;
    if (round === 1) intro = rng.pick([`okay the next one looks like ${article} ${label}`, `so this one is like ${article} ${label}`, `the next figure is kind of ${article} ${label}`]);
    else if (round === 2) intro = rng.pick([`next is the ${label}`, `now the ${label} again`, `then the ${label}`]);
    else intro = rng.pick([`the ${label}`, `now the ${label}`, `${label}`]);
    const u1 = this.say("A", intro, round, this.utts.length === 0 ? {} : { gap: rng.logNormal(900, 0.35) });
    let directorGestured = false;
    if (rng.bernoulli(pG)) directorGestured = this.gesture("A", rng.bernoulli(0.88) ? "iconic" : "metaphoric", this.onsetOf(u1, label));

    if (round <= 2 && rng.bernoulli(round === 1 ? 0.85 : 0.4)) {
      const f1 = rng.pick(figure.features);
      let f2 = rng.pick(figure.features);
      if (f2 === f1) f2 = figure.features[(figure.features.indexOf(f1) + 1) % figure.features.length]!;
      const elab = round === 1 ? `with ${f1} and ${f2}` : `the one with ${f1}`;
      const u2 = this.say("A", elab, round);
      if (rng.bernoulli(pG * 0.8)) {
        const ok = this.gesture("A", "iconic", this.onsetOf(u2, f1));
        directorGestured = directorGestured || ok;
      }
      // Listener backchannel overlapping the elaboration.
      if (rng.bernoulli(0.3)) {
        const bcStart = u2.start + (u2.end - u2.start) * rng.range(0.35, 0.8);
        this.say("B", rng.pick(BACKCHANNEL), round, { gap: bcStart - this.lastEnd, overlapPrev: true });
      }
    } else if (rng.bernoulli(0.12 * decay)) {
      // An occasional beat gesture on a short utterance.
      this.gesture("A", "beat", u1.wordOnsets[u1.wordOnsets.length - 1]!);
    }

    // --- matcher responds ----------------------------------------------------------
    const pClarify = [0.6, 0.33, 0.12, 0.06][round - 1]!;
    const r = rng.uniform();
    if (r < pClarify) {
      const bLabel = this.chooseLabel("B", fig);
      const q = rng.pick([`the ${bLabel}`, `you mean the ${bLabel}`, `is that the ${bLabel} one`]);
      const uq = this.say("B", q, round);
      // Gestural alignment: matchers gesture more after seeing the director gesture.
      const pB = c.visible ? (directorGestured ? 0.45 : 0.12) : 0.1;
      if (rng.bernoulli(pB * this.gestureBoost)) this.gesture("B", "iconic", this.onsetOf(uq, bLabel));
      if (rng.bernoulli(0.2)) {
        const hs = uq.start + rng.range(0, 300);
        this.head.B.push({ start: Math.round(hs), end: Math.round(hs + rng.logNormal(600, 0.3)), value: "tilt" });
      }
      const aLabel = this.chooseLabel("A", fig);
      const conf = rng.bernoulli(0.55) ? `${rng.pick(CONFIRM)} the ${aLabel}` : rng.pick(CONFIRM);
      this.say("A", conf, round);
      this.say("B", rng.pick(ACCEPT), round);
    } else if (r < pClarify + 0.18) {
      const loc = rng.pick(LOCATIONS);
      const uq = this.say("B", rng.pick([`is it on the ${loc}`, `is that in the ${loc}`]), round);
      if (rng.bernoulli(c.visible ? 0.35 : 0.15)) this.gesture("B", "deictic", this.onsetOf(uq, loc));
      const loc2 = rng.bernoulli(0.5) ? loc : rng.pick(LOCATIONS);
      const ans = loc2 === loc ? `yes on the ${loc}` : `no it is on the ${loc2}`;
      const ua = this.say("A", ans, round);
      if (rng.bernoulli(c.visible ? 0.6 : 0.3)) this.gesture("A", "deictic", this.onsetOf(ua, loc2));
      if (loc2 !== loc && rng.bernoulli(0.5)) {
        const hs = ua.start + rng.range(0, 200);
        const list = this.head.A;
        const prev = list[list.length - 1];
        if (!prev || hs > prev.end + 100) list.push({ start: Math.round(hs), end: Math.round(hs + rng.logNormal(700, 0.3)), value: "shake" });
      }
      this.say("B", rng.pick(ACCEPT), round);
    } else {
      this.say("B", rng.pick(ACCEPT), round);
    }
  }

  run(): void {
    const rng = this.rng;
    for (let round = 1; round <= 4; round++) {
      const roundStart = this.utts.length === 0 ? this.t : this.lastEnd + 700;
      if (round > 1) {
        this.say("A", rng.pick(["okay next round", "alright let us go again", "okay once more"]), round, { gap: rng.logNormal(1400, 0.3) });
        this.say("B", rng.pick(["okay", "sure", "ready"]), round);
      }
      const order = rng.shuffle(FIGURES.map((_, i) => i));
      for (const fig of order) this.runTrial(round, fig);
      this.rounds.push({ start: Math.round(roundStart), end: Math.round(this.lastEnd + 300), value: `round ${round}` });
    }
  }

  /** Gaze as a state sequence driven by who is speaking. */
  gaze(p: Speaker): WriteAnnotation[] {
    const rng = this.rng;
    const visible = this.cond.visible;
    const end = this.lastEnd + 1500;
    const changes: { t: number; v: string }[] = [{ t: 0, v: "task" }];
    for (const u of this.utts) {
      if (u.speaker === p) {
        // Speakers look away while planning and return to the partner near the turn end.
        changes.push({ t: u.start - rng.range(0, 150), v: rng.categorical([0.62, visible ? 0.23 : 0, 0.15]) === 0 ? "task" : rng.bernoulli(visible ? 0.6 : 0) ? "partner" : "away" });
        const dur = u.end - u.start;
        if (visible && dur > 900 && rng.bernoulli(0.72)) changes.push({ t: u.end - rng.range(350, Math.min(900, dur * 0.6)), v: "partner" });
      } else {
        // Listeners mostly look at the speaker (when they can see them).
        const v = visible ? (rng.bernoulli(0.74) ? "partner" : "task") : rng.bernoulli(0.8) ? "task" : "away";
        changes.push({ t: u.start + rng.range(0, 250), v });
      }
    }
    changes.sort((a, b) => a.t - b.t);
    const out: WriteAnnotation[] = [];
    for (let i = 0; i < changes.length; i++) {
      const s = Math.max(0, Math.round(changes[i]!.t));
      const e = Math.round(i + 1 < changes.length ? changes[i + 1]!.t : end);
      if (e - s < 150) continue;
      const last = out[out.length - 1];
      if (last && last.value === changes[i]!.v) last.end = e;
      else out.push({ start: last ? last.end : s, end: e, value: changes[i]!.v });
    }
    return out;
  }
}

/** A second rater's version of a gesture tier: jittered boundaries, misses, confusions. */
function secondRater(rng: Rng, gestures: Gesture[]): WriteAnnotation[] {
  const confuse: Record<string, string> = { iconic: "metaphoric", metaphoric: "iconic", deictic: "beat", beat: "deictic" };
  const out: WriteAnnotation[] = [];
  for (const g of gestures) {
    if (rng.bernoulli(0.08)) continue;
    const start = Math.max(0, Math.round(g.start + rng.normal(0, 90)));
    const end = Math.max(start + 120, Math.round(g.end + rng.normal(0, 110)));
    const type = rng.bernoulli(0.07) ? confuse[g.type] ?? g.type : g.type;
    const prev = out[out.length - 1];
    if (prev && start < prev.end) continue;
    out.push({ start, end, value: type });
  }
  return out;
}

function buildDocument(sim: DyadSim, name: string, withSecondRater: boolean): WriteDocument {
  const tiers: WriteTier[] = [];
  const sorted = [...sim.utts].sort((a, b) => a.start - b.start);
  for (const s of ["A", "B"] as const) {
    tiers.push({
      id: `${s}_speech`,
      linguisticType: "utterance",
      participant: s,
      annotator: "R1",
      annotations: sorted.filter((u) => u.speaker === s).map((u) => ({ start: u.start, end: u.end, value: u.text })),
    });
  }
  for (const s of ["A", "B"] as const) {
    const gs = sim.gestures[s];
    tiers.push({
      id: `${s}_gesture`,
      linguisticType: "gesture",
      participant: s,
      annotator: "R1",
      annotations: gs.map((g) => ({ start: g.start, end: g.end, value: g.type })),
    });
    tiers.push({
      id: `${s}_gesture_phase`,
      linguisticType: "gesture-phase",
      participant: s,
      annotator: "R1",
      parentRef: `${s}_gesture`,
      annotations: gs.flatMap((g) => g.phases),
    });
  }
  for (const s of ["A", "B"] as const) {
    tiers.push({ id: `${s}_gaze`, linguisticType: "gaze", participant: s, annotator: "R1", annotations: sim.gaze(s) });
  }
  for (const s of ["A", "B"] as const) {
    const head = [...sim.head[s]].sort((a, b) => a.start - b.start).filter((h, i, arr) => i === 0 || h.start >= arr[i - 1]!.end);
    tiers.push({ id: `${s}_head`, linguisticType: "head", participant: s, annotator: "R1", annotations: head });
  }
  if (withSecondRater) {
    for (const s of ["A", "B"] as const) {
      tiers.push({
        id: `${s}_gesture_R2`,
        linguisticType: "gesture",
        participant: s,
        annotator: "R2",
        annotations: secondRater(sim.rng, sim.gestures[s]),
      });
    }
  }
  tiers.push({ id: "round", linguisticType: "phase", annotations: sim.rounds });
  return {
    author: "ELAN Analyser demo generator",
    date: "2026-01-15T10:00:00+01:00",
    media: [{ url: `file:///demo/${name}.mp4`, mimeType: "video/mp4", relativeUrl: `./${name}.mp4` }],
    tiers,
    linguisticTypes: [
      { id: "utterance" },
      { id: "gesture", cvRef: "gesture-types" },
      { id: "gesture-phase", stereotype: "Included_In", cvRef: "gesture-phases" },
      { id: "gaze", cvRef: "gaze-targets" },
      { id: "head" },
      { id: "phase" },
    ],
    controlledVocabularies: [
      {
        id: "gesture-types",
        description: "Gesture types (after McNeill 1992)",
        entries: [
          { value: "iconic", description: "depicts form or action" },
          { value: "metaphoric", description: "depicts an abstract idea" },
          { value: "deictic", description: "pointing" },
          { value: "beat", description: "rhythmic emphasis" },
        ],
      },
      {
        id: "gesture-phases",
        description: "Gesture phases (after Kendon 2004)",
        entries: [{ value: "preparation" }, { value: "stroke" }, { value: "hold" }, { value: "retraction" }],
      },
      {
        id: "gaze-targets",
        description: "Gaze targets",
        entries: [{ value: "partner" }, { value: "task" }, { value: "away" }],
      },
    ],
  };
}

export const DEMO_DYADS = 12;

/** Generate the demo corpus. The same seed always yields the same files. */
export function generateDemoCorpus(seed = 2026): DemoFile[] {
  const files: DemoFile[] = [];
  for (let d = 1; d <= DEMO_DYADS; d++) {
    const cond = d % 2 === 1 ? CONDITIONS.f2f : CONDITIONS.screen;
    const sim = new DyadSim(seed * 1000 + d * 7919, cond);
    sim.run();
    const id = String(d).padStart(2, "0");
    const name = `dyad${id}_${cond.name}`;
    const doc = buildDocument(sim, name, d === 1 || d === 2);
    files.push({
      fileName: `${name}.eaf`,
      xml: writeEaf(doc),
      meta: { dyad: id, condition: cond.name },
    });
  }
  return files;
}
