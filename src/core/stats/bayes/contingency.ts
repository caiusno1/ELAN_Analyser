import { eti, median as medianOf } from "../describe.ts";
import { betaLogPdf } from "../distributions.ts";
import { integrate } from "../quadrature.ts";
import { Rng } from "../rng.ts";
import { betaI, lgamma, solveMonotone } from "../special.ts";

/**
 * Bayes factors for independence in R × C contingency tables (Gunel & Dickey 1974;
 * Jamil, Ly, Morey, Love, Marsman & Wagenmakers 2017). Formulas follow the BayesFactor
 * R package, against which they are tested.
 */

export type SamplingScheme = "poisson" | "jointMultinomial" | "independentRows" | "independentCols";

export const SCHEME_LABEL: Record<SamplingScheme, string> = {
  poisson: "Poisson (nothing fixed)",
  jointMultinomial: "Joint multinomial (total fixed)",
  independentRows: "Independent multinomial (row totals fixed)",
  independentCols: "Independent multinomial (column totals fixed)",
};

/** ln of the Dirichlet function D(v) = ΠΓ(v_i) / Γ(Σv_i). */
function ldirich(v: number[]): number {
  let s = 0;
  let tot = 0;
  for (const x of v) {
    s += lgamma(x);
    tot += x;
  }
  return s - lgamma(tot);
}

function transposeTable(t: number[][]): number[][] {
  return t[0]!.map((_, j) => t.map((row) => row[j]!));
}

/**
 * ln BF10 for dependence between rows and columns.
 * @param a prior concentration (>= 1); 1 is the default uniform choice.
 */
export function contingencyLogBf10(table: number[][], scheme: SamplingScheme = "independentRows", a = 1): number {
  if (a < 1) throw new RangeError("Prior concentration must be at least 1.");
  if (scheme === "independentCols") return contingencyLogBf10(transposeTable(table), "independentRows", a);
  const I = table.length;
  const J = table[0]!.length;
  const y = table.flat();
  const n = y.reduce((s, v) => s + v, 0);
  const yr = table.map((row) => row.reduce((s, v) => s + v, 0));
  const yc = table[0]!.map((_, j) => table.reduce((s, row) => s + row[j]!, 0));
  const aCell = y.map(() => a);
  const ar = yr.map(() => a * J);
  const ac = yc.map(() => a * I);
  const xiR = ar.map((v) => v - (J - 1));
  const xiC = ac.map((v) => v - (I - 1));
  const yPlusA = y.map((v) => v + a);
  switch (scheme) {
    case "jointMultinomial":
      return (
        ldirich(yPlusA) + ldirich(xiR) + ldirich(xiC) - ldirich(aCell) -
        ldirich(yr.map((v, i) => v + xiR[i]!)) - ldirich(yc.map((v, j) => v + xiC[j]!))
      );
    case "independentRows":
      return (
        ldirich(xiC) + ldirich(ar) + ldirich(yPlusA) -
        ldirich(yc.map((v, j) => v + xiC[j]!)) - ldirich(yr.map((v, i) => v + ar[i]!)) - ldirich(aCell)
      );
    case "poisson": {
      if (n === 0) return 0;
      const b = (I * J * a) / n;
      const sumA = a * I * J;
      const k = (I - 1) * (J - 1);
      let ldirich1 = 0;
      for (let i = 0; i < y.length; i++) ldirich1 += lgamma(a) - lgamma(y[i]! + a);
      return (
        lgamma(sumA - k) - k * Math.log1p(1 / b) - lgamma(n + sumA - k) -
        ldirich(yr.map((v, i) => v + xiR[i]!)) + ldirich(xiR) -
        ldirich(yc.map((v, j) => v + xiC[j]!)) + ldirich(xiC) - ldirich1
      );
    }
  }
}

/** P(X > Y) for independent X ~ Beta(a1, b1), Y ~ Beta(a2, b2). */
export function probBetaGreater(a1: number, b1: number, a2: number, b2: number): number {
  const m1 = a1 / (a1 + b1);
  const s1 = Math.sqrt((a1 * b1) / ((a1 + b1) ** 2 * (a1 + b1 + 1)));
  const pts = [m1 - 4 * s1, m1 - s1, m1, m1 + s1, m1 + 4 * s1].filter((p) => p > 0 && p < 1);
  const res = integrate((x) => Math.exp(betaLogPdf(x, a1, b1)) * betaI(a2, b2, x), 0, 1, { relTol: 1e-10, points: pts });
  return Math.min(1, Math.max(0, res.value));
}

export interface OddsRatioPosterior {
  /** Posterior median and central credible interval of the log odds ratio. */
  logOdds: { median: number; ci: [number, number] };
  oddsRatio: { median: number; ci: [number, number] };
  /** P(odds ratio > 1 | data). */
  pGreater1: number;
  ciMass: number;
}

/**
 * Posterior of the odds ratio (y11·y22)/(y12·y21) of a 2 × 2 table. Under every sampling
 * scheme the posterior is that of independent Gamma(a + y_rc) cell intensities, i.e.
 * row-wise Beta posteriors; quantiles are found by numerical integration.
 */
export function oddsRatioPosterior(table: number[][], a = 1, ciMass = 0.95): OddsRatioPosterior {
  const [a1, b1] = [a + table[0]![0]!, a + table[0]![1]!];
  const [a2, b2] = [a + table[1]![0]!, a + table[1]![1]!];
  const m2 = a2 / (a2 + b2);
  const s2 = Math.sqrt((a2 * b2) / ((a2 + b2) ** 2 * (a2 + b2 + 1)));
  const pts = [m2 - 4 * s2, m2 - s2, m2, m2 + s2, m2 + 4 * s2].filter((p) => p > 0 && p < 1);
  // P(logOR <= c) = E_{p2}[ P(p1 <= g(p2)) ],  g(y) = e^c y / (1 − y + e^c y)
  const cdf = (c: number): number => {
    const ec = Math.exp(c);
    return integrate(
      (y) => Math.exp(betaLogPdf(y, a2, b2)) * betaI(a1, b1, (ec * y) / (1 - y + ec * y)),
      0, 1, { relTol: 1e-9, points: pts },
    ).value;
  };
  const q = (p: number) => solveMonotone((c) => cdf(c) - p, -60, 60, 1e-9, 200);
  const tail = (1 - ciMass) / 2;
  const med = q(0.5);
  const lo = q(tail);
  const hi = q(1 - tail);
  return {
    logOdds: { median: med, ci: [lo, hi] },
    oddsRatio: { median: Math.exp(med), ci: [Math.exp(lo), Math.exp(hi)] },
    pGreater1: probBetaGreater(a1, b1, a2, b2),
    ciMass,
  };
}

export interface CramersVPosterior {
  median: number;
  ci: [number, number];
  ciMass: number;
}

/** Posterior of Cramér's V by sampling cell probabilities from their Dirichlet posterior. */
export function cramersVPosterior(table: number[][], a = 1, ciMass = 0.95, draws = 8000, seed = 1): CramersVPosterior {
  const I = table.length;
  const J = table[0]!.length;
  const alpha = table.flat().map((v) => v + a);
  const rng = new Rng(seed);
  const p = new Float64Array(alpha.length);
  const vs = new Float64Array(draws);
  const pr = new Float64Array(I);
  const pc = new Float64Array(J);
  const k = Math.min(I, J) - 1;
  for (let d = 0; d < draws; d++) {
    rng.dirichlet(alpha, p);
    pr.fill(0);
    pc.fill(0);
    for (let i = 0; i < I; i++) for (let j = 0; j < J; j++) {
      const v = p[i * J + j]!;
      pr[i] = pr[i]! + v;
      pc[j] = pc[j]! + v;
    }
    let phi2 = 0;
    for (let i = 0; i < I; i++) for (let j = 0; j < J; j++) {
      const e = pr[i]! * pc[j]!;
      const diff = p[i * J + j]! - e;
      phi2 += (diff * diff) / e;
    }
    vs[d] = Math.sqrt(phi2 / k);
  }
  return { median: medianOf(vs), ci: eti(vs, ciMass), ciMass };
}

/** Observed Cramér's V of a table of counts. */
export function cramersV(table: number[][]): number {
  const I = table.length;
  const J = table[0]!.length;
  const n = table.flat().reduce((s, v) => s + v, 0);
  if (n === 0) return NaN;
  const yr = table.map((row) => row.reduce((s, v) => s + v, 0));
  const yc = table[0]!.map((_, j) => table.reduce((s, row) => s + row[j]!, 0));
  let chi2 = 0;
  for (let i = 0; i < I; i++) for (let j = 0; j < J; j++) {
    const e = (yr[i]! * yc[j]!) / n;
    if (e > 0) chi2 += (table[i]![j]! - e) ** 2 / e;
  }
  return Math.sqrt(chi2 / (n * (Math.min(I, J) - 1)));
}
