import type { ReactNode } from "react";
import { column, levelsOf, type Dataset } from "../../core/data/dataset.ts";
import { evidenceLabel } from "../../core/stats/bayes/proportions.ts";
import { XYChart, type Mark } from "../charts/XYChart.tsx";
import { fmtBf } from "../kit.tsx";

/** Variables of a dataset, optionally of one type only. */
export function variableOptions(ds: Dataset, type?: "number" | "string", none?: string): { value: string; label: string }[] {
  const cols = ds.columns.filter((c) => !type || c.type === type);
  return [...(none !== undefined ? [{ value: "", label: none }] : []), ...cols.map((c) => ({ value: c.name, label: c.name }))];
}

/** Variables that can define groups: text variables, and numeric ones with few distinct values. */
export function groupingOptions(ds: Dataset, none?: string): { value: string; label: string }[] {
  const out = none !== undefined ? [{ value: "", label: none }] : [];
  for (const c of ds.columns) {
    if (c.type === "string") {
      const k = new Set(c.values).size;
      if (k >= 2 && k <= Math.max(60, ds.rowCount / 2)) out.push({ value: c.name, label: `${c.name} (${k} groups)` });
    } else {
      const k = new Set(Array.from(c.values).filter((v) => !Number.isNaN(v))).size;
      if (k >= 2 && k <= 8) out.push({ value: c.name, label: `${c.name} (${k} values)` });
    }
  }
  return out;
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

/** A note about rows that could not be used. */
export function DroppedNote({ dropped }: { dropped: number }): ReactNode {
  if (dropped <= 0) return null;
  return <p className="faint">{dropped} row{dropped === 1 ? " was" : "s were"} left out because of missing values.</p>;
}

export const BF_THRESHOLDS: { y: number; label: string }[] = [
  { y: Math.log(3), label: "3" },
  { y: Math.log(10), label: "10" },
  { y: -Math.log(3), label: "1/3" },
  { y: -Math.log(10), label: "1/10" },
];

/** Tick format for an axis that shows ln BF as a Bayes factor. */
export function bfTick(v: number): string {
  const bf = Math.exp(v);
  if (bf >= 1) return bf >= 1000 ? bf.toExponential(0).replace("e+", "e") : String(Number(bf.toPrecision(2)));
  const inv = 1 / bf;
  return inv >= 1000 ? `1/${inv.toExponential(0).replace("e+", "e")}` : `1/${Number(inv.toPrecision(2))}`;
}
