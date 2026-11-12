import { mean, sd } from "../describe.ts";
import { Rng } from "../rng.ts";
import { digamma, gammaQ, lchoose, lgamma, log1pExp } from "../special.ts";

/**
 * Bayesian generalized linear multilevel models:
 *
 *   η_i = offset_i + α + Σ_j β_j x_ij + Σ_k τ_k z_k[g_k(i)] · w_ik
 *
 * with normal priors on the coefficients, exponential priors on the scales, and
 * standard-normal "raw" group effects z (non-centred parameterisation). The class
 * exposes the exact log joint density and its gradient on an unconstrained parameter
 * vector, which is what the NUTS sampler and the bridge sampler need.
 */

export type Family = "gaussian" | "lognormal" | "student" | "poisson" | "negbinomial" | "bernoulli" | "binomial";

export const FAMILY_INFO: Record<Family, { label: string; link: string; hasSigma: boolean; description: string }> = {
  gaussian: { label: "Gaussian", link: "identity", hasSigma: true, description: "continuous, symmetric outcomes" },
  lognormal: { label: "Log-normal", link: "identity on ln(y)", hasSigma: true, description: "positive, right-skewed outcomes such as durations" },
  student: { label: "Student-t (robust)", link: "identity", hasSigma: true, description: "continuous outcomes with outliers" },
  poisson: { label: "Poisson", link: "log", hasSigma: false, description: "counts; add an exposure to model rates" },
  negbinomial: { label: "Negative binomial", link: "log", hasSigma: false, description: "over-dispersed counts" },
  bernoulli: { label: "Bernoulli", link: "logit", hasSigma: false, description: "binary outcomes (0/1)" },
  binomial: { label: "Binomial", link: "logit", hasSigma: false, description: "successes out of a number of trials" },
};

export interface FixedColumn {
  name: string;
  values: Float64Array;
}

export interface RandomTerm {
  /** Display name, e.g. "speaker" or "speaker: condition". */
  name: string;
  /** Level index (0-based) of each observation. */
  index: Int32Array;
  levelNames: string[];
  /** Covariate for a random slope; omit for a random intercept. */
  x?: Float64Array;
}

export interface GlmmPriors {
  /** Multiplier of the automatic coefficient prior SD (default 2.5). */
  coefScale?: number;
  /** Explicit prior SDs of the coefficients on their original scale (overrides coefScale). */
  coefSd?: number[];
  interceptMean?: number;
  interceptSd?: number;
  /** Rate of the exponential prior on the residual SD. */
  sigmaRate?: number;
  /** Rate(s) of the exponential priors on the group-level SDs. */
  tauRate?: number | number[];
}

export interface GlmmInput {
  family: Family;
  y: ArrayLike<number>;
  /** Number of trials per observation (binomial family). */
  trials?: ArrayLike<number>;
  /** Offset on the scale of the linear predictor, e.g. ln(exposure). */
  offset?: ArrayLike<number>;
  /** Fixed-effect columns without the intercept. */
  columns: FixedColumn[];
  random: RandomTerm[];
  priors?: GlmmPriors;
}

export interface ConstrainedDraw {
  intercept: number;
  /** Coefficients on the original scale of the predictors. */
  coefs: Float64Array;
  sigma?: number;
  nu?: number;
  phi?: number;
  /** Group-level standard deviations, one per random term. */
  tau: Float64Array;
  /** Group effects u = τ·z for each random term. */
  effects: Float64Array[];
}

const LN_2PI = Math.log(2 * Math.PI);

export class GlmmModel {
  readonly family: Family;
  readonly n: number;
  /** Number of fixed-effect coefficients including the intercept. */
  readonly p: number;
  readonly dim: number;
  readonly coefNames: string[];
  readonly random: RandomTerm[];
  /** Typical scale of the outcome used to scale the default priors. */
  readonly yScale: number;

  private readonly y: Float64Array;
  private readonly trials: Float64Array | undefined;
  private readonly offset: Float64Array | undefined;
  /** Standardised design matrix without the intercept column, column-major. */
  private readonly xz: Float64Array;
  private readonly xMean: Float64Array;
  private readonly xSd: Float64Array;
  private readonly slopeZ: (Float64Array | undefined)[];
  private readonly slopeSd: Float64Array;
  private readonly priorMean: Float64Array;
  private readonly priorSd: Float64Array;
  private readonly sigmaRate: number;
  private readonly tauRate: Float64Array;
  /** Parameter-independent part of the log likelihood. */
  private readonly likConst: number;
  private readonly priorConst: number;
  private readonly iSigma: number;
  private readonly iNu: number;
  private readonly iPhi: number;
  private readonly iTau: Int32Array;
  private readonly iZ: Int32Array;
  // Work arrays reused across evaluations.
  private readonly eta: Float64Array;
  private readonly dEta: Float64Array;
  private readonly levelSum: Float64Array[];

  constructor(input: GlmmInput) {
    this.family = input.family;
    const n = input.y.length;
    this.n = n;
    if (n < 2) throw new Error("The model needs at least two observations.");
    const yRaw = Float64Array.from(input.y as ArrayLike<number>);
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(yRaw[i]!)) throw new Error("The outcome contains missing or non-numeric values.");
    }
    let y = yRaw;
    let likConst = 0;
    switch (input.family) {
      case "lognormal":
        y = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          if (!(yRaw[i]! > 0)) throw new Error("A log-normal model needs strictly positive outcomes.");
          y[i] = Math.log(yRaw[i]!);
          likConst -= y[i]!; // Jacobian of the log transform
        }
        likConst -= 0.5 * n * LN_2PI;
        break;
      case "gaussian":
        likConst = -0.5 * n * LN_2PI;
        break;
      case "poisson":
      case "negbinomial":
        for (let i = 0; i < n; i++) {
          if (yRaw[i]! < 0 || Math.floor(yRaw[i]!) !== yRaw[i]!) throw new Error("Count models need non-negative whole numbers as outcomes.");
          likConst -= lgamma(yRaw[i]! + 1);
        }
        break;
      case "bernoulli":
        for (let i = 0; i < n; i++) {
          if (yRaw[i]! !== 0 && yRaw[i]! !== 1) throw new Error("A Bernoulli model needs outcomes coded 0 or 1.");
        }
        break;
      case "binomial": {
        if (!input.trials) throw new Error("A binomial model needs the number of trials.");
        for (let i = 0; i < n; i++) {
          const t = input.trials[i]!;
          if (!(t >= yRaw[i]!) || yRaw[i]! < 0) throw new Error("Binomial successes must lie between 0 and the number of trials.");
          likConst += lchoose(t, yRaw[i]!);
        }
        break;
      }
      case "student":
        break;
    }
    this.y = y;
    this.likConst = likConst;
    this.trials = input.family === "binomial" ? Float64Array.from(input.trials as ArrayLike<number>) : undefined;
    this.offset = input.offset ? Float64Array.from(input.offset as ArrayLike<number>) : undefined;

    const gaussianLike = input.family === "gaussian" || input.family === "lognormal" || input.family === "student";
    const sY = gaussianLike ? sd(y) || 1 : 1;
    this.yScale = sY;

    // ---- fixed effects: centre and scale every column ------------------------------
    const k = input.columns.length;
    this.p = k + 1;
    this.coefNames = ["(Intercept)", ...input.columns.map((c) => c.name)];
    this.xz = new Float64Array(n * k);
    this.xMean = new Float64Array(k);
    this.xSd = new Float64Array(k);
    input.columns.forEach((col, j) => {
      if (col.values.length !== n) throw new Error(`Predictor "${col.name}" has the wrong length.`);
      const m = mean(col.values);
      const s = sd(col.values);
      if (!(s > 0)) throw new Error(`Predictor "${col.name}" does not vary, so its effect cannot be estimated.`);
      this.xMean[j] = m;
      this.xSd[j] = s;
      for (let i = 0; i < n; i++) this.xz[j * n + i] = (col.values[i]! - m) / s;
    });

    // ---- priors ---------------------------------------------------------------------
    const pr = input.priors ?? {};
    const coefScale = pr.coefScale ?? 2.5;
    this.priorMean = new Float64Array(this.p);
    this.priorSd = new Float64Array(this.p);
    let interceptMean = 0;
    if (gaussianLike) interceptMean = mean(y);
    else if (input.family === "poisson" || input.family === "negbinomial") {
      let total = 0;
      let exposure = 0;
      for (let i = 0; i < n; i++) {
        total += y[i]!;
        exposure += this.offset ? Math.exp(this.offset[i]!) : 1;
      }
      interceptMean = Math.log(Math.max(total, 0.5) / exposure);
    }
    this.priorMean[0] = pr.interceptMean ?? interceptMean;
    this.priorSd[0] = pr.interceptSd ?? 2.5 * sY;
    for (let j = 0; j < k; j++) {
      // Coefficients live on the standardised scale internally: β_z = β · sd(x).
      this.priorSd[j + 1] = pr.coefSd?.[j] !== undefined ? pr.coefSd[j]! * this.xSd[j]! : coefScale * sY;
    }
    this.sigmaRate = pr.sigmaRate ?? 1 / sY;
    this.random = input.random;
    this.tauRate = new Float64Array(input.random.length);
    input.random.forEach((_, t) => {
      const given = Array.isArray(pr.tauRate) ? pr.tauRate[t] : pr.tauRate;
      this.tauRate[t] = given ?? (gaussianLike ? 1 / sY : 1);
    });

    // ---- random terms ----------------------------------------------------------------
    this.slopeZ = [];
    this.slopeSd = new Float64Array(input.random.length).fill(1);
    input.random.forEach((term, t) => {
      if (term.index.length !== n) throw new Error(`Grouping factor "${term.name}" has the wrong length.`);
      if (term.x) {
        const m = mean(term.x);
        const s = sd(term.x) || 1;
        const z = new Float64Array(n);
        for (let i = 0; i < n; i++) z[i] = (term.x[i]! - m) / s;
        this.slopeZ.push(z);
        this.slopeSd[t] = s;
      } else this.slopeZ.push(undefined);
    });

    // ---- parameter layout --------------------------------------------------------------
    let pos = this.p;
    this.iSigma = gaussianLike ? pos++ : -1;
    this.iNu = input.family === "student" ? pos++ : -1;
    this.iPhi = input.family === "negbinomial" ? pos++ : -1;
    this.iTau = new Int32Array(input.random.length);
    this.iZ = new Int32Array(input.random.length);
    input.random.forEach((term, t) => {
      this.iTau[t] = pos++;
      this.iZ[t] = pos;
      pos += term.levelNames.length;
    });
    this.dim = pos;

    // ---- constants of the prior densities ----------------------------------------------
    let pc = 0;
    for (let j = 0; j < this.p; j++) pc += -0.5 * LN_2PI - Math.log(this.priorSd[j]!);
    if (this.iSigma >= 0) pc += Math.log(this.sigmaRate);
    if (this.iNu >= 0) pc += 2 * Math.log(0.1) - lgamma(2) - Math.log(gammaQ(2, 0.1));
    if (this.iPhi >= 0) pc += 0.5 * Math.log(2 / Math.PI) - Math.LN2;
    input.random.forEach((term, t) => {
      pc += Math.log(this.tauRate[t]!) - 0.5 * LN_2PI * term.levelNames.length;
    });
    this.priorConst = pc;

    this.eta = new Float64Array(n);
    this.dEta = new Float64Array(n);
    this.levelSum = input.random.map((term) => new Float64Array(term.levelNames.length));
  }

  /** Names of the unconstrained parameters, for diagnostics. */
  parameterNames(): string[] {
    const names = [...this.coefNames];
    if (this.iSigma >= 0) names.push("log sigma");
    if (this.iNu >= 0) names.push("log(nu - 1)");
    if (this.iPhi >= 0) names.push("log phi");
    this.random.forEach((term) => {
      names.push(`log sd(${term.name})`);
      for (const l of term.levelNames) names.push(`z[${term.name}: ${l}]`);
    });
    return names;
  }

  /** A dispersed starting point. */
  initial(rng: Rng): Float64Array {
    const theta = new Float64Array(this.dim);
    theta[0] = this.priorMean[0]! + rng.range(-0.5, 0.5) * this.yScale;
    for (let j = 1; j < this.p; j++) theta[j] = rng.range(-0.5, 0.5) * this.yScale;
    if (this.iSigma >= 0) theta[this.iSigma] = Math.log(this.yScale) + rng.range(-0.5, 0.5);
    if (this.iNu >= 0) theta[this.iNu] = Math.log(9) + rng.range(-0.5, 0.5);
    if (this.iPhi >= 0) theta[this.iPhi] = rng.range(-0.5, 0.5);
    this.random.forEach((term, t) => {
      theta[this.iTau[t]!] = Math.log(0.3 * this.yScale) + rng.range(-0.5, 0.5);
      for (let l = 0; l < term.levelNames.length; l++) theta[this.iZ[t]! + l] = rng.range(-0.5, 0.5);
    });
    return theta;
  }

  /** Fill `this.eta` with the linear predictor at `theta`. */
  private linearPredictor(theta: ArrayLike<number>): void {
    const { n, eta, xz } = this;
    const b0 = theta[0]!;
    if (this.offset) for (let i = 0; i < n; i++) eta[i] = this.offset[i]! + b0;
    else eta.fill(b0);
    for (let j = 1; j < this.p; j++) {
      const b = theta[j]!;
      if (b === 0) continue;
      const base = (j - 1) * n;
      for (let i = 0; i < n; i++) eta[i] = eta[i]! + b * xz[base + i]!;
    }
    for (let t = 0; t < this.random.length; t++) {
      const tau = Math.exp(theta[this.iTau[t]!]!);
      const zi = this.iZ[t]!;
      const idx = this.random[t]!.index;
      const w = this.slopeZ[t];
      if (w) for (let i = 0; i < n; i++) eta[i] = eta[i]! + tau * theta[zi + idx[i]!]! * w[i]!;
      else for (let i = 0; i < n; i++) eta[i] = eta[i]! + tau * theta[zi + idx[i]!]!;
    }
  }

  /**
   * Log joint density ln p(y, θ) on the unconstrained scale (including Jacobians and all
   * normalising constants), with its gradient written to `grad`.
   */
  logDensity = (theta: Float64Array, grad: Float64Array): number => {
    const { n, y, eta, dEta } = this;
    this.linearPredictor(theta);
    let ll = this.likConst;
    grad.fill(0);

    switch (this.family) {
      case "gaussian":
      case "lognormal": {
        const ls = theta[this.iSigma]!;
        const inv2 = Math.exp(-2 * ls);
        let ss = 0;
        for (let i = 0; i < n; i++) {
          const r = y[i]! - eta[i]!;
          ss += r * r;
          dEta[i] = r * inv2;
        }
        ll += -n * ls - 0.5 * ss * inv2;
        grad[this.iSigma] = -n + ss * inv2;
        break;
      }
      case "student": {
        const ls = theta[this.iSigma]!;
        const sigma = Math.exp(ls);
        const nu = 1 + Math.exp(theta[this.iNu]!);
        let acc = 0;
        let gSigma = 0;
        let gNu = 0;
        for (let i = 0; i < n; i++) {
          const z = (y[i]! - eta[i]!) / sigma;
          const z2 = z * z;
          const q = 1 + z2 / nu;
          acc += Math.log(q);
          dEta[i] = ((nu + 1) * z) / ((nu + z2) * sigma);
          gSigma += -1 + ((nu + 1) * z2) / (nu + z2);
          gNu += -0.5 * Math.log(q) + ((nu + 1) / 2) * (z2 / (nu * nu)) / q;
        }
        ll += n * (lgamma((nu + 1) / 2) - lgamma(nu / 2) - 0.5 * Math.log(nu * Math.PI) - ls) - ((nu + 1) / 2) * acc;
        grad[this.iSigma] = gSigma;
        gNu += n * (0.5 * digamma((nu + 1) / 2) - 0.5 * digamma(nu / 2) - 0.5 / nu);
        grad[this.iNu] = gNu * (nu - 1);
        break;
      }
      case "poisson": {
        for (let i = 0; i < n; i++) {
          const mu = Math.exp(eta[i]!);
          ll += y[i]! * eta[i]! - mu;
          dEta[i] = y[i]! - mu;
        }
        break;
      }
      case "negbinomial": {
        const lphi = theta[this.iPhi]!;
        const phi = Math.exp(lphi);
        let gPhi = 0;
        const lgPhi = lgamma(phi);
        const dgPhi = digamma(phi);
        for (let i = 0; i < n; i++) {
          const e = eta[i]!;
          // ln(mu + phi) computed stably for large |eta|
          const lmp = e > lphi ? e + Math.log1p(Math.exp(lphi - e)) : lphi + Math.log1p(Math.exp(e - lphi));
          const yi = y[i]!;
          ll += lgamma(yi + phi) - lgPhi + phi * (lphi - lmp) + yi * (e - lmp);
          const frac = Math.exp(e - lmp); // mu / (mu + phi)
          dEta[i] = yi - (yi + phi) * frac;
          gPhi += digamma(yi + phi) - dgPhi + (lphi - lmp) + 1 - (yi + phi) * Math.exp(-lmp);
        }
        grad[this.iPhi] = gPhi * phi;
        break;
      }
      case "bernoulli": {
        for (let i = 0; i < n; i++) {
          const e = eta[i]!;
          ll += y[i]! * e - log1pExp(e);
          dEta[i] = y[i]! - 1 / (1 + Math.exp(-e));
        }
        break;
      }
      case "binomial": {
        const tr = this.trials!;
        for (let i = 0; i < n; i++) {
          const e = eta[i]!;
          ll += y[i]! * e - tr[i]! * log1pExp(e);
          dEta[i] = y[i]! - tr[i]! / (1 + Math.exp(-e));
        }
        break;
      }
    }
    if (!Number.isFinite(ll)) return -Infinity;

    // ---- chain rule to the parameters ------------------------------------------------
    let g0 = 0;
    for (let i = 0; i < n; i++) g0 += dEta[i]!;
    grad[0] = g0;
    for (let j = 1; j < this.p; j++) {
      const base = (j - 1) * n;
      let g = 0;
      for (let i = 0; i < n; i++) g += dEta[i]! * this.xz[base + i]!;
      grad[j] = g;
    }
    let lp = ll + this.priorConst;
    // Coefficient priors.
    for (let j = 0; j < this.p; j++) {
      const d = (theta[j]! - this.priorMean[j]!) / this.priorSd[j]!;
      lp -= 0.5 * d * d;
      grad[j] = grad[j]! - d / this.priorSd[j]!;
    }
    if (this.iSigma >= 0) {
      const ls = theta[this.iSigma]!;
      const sigma = Math.exp(ls);
      lp += -this.sigmaRate * sigma + ls;
      grad[this.iSigma] = grad[this.iSigma]! - this.sigmaRate * sigma + 1;
    }
    if (this.iNu >= 0) {
      const w = theta[this.iNu]!;
      const nu = 1 + Math.exp(w);
      lp += Math.log(nu) - 0.1 * nu + w;
      grad[this.iNu] = grad[this.iNu]! + (1 / nu - 0.1) * (nu - 1) + 1;
    }
    if (this.iPhi >= 0) {
      const psi = theta[this.iPhi]!;
      lp += -0.5 * Math.exp(-psi) - 0.5 * psi;
      grad[this.iPhi] = grad[this.iPhi]! + 0.5 * Math.exp(-psi) - 0.5;
    }
    for (let t = 0; t < this.random.length; t++) {
      const term = this.random[t]!;
      const L = term.levelNames.length;
      const sums = this.levelSum[t]!;
      sums.fill(0);
      const idx = term.index;
      const w = this.slopeZ[t];
      if (w) for (let i = 0; i < n; i++) sums[idx[i]!] = sums[idx[i]!]! + dEta[i]! * w[i]!;
      else for (let i = 0; i < n; i++) sums[idx[i]!] = sums[idx[i]!]! + dEta[i]!;
      const lt = theta[this.iTau[t]!]!;
      const tau = Math.exp(lt);
      const zi = this.iZ[t]!;
      let gTau = 0;
      let zz = 0;
      for (let l = 0; l < L; l++) {
        const z = theta[zi + l]!;
        gTau += z * sums[l]!;
        zz += z * z;
        grad[zi + l] = tau * sums[l]! - z;
      }
      lp += -0.5 * zz - this.tauRate[t]! * tau + lt;
      grad[this.iTau[t]!] = tau * gTau - this.tauRate[t]! * tau + 1;
    }
    return Number.isFinite(lp) ? lp : -Infinity;
  };

  /** Map an unconstrained draw to interpretable parameters on the original scales. */
  constrain(theta: ArrayLike<number>): ConstrainedDraw {
    const k = this.p - 1;
    const coefs = new Float64Array(k);
    let intercept = theta[0]!;
    for (let j = 0; j < k; j++) {
      coefs[j] = theta[j + 1]! / this.xSd[j]!;
      intercept -= coefs[j]! * this.xMean[j]!;
    }
    const tau = new Float64Array(this.random.length);
    const effects: Float64Array[] = [];
    this.random.forEach((term, t) => {
      const tz = Math.exp(theta[this.iTau[t]!]!);
      tau[t] = tz / this.slopeSd[t]!;
      const u = new Float64Array(term.levelNames.length);
      for (let l = 0; l < u.length; l++) u[l] = tau[t]! * theta[this.iZ[t]! + l]!;
      effects.push(u);
    });
    const out: ConstrainedDraw = { intercept, coefs, tau, effects };
    if (this.iSigma >= 0) out.sigma = Math.exp(theta[this.iSigma]!);
    if (this.iNu >= 0) out.nu = 1 + Math.exp(theta[this.iNu]!);
    if (this.iPhi >= 0) out.phi = Math.exp(theta[this.iPhi]!);
    return out;
  }

  /** Prior standard deviation of a coefficient on the original predictor scale. */
  coefPriorSd(j: number): number {
    return j === 0 ? this.priorSd[0]! : this.priorSd[j]! / this.xSd[j - 1]!;
  }

  /** Pointwise log likelihood ln p(y_i | θ) (including constants), written to `out`. */
  pointwiseLogLik(theta: ArrayLike<number>, out: Float64Array): void {
    const { n, y, eta } = this;
    this.linearPredictor(theta);
    switch (this.family) {
      case "gaussian":
      case "lognormal": {
        const ls = theta[this.iSigma]!;
        const inv2 = Math.exp(-2 * ls);
        for (let i = 0; i < n; i++) {
          const r = y[i]! - eta[i]!;
          out[i] = -0.5 * LN_2PI - ls - 0.5 * r * r * inv2 - (this.family === "lognormal" ? y[i]! : 0);
        }
        break;
      }
      case "student": {
        const ls = theta[this.iSigma]!;
        const sigma = Math.exp(ls);
        const nu = 1 + Math.exp(theta[this.iNu]!);
        const c = lgamma((nu + 1) / 2) - lgamma(nu / 2) - 0.5 * Math.log(nu * Math.PI) - ls;
        for (let i = 0; i < n; i++) {
          const z = (y[i]! - eta[i]!) / sigma;
          out[i] = c - ((nu + 1) / 2) * Math.log1p((z * z) / nu);
        }
        break;
      }
      case "poisson":
        for (let i = 0; i < n; i++) out[i] = y[i]! * eta[i]! - Math.exp(eta[i]!) - lgamma(y[i]! + 1);
        break;
      case "negbinomial": {
        const lphi = theta[this.iPhi]!;
        const phi = Math.exp(lphi);
        for (let i = 0; i < n; i++) {
          const e = eta[i]!;
          const lmp = e > lphi ? e + Math.log1p(Math.exp(lphi - e)) : lphi + Math.log1p(Math.exp(e - lphi));
          out[i] = lgamma(y[i]! + phi) - lgamma(phi) - lgamma(y[i]! + 1) + phi * (lphi - lmp) + y[i]! * (e - lmp);
        }
        break;
      }
      case "bernoulli":
        for (let i = 0; i < n; i++) out[i] = y[i]! * eta[i]! - log1pExp(eta[i]!);
        break;
      case "binomial":
        for (let i = 0; i < n; i++) {
          out[i] = lchoose(this.trials![i]!, y[i]!) + y[i]! * eta[i]! - this.trials![i]! * log1pExp(eta[i]!);
        }
        break;
    }
  }

  /** Simulate a replicated data set y_rep ~ p(y | θ) on the scale of the original outcome. */
  simulate(theta: ArrayLike<number>, rng: Rng, out: Float64Array): void {
    const { n, eta } = this;
    this.linearPredictor(theta);
    switch (this.family) {
      case "gaussian": {
        const s = Math.exp(theta[this.iSigma]!);
        for (let i = 0; i < n; i++) out[i] = eta[i]! + s * rng.normal();
        break;
      }
      case "lognormal": {
        const s = Math.exp(theta[this.iSigma]!);
        for (let i = 0; i < n; i++) out[i] = Math.exp(eta[i]! + s * rng.normal());
        break;
      }
      case "student": {
        const s = Math.exp(theta[this.iSigma]!);
        const nu = 1 + Math.exp(theta[this.iNu]!);
        for (let i = 0; i < n; i++) out[i] = eta[i]! + s * rng.studentT(nu);
        break;
      }
      case "poisson":
        for (let i = 0; i < n; i++) out[i] = rng.poisson(Math.exp(eta[i]!));
        break;
      case "negbinomial": {
        const phi = Math.exp(theta[this.iPhi]!);
        for (let i = 0; i < n; i++) out[i] = rng.negBinomial(Math.exp(eta[i]!), phi);
        break;
      }
      case "bernoulli":
        for (let i = 0; i < n; i++) out[i] = rng.uniform() < 1 / (1 + Math.exp(-eta[i]!)) ? 1 : 0;
        break;
      case "binomial":
        for (let i = 0; i < n; i++) out[i] = rng.binomial(this.trials![i]!, 1 / (1 + Math.exp(-eta[i]!)));
        break;
    }
  }

  /** The outcome on its original scale (log-normal models store ln y internally). */
  observed(): Float64Array {
    if (this.family !== "lognormal") return this.y;
    const out = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) out[i] = Math.exp(this.y[i]!);
    return out;
  }
}
