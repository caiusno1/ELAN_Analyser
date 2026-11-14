import { column, levelsOf, type Dataset } from "../data/dataset.ts";
import type { Family, FixedColumn, GlmmInput, RandomTerm } from "./mcmc/glmm.ts";

/** A regression model described in terms of the variables of a dataset. */
export interface ModelSpec {
  outcome: string;
  family: Family;
  /** Fixed effects: numeric variables enter as they are, text variables as categories. */
  predictors: string[];
  /** Numeric variables that should be treated as categories. */
  asCategory?: string[];
  /** Pairs of predictors whose interaction is included. */
  interactions?: [string, string][];
  /** Grouping variables that get a random intercept. */
  random: string[];
  /** Counts: observation time or other exposure (the model then describes rates). */
  exposure?: string;
  /** Binomial: number of trials. */
  trials?: string;
  /**
   * Further variables that must not be missing in the rows used, although they are not in
   * the model. This keeps a reduced model on exactly the rows of the full model.
   */
  completeFor?: string[];
}

/** A fixed-effect term and the model that results from leaving it out. */
export interface TermTest {
  term: string;
  /** The model without the term; undefined if the term cannot be tested on its own. */
  reduced?: ModelSpec;
  /** Why the term cannot be tested. */
  reason?: string;
}

/**
 * The fixed-effect terms of a model, each with the reduced model that tests it. A predictor
 * that is part of an interaction is not tested on its own: without it the interaction would
 * mean something else (principle of marginality).
 */
export function termTests(spec: ModelSpec): TermTest[] {
  const interactions = spec.interactions ?? [];
  const out: TermTest[] = spec.predictors.map((p) => {
    if (interactions.some(([a, b]) => a === p || b === p)) return { term: p, reason: "part of an interaction" };
    const reduced: ModelSpec = { ...spec, predictors: spec.predictors.filter((q) => q !== p), completeFor: [...(spec.completeFor ?? []), p] };
    return { term: p, reduced };
  });
  for (const pair of interactions) {
    const rest = interactions.filter((q) => q !== pair);
    const reduced: ModelSpec = { ...spec };
    if (rest.length) reduced.interactions = rest;
    else delete reduced.interactions;
    out.push({ term: `${pair[0]} × ${pair[1]}`, reduced });
  }
  return out;
}

export interface BuiltModel {
  input: GlmmInput;
  rowsUsed: number;
  rowsDropped: number;
  /** For each predictor, the names of its design columns. */
  terms: { predictor: string; columns: string[]; reference?: string }[];
  /** Human-readable model formula. */
  formula: string;
}

function isCategorical(ds: Dataset, name: string, asCategory: ReadonlySet<string>): boolean {
  const c = column(ds, name);
  return !!c && (c.type === "string" || asCategory.has(name));
}

function cellString(ds: Dataset, name: string, i: number): string {
  const c = column(ds, name)!;
  if (c.type === "string") return c.values[i]!;
  const v = c.values[i]!;
  return Number.isNaN(v) ? "" : String(v);
}

function cellNumber(ds: Dataset, name: string, i: number): number {
  const c = column(ds, name)!;
  if (c.type === "number") return c.values[i]!;
  const s = c.values[i]!.trim();
  return s === "" ? NaN : Number(s);
}

export function formulaOf(spec: ModelSpec): string {
  const rhs = [
    ...spec.predictors,
    ...(spec.interactions ?? []).map(([a, b]) => `${a} × ${b}`),
    ...spec.random.map((g) => `(1 | ${g})`),
  ];
  const lhs = spec.family === "binomial" && spec.trials ? `${spec.outcome} of ${spec.trials}` : spec.outcome;
  const off = spec.exposure ? ` + offset(ln ${spec.exposure})` : "";
  return `${lhs} ~ ${rhs.length ? rhs.join(" + ") : "1"}${off}`;
}

/**
 * Turn a model specification into the numeric input of the sampler: rows with missing
 * values are dropped, categories are dummy-coded against their first level (treatment
 * coding), and grouping variables become level indices.
 */
export function buildModel(ds: Dataset, spec: ModelSpec): BuiltModel {
  const asCategory = new Set(spec.asCategory ?? []);
  const need = [spec.outcome, ...spec.predictors, ...spec.random, ...(spec.exposure ? [spec.exposure] : []), ...(spec.trials ? [spec.trials] : []), ...(spec.completeFor ?? [])];
  for (const v of need) if (!column(ds, v)) throw new Error(`The table has no variable “${v}”.`);
  for (const [a, b] of spec.interactions ?? []) {
    if (!spec.predictors.includes(a) || !spec.predictors.includes(b)) throw new Error("Both variables of an interaction must also be predictors.");
  }

  // ---- complete rows ---------------------------------------------------------------
  const keep: number[] = [];
  for (let i = 0; i < ds.rowCount; i++) {
    let ok = Number.isFinite(cellNumber(ds, spec.outcome, i));
    for (const p of [...spec.predictors, ...(spec.completeFor ?? [])]) {
      if (!ok) break;
      ok = isCategorical(ds, p, asCategory) ? cellString(ds, p, i).trim() !== "" : Number.isFinite(cellNumber(ds, p, i));
    }
    for (const g of spec.random) if (ok) ok = cellString(ds, g, i).trim() !== "";
    if (ok && spec.exposure) ok = cellNumber(ds, spec.exposure, i) > 0;
    if (ok && spec.trials) ok = Number.isFinite(cellNumber(ds, spec.trials, i));
    if (ok) keep.push(i);
  }
  const n = keep.length;
  if (n < 3) throw new Error("Fewer than three complete rows are left for this model.");

  // ---- fixed effects ---------------------------------------------------------------
  const columns: FixedColumn[] = [];
  const terms: BuiltModel["terms"] = [];
  const designOf = new Map<string, FixedColumn[]>();
  for (const p of spec.predictors) {
    if (isCategorical(ds, p, asCategory)) {
      const vals = keep.map((i) => cellString(ds, p, i).trim());
      const levels = levelsOf(vals);
      if (levels.length < 2) throw new Error(`“${p}” has only one value in the rows used, so it cannot be a predictor.`);
      if (levels.length > 30) throw new Error(`“${p}” has ${levels.length} different values — too many for a fixed effect. Use it as a grouping variable instead.`);
      const cols = levels.slice(1).map((level) => ({ name: `${p}: ${level}`, values: Float64Array.from(vals, (v) => (v === level ? 1 : 0)) }));
      designOf.set(p, cols);
      columns.push(...cols);
      terms.push({ predictor: p, columns: cols.map((c) => c.name), reference: levels[0]! });
    } else {
      const col = { name: p, values: Float64Array.from(keep, (i) => cellNumber(ds, p, i)) };
      designOf.set(p, [col]);
      columns.push(col);
      terms.push({ predictor: p, columns: [p] });
    }
  }
  for (const [a, b] of spec.interactions ?? []) {
    const cols: FixedColumn[] = [];
    for (const ca of designOf.get(a)!) {
      for (const cb of designOf.get(b)!) {
        const values = new Float64Array(n);
        for (let i = 0; i < n; i++) values[i] = ca.values[i]! * cb.values[i]!;
        cols.push({ name: `${ca.name} × ${cb.name}`, values });
      }
    }
    columns.push(...cols);
    terms.push({ predictor: `${a} × ${b}`, columns: cols.map((c) => c.name) });
  }

  // ---- grouping factors --------------------------------------------------------------
  const random: RandomTerm[] = spec.random.map((g) => {
    const vals = keep.map((i) => cellString(ds, g, i).trim());
    const levels = levelsOf(vals);
    if (levels.length < 2) throw new Error(`The grouping variable “${g}” has only one value in the rows used.`);
    const index = new Map(levels.map((l, k) => [l, k]));
    return { name: g, index: Int32Array.from(vals, (v) => index.get(v)!), levelNames: levels };
  });

  const input: GlmmInput = {
    family: spec.family,
    y: Float64Array.from(keep, (i) => cellNumber(ds, spec.outcome, i)),
    columns,
    random,
  };
  if (spec.exposure) input.offset = Float64Array.from(keep, (i) => Math.log(cellNumber(ds, spec.exposure!, i)));
  if (spec.family === "binomial") {
    if (!spec.trials) throw new Error("A binomial model needs a variable with the number of trials.");
    input.trials = Float64Array.from(keep, (i) => cellNumber(ds, spec.trials!, i));
  }
  return { input, rowsUsed: n, rowsDropped: ds.rowCount - n, terms, formula: formulaOf(spec) };
}
