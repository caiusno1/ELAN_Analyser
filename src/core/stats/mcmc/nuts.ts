import { Rng } from "../rng.ts";

/**
 * No-U-Turn Sampler (Hoffman & Gelman 2014, Algorithm 6) with dual-averaging step-size
 * adaptation and a diagonal mass matrix adapted in expanding windows, as in Stan.
 *
 * `logDensity(theta, grad)` returns the log target density at `theta` (up to a constant)
 * and writes its gradient into `grad`. A non-finite return value marks an invalid point.
 */

export type LogDensity = (theta: Float64Array, grad: Float64Array) => number;

export interface NutsOptions {
  warmup?: number;
  samples?: number;
  seed?: number;
  /** Target average acceptance statistic (Stan's adapt_delta). */
  targetAccept?: number;
  maxTreeDepth?: number;
  /** Called every few iterations with the number of completed iterations. */
  onProgress?: (done: number, total: number) => void;
  /** Return true to stop sampling early. */
  shouldStop?: () => boolean;
}

export interface ChainResult {
  dim: number;
  /** Post-warmup draws, row-major: draws[i * dim + j]. */
  draws: Float64Array;
  /** Log density of each draw. */
  logDensity: Float64Array;
  samples: number;
  stepSize: number;
  /** Adapted inverse metric (posterior variance estimates). */
  inverseMetric: Float64Array;
  divergences: number;
  treeDepthHits: number;
  meanAcceptance: number;
  leapfrogSteps: number;
}

const DELTA_MAX = 1000;

interface TreeState {
  thetaMinus: Float64Array;
  rMinus: Float64Array;
  gradMinus: Float64Array;
  thetaPlus: Float64Array;
  rPlus: Float64Array;
  gradPlus: Float64Array;
  thetaPrime: Float64Array;
  gradPrime: Float64Array;
  logpPrime: number;
  n: number;
  ok: boolean;
  alpha: number;
  nAlpha: number;
  diverged: boolean;
}

export function runNuts(logDensity: LogDensity, init: Float64Array, options: NutsOptions = {}): ChainResult {
  const dim = init.length;
  const warmup = options.warmup ?? 1000;
  const samples = options.samples ?? 1000;
  const delta = options.targetAccept ?? 0.8;
  const maxDepth = options.maxTreeDepth ?? 10;
  const rng = new Rng(options.seed ?? 1);
  const total = warmup + samples;

  const invM = new Float64Array(dim).fill(1);
  let leapfrogSteps = 0;

  const kinetic = (r: Float64Array): number => {
    let k = 0;
    for (let i = 0; i < dim; i++) k += r[i]! * r[i]! * invM[i]!;
    return 0.5 * k;
  };

  /** One leapfrog step from (theta, r, grad); returns the new state. */
  const leapfrog = (theta: Float64Array, r: Float64Array, grad: Float64Array, eps: number) => {
    const rNew = new Float64Array(dim);
    const thetaNew = new Float64Array(dim);
    const gradNew = new Float64Array(dim);
    for (let i = 0; i < dim; i++) {
      rNew[i] = r[i]! + 0.5 * eps * grad[i]!;
      thetaNew[i] = theta[i]! + eps * invM[i]! * rNew[i]!;
    }
    let logp = logDensity(thetaNew, gradNew);
    leapfrogSteps++;
    if (!Number.isFinite(logp)) logp = -Infinity;
    else {
      for (let i = 0; i < dim; i++) {
        if (!Number.isFinite(gradNew[i]!)) {
          logp = -Infinity;
          break;
        }
        rNew[i] = rNew[i]! + 0.5 * eps * gradNew[i]!;
      }
    }
    return { theta: thetaNew, r: rNew, grad: gradNew, logp };
  };

  const noUTurn = (thetaMinus: Float64Array, thetaPlus: Float64Array, rMinus: Float64Array, rPlus: Float64Array): boolean => {
    let a = 0;
    let b = 0;
    for (let i = 0; i < dim; i++) {
      const d = thetaPlus[i]! - thetaMinus[i]!;
      a += d * invM[i]! * rMinus[i]!;
      b += d * invM[i]! * rPlus[i]!;
    }
    return a >= 0 && b >= 0;
  };

  const buildTree = (
    theta: Float64Array, r: Float64Array, grad: Float64Array,
    logU: number, v: number, depth: number, eps: number, joint0: number,
  ): TreeState => {
    if (depth === 0) {
      const s = leapfrog(theta, r, grad, v * eps);
      const joint = s.logp === -Infinity ? -Infinity : s.logp - kinetic(s.r);
      const valid = Number.isFinite(joint);
      const diverged = !valid || logU >= DELTA_MAX + joint;
      return {
        thetaMinus: s.theta, rMinus: s.r, gradMinus: s.grad,
        thetaPlus: s.theta, rPlus: s.r, gradPlus: s.grad,
        thetaPrime: s.theta, gradPrime: s.grad, logpPrime: s.logp,
        n: valid && logU <= joint ? 1 : 0,
        ok: !diverged,
        alpha: valid ? Math.min(1, Math.exp(joint - joint0)) : 0,
        nAlpha: 1,
        diverged,
      };
    }
    const t = buildTree(theta, r, grad, logU, v, depth - 1, eps, joint0);
    if (!t.ok) return t;
    const t2 = v === -1
      ? buildTree(t.thetaMinus, t.rMinus, t.gradMinus, logU, v, depth - 1, eps, joint0)
      : buildTree(t.thetaPlus, t.rPlus, t.gradPlus, logU, v, depth - 1, eps, joint0);
    if (v === -1) {
      t.thetaMinus = t2.thetaMinus;
      t.rMinus = t2.rMinus;
      t.gradMinus = t2.gradMinus;
    } else {
      t.thetaPlus = t2.thetaPlus;
      t.rPlus = t2.rPlus;
      t.gradPlus = t2.gradPlus;
    }
    if (t2.n > 0 && rng.uniform() < t2.n / (t.n + t2.n)) {
      t.thetaPrime = t2.thetaPrime;
      t.gradPrime = t2.gradPrime;
      t.logpPrime = t2.logpPrime;
    }
    t.alpha += t2.alpha;
    t.nAlpha += t2.nAlpha;
    t.n += t2.n;
    t.diverged = t.diverged || t2.diverged;
    t.ok = t2.ok && noUTurn(t.thetaMinus, t.thetaPlus, t.rMinus, t.rPlus);
    return t;
  };

  // ---- initial state ----------------------------------------------------------------
  let theta: Float64Array = Float64Array.from(init);
  let grad: Float64Array = new Float64Array(dim);
  let logp = logDensity(theta, grad);
  if (!Number.isFinite(logp)) {
    // Look for a valid starting point near the origin.
    for (let attempt = 0; attempt < 100 && !Number.isFinite(logp); attempt++) {
      for (let i = 0; i < dim; i++) theta[i] = rng.range(-1, 1) * 0.5;
      logp = logDensity(theta, grad);
    }
    if (!Number.isFinite(logp)) throw new Error("Could not find a starting point with finite log density.");
  }

  const findReasonableEpsilon = (): number => {
    let eps = 0.1;
    const r = new Float64Array(dim);
    for (let i = 0; i < dim; i++) r[i] = rng.normal() / Math.sqrt(invM[i]!);
    const joint0 = logp - kinetic(r);
    let s = leapfrog(theta, r, grad, eps);
    let joint = s.logp === -Infinity ? -Infinity : s.logp - kinetic(s.r);
    const dir = joint - joint0 > Math.log(0.5) ? 1 : -1;
    for (let it = 0; it < 60; it++) {
      const accept = joint - joint0;
      if (dir === 1 ? !(accept > Math.log(0.5)) : accept > Math.log(0.5)) break;
      eps *= dir === 1 ? 2 : 0.5;
      if (eps > 1e6 || eps < 1e-10) break;
      s = leapfrog(theta, r, grad, eps);
      joint = s.logp === -Infinity ? -Infinity : s.logp - kinetic(s.r);
    }
    return eps;
  };

  // ---- adaptation schedule (Stan's windowed adaptation) -----------------------------
  let initBuffer = 75;
  let termBuffer = 50;
  let baseWindow = 25;
  if (warmup < 20) {
    initBuffer = warmup;
    termBuffer = 0;
    baseWindow = 0;
  } else if (warmup < 150) {
    initBuffer = Math.floor(0.15 * warmup);
    termBuffer = Math.floor(0.1 * warmup);
    baseWindow = warmup - initBuffer - termBuffer;
  }
  let windowSize = baseWindow;
  let windowEnd = initBuffer + windowSize - 1;
  const slowEnd = warmup - termBuffer; // exclusive
  if (baseWindow > 0 && windowEnd + windowSize * 2 >= slowEnd) windowEnd = slowEnd - 1;
  let accN = 0;
  const accMean = new Float64Array(dim);
  const accM2 = new Float64Array(dim);

  let eps = findReasonableEpsilon();
  let mu = Math.log(10 * eps);
  let logEpsBar = 0;
  let hBar = 0;
  let adaptCount = 0;
  const gamma = 0.05;
  const t0 = 10;
  const kappa = 0.75;

  const draws = new Float64Array(samples * dim);
  const logDens = new Float64Array(samples);
  let divergences = 0;
  let treeDepthHits = 0;
  let acceptSum = 0;
  const r0 = new Float64Array(dim);

  for (let m = 0; m < total; m++) {
    if (options.shouldStop?.()) break;
    for (let i = 0; i < dim; i++) r0[i] = rng.normal() / Math.sqrt(invM[i]!);
    const joint0 = logp - kinetic(r0);
    const logU = joint0 - rng.exponential();
    let thetaMinus = theta;
    let thetaPlus = theta;
    let rMinus: Float64Array = Float64Array.from(r0);
    let rPlus: Float64Array = rMinus;
    let gradMinus = grad;
    let gradPlus = grad;
    let depth = 0;
    let n = 1;
    let ok = true;
    let alpha = 0;
    let nAlpha = 0;
    let diverged = false;
    let newTheta = theta;
    let newGrad = grad;
    let newLogp = logp;
    while (ok && depth < maxDepth) {
      const v = rng.uniform() < 0.5 ? -1 : 1;
      const t = v === -1
        ? buildTree(thetaMinus, rMinus, gradMinus, logU, v, depth, eps, joint0)
        : buildTree(thetaPlus, rPlus, gradPlus, logU, v, depth, eps, joint0);
      if (v === -1) {
        thetaMinus = t.thetaMinus;
        rMinus = t.rMinus;
        gradMinus = t.gradMinus;
      } else {
        thetaPlus = t.thetaPlus;
        rPlus = t.rPlus;
        gradPlus = t.gradPlus;
      }
      if (t.ok && t.n > 0 && rng.uniform() < Math.min(1, t.n / n)) {
        newTheta = t.thetaPrime;
        newGrad = t.gradPrime;
        newLogp = t.logpPrime;
      }
      n += t.n;
      alpha = t.alpha;
      nAlpha = t.nAlpha;
      diverged = diverged || t.diverged;
      ok = t.ok && noUTurn(thetaMinus, thetaPlus, rMinus, rPlus);
      depth++;
    }
    theta = newTheta;
    grad = newGrad;
    logp = newLogp;
    const acceptStat = nAlpha > 0 ? alpha / nAlpha : 0;

    if (m < warmup) {
      // Dual averaging of the step size.
      adaptCount++;
      const eta = 1 / (adaptCount + t0);
      hBar = (1 - eta) * hBar + eta * (delta - acceptStat);
      const logEps = mu - (Math.sqrt(adaptCount) / gamma) * hBar;
      const w = Math.pow(adaptCount, -kappa);
      logEpsBar = w * logEps + (1 - w) * logEpsBar;
      eps = Math.exp(logEps);

      // Metric adaptation inside the slow windows.
      if (baseWindow > 0 && m >= initBuffer && m < slowEnd) {
        accN++;
        for (let i = 0; i < dim; i++) {
          const d = theta[i]! - accMean[i]!;
          accMean[i] = accMean[i]! + d / accN;
          accM2[i] = accM2[i]! + d * (theta[i]! - accMean[i]!);
        }
        if (m === windowEnd) {
          if (accN > 1) {
            for (let i = 0; i < dim; i++) {
              const variance = accM2[i]! / (accN - 1);
              invM[i] = (accN / (accN + 5)) * variance + 1e-3 * (5 / (accN + 5));
            }
          }
          accN = 0;
          accMean.fill(0);
          accM2.fill(0);
          windowSize *= 2;
          windowEnd = m + windowSize;
          if (windowEnd + windowSize * 2 >= slowEnd) windowEnd = slowEnd - 1;
          // Restart step-size adaptation for the new metric.
          eps = findReasonableEpsilon();
          mu = Math.log(10 * eps);
          logEpsBar = 0;
          hBar = 0;
          adaptCount = 0;
        }
      }
      if (m === warmup - 1) eps = Math.exp(logEpsBar);
    } else {
      const k = m - warmup;
      draws.set(theta, k * dim);
      logDens[k] = logp;
      if (diverged) divergences++;
      if (depth >= maxDepth && ok) treeDepthHits++;
      acceptSum += acceptStat;
    }
    if (options.onProgress && (m % 20 === 19 || m === total - 1)) options.onProgress(m + 1, total);
  }

  return {
    dim,
    draws,
    logDensity: logDens,
    samples,
    stepSize: eps,
    inverseMetric: Float64Array.from(invM),
    divergences,
    treeDepthHits,
    meanAcceptance: samples > 0 ? acceptSum / samples : NaN,
    leapfrogSteps,
  };
}
