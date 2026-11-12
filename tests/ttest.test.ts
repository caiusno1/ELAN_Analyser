import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_EFFECT_PRIOR, effectPosterior, effectPriorPdf, jzsLogBf10ByGIntegral, nctLogPdf, oneSampleStats,
  pairedStats, tTestBayesFactors, tTestRobustness, tTestSequential, twoSampleStats, type TStatistic,
} from "../src/core/stats/bayes/ttest.ts";
import { nctPdf } from "../src/core/stats/distributions.ts";

// Reference Bayes factors: tests/reference/ref_bayesfactor.R (R package BayesFactor).
const ref = JSON.parse(readFileSync(new URL("./fixtures/ref_bayesfactor.json", import.meta.url), "utf8"));
const special = JSON.parse(readFileSync(new URL("./fixtures/ref_special.json", import.meta.url), "utf8"));

interface TCase { kind: "one" | "two" | "paired"; x: number[]; y?: number[]; r: number; logbf10: number; logbf_plus: number; logbf_minus: number }

function statOf(c: TCase): TStatistic {
  if (c.kind === "one") return oneSampleStats(c.x);
  if (c.kind === "paired") return pairedStats(c.x, c.y!);
  return twoSampleStats(c.x, c.y!);
}

describe("noncentral t log density", () => {
  it("matches the mpmath reference in relative terms, including opposite signs", () => {
    let worst = 0;
    for (const [t, v, mu, want] of special.nctLogPdf as [number, number, number, number][]) {
      worst = Math.max(worst, Math.abs(nctLogPdf(t, v, mu) - want) / Math.max(1, Math.abs(want)));
    }
    expect(worst).toBeLessThan(1e-10);
  });

  it("agrees with the hypergeometric form where that one is accurate", () => {
    for (const [t, v, mu] of [[2.5, 12, 1.2], [0.4, 3, -0.2], [-3, 40, -2.5], [6, 100, 5]] as const) {
      expect(Math.exp(nctLogPdf(t, v, mu))).toBeCloseTo(nctPdf(t, v, mu), 12);
    }
  });
});

describe("Bayesian t-test vs R BayesFactor", () => {
  const cases = ref.ttest as TCase[];

  it("reproduces two-sided JZS Bayes factors", () => {
    for (const c of cases) {
      const got = tTestBayesFactors(statOf(c), { family: "cauchy", location: 0, scale: c.r });
      expect(Math.abs(got.logBf10 - c.logbf10), `${c.kind} n=${c.x.length} r=${c.r}`).toBeLessThan(2e-6 * Math.max(1, Math.abs(c.logbf10)));
    }
  });

  it("reproduces one-sided Bayes factors", () => {
    for (const c of cases) {
      const got = tTestBayesFactors(statOf(c), { family: "cauchy", location: 0, scale: c.r });
      // BayesFactor estimates interval hypotheses with ~1e-4 relative accuracy.
      expect(Math.abs(got.logBfPlus0 - c.logbf_plus), `plus ${c.kind} n=${c.x.length}`).toBeLessThan(2e-3 * Math.max(1, Math.abs(c.logbf_plus)));
      expect(Math.abs(got.logBfMinus0 - c.logbf_minus), `minus ${c.kind} n=${c.x.length}`).toBeLessThan(2e-3 * Math.max(1, Math.abs(c.logbf_minus)));
    }
  });

  it("agrees with the classic g-integral formulation", () => {
    for (const c of cases) {
      const stat = statOf(c);
      const a = tTestBayesFactors(stat, { family: "cauchy", location: 0, scale: c.r }).logBf10;
      const b = jzsLogBf10ByGIntegral(stat, c.r);
      expect(Math.abs(a - b)).toBeLessThan(1e-7 * Math.max(1, Math.abs(a)));
    }
  });

  it("stays finite and consistent for extreme evidence", () => {
    const big = tTestBayesFactors({ t: 45, df: 400, nEff: 401 });
    expect(big.logBf10).toBeGreaterThan(300);
    expect(Number.isFinite(big.logBf10)).toBe(true);
    expect(big.logBfPlus0).toBeCloseTo(big.logBf10 + Math.LN2, 6);
    expect(big.logBfMinus0).toBeLessThan(-5);
    expect(Math.abs(big.logBf10 - jzsLogBf10ByGIntegral({ t: 45, df: 400, nEff: 401 }, Math.SQRT1_2))).toBeLessThan(1e-6);
    const nullish = tTestBayesFactors({ t: 0, df: 9999, nEff: 10000 });
    expect(nullish.logBf10).toBeLessThan(-4);
    expect(nullish.logBfPlus0).toBeCloseTo(nullish.logBfMinus0, 8);
  });
});

describe("posterior of the effect size", () => {
  it("matches MCMC posteriors from BayesFactor", () => {
    for (const p of ref.ttest_posterior as { x: number[]; q: number[]; p_pos: number }[]) {
      const post = effectPosterior(oneSampleStats(p.x));
      // The references are MCMC estimates, hence the loose tolerance.
      expect(Math.abs(post.ci[0] - p.q[0]!)).toBeLessThan(0.02);
      expect(Math.abs(post.median - p.q[1]!)).toBeLessThan(0.01);
      expect(Math.abs(post.ci[1] - p.q[2]!)).toBeLessThan(0.02);
      expect(Math.abs(post.pPositive - p.p_pos)).toBeLessThan(0.005);
    }
  });

  it("is a proper density consistent with the Bayes factors", () => {
    const stat = oneSampleStats([0.3, 1.2, -0.4, 0.8, 1.5, 0.2, 0.9, 1.1]);
    const post = effectPosterior(stat);
    expect(post.cdf[post.cdf.length - 1]).toBeCloseTo(1, 10);
    // Savage–Dickey: BF01 = posterior density at 0 / prior density at 0.
    let i = 0;
    while (post.x[i + 1]! < 0) i++;
    const f = (0 - post.x[i]!) / (post.x[i + 1]! - post.x[i]!);
    const dens0 = post.density[i]! + f * (post.density[i + 1]! - post.density[i]!);
    const bf = tTestBayesFactors(stat);
    expect(Math.log(effectPriorPdf(DEFAULT_EFFECT_PRIOR, 0) / dens0)).toBeCloseTo(bf.logBf10, 3);
    // BF+0 = BF10 · P(δ>0 | data) / P(δ>0).
    expect(bf.logBf10 + Math.log(post.pPositive / 0.5)).toBeCloseTo(bf.logBfPlus0, 4);
    // One-sided posterior lives on the positive half-line.
    const one = effectPosterior(stat, DEFAULT_EFFECT_PRIOR, "greater");
    expect(one.x[0]).toBeGreaterThanOrEqual(0);
    expect(one.pPositive).toBe(1);
  });

  it("supports informed priors", () => {
    const stat = { t: 2.2, df: 30, nEff: 31 };
    const informed = tTestBayesFactors(stat, { family: "normal", location: 0.4, scale: 0.2 });
    const vague = tTestBayesFactors(stat, { family: "normal", location: 0, scale: 5 });
    expect(informed.logBf10).toBeGreaterThan(vague.logBf10);
    const tp = tTestBayesFactors(stat, { family: "t", location: 0.35, scale: 0.102, df: 3 });
    expect(Number.isFinite(tp.logBf10)).toBe(true);
    // A t prior with huge df is a normal prior.
    const a = tTestBayesFactors(stat, { family: "t", location: 0.1, scale: 0.5, df: 1e7 }).logBf10;
    const b = tTestBayesFactors(stat, { family: "normal", location: 0.1, scale: 0.5 }).logBf10;
    expect(a).toBeCloseTo(b, 5);
  });
});

describe("robustness and sequential analysis", () => {
  const x = [0.3, 1.2, -0.4, 0.8, 1.5, 0.2, 0.9, 1.1, 0.4, 0.7];

  it("recomputes the Bayes factor across prior widths", () => {
    const stat = oneSampleStats(x);
    const scales = [0.2, Math.SQRT1_2, 1, 1.5];
    const rob = tTestRobustness(stat, DEFAULT_EFFECT_PRIOR, "two-sided", scales);
    expect(rob[1]).toBeCloseTo(tTestBayesFactors(stat).logBf10, 10);
    expect(rob.length).toBe(4);
  });

  it("ends at the full-sample Bayes factor", () => {
    const seq = tTestSequential(x, DEFAULT_EFFECT_PRIOR, "two-sided");
    expect(seq[seq.length - 1]!.n).toBe(x.length);
    expect(seq[seq.length - 1]!.logBf).toBeCloseTo(tTestBayesFactors(oneSampleStats(x)).logBf10, 9);
    expect(seq[0]!.n).toBe(2);
    const y = [0.1, -0.2, 0.5, 0.0, -0.4, 0.3, 0.2, -0.1];
    const values = [...x, ...y];
    const groups = [...x.map(() => 0), ...y.map(() => 1)];
    const seq2 = tTestSequential(values, DEFAULT_EFFECT_PRIOR, "two-sided", { groups });
    expect(seq2[seq2.length - 1]!.logBf).toBeCloseTo(tTestBayesFactors(twoSampleStats(x, y)).logBf10, 9);
  });
});
