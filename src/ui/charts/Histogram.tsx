import { useMemo } from "react";
import { fmt } from "../kit.tsx";
import { XYChart, type LegendItem, type Mark } from "./XYChart.tsx";

export interface HistBin {
  x0: number;
  x1: number;
  n: number;
}

/** Bins with a "nice" width covering the central part of the data (outliers are clipped into the end bins). */
export function binValues(values: ArrayLike<number>, opts: { bins?: number; trim?: number; lo?: number; hi?: number; log?: boolean } = {}): HistBin[] {
  const xs: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = opts.log ? Math.log10(values[i]!) : values[i]!;
    if (Number.isFinite(v)) xs.push(v);
  }
  if (xs.length === 0) return [];
  xs.sort((a, b) => a - b);
  const trim = opts.trim ?? 0.005;
  let lo = opts.lo ?? xs[Math.floor(trim * (xs.length - 1))]!;
  let hi = opts.hi ?? xs[Math.ceil((1 - trim) * (xs.length - 1))]!;
  if (hi <= lo) {
    lo -= 0.5;
    hi += 0.5;
  }
  const k = opts.bins ?? Math.max(8, Math.min(50, Math.round(Math.sqrt(xs.length) * 1.2)));
  const raw = (hi - lo) / k;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw * 0.999) ?? raw;
  const start = Math.floor(lo / step) * step;
  const n = Math.max(1, Math.ceil((hi - start) / step - 1e-9));
  const counts = new Array<number>(n).fill(0);
  for (const v of xs) {
    const b = Math.min(n - 1, Math.max(0, Math.floor((v - start) / step)));
    counts[b]!++;
  }
  return counts.map((c, i) => ({ x0: start + i * step, x1: start + (i + 1) * step, n: c }));
}

/** Histogram of one or several groups (groups are drawn as outlines on a shared axis). */
export function Histogram({ series, xLabel, yLabel = "count", height = 240, log, markers, format }: {
  series: { label: string; values: ArrayLike<number>; color?: string }[];
  xLabel: string;
  yLabel?: string;
  height?: number;
  /** Bin on a log10 scale (for durations and other right-skewed quantities). */
  log?: boolean;
  markers?: { x: number; label: string }[];
  format?: (v: number) => string;
}) {
  const { marks, legend } = useMemo(() => {
    const all: number[] = [];
    for (const s of series) for (let i = 0; i < s.values.length; i++) all.push(s.values[i]!);
    const base = binValues(all, log ? { log: true } : {});
    const marks: Mark[] = [];
    const legend: LegendItem[] = [];
    if (base.length === 0) return { marks, legend };
    const lo = base[0]!.x0;
    const hi = base[base.length - 1]!.x1;
    const f = format ?? ((v: number) => fmt(v));
    const show = (v: number) => (log ? f(Math.pow(10, v)) : f(v));
    if (series.length === 1) {
      const color = series[0]!.color ?? "var(--series-1)";
      marks.push({ type: "rect", color, data: base.map((b) => ({ x0: b.x0, x1: b.x1, y0: 0, y1: b.n, tip: { title: `${show(b.x0)} – ${show(b.x1)}`, rows: [[yLabel, String(b.n)]] } })) });
    } else {
      // Several groups: share of each group per bin, as step lines, so that groups of different size compare.
      series.forEach((s, si) => {
        const color = s.color ?? `var(--series-${(si % 8) + 1})`;
        const bins = binValues(s.values, { lo, hi, bins: base.length, trim: 0, ...(log ? { log: true } : {}) });
        const total = bins.reduce((a, b) => a + b.n, 0) || 1;
        const pts: [number, number][] = [];
        for (const b of bins) {
          pts.push([b.x0, b.n / total], [b.x1, b.n / total]);
        }
        marks.push({ type: "line", points: pts, color, label: s.label, width: 2 });
        legend.push({ label: `${s.label} (n = ${total})`, color, kind: "line" });
      });
    }
    for (const m of markers ?? []) marks.push({ type: "rule", x: log ? Math.log10(m.x) : m.x, label: m.label, color: "var(--text-2)" });
    return { marks, legend };
  }, [series, log, markers, yLabel, format]);
  if (marks.length === 0) return null;
  const f = format ?? ((v: number) => fmt(v));
  return (
    <XYChart
      height={height}
      x={{ type: "linear", label: log ? `${xLabel} (log scale)` : xLabel, format: (v) => (log ? f(Number(Math.pow(10, v).toPrecision(2))) : f(v)), nice: false }}
      y={{ type: "linear", zero: true, label: series.length === 1 ? yLabel : "share of group", ...(series.length > 1 ? { format: (v: number) => `${Math.round(v * 100)}%` } : {}) }}
      marks={marks}
      {...(legend.length ? { legend } : {})}
      crosshair={series.length > 1}
      crosshairFormat={(v) => (log ? f(Math.pow(10, v)) : f(v))}
      ariaLabel={`Distribution of ${xLabel}`}
    />
  );
}
