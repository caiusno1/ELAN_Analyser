import { describe, expect, it } from "vitest";
import { datasetFromRows } from "../src/core/data/dataset.ts";
import { buildModel, formulaOf } from "../src/core/stats/design.ts";

const ds = datasetFromRows("t", "row", "", [
  { y: 1.5, x: 1, cond: "b", g: "s1", t: 2, n: 5 },
  { y: 2.5, x: 2, cond: "a", g: "s1", t: 3, n: 5 },
  { y: 3.5, x: 3, cond: "c", g: "s2", t: 1, n: 6 },
  { y: 4.5, x: 4, cond: "a", g: "s2", t: 2, n: 6 },
  { y: NaN, x: 5, cond: "b", g: "s3", t: 2, n: 4 },
  { y: 6.5, x: 6, cond: "", g: "s3", t: 2, n: 4 },
  { y: 7.5, x: 7, cond: "b", g: "s3", t: 0, n: 4 },
], [{ name: "y" }, { name: "x" }, { name: "cond", type: "string" }, { name: "g", type: "string" }, { name: "t" }, { name: "n" }]);

describe("buildModel", () => {
  it("dummy-codes categories, indexes groups and drops incomplete rows", () => {
    const m = buildModel(ds, { outcome: "y", family: "gaussian", predictors: ["x", "cond"], random: ["g"] });
    expect(m.rowsUsed).toBe(5);
    expect(m.rowsDropped).toBe(2);
    expect(m.input.columns.map((c) => c.name)).toEqual(["x", "cond: b", "cond: c"]);
    expect([...m.input.columns[1]!.values]).toEqual([1, 0, 0, 0, 1]);
    expect(m.terms[1]).toEqual({ predictor: "cond", columns: ["cond: b", "cond: c"], reference: "a" });
    expect(m.input.random[0]!.levelNames).toEqual(["s1", "s2", "s3"]);
    expect([...m.input.random[0]!.index]).toEqual([0, 0, 1, 1, 2]);
    expect(m.formula).toBe("y ~ x + cond + (1 | g)");
  });

  it("builds interactions, offsets and trials", () => {
    const m = buildModel(ds, { outcome: "n", family: "poisson", predictors: ["x", "cond"], interactions: [["x", "cond"]], random: [], exposure: "t" });
    expect(m.input.columns.map((c) => c.name)).toEqual(["x", "cond: b", "cond: c", "x × cond: b", "x × cond: c"]);
    // The row with exposure 0 and the one with an empty category are dropped.
    expect(m.rowsUsed).toBe(5);
    expect(m.input.offset![0]).toBeCloseTo(Math.log(2), 12);
    const b = buildModel(ds, { outcome: "x", family: "binomial", predictors: [], random: [], trials: "n" });
    expect(Array.from(b.input.trials!)).toEqual([5, 5, 6, 6, 4, 4, 4]);
    expect(formulaOf({ outcome: "k", family: "binomial", predictors: [], random: ["g"], trials: "n" })).toBe("k of n ~ (1 | g)");
    const cat = buildModel(ds, { outcome: "y", family: "gaussian", predictors: ["n"], asCategory: ["n"], random: [] });
    expect(cat.input.columns.map((c) => c.name)).toEqual(["n: 5", "n: 6"]);
  });

  it("explains what is wrong with a specification", () => {
    expect(() => buildModel(ds, { outcome: "nope", family: "gaussian", predictors: [], random: [] })).toThrow(/no variable/);
    expect(() => buildModel(ds, { outcome: "y", family: "gaussian", predictors: ["x"], interactions: [["x", "cond"]], random: [] })).toThrow(/interaction/);
    expect(() => buildModel(ds, { outcome: "x", family: "binomial", predictors: [], random: [] })).toThrow(/trials/);
    const one = datasetFromRows("o", "row", "", [{ y: 1, c: "a" }, { y: 2, c: "a" }, { y: 3, c: "a" }], [{ name: "y" }, { name: "c", type: "string" }]);
    expect(() => buildModel(one, { outcome: "y", family: "gaussian", predictors: ["c"], random: [] })).toThrow(/only one value/);
  });
});
