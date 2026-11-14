import { useMemo } from "react";
import { mean, sd } from "../../core/stats/describe.ts";
import { tInv } from "../../core/stats/distributions.ts";
import { fmt } from "../kit.tsx";
import { XYChart, type Mark } from "./XYChart.tsx";

export interface Group {
  label: string;
  values: number[];
  color?: string;
  /** Optional label per value, shown on hover. */
  names?: string[];
}

/** Deterministic horizontal jitter so that points do not jump between renders. */
function jitter(i: number, spread: number): number {
  const u = Math.sin((i + 1) * 12.9898) * 43758.5453;
  return ((u - Math.floor(u)) - 0.5) * spread;
}

/**
 * Every observation as a dot, with the group mean and its 95% credible interval
 * (reference prior, each group on its own). Shows the data behind a group comparison.
 */
export function GroupChart({ groups, yLabel, xLabel, height = 260, zero }: { groups: Group[]; yLabel: string; xLabel?: string; height?: number; zero?: boolean }) {
  const marks = useMemo<Mark[]>(() => {
    const dots: Extract<Mark, { type: "dot" }>["data"] = [];
    const intervals: Extract<Mark, { type: "interval" }>["data"] = [];
    const means: Extract<Mark, { type: "dot" }>["data"] = [];
    groups.forEach((g, gi) => {
      const color = g.color ?? `var(--series-${(gi % 8) + 1})`;
      const vals = g.values.filter((v) => Number.isFinite(v));
      const n = vals.length;
      vals.forEach((v, i) => {
        dots.push({ x: g.label, y: v, color, jitter: jitter(i + gi * 131, Math.min(26, 6 + n)), tip: { title: g.names?.[i] ?? g.label, rows: [[yLabel, fmt(v)]] } });
      });
      if (n >= 1) {
        const m = mean(vals);
        if (n >= 2) {
          const half = (tInv(0.975, n - 1) * sd(vals)) / Math.sqrt(n);
          intervals.push({ x: g.label, lo: m - half, hi: m + half });
          means.push({ x: g.label, y: m, color: "var(--text)", r: 4.5, tip: { title: g.label, rows: [["mean", fmt(m)], ["95% credible interval", `${fmt(m - half)} – ${fmt(m + half)}`], ["n", String(n)]] } });
        } else means.push({ x: g.label, y: m, color: "var(--text)", r: 4.5 });
      }
    });
    return [
      { type: "dot", data: dots, r: 3.5, opacity: 0.75 },
      { type: "interval", data: intervals, color: "var(--text)", width: 2, cap: true },
      { type: "dot", data: means },
    ];
  }, [groups, yLabel]);
  const y = zero ? { type: "linear" as const, label: yLabel, zero: true } : { type: "linear" as const, label: yLabel };
  const x = xLabel ? { type: "band" as const, domain: groups.map((g) => g.label), label: xLabel, padding: 0.4 } : { type: "band" as const, domain: groups.map((g) => g.label), padding: 0.4 };
  return <XYChart height={height} x={x} y={y} marks={marks} ariaLabel={`${yLabel} by group: individual values, group means and 95% credible intervals`} />;
}
