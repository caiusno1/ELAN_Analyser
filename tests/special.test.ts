import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { betaI, betaIc, digamma, erfc, gammaP, gammaQ, hyp2f1, lgamma, logHyp1f1 } from "../src/core/stats/special.ts";
import { betaInv, betaPrimeInv, gammaInv, nctPdf, normalCdf, normalInv, tCdf, tInv, tLogPdf } from "../src/core/stats/distributions.ts";
import { integrate, integrateInf } from "../src/core/stats/quadrature.ts";

// Reference values: tests/reference/ref_special.py (SciPy + mpmath at 40 digits).
const ref = JSON.parse(readFileSync(new URL("./fixtures/ref_special.json", import.meta.url), "utf8")) as Record<string, number[][]>;

/** Largest relative error (with an absolute floor) over a reference table. */
function worst(rows: number[][], f: (...args: number[]) => number, floor = 1e-300): { err: number; at: number[] } {
  let err = 0;
  let at: number[] = [];
  for (const row of rows) {
    const want = row[row.length - 1]!;
    const got = f(...row.slice(0, -1));
    const e = want === got ? 0 : Math.abs(got - want) / Math.max(Math.abs(want), floor);
    if (!(e <= err)) {
      err = e;
      at = [...row, got];
    }
  }
  return { err, at };
}

function check(name: string, f: (...args: number[]) => number, tol: number, floor = 1e-300) {
  it(`${name} matches reference to ${tol}`, () => {
    const w = worst(ref[name]!, f, floor);
    expect(w.err, `worst case ${JSON.stringify(w.at)}`).toBeLessThan(tol);
  });
}

describe("special functions vs SciPy/mpmath", () => {
  check("lgamma", lgamma, 2e-13, 1e-2);
  check("digamma", digamma, 1e-12);
  check("gammaP", gammaP, 1e-12, 1e-280);
  check("gammaQ", gammaQ, 1e-12, 1e-280);
  check("erfc", erfc, 1e-12);
  check("betaI", betaI, 1e-11, 1e-280);
  check("betaIc", betaIc, 1e-11, 1e-280);
  check("logHyp1f1", logHyp1f1, 1e-12, 1e-3);
  check("hyp2f1", hyp2f1, 1e-12);
});

describe("distributions vs SciPy/mpmath", () => {
  check("normalCdf", normalCdf, 1e-11);
  check("normalInv", normalInv, 1e-10);
  check("tCdf", tCdf, 1e-10);
  check("tInv", tInv, 1e-9);
  check("tLogPdf", tLogPdf, 1e-12);
  check("gammaInv", gammaInv, 1e-9);
  check("betaInv", betaInv, 1e-9);
  check("betaPrimeInv", betaPrimeInv, 1e-9);

  it("noncentral t density matches an independent integral representation", () => {
    let worstAbs = 0;
    let worstRel = 0;
    let at: number[] = [];
    for (const [t, v, mu, want] of ref.nctPdf! as [number, number, number, number][]) {
      const got = nctPdf(t, v, mu);
      const abs = Math.abs(got - want);
      // Relative accuracy where the density matters, absolute accuracy in the far tails.
      const rel = want > 1e-4 ? abs / want : 0;
      if (abs > worstAbs) worstAbs = abs;
      if (rel > worstRel) {
        worstRel = rel;
        at = [t, v, mu, want, got];
      }
    }
    expect(worstRel, JSON.stringify(at)).toBeLessThan(1e-9);
    expect(worstAbs).toBeLessThan(1e-11);
  });
});

describe("quadrature", () => {
  it("integrates smooth, peaked and infinite-range functions", () => {
    expect(integrate(Math.sin, 0, Math.PI).value).toBeCloseTo(2, 12);
    expect(integrate((x) => x * x, 3, 1).value).toBeCloseTo(-26 / 3, 12);
    const gauss = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
    expect(integrateInf(gauss, -Infinity, Infinity).value).toBeCloseTo(1, 11);
    expect(integrateInf(gauss, 0, Infinity).value).toBeCloseTo(0.5, 11);
    expect(integrateInf(gauss, -Infinity, 1).value).toBeCloseTo(normalCdf(1), 11);
    // A very narrow peak far from the origin is found when its location is given.
    const narrow = (x: number) => Math.exp(-0.5 * ((x - 37.2) / 1e-3) ** 2) / (1e-3 * Math.sqrt(2 * Math.PI));
    expect(integrateInf(narrow, -Infinity, Infinity, { points: [37.2 - 0.01, 37.2, 37.2 + 0.01] }).value).toBeCloseTo(1, 9);
    // Integrable endpoint singularity.
    expect(integrate((x) => 1 / Math.sqrt(x), 0, 1, { relTol: 1e-8 }).value).toBeCloseTo(2, 6);
  });
});
