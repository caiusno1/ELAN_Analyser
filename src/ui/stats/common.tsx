import type { ReactNode } from "react";
import { column, levelsOf, nestingOf, type Dataset, type NumberColumn } from "../../core/data/dataset.ts";
import { evidenceLabel } from "../../core/stats/bayes/proportions.ts";
import { XYChart, type AxisSpec, type Mark } from "../charts/XYChart.tsx";
import { Callout, fmtBf } from "../kit.tsx";

/** Variables of a dataset, optionally of one type only. */
export function variableOptions(ds: Dataset, type?: "number" | "string", none?: string): { value: string; label: string }[] {
  const cols = ds.columns.filter((c) => !type || c.type === type);
  return [...(none !== undefined ? [{ value: "", label: none }] : []), ...cols.map((c) => ({ value: c.name, label: c.name }))];
}

/** Variables that can define groups (text variables, and numeric ones with few distinct values) with their number of groups. */
function groupings(ds: Dataset): { name: string; k: number; numeric: boolean }[] {
  const out: { name: string; k: number; numeric: boolean }[] = [];
  for (const c of ds.columns) {
    if (c.type === "string") {
      const k = new Set(c.values).size;
      if (k >= 2 && k <= Math.max(60, ds.rowCount / 2)) out.push({ name: c.name, k, numeric: false });
    } else {
      const k = new Set(Array.from(c.values).filter((v) => !Number.isNaN(v))).size;
      if (k >= 2 && k <= 8) out.push({ name: c.name, k, numeric: true });
    }
  }
  return out;
}

export function groupingOptions(ds: Dataset, none?: string): { value: string; label: string }[] {
  return [...(none !== undefined ? [{ value: "", label: none }] : []), ...groupings(ds).map((g) => ({ value: g.name, label: `${g.name} (${g.k} ${g.numeric ? "values" : "groups"})` }))];
}

/** Variables that say which speaker or tier a row belongs to: possible groupings, but rarely the comparison of interest. */
const LABEL_LIKE = /^(file|participant|speaker|tier|from|to|direction|rater|annotator|prime_speaker|[xy]_(tier|participant)|tier_[12])$/i;
/** Variables that count, locate or identify rows rather than measure something. */
const NOT_A_MEASURE = /^(n|n_rows|n_[12xy]|count|index|id|round|trial|units|tokens|content_tokens|(start|end|time|reference_time)(_s|_ms)?|relative_time|observed_min|duration_min)$/i;

/** A sensible grouping variable to start with: one with two groups (or with a few), preferably a variable of the study design. */
export function defaultGrouping(ds: Dataset, want: "two" | "several" = "two"): string {
  // Fewest groups first (stable), so that "several" prefers 4 annotation values over 12 recordings.
  const g = groupings(ds).sort((a, b) => a.k - b.k);
  const fits = (x: { k: number }) => (want === "two" ? x.k === 2 : x.k >= 3 && x.k <= 12);
  const design = (x: { name: string }) => !LABEL_LIKE.test(x.name);
  return (g.find((x) => fits(x) && design(x)) ?? g.find(fits) ?? g.find((x) => design(x) && x.k <= 12) ?? g.find(design) ?? g[0])?.name ?? "";
}

/** A sensible outcome to start with: the main measure of the table, or the first numeric variable that measures something. */
export function defaultOutcome(ds: Dataset, exclude?: string): string {
  const numeric = ds.columns.filter((c): c is NumberColumn => c.type === "number" && c.name !== exclude);
  if (ds.primary && numeric.some((c) => c.name === ds.primary)) return ds.primary;
  const varies = (c: NumberColumn) => new Set(Array.from(c.values).filter((v) => !Number.isNaN(v))).size > 1;
  return (numeric.find((c) => !NOT_A_MEASURE.test(c.name) && varies(c)) ?? numeric.find(varies) ?? numeric[0])?.name ?? "";
}

export function textOf(ds: Dataset, name: string, i: number): string {
  const c = column(ds, name);
  if (!c) return "";
  if (c.type === "string") return c.values[i]!.trim();
  const v = c.values[i]!;
  return Number.isNaN(v) ? "" : String(v);
}

export function numberOf(ds: Dataset, name: string, i: number): number {
  const c = column(ds, name);
  if (!c) return NaN;
  if (c.type === "number") return c.values[i]!;
  const s = c.values[i]!.trim();
  return s === "" ? NaN : Number(s);
}

/** Values of a numeric variable split by a grouping variable; rows with missing values are left out. */
export function splitByGroup(ds: Dataset, variable: string, group: string): { groups: { label: string; values: number[]; rows: number[] }[]; dropped: number } {
  const acc = new Map<string, { values: number[]; rows: number[] }>();
  let dropped = 0;
  for (let i = 0; i < ds.rowCount; i++) {
    const v = numberOf(ds, variable, i);
    const g = textOf(ds, group, i);
    if (!Number.isFinite(v) || g === "") {
      dropped++;
      continue;
    }
    const e = acc.get(g) ?? { values: [], rows: [] };
    e.values.push(v);
    e.rows.push(i);
    acc.set(g, e);
  }
  const labels = levelsOf([...acc.keys()]);
  return { groups: labels.map((label) => ({ label, ...acc.get(label)! })), dropped };
}

export function numericValues(ds: Dataset, variable: string): { values: number[]; dropped: number } {
  const values: number[] = [];
  let dropped = 0;
  for (let i = 0; i < ds.rowCount; i++) {
    const v = numberOf(ds, variable, i);
    if (Number.isFinite(v)) values.push(v);
    else dropped++;
  }
  return { values, dropped };
}

export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The headline of a Bayesian test: the Bayes factor and what it means in words. */
export function BfHeadline({ logBf, label = "BF₁₀", h1, h0 }: { logBf: number; label?: string; h1: string; h0: string }) {
  const ev = evidenceLabel(logBf);
  const inverse = label.replace("₁₀", "₀₁").replace("₊₀", "₀₊").replace("₋₀", "₀₋");
  return (
    <div>
      <div className="bf">
        <span className="bf-value">
          {label} = {fmtBf(logBf)}
        </span>
        <span className="bf-text">
          {ev.favours === "H1" ? `${capitalise(ev.strength)} evidence ${h1}.` : ev.favours === "H0" ? `${capitalise(ev.strength)} evidence ${h0}.` : "The data do not favour either hypothesis."}
        </span>
      </div>
      <div className="faint" style={{ marginTop: 2 }}>
        {logBf >= 0
          ? `The data are ${fmtBf(logBf)} times more likely under the alternative than under the null hypothesis.`
          : `The data are ${fmtBf(-logBf)} times more likely under the null hypothesis than under the alternative (${inverse} = ${fmtBf(-logBf)}).`}
      </div>
    </div>
  );
}

/** Prior and posterior density of a parameter, with the credible interval shaded and the test value marked. */
export function PosteriorChart({ x, posterior, prior, ci, xLabel, testValue = 0, height = 230 }: {
  x: ArrayLike<number>;
  posterior: ArrayLike<number>;
  prior?: (x: number) => number;
  ci?: [number, number];
  xLabel: string;
  testValue?: number;
  height?: number;
}) {
  const pts: [number, number][] = Array.from({ length: x.length }, (_, i) => [x[i]!, posterior[i]!]);
  // Thin the curve for drawing.
  const step = Math.max(1, Math.floor(pts.length / 400));
  const thin = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  const marks: Mark[] = [];
  if (ci) marks.push({ type: "area", color: "var(--series-1)", opacity: 0.18, points: thin.filter((p) => p[0] >= ci[0] && p[0] <= ci[1]).map((p) => [p[0], 0, p[1]]) });
  if (prior) marks.push({ type: "line", color: "var(--text-2)", dash: "5 4", width: 1.5, label: "prior", points: thin.map((p) => [p[0], prior(p[0])]) });
  marks.push({ type: "line", color: "var(--series-1)", label: "posterior", points: thin });
  const lo = x[0]!;
  const hi = x[x.length - 1]!;
  if (testValue >= lo && testValue <= hi) {
    // Savage–Dickey points: the heights of prior and posterior at the test value.
    let k = 0;
    while (k + 1 < x.length && x[k + 1]! < testValue) k++;
    const f = x.length > 1 ? (testValue - x[k]!) / (x[Math.min(k + 1, x.length - 1)]! - x[k]! || 1) : 0;
    const post0 = posterior[k]! + f * ((posterior[Math.min(k + 1, x.length - 1)] ?? posterior[k]!) - posterior[k]!);
    const dots = [{ x: testValue, y: post0, color: "var(--series-1)", tip: { title: `Posterior density at ${testValue}`, rows: [["density", post0.toPrecision(3)] as [string, string]] } }];
    if (prior) dots.push({ x: testValue, y: prior(testValue), color: "var(--text-2)", tip: { title: `Prior density at ${testValue}`, rows: [["density", prior(testValue).toPrecision(3)] as [string, string]] } });
    marks.push({ type: "dot", data: dots });
  }
  return (
    <XYChart
      height={height}
      crosshair
      x={{ type: "linear", label: xLabel, nice: false }}
      y={{ type: "linear", zero: true, label: "density" }}
      legend={[{ label: "posterior", color: "var(--series-1)", kind: "line" }, ...(prior ? [{ label: "prior", color: "var(--text-2)", kind: "line" as const, dash: true }] : []), ...(ci ? [{ label: "95% credible interval", color: "var(--seq-2)" }] : [])]}
      marks={marks}
      ariaLabel={`Prior and posterior distribution of ${xLabel}`}
    />
  );
}

/**
 * A warning for tests that assume independent rows, shown when the rows of the table are
 * nested in recordings: many annotations from few recordings are not many observations.
 */
export function NestingNote({ ds }: { ds: Dataset }): ReactNode {
  const nesting = nestingOf(ds);
  if (!nesting || nesting.perGroup < 1.5) return null;
  const per = nesting.perGroup >= 10 ? Math.round(nesting.perGroup).toLocaleString("en-US") : fmtNumber(nesting.perGroup);
  return (
    <Callout kind="warning">
      The {ds.rowCount.toLocaleString("en-US")} rows of this table come from {nesting.groups.toLocaleString("en-US")} recording{nesting.groups === 1 ? "" : "s"} (about {per} each). This test treats every row as an independent
      observation; rows from the same recording usually resemble each other, and the evidence is then overstated — often by orders of magnitude. Aggregate to one row per recording or speaker (Data › Aggregate), or use the multilevel
      model with “{nesting.variable}” as grouping variable.
    </Callout>
  );
}

function fmtNumber(v: number): string {
  return String(Number(v.toPrecision(2)));
}

/** A note about rows that could not be used. */
export function DroppedNote({ dropped }: { dropped: number }): ReactNode {
  if (dropped <= 0) return null;
  return <p className="faint">{dropped} row{dropped === 1 ? " was" : "s were"} left out because of missing values.</p>;
}

const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";

function bfNumber(bf: number): string {
  if (bf < 1e5) return String(Number(bf.toPrecision(2)));
  const e = Math.round(Math.log10(bf));
  if (Math.abs(bf / Math.pow(10, e) - 1) < 0.01) return `10${String(e).replace(/\d/g, (d) => SUPERSCRIPT[Number(d)]!)}`;
  return bf.toExponential(0).replace("e+", "e");
}

/** Tick format for an axis that shows ln BF as a Bayes factor. */
export function bfTick(v: number): string {
  const bf = Math.exp(v);
  if (Math.abs(v) < 1e-9) return "1";
  return bf >= 1 ? bfNumber(bf) : `1/${bfNumber(1 / bf)}`;
}

/**
 * A y axis for ln BF with ticks at the conventional evidence thresholds (1/10, 1/3, 1, 3, 10, …).
 * The range always includes 1/3 … 3, so that fluctuations around "no evidence" look as small as they are.
 */
export function bfAxis(logBfs: Iterable<number>, label: string): AxisSpec {
  let lo = -Math.log(3);
  let hi = Math.log(3);
  for (const v of logBfs) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const pad = (hi - lo) * 0.07;
  const decades = (hi - lo) / Math.LN10;
  const ticks: number[] = [0];
  if (decades <= 5) {
    for (let e = 0; e <= 6; e++) for (const m of [3, 10]) ticks.push(Math.log(m) + e * Math.LN10, -(Math.log(m) + e * Math.LN10));
  } else {
    const step = Math.ceil(decades / 7);
    for (let e = step; e <= 400; e += step) ticks.push(e * Math.LN10, -e * Math.LN10);
  }
  return { type: "linear", domain: [lo - pad, hi + pad], label, format: bfTick, tickValues: ticks.sort((a, b) => a - b) };
}
