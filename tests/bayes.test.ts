import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { anovaLogBf10, oneWayStats, postHoc } from "../src/core/stats/bayes/anova.ts";
import { correlationBayesFactors, correlationLogBf10, correlationLogBf10Numeric, correlationPosterior, correlationPriorLogPdf } from "../src/core/stats/bayes/correlation.ts";
import { contingencyLogBf10, cramersV, cramersVPosterior, oddsRatioPosterior, probBetaGreater } from "../src/core/stats/bayes/contingency.ts";
import { binomialTest, compareRates, evidenceLabel, multinomialTest, rateSummary } from "../src/core/stats/bayes/proportions.ts";
import { tTestBayesFactors, twoSampleStats } from "../src/core/stats/bayes/ttest.ts";
import { pearson } from "../src/core/stats/describe.ts";
import { integrate } from "../src/core/stats/quadrature.ts";
import { Rng } from "../src/core/stats/rng.ts";

// Reference Bayes factors: tests/reference/ref_bayesfactor.R (R package BayesFactor).
const ref = JSON.parse(readFileSync(new URL("./fixtures/ref_bayesfactor.json", import.meta.url), "utf8"));

function split(y: number[], g: number[]): number[][] {
  const k = Math.max(...g);
  const groups: number[][] = Array.from({ length: k }, () => []);
  y.forEach((v, i) => groups[g[i]! - 1]!.push(v));
  return groups;
}

describe("one-way ANOVA vs R BayesFactor", () => {
  it("reproduces anovaBF for balanced and unbalanced designs", () => {
    for (const c of ref.anova as { y: number[]; g: number[]; r: number; logbf10: number }[]) {
      const stats = oneWayStats(split(c.y, c.g));
      const got = anovaLogBf10(stats, c.r);
      expect(Math.abs(got - c.logbf10), `k=${stats.groups.length} N=${stats.n} r=${c.r}: got ${got}, want ${c.logbf10}`).toBeLessThan(1e-4 * Math.max(1, Math.abs(c.logbf10)));
    }
  });

  it("equals the two-sample t-test for two groups (r_anova = r_t / √2)", () => {
    const x = [5.1, 4.8, 6.2, 5.5, 5.9, 4.4, 6.8];
    const y = [4.2, 4.9, 3.8, 5.0, 4.1, 3.5, 4.6, 4.4, 3.9];
    const a = anovaLogBf10(oneWayStats([x, y]), 0.5);
    const t = tTestBayesFactors(twoSampleStats(x, y), { family: "cauchy", location: 0, scale: Math.SQRT1_2 }).logBf10;
    expect(a).toBeCloseTo(t, 7);
  });

  it("computes descriptives and post-hoc comparisons", () => {
    const groups = [[1, 2, 3, 4], [2, 3, 4, 5], [6, 7, 8, 9]];
    const s = oneWayStats(groups, ["a", "b", "c"]);
    expect(s.grandMean).toBeCloseTo(4.5, 12);
    expect(s.ssBetween + s.ssWithin).toBeCloseTo(s.ssTotal, 10);
    expect(s.f).toBeCloseTo((s.ssBetween / 2) / (s.ssWithin / 9), 10);
    expect(s.groups[0]!.ci[0]).toBeLessThan(2.5);
    const ph = postHoc(groups, ["a", "b", "c"]);
    expect(ph).toHaveLength(3);
    expect(ph[0]!.priorOdds).toBeCloseTo((1 - 0.5 ** (2 / 3)) / 0.5 ** (2 / 3), 12);
    expect(ph[1]!.logBf10).toBeGreaterThan(ph[0]!.logBf10);
    expect(ph[0]!.logPosteriorOdds).toBeCloseTo(Math.log(ph[0]!.priorOdds) + ph[0]!.logBf10, 12);
  });
});

describe("correlation vs R BayesFactor", () => {
  const cases = ref.correlation as { x: number[]; y: number[]; kappa: number; r: number; logbf10: number; logbf_plus: number; logbf_minus: number }[];

  it("reproduces correlationBF (two-sided and one-sided)", () => {
    for (const c of cases) {
      const r = pearson(c.x, c.y);
      expect(r).toBeCloseTo(c.r, 12);
      const got = correlationBayesFactors(r, c.x.length, c.kappa);
      const label = `n=${c.x.length} r=${r.toFixed(3)} kappa=${c.kappa}`;
      expect(Math.abs(got.logBf10 - c.logbf10), label).toBeLessThan(1e-6 * Math.max(1, Math.abs(c.logbf10)));
      // BayesFactor evaluates interval hypotheses with Jeffreys' *approximate* likelihood
      // (jeffreys_approx_corr); ours is exact, so small-n cases differ by up to ~1%.
      expect(Math.abs(got.logBfPlus0 - c.logbf_plus), `plus ${label}`).toBeLessThan(0.02 * Math.max(1, Math.abs(c.logbf_plus)));
      expect(Math.abs(got.logBfMinus0 - c.logbf_minus), `minus ${label}`).toBeLessThan(0.02 * Math.max(1, Math.abs(c.logbf_minus)));
    }
  });

  it("closed form equals direct numerical integration", () => {
    for (const [r, n, k] of [[0.3, 20, 1], [-0.7, 9, 1], [0.05, 400, 0.5], [0.92, 30, 1 / 3], [0, 50, 1], [0.999, 12, 1]] as const) {
      const a = correlationLogBf10(r, n, k);
      const b = correlationLogBf10Numeric(r, n, k);
      expect(Math.abs(a - b), `r=${r} n=${n}`).toBeLessThan(1e-7 * Math.max(1, Math.abs(a)));
    }
  });

  it("has a normalised prior and a sensible posterior", () => {
    for (const k of [1, 0.5, 2]) {
      const total = integrate((rho) => Math.exp(correlationPriorLogPdf(rho, k)), -1, 1, { relTol: 1e-9 }).value;
      expect(total).toBeCloseTo(1, 6);
    }
    const post = correlationPosterior(0.45, 40);
    expect(post.median).toBeGreaterThan(0.3);
    expect(post.median).toBeLessThan(0.5);
    expect(post.ci[0]).toBeGreaterThan(0.1);
    expect(post.ci[1]).toBeLessThan(0.7);
    expect(post.pPositive).toBeGreaterThan(0.99);
    const bf = correlationBayesFactors(0.45, 40);
    expect(bf.logBf10 + Math.log(2 * post.pPositive)).toBeCloseTo(bf.logBfPlus0, 4);
    const one = correlationPosterior(0.45, 40, 1, "less");
    expect(one.x[one.x.length - 1]).toBeLessThanOrEqual(0);
    expect(correlationLogBf10(1, 10)).toBe(Infinity);
  });
});

describe("contingency tables vs R BayesFactor", () => {
  const cases = ref.contingency as { table: number[][]; a: number; poisson: number; jointMulti: number; indepMultiRows: number; indepMultiCols: number }[];

  it("reproduces all four sampling schemes", () => {
    for (const c of cases) {
      const label = `${JSON.stringify(c.table)} a=${c.a}`;
      const tol = (v: number) => 1e-9 * Math.max(1, Math.abs(v));
      expect(Math.abs(contingencyLogBf10(c.table, "poisson", c.a) - c.poisson), `poisson ${label}`).toBeLessThan(tol(c.poisson));
      expect(Math.abs(contingencyLogBf10(c.table, "jointMultinomial", c.a) - c.jointMulti), `joint ${label}`).toBeLessThan(tol(c.jointMulti));
      expect(Math.abs(contingencyLogBf10(c.table, "independentRows", c.a) - c.indepMultiRows), `rows ${label}`).toBeLessThan(tol(c.indepMultiRows));
      expect(Math.abs(contingencyLogBf10(c.table, "independentCols", c.a) - c.indepMultiCols), `cols ${label}`).toBeLessThan(tol(c.indepMultiCols));
    }
  });

  it("rejects prior concentrations below 1", () => {
    expect(() => contingencyLogBf10([[1, 2], [3, 4]], "poisson", 0.5)).toThrow(RangeError);
  });

  it("summarises the odds ratio of a 2 × 2 table", () => {
    const table = [[12, 5], [7, 14]];
    const or = oddsRatioPosterior(table);
    // Monte Carlo check with independent Beta posteriors.
    const rng = new Rng(11);
    const draws: number[] = [];
    for (let i = 0; i < 200000; i++) {
      const p1 = rng.beta(13, 6);
      const p2 = rng.beta(8, 15);
      draws.push(Math.log(p1 / (1 - p1)) - Math.log(p2 / (1 - p2)));
    }
    draws.sort((a, b) => a - b);
    expect(Math.abs(or.logOdds.median - draws[100000]!)).toBeLessThan(0.01);
    expect(Math.abs(or.logOdds.ci[0] - draws[5000]!)).toBeLessThan(0.02);
    expect(Math.abs(or.logOdds.ci[1] - draws[195000]!)).toBeLessThan(0.02);
    expect(Math.abs(or.pGreater1 - draws.filter((d) => d > 0).length / draws.length)).toBeLessThan(0.003);
    expect(or.oddsRatio.median).toBeCloseTo(Math.exp(or.logOdds.median), 10);
    expect(probBetaGreater(3, 3, 3, 3)).toBeCloseTo(0.5, 8);
    expect(probBetaGreater(200, 5, 5, 200)).toBeCloseTo(1, 8);
  });

  it("estimates Cramér's V", () => {
    const strong = [[40, 2, 3], [3, 38, 4], [2, 5, 41]];
    expect(cramersV(strong)).toBeGreaterThan(0.75);
    const post = cramersVPosterior(strong);
    expect(post.ci[0]).toBeLessThan(post.median);
    expect(post.median).toBeLessThan(post.ci[1]);
    expect(Math.abs(post.median - cramersV(strong))).toBeLessThan(0.08);
    expect(cramersVPosterior(strong, 1, 0.95, 4000, 5)).toEqual(cramersVPosterior(strong, 1, 0.95, 4000, 5));
    expect(cramersV([[10, 10], [10, 10]])).toBe(0);
  });
});

describe("proportions and rates", () => {
  it("binomial test matches hand-computed values", () => {
    // BF10 = B(k+1, n−k+1) / θ0^k(1−θ0)^(n−k); for k=7, n=10, θ0=.5: (1/1320)/(1/1024)
    const res = binomialTest(7, 10);
    expect(Math.exp(res.logBf10)).toBeCloseTo(1024 / 1320, 10);
    expect(res.posterior.mean).toBeCloseTo(8 / 12, 12);
    // Directional Bayes factors average back to the two-sided one (prior mass 1/2 each).
    expect((Math.exp(res.logBfPlus0) + Math.exp(res.logBfMinus0)) / 2).toBeCloseTo(Math.exp(res.logBf10), 10);
    expect(res.logBfPlus0).toBeGreaterThan(res.logBfMinus0);
    const strong = binomialTest(95, 100, 0.5);
    expect(strong.logBf10).toBeGreaterThan(30);
    expect(strong.posterior.ci[0]).toBeGreaterThan(0.88);
    const edge = binomialTest(0, 20, 0.1, 2, 3);
    expect(Number.isFinite(edge.logBf10)).toBe(true);
  });

  it("multinomial test reduces to the binomial test for two categories", () => {
    const m = multinomialTest([7, 3]);
    expect(m.logBf10).toBeCloseTo(binomialTest(7, 10).logBf10, 10);
    const m2 = multinomialTest([30, 10, 10], [2, 1, 1]);
    expect(m2.expected).toEqual([0.5, 0.25, 0.25]);
    expect(m2.logBf10).toBeLessThan(0);
    expect(multinomialTest([60, 5, 5]).logBf10).toBeGreaterThan(10);
    expect(m2.posteriors[0]!.mean).toBeCloseTo(31 / 53, 12);
    expect(multinomialTest([0, 0, 4]).logBf10).toBeGreaterThan(0);
  });

  it("compares Poisson rates", () => {
    const same = compareRates(50, 10, 100, 20);
    expect(same.logBf10).toBeLessThan(-1);
    expect(same.ratio.median).toBeGreaterThan(0.85);
    expect(same.ratio.median).toBeLessThan(1.15);
    const diff = compareRates(90, 10, 60, 20);
    expect(diff.logBf10).toBeGreaterThan(8);
    expect(diff.ratio.ci[0]).toBeGreaterThan(2);
    expect(diff.ratio.ci[1]).toBeLessThan(4.5);
    expect(diff.pGreater).toBeGreaterThan(0.999);
    expect(Math.log((Math.exp(diff.logBfPlus0) + Math.exp(diff.logBfMinus0)) / 2)).toBeCloseTo(diff.logBf10, 8);
    // Swapping the samples mirrors the result.
    const swapped = compareRates(60, 20, 90, 10);
    expect(swapped.logBf10).toBeCloseTo(diff.logBf10, 8);
    expect(swapped.ratio.median).toBeCloseTo(1 / diff.ratio.median, 3);
    // Brute-force check of the marginal likelihood by integrating over φ on a grid.
    const [k1, t1, k2, t2, sd] = [12, 3, 5, 4, 1];
    let m1 = 0;
    const h = 0.0005;
    for (let phi = -12; phi <= 12; phi += h) {
      const theta = 1 / (1 + Math.exp(-(phi + Math.log(t1 / t2))));
      m1 += theta ** k1 * (1 - theta) ** k2 * Math.exp(-0.5 * (phi / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI)) * h;
    }
    const theta0 = t1 / (t1 + t2);
    expect(compareRates(k1, t1, k2, t2, sd).logBf10).toBeCloseTo(Math.log(m1 / (theta0 ** k1 * (1 - theta0) ** k2)), 5);
    const zero = compareRates(0, 10, 0, 10);
    expect(zero.logBf10).toBeCloseTo(0, 10);
    const rs = rateSummary(20, 4);
    expect(rs.rate).toBe(5);
    expect(rs.ci[0]).toBeLessThan(5);
    expect(rs.ci[1]).toBeGreaterThan(5);
  });

  it("labels evidence", () => {
    expect(evidenceLabel(Math.log(2))).toEqual({ strength: "anecdotal", favours: "H1" });
    expect(evidenceLabel(Math.log(1 / 5))).toEqual({ strength: "moderate", favours: "H0" });
    expect(evidenceLabel(Math.log(20)).strength).toBe("strong");
    expect(evidenceLabel(Math.log(50)).strength).toBe("very strong");
    expect(evidenceLabel(Math.log(1e5)).strength).toBe("extreme");
    expect(evidenceLabel(0)).toEqual({ strength: "no", favours: "neither" });
    expect(evidenceLabel(Infinity).strength).toBe("extreme");
  });
});
