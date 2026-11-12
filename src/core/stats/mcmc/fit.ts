import { eti, hdi, kde, mean, quantileSorted, sd, sortedCopy } from "../describe.ts";
import { normalLogPdf } from "../distributions.ts";
import { Rng } from "../rng.ts";
import { logAddExp } from "../special.ts";
import { bridgeSample, type BridgeResult } from "./bridge.ts";
import { convergence } from "./diagnostics.ts";
import { GlmmModel, type Family, type GlmmInput } from "./glmm.ts";
import { runNuts, type ChainResult } from "./nuts.ts";

export interface FitOptions {
  chains?: number;
  warmup?: number;
  samples?: number;
  seed?: number;
  targetAccept?: number;
  maxTreeDepth?: number;
  /** Estimate the marginal likelihood by bridge sampling (needed for Bayes factors between models). */
  bridge?: boolean;
  onProgress?: (fraction: number) => void;
  shouldStop?: () => boolean;
}

export type ParamKind = "intercept" | "coefficient" | "residual" | "group-sd" | "shape";

export interface ParamSummary {
  name: string;
  kind: ParamKind;
  mean: number;
  sd: number;
  median: number;
  /** 95% equal-tailed credible interval. */
  ci: [number, number];
  /** 95% highest-density interval. */
  hdi: [number, number];
  /** Probability of direction: posterior mass on the dominant side of zero. */
  pd: number;
  rhat: number;
  essBulk: number;
  essTail: number;
  /** Coefficients only: prior SD on the original predictor scale. */
  priorSd?: number;
  /** Coefficients only: ln BF10 against β = 0 by the Savage–Dickey density ratio. */
  logBf10?: number;
  /** How the posterior density at zero was estimated. */
  bfMethod?: "kernel" | "normal-tail";
  /** Coefficients only: posterior mass inside the region of practical equivalence. */
  rope?: number;
  /** Half-width of the ROPE on the coefficient's own scale. */
  ropeHalfWidth?: number;
}

export interface GroupEffect {
  term: string;
  level: string;
  mean: number;
  ci: [number, number];
}

export interface WaicResult {
  /** Expected log pointwise predictive density. */
  elpd: number;
  pWaic: number;
  waic: number;
  se: number;
  pointwise: Float64Array;
}

export interface GlmmFit {
  family: Family;
  n: number;
  dim: number;
  chains: number;
  drawsPerChain: number;
  summaries: ParamSummary[];
  /** Posterior draws of the named parameters (chains concatenated). */
  draws: Record<string, Float64Array>;
  groupEffects: GroupEffect[];
  diagnostics: {
    divergences: number;
    treeDepthHits: number;
    stepSizes: number[];
    acceptance: number[];
    maxRhat: number;
    minEss: number;
    leapfrogSteps: number;
  };
  waic: WaicResult;
  ppc: { observed: Float64Array; replicated: Float64Array[] };
  bridge?: BridgeResult;
  seconds: number;
}

/** Run one chain; safe to call in a Web Worker. */
export function sampleChain(input: GlmmInput, chain: number, options: FitOptions = {}): ChainResult {
  const model = new GlmmModel(input);
  const seed = (options.seed ?? 20260101) + chain * 7919;
  const rng = new Rng(seed ^ 0x5bd1e995);
  const nutsOptions: Parameters<typeof runNuts>[2] = {
    warmup: options.warmup ?? 1000,
    samples: options.samples ?? 1000,
    seed,
    targetAccept: options.targetAccept ?? 0.8,
    maxTreeDepth: options.maxTreeDepth ?? 10,
  };
  if (options.onProgress) nutsOptions.onProgress = (done, total) => options.onProgress!(done / total);
  if (options.shouldStop) nutsOptions.shouldStop = options.shouldStop;
  return runNuts(model.logDensity, model.initial(rng), nutsOptions);
}

function ropeHalfWidthFor(family: Family, yScale: number): number {
  // Kruschke (2018): ±0.1 SD for standardised effects; ±0.18 on the logit scale
  // (0.1·π/√3); for log-link models ±0.1 ≈ a 10% change in the rate.
  if (family === "bernoulli" || family === "binomial") return 0.18;
  if (family === "poisson" || family === "negbinomial") return 0.1;
  return 0.1 * yScale;
}

/** ln of the posterior density at zero, from draws. */
function logDensityAtZero(draws: Float64Array): { logDensity: number; method: "kernel" | "normal-tail" } {
  const m = mean(draws);
  const s = sd(draws);
  let below = 0;
  for (let i = 0; i < draws.length; i++) if (draws[i]! < 0) below++;
  const minority = Math.min(below, draws.length - below);
  // A kernel estimate needs draws on both sides of zero; otherwise extrapolate the tail.
  if (minority >= Math.max(20, 0.005 * draws.length)) {
    const k = kde(draws, { points: 3, lo: -1e-9, hi: 1e-9 });
    return { logDensity: Math.log(k.y[1]!), method: "kernel" };
  }
  return { logDensity: normalLogPdf(0, m, s), method: "normal-tail" };
}

/** Combine chains into summaries, diagnostics, WAIC, posterior predictive draws and (optionally) a bridge estimate. */
export function summarizeFit(input: GlmmInput, chains: ChainResult[], options: FitOptions = {}, seconds = 0): GlmmFit {
  const model = new GlmmModel(input);
  const dim = model.dim;
  const nChains = chains.length;
  const perChain = chains[0]!.samples;
  const total = nChains * perChain;
  const k = model.p - 1;

  // ---- constrained draws ---------------------------------------------------------------
  const names: string[] = [...model.coefNames];
  const kinds: ParamKind[] = ["intercept", ...new Array<ParamKind>(k).fill("coefficient")];
  const gaussianLike = model.family === "gaussian" || model.family === "lognormal" || model.family === "student";
  if (gaussianLike) {
    names.push("sigma");
    kinds.push("residual");
  }
  if (model.family === "student") {
    names.push("nu");
    kinds.push("shape");
  }
  if (model.family === "negbinomial") {
    names.push("phi");
    kinds.push("shape");
  }
  for (const term of model.random) {
    names.push(`sd(${term.name})`);
    kinds.push("group-sd");
  }
  const draws: Record<string, Float64Array> = {};
  for (const nm of names) draws[nm] = new Float64Array(total);
  const effSum = model.random.map((t) => new Float64Array(t.levelNames.length));
  const effDraws = model.random.map((t) => t.levelNames.map(() => new Float64Array(total)));

  for (let c = 0; c < nChains; c++) {
    const d = chains[c]!.draws;
    for (let s = 0; s < perChain; s++) {
      const row = d.subarray(s * dim, (s + 1) * dim);
      const con = model.constrain(row);
      const at = c * perChain + s;
      draws[names[0]!]![at] = con.intercept;
      for (let j = 0; j < k; j++) draws[names[j + 1]!]![at] = con.coefs[j]!;
      let pos = k + 1;
      if (con.sigma !== undefined) draws[names[pos++]!]![at] = con.sigma;
      if (con.nu !== undefined) draws[names[pos++]!]![at] = con.nu;
      if (con.phi !== undefined) draws[names[pos++]!]![at] = con.phi;
      for (let t = 0; t < model.random.length; t++) {
        draws[names[pos++]!]![at] = con.tau[t]!;
        const u = con.effects[t]!;
        for (let l = 0; l < u.length; l++) {
          effSum[t]![l] = effSum[t]![l]! + u[l]!;
          effDraws[t]![l]![at] = u[l]!;
        }
      }
    }
  }

  // ---- summaries -----------------------------------------------------------------------
  const ropeHalf = ropeHalfWidthFor(model.family, model.yScale);
  const summaries: ParamSummary[] = names.map((nm, idx) => {
    const x = draws[nm]!;
    const sorted = sortedCopy(x);
    const perChainDraws: Float64Array[] = [];
    for (let c = 0; c < nChains; c++) perChainDraws.push(x.subarray(c * perChain, (c + 1) * perChain));
    const conv = convergence(perChainDraws);
    let pos = 0;
    for (let i = 0; i < x.length; i++) if (x[i]! > 0) pos++;
    const pPos = pos / x.length;
    const summary: ParamSummary = {
      name: nm,
      kind: kinds[idx]!,
      mean: mean(x),
      sd: sd(x),
      median: quantileSorted(sorted, 0.5),
      ci: [quantileSorted(sorted, 0.025), quantileSorted(sorted, 0.975)],
      hdi: hdi(x, 0.95),
      pd: Math.max(pPos, 1 - pPos),
      rhat: conv.rhat,
      essBulk: conv.essBulk,
      essTail: conv.essTail,
    };
    if (kinds[idx] === "coefficient") {
      const priorSd = model.coefPriorSd(idx);
      const at0 = logDensityAtZero(x);
      summary.priorSd = priorSd;
      summary.logBf10 = normalLogPdf(0, 0, priorSd) - at0.logDensity;
      summary.bfMethod = at0.method;
      // The ROPE is defined for a standardised predictor: rescale it to this coefficient.
      const colSd = sd(input.columns[idx - 1]!.values);
      const half = ropeHalf / colSd;
      let inside = 0;
      for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) < half) inside++;
      summary.rope = inside / x.length;
      summary.ropeHalfWidth = half;
    }
    return summary;
  });

  const groupEffects: GroupEffect[] = [];
  model.random.forEach((term, t) => {
    term.levelNames.forEach((level, l) => {
      groupEffects.push({ term: term.name, level, mean: effSum[t]![l]! / total, ci: eti(effDraws[t]![l]!, 0.95) });
    });
  });

  // ---- WAIC on a thinned set of draws ----------------------------------------------------
  const n = model.n;
  const maxWaicDraws = Math.max(200, Math.min(total, Math.floor(4e7 / Math.max(n, 1))));
  const stride = Math.max(1, Math.floor(total / maxWaicDraws));
  const lse = new Float64Array(n).fill(-Infinity);
  const llMean = new Float64Array(n);
  const llM2 = new Float64Array(n);
  const ll = new Float64Array(n);
  let used = 0;
  for (let at = 0; at < total; at += stride) {
    const c = Math.floor(at / perChain);
    const s = at % perChain;
    model.pointwiseLogLik(chains[c]!.draws.subarray(s * dim, (s + 1) * dim), ll);
    used++;
    for (let i = 0; i < n; i++) {
      const v = ll[i]!;
      lse[i] = logAddExp(lse[i]!, v);
      const dlt = v - llMean[i]!;
      llMean[i] = llMean[i]! + dlt / used;
      llM2[i] = llM2[i]! + dlt * (v - llMean[i]!);
    }
  }
  const pointwise = new Float64Array(n);
  let elpd = 0;
  let pWaic = 0;
  for (let i = 0; i < n; i++) {
    const lppd = lse[i]! - Math.log(used);
    const pv = used > 1 ? llM2[i]! / (used - 1) : 0;
    pointwise[i] = lppd - pv;
    elpd += pointwise[i]!;
    pWaic += pv;
  }
  const waic: WaicResult = { elpd, pWaic, waic: -2 * elpd, se: Math.sqrt(n) * sd(pointwise), pointwise };

  // ---- posterior predictive draws ------------------------------------------------------
  const rng = new Rng((options.seed ?? 20260101) + 99);
  const keep = n > 4000 ? rng.shuffle(Array.from({ length: n }, (_, i) => i)).slice(0, 4000).sort((a, b) => a - b) : undefined;
  const pick = (arr: Float64Array) => (keep ? Float64Array.from(keep, (i) => arr[i]!) : Float64Array.from(arr));
  const replicated: Float64Array[] = [];
  const nRep = Math.min(40, total);
  const yRep = new Float64Array(n);
  for (let r = 0; r < nRep; r++) {
    const at = Math.floor(((r + 0.5) * total) / nRep);
    const c = Math.floor(at / perChain);
    const s = at % perChain;
    model.simulate(chains[c]!.draws.subarray(s * dim, (s + 1) * dim), rng, yRep);
    replicated.push(pick(yRep));
  }

  // ---- diagnostics ---------------------------------------------------------------------
  let maxRhat = 0;
  let minEss = Infinity;
  for (const s of summaries) {
    if (Number.isFinite(s.rhat) && s.rhat > maxRhat) maxRhat = s.rhat;
    if (Number.isFinite(s.essBulk)) minEss = Math.min(minEss, s.essBulk, s.essTail);
  }
  const fit: GlmmFit = {
    family: model.family,
    n,
    dim,
    chains: nChains,
    drawsPerChain: perChain,
    summaries,
    draws,
    groupEffects,
    diagnostics: {
      divergences: chains.reduce((a, c) => a + c.divergences, 0),
      treeDepthHits: chains.reduce((a, c) => a + c.treeDepthHits, 0),
      stepSizes: chains.map((c) => c.stepSize),
      acceptance: chains.map((c) => c.meanAcceptance),
      maxRhat,
      minEss,
      leapfrogSteps: chains.reduce((a, c) => a + c.leapfrogSteps, 0),
    },
    waic,
    ppc: { observed: pick(model.observed()), replicated },
    seconds,
  };
  if (options.bridge) {
    const grad = new Float64Array(dim);
    fit.bridge = bridgeSample((theta) => model.logDensity(theta, grad), chains.map((c) => c.draws), dim, { seed: (options.seed ?? 1) + 5 });
  }
  return fit;
}

/** Fit a model on the calling thread (chains run one after another). */
export function fitGlmm(input: GlmmInput, options: FitOptions = {}): GlmmFit {
  const nChains = options.chains ?? 4;
  const start = Date.now();
  const chains: ChainResult[] = [];
  for (let c = 0; c < nChains; c++) {
    const opts: FitOptions = { ...options };
    if (options.onProgress) opts.onProgress = (f) => options.onProgress!((c + f) / nChains);
    chains.push(sampleChain(input, c, opts));
  }
  return summarizeFit(input, chains, options, (Date.now() - start) / 1000);
}

/** Difference in expected predictive accuracy between two fits of the same data (a − b). */
export function compareWaic(a: WaicResult, b: WaicResult): { elpdDiff: number; se: number } {
  const n = Math.min(a.pointwise.length, b.pointwise.length);
  const diff = new Float64Array(n);
  for (let i = 0; i < n; i++) diff[i] = a.pointwise[i]! - b.pointwise[i]!;
  let s = 0;
  for (let i = 0; i < n; i++) s += diff[i]!;
  return { elpdDiff: s, se: Math.sqrt(n) * sd(diff) };
}
