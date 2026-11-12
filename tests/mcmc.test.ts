import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { convergence } from "../src/core/stats/mcmc/diagnostics.ts";
import { compareWaic, fitGlmm, sampleChain, summarizeFit, type GlmmFit } from "../src/core/stats/mcmc/fit.ts";
import { GlmmModel, type Family, type GlmmInput } from "../src/core/stats/mcmc/glmm.ts";
import { runNuts } from "../src/core/stats/mcmc/nuts.ts";
import { mean, sd } from "../src/core/stats/describe.ts";
import { normalLogPdf, poissonLogPmf } from "../src/core/stats/distributions.ts";
import { integrate, integrateInf } from "../src/core/stats/quadrature.ts";
import { Rng } from "../src/core/stats/rng.ts";

// Reference posteriors: tests/reference/ref_rstanarm.R (rstanarm 2.32 / Stan).
const ref = JSON.parse(readFileSync(new URL("./fixtures/ref_rstanarm.json", import.meta.url), "utf8"));

interface RefPost { name: string; mean: number; sd: number; q025: number; q50: number; q975: number }

function expectClose(fit: GlmmFit, name: string, r: { mean: number; sd: number; q025?: number; q975?: number }) {
  const s = fit.summaries.find((p) => p.name === name)!;
  expect(s, `parameter ${name}`).toBeDefined();
  expect(Math.abs(s.mean - r.mean) / r.sd, `${name} mean ${s.mean} vs ${r.mean}`).toBeLessThan(0.12);
  expect(Math.abs(s.sd / r.sd - 1), `${name} sd ${s.sd} vs ${r.sd}`).toBeLessThan(0.1);
  if (r.q025 !== undefined) expect(Math.abs(s.ci[0] - r.q025) / r.sd, `${name} q2.5`).toBeLessThan(0.2);
  if (r.q975 !== undefined) expect(Math.abs(s.ci[1] - r.q975) / r.sd, `${name} q97.5`).toBeLessThan(0.2);
  expect(s.rhat).toBeLessThan(1.02);
  expect(s.essBulk).toBeGreaterThan(400);
}

const col = (name: string, values: number[]) => ({ name, values: Float64Array.from(values) });
const levels = (g: (number | string)[]) => {
  const names = [...new Set(g.map(String))].sort((a, b) => Number(a) - Number(b));
  return { index: Int32Array.from(g, (v) => names.indexOf(String(v))), levelNames: names };
};

describe("NUTS sampler", () => {
  it("samples a correlated-scale Gaussian target correctly", () => {
    const scales = [0.01, 1, 30, 0.2, 5];
    const logp = (theta: Float64Array, grad: Float64Array) => {
      let lp = 0;
      for (let i = 0; i < 5; i++) {
        const z = (theta[i]! - i) / scales[i]!;
        lp -= 0.5 * z * z;
        grad[i] = -z / scales[i]!;
      }
      return lp;
    };
    const res = runNuts(logp, new Float64Array(5), { warmup: 800, samples: 3000, seed: 3 });
    expect(res.divergences).toBe(0);
    for (let i = 0; i < 5; i++) {
      const x = Float64Array.from({ length: res.samples }, (_, s) => res.draws[s * 5 + i]!);
      expect(Math.abs(mean(x) - i) / scales[i]!).toBeLessThan(0.1);
      expect(sd(x) / scales[i]!).toBeGreaterThan(0.9);
      expect(sd(x) / scales[i]!).toBeLessThan(1.1);
      expect(res.inverseMetric[i]! / scales[i]! ** 2).toBeGreaterThan(0.5);
      expect(res.inverseMetric[i]! / scales[i]! ** 2).toBeLessThan(2);
    }
    // Same seed, same draws.
    const again = runNuts(logp, new Float64Array(5), { warmup: 800, samples: 3000, seed: 3 });
    expect(again.draws[1234]).toBe(res.draws[1234]);
  });

  it("recovers from an invalid starting point and reports divergences honestly", () => {
    // Half-line target: log density of an Exponential(1) variable on its natural scale.
    const logp = (theta: Float64Array, grad: Float64Array) => {
      if (theta[0]! <= 0) return -Infinity;
      grad[0] = -1;
      return -theta[0]!;
    };
    const res = runNuts(logp, Float64Array.from([-3]), { warmup: 500, samples: 2000, seed: 1 });
    const x = Float64Array.from(res.draws);
    expect(Math.min(...x)).toBeGreaterThan(0);
    expect(Math.abs(mean(x) - 1)).toBeLessThan(0.15);
  });
});

describe("convergence diagnostics", () => {
  it("gives R-hat near 1 and ESS near N for independent draws", () => {
    const rng = new Rng(8);
    const chains = Array.from({ length: 4 }, () => Float64Array.from({ length: 1000 }, () => rng.normal()));
    const c = convergence(chains);
    expect(c.rhat).toBeLessThan(1.01);
    expect(c.essBulk).toBeGreaterThan(3000);
    expect(c.essBulk).toBeLessThan(5200);
    expect(c.essTail).toBeGreaterThan(2500);
  });

  it("flags chains that disagree in location or in scale", () => {
    const rng = new Rng(9);
    const shifted = Array.from({ length: 4 }, (_, k) => Float64Array.from({ length: 500 }, () => rng.normal(k === 3 ? 3 : 0, 1)));
    expect(convergence(shifted).rhat).toBeGreaterThan(1.3);
    const scaled = Array.from({ length: 4 }, (_, k) => Float64Array.from({ length: 500 }, () => rng.normal(0, k === 3 ? 8 : 1)));
    expect(convergence(scaled).rhat).toBeGreaterThan(1.1);
  });

  it("estimates the effective sample size of an AR(1) process", () => {
    const rng = new Rng(10);
    const rho = 0.8;
    const chains = Array.from({ length: 4 }, () => {
      const x = new Float64Array(4000);
      x[0] = rng.normal();
      for (let i = 1; i < x.length; i++) x[i] = rho * x[i - 1]! + Math.sqrt(1 - rho * rho) * rng.normal();
      return x;
    });
    const expected = (16000 * (1 - rho)) / (1 + rho);
    const ess = convergence(chains).essBulk;
    expect(ess).toBeGreaterThan(0.75 * expected);
    expect(ess).toBeLessThan(1.3 * expected);
  });

  it("returns NaN for constant draws", () => {
    expect(Number.isNaN(convergence([new Float64Array(100).fill(2), new Float64Array(100).fill(2)]).rhat)).toBe(true);
  });
});

describe("multilevel models vs rstanarm (Stan)", () => {
  const opts = { chains: 4, warmup: 800, samples: 2500, seed: 17 };

  it("Gaussian regression", () => {
    const d = ref.gaussian.data;
    const fit = fitGlmm({ family: "gaussian", y: d.y, columns: [col("x1", d.x1), col("x2", d.x2)], random: [], priors: ref.gaussian.priors }, opts);
    for (const r of ref.gaussian.post as RefPost[]) expectClose(fit, r.name, r);
    expect(fit.diagnostics.divergences).toBe(0);
  });

  it("Poisson model with exposure and a random intercept", () => {
    const d = ref.poisson.data;
    const g = levels(d.g);
    const fit = fitGlmm({
      family: "poisson", y: d.y, offset: (d.expo as number[]).map((e) => Math.log(e)),
      columns: [col("x", d.x)], random: [{ name: "g", ...g }],
      priors: { coefSd: [2.5], interceptMean: 0, interceptSd: 5, tauRate: 1 },
    }, opts);
    for (const r of ref.poisson.post as RefPost[]) expectClose(fit, r.name, r);
    expectClose(fit, "sd(g)", ref.poisson.sd_g);
    const b1 = fit.groupEffects.find((e) => e.term === "g" && e.level === "1")!;
    expect(Math.abs(b1.mean - ref.poisson.b1.mean) / ref.poisson.b1.sd).toBeLessThan(0.15);
    expect(fit.diagnostics.divergences).toBeLessThan(5);
  });

  it("Bernoulli model with a random intercept", () => {
    const d = ref.bernoulli.data;
    const g = levels(d.g);
    const fit = fitGlmm({
      family: "bernoulli", y: d.y, columns: [col("x", d.x), col("cond", d.cond)], random: [{ name: "g", ...g }],
      priors: { coefSd: [2.5, 2.5], interceptMean: 0, interceptSd: 2.5, tauRate: 1 },
    }, opts);
    for (const r of ref.bernoulli.post as RefPost[]) expectClose(fit, r.name, r);
    expectClose(fit, "sd(g)", ref.bernoulli.sd_g);
    expect(fit.ppc.replicated.length).toBe(40);
    expect(fit.ppc.observed.length).toBe(300);
  });
});

describe("parameter recovery for the remaining families", () => {
  const rng = new Rng(21);
  const n = 400;
  const x = Float64Array.from({ length: n }, () => rng.normal());
  const fitFamily = (family: Family, y: Float64Array, extra: Partial<GlmmInput> = {}) =>
    fitGlmm({ family, y, columns: [{ name: "x", values: x }], random: [], ...extra }, { chains: 2, warmup: 600, samples: 1000, seed: 5 });
  const inCi = (fit: GlmmFit, name: string, truth: number) => {
    const s = fit.summaries.find((p) => p.name === name)!;
    expect(s.ci[0], `${name} lower`).toBeLessThan(truth);
    expect(s.ci[1], `${name} upper`).toBeGreaterThan(truth);
    expect(s.rhat).toBeLessThan(1.03);
  };

  it("log-normal", () => {
    const y = Float64Array.from(x, (v) => Math.exp(1 + 0.3 * v + rng.normal(0, 0.4)));
    const fit = fitFamily("lognormal", y);
    inCi(fit, "x", 0.3);
    inCi(fit, "sigma", 0.4);
    inCi(fit, "(Intercept)", 1);
  });

  it("Student-t with outliers", () => {
    const y = Float64Array.from(x, (v) => 2 + 0.5 * v + 0.6 * rng.studentT(3));
    const fit = fitFamily("student", y);
    inCi(fit, "x", 0.5);
    inCi(fit, "nu", 3);
    expect(fit.summaries.find((p) => p.name === "nu")!.median).toBeLessThan(8);
  });

  it("negative binomial", () => {
    const y = Float64Array.from(x, (v) => rng.negBinomial(Math.exp(1.2 + 0.4 * v), 2));
    const fit = fitFamily("negbinomial", y);
    inCi(fit, "x", 0.4);
    inCi(fit, "phi", 2);
  });

  it("binomial", () => {
    const trials = Float64Array.from({ length: n }, (_, i) => 3 + (i % 6));
    const y = Float64Array.from(x, (v, i) => rng.binomial(trials[i]!, 1 / (1 + Math.exp(-(-0.5 + 0.7 * v)))));
    const fit = fitFamily("binomial", y, { trials });
    inCi(fit, "x", 0.7);
    inCi(fit, "(Intercept)", -0.5);
  });

  it("rejects unusable input with clear messages", () => {
    expect(() => new GlmmModel({ family: "lognormal", y: [1, -2, 3], columns: [], random: [] })).toThrow(/positive/);
    expect(() => new GlmmModel({ family: "poisson", y: [1, 2.5, 3], columns: [], random: [] })).toThrow(/whole numbers/);
    expect(() => new GlmmModel({ family: "bernoulli", y: [0, 1, 2], columns: [], random: [] })).toThrow(/0 or 1/);
    expect(() => new GlmmModel({ family: "gaussian", y: [1, 2, 3], columns: [col("c", [1, 1, 1])], random: [] })).toThrow(/does not vary/);
    expect(() => new GlmmModel({ family: "binomial", y: [1, 2, 3], columns: [], random: [] })).toThrow(/trials/);
  });
});

describe("bridge sampling", () => {
  it("matches the exact marginal likelihood of a one-parameter Poisson model", () => {
    const y = [3, 1, 4, 1, 5, 9, 2, 6];
    const input: GlmmInput = { family: "poisson", y, columns: [], random: [], priors: { interceptMean: 1, interceptSd: 2 } };
    const chains = [0, 1, 2, 3].map((c) => sampleChain(input, c, { warmup: 500, samples: 2000, seed: 2 }));
    const fit = summarizeFit(input, chains, { bridge: true, seed: 2 });
    const logLik = (a: number) => y.reduce((s, v) => s + poissonLogPmf(v, Math.exp(a)), 0);
    const peak = Math.log(mean(y));
    const lmax = logLik(peak) + normalLogPdf(peak, 1, 2);
    const exact = lmax + Math.log(integrateInf((a) => Math.exp(logLik(a) + normalLogPdf(a, 1, 2) - lmax), -Infinity, Infinity, { points: [peak - 1, peak, peak + 1] }).value);
    expect(fit.bridge!.converged).toBe(true);
    expect(Math.abs(fit.bridge!.logMarginal - exact)).toBeLessThan(0.02);
    expect(fit.bridge!.cv).toBeLessThan(0.05);
  });

  it("matches the exact marginal likelihood of a Gaussian mean-and-scale model", () => {
    const rng = new Rng(4);
    const y = Array.from({ length: 25 }, () => rng.normal(10, 3));
    const pri = { interceptMean: 8, interceptSd: 6, sigmaRate: 0.25 };
    const input: GlmmInput = { family: "gaussian", y, columns: [], random: [], priors: pri };
    const chains = [0, 1, 2, 3].map((c) => sampleChain(input, c, { warmup: 500, samples: 2000, seed: 6 }));
    const fit = summarizeFit(input, chains, { bridge: true, seed: 6 });
    // Integrate the mean out analytically, then the scale numerically.
    const n = y.length;
    const ybar = mean(y);
    const ss = y.reduce((s, v) => s + (v - ybar) ** 2, 0);
    const logInner = (sigma: number) =>
      -(n / 2) * Math.log(2 * Math.PI * sigma * sigma) - ss / (2 * sigma * sigma) +
      0.5 * Math.log((2 * Math.PI * sigma * sigma) / n) +
      normalLogPdf(ybar, pri.interceptMean, Math.sqrt(pri.interceptSd ** 2 + (sigma * sigma) / n)) +
      Math.log(pri.sigmaRate) - pri.sigmaRate * sigma;
    const sHat = Math.sqrt(ss / n);
    const lmax = logInner(sHat);
    const exact = lmax + Math.log(integrate((s) => Math.exp(logInner(s) - lmax), 0.05, 60, { points: [sHat * 0.6, sHat, sHat * 1.6] }).value);
    expect(Math.abs(fit.bridge!.logMarginal - exact)).toBeLessThan(0.03);
  });

  it("agrees with the Savage–Dickey ratio for nested models", () => {
    const rng = new Rng(12);
    const n = 60;
    const x = Float64Array.from({ length: n }, () => rng.normal());
    const y = Float64Array.from(x, (v) => 1 + 0.1 * v + rng.normal(0, 1));
    const o = { chains: 4, warmup: 600, samples: 3000, seed: 3, bridge: true };
    const full = fitGlmm({ family: "gaussian", y, columns: [{ name: "x", values: x }], random: [] }, o);
    const nul = fitGlmm({ family: "gaussian", y, columns: [], random: [] }, o);
    const bridgeLogBf = full.bridge!.logMarginal - nul.bridge!.logMarginal;
    const sdLogBf = full.summaries.find((p) => p.name === "x")!.logBf10!;
    expect(full.summaries.find((p) => p.name === "x")!.bfMethod).toBe("kernel");
    expect(Math.abs(bridgeLogBf - sdLogBf), `bridge ${bridgeLogBf} vs Savage-Dickey ${sdLogBf}`).toBeLessThan(0.15);
    const cmp = compareWaic(full.waic, nul.waic);
    expect(Number.isFinite(cmp.elpdDiff)).toBe(true);
    expect(cmp.se).toBeGreaterThan(0);
  });

  it("works with group-level effects", () => {
    const rng = new Rng(30);
    const G = 8;
    const n = 120;
    const idx = Int32Array.from({ length: n }, (_, i) => i % G);
    const u = Array.from({ length: G }, () => rng.normal(0, 1));
    const y = Float64Array.from({ length: n }, (_, i) => rng.poisson(Math.exp(1 + u[idx[i]!]!)));
    const names = Array.from({ length: G }, (_, g) => `g${g}`);
    const o = { chains: 4, warmup: 600, samples: 1500, seed: 8, bridge: true };
    const withGroups = fitGlmm({ family: "poisson", y, columns: [], random: [{ name: "g", index: idx, levelNames: names }] }, o);
    const without = fitGlmm({ family: "poisson", y, columns: [], random: [] }, o);
    expect(withGroups.bridge!.converged).toBe(true);
    // Strong group differences: the multilevel model must win decisively.
    expect(withGroups.bridge!.logMarginal - without.bridge!.logMarginal).toBeGreaterThan(20);
    expect(withGroups.bridge!.cv).toBeLessThan(0.2);
  });
});
