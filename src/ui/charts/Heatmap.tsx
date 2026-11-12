import { useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useThemeColors, useWidth } from "../hooks.ts";
import type { Tip } from "./XYChart.tsx";

const TOKENS = ["seq-1", "seq-7", "div-neg", "div-mid", "div-pos", "text", "surface", "surface-2"] as const;

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function mix(a: string, b: string, t: number): [number, number, number] {
  const pa = parseHex(a);
  const pb = parseHex(b);
  return [0, 1, 2].map((i) => Math.round(pa[i]! + (pb[i]! - pa[i]!) * t)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export interface HeatmapProps {
  rows: string[];
  cols: string[];
  /** values[r][c]; NaN draws an empty cell. */
  values: number[][];
  /** "sequential": 0 … max in one hue; "diverging": around zero in two hues. */
  mode: "sequential" | "diverging";
  /** Text inside a cell (shown when it fits). */
  cellText?: (r: number, c: number) => string;
  tip?: (r: number, c: number) => Tip;
  onCell?: (r: number, c: number) => void;
  rowLabel?: string;
  colLabel?: string;
  /** Largest absolute value of the colour scale (default: from the data). */
  max?: number;
  ariaLabel: string;
  legendLabel?: string;
}

/** A matrix of coloured cells with labelled rows and columns and a scale legend. */
export function Heatmap({ rows, cols, values, mode, cellText, tip, onCell, rowLabel, colLabel, max, ariaLabel, legendLabel }: HeatmapProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const colors = useThemeColors(TOKENS);
  const [hover, setHover] = useState<{ tip: Tip; x: number; y: number; r: number; c: number } | undefined>();
  const layout = useMemo(() => {
    const labelW = Math.min(170, 16 + Math.max(...rows.map((r) => Math.min(r.length, 24)), 4) * 6.4) + (rowLabel ? 16 : 0);
    const avail = Math.max(120, width - labelW - 8);
    const cell = Math.max(18, Math.min(64, Math.floor(avail / Math.max(cols.length, 1))));
    const cellH = Math.max(20, Math.min(34, cell));
    const longest = Math.max(...cols.map((c) => Math.min(c.length, 20)), 1) * 6.2;
    const rotate = longest > cell - 4;
    const top = (rotate ? Math.min(100, 12 + longest * 0.7) : 20) + (colLabel ? 16 : 0);
    return { labelW, cell, cellH, rotate, top };
  }, [width, rows, cols, rowLabel, colLabel]);
  const vmax = useMemo(() => {
    if (max !== undefined) return max;
    let m = 0;
    for (const row of values) for (const v of row) if (Number.isFinite(v) && Math.abs(v) > m) m = Math.abs(v);
    return m || 1;
  }, [values, max]);
  const fill = (v: number): [number, number, number] => {
    if (mode === "sequential") return mix(colors["seq-1"], colors["seq-7"], Math.min(1, Math.max(0, v / vmax)));
    const t = Math.min(1, Math.abs(v) / vmax);
    return mix(colors["div-mid"], v >= 0 ? colors["div-pos"] : colors["div-neg"], t);
  };
  const { labelW, cell, cellH, rotate, top } = layout;
  const w = labelW + cols.length * cell + 8;
  const h = top + rows.length * cellH + 34;
  const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const legendW = Math.min(180, cols.length * cell);
  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <div style={{ overflowX: "auto" }}>
          <svg width={w} height={h} role="img" aria-label={ariaLabel}>
            {colLabel && <text className="axis-title" x={labelW + (cols.length * cell) / 2} y={11} textAnchor="middle">{colLabel}</text>}
            {rowLabel && <text className="axis-title" transform={`translate(11,${top + (rows.length * cellH) / 2}) rotate(-90)`} textAnchor="middle">{rowLabel}</text>}
            <g className="axis">
              {cols.map((c, ci) => {
                const cx = labelW + ci * cell + cell / 2;
                return rotate
                  ? <text key={ci} transform={`translate(${cx + 3},${top - 6}) rotate(-45)`} textAnchor="start"><title>{c}</title>{trunc(c, 20)}</text>
                  : <text key={ci} x={cx} y={top - 6} textAnchor="middle"><title>{c}</title>{trunc(c, 20)}</text>;
              })}
              {rows.map((r, ri) => (
                <text key={ri} x={labelW - 8} y={top + ri * cellH + cellH / 2} dy="0.32em" textAnchor="end"><title>{r}</title>{trunc(r, 24)}</text>
              ))}
            </g>
            {rows.map((_, ri) =>
              cols.map((__, ci) => {
                const v = values[ri]?.[ci] ?? NaN;
                const x = labelW + ci * cell;
                const y = top + ri * cellH;
                const rgb = Number.isFinite(v) ? fill(v) : undefined;
                const text = cellText?.(ri, ci) ?? "";
                const fits = text.length * 6.4 < cell - 6;
                const isHover = hover?.r === ri && hover.c === ci;
                const handlers = {
                  onPointerMove: (e: ReactPointerEvent) => tip && setHover({ tip: tip(ri, ci), x: e.clientX, y: e.clientY, r: ri, c: ci }),
                  onPointerLeave: () => setHover(undefined),
                  onClick: onCell ? () => onCell(ri, ci) : undefined,
                };
                return (
                  <g key={`${ri}-${ci}`} style={{ cursor: onCell ? "pointer" : undefined }} {...handlers}>
                    <rect x={x + 1} y={y + 1} width={cell - 2} height={cellH - 2} rx={3}
                      style={{ fill: rgb ? `rgb(${rgb.join(",")})` : "var(--surface-2)", stroke: isHover ? "var(--text)" : "none", strokeWidth: 1.5 }} />
                    {rgb && fits && (
                      <text x={x + cell / 2} y={y + cellH / 2} dy="0.32em" textAnchor="middle"
                        style={{ fill: luminance(rgb) > 0.4 ? "#0b0b0b" : "#ffffff", fontSize: 11, fontVariantNumeric: "tabular-nums", pointerEvents: "none" }}>
                        {text}
                      </text>
                    )}
                  </g>
                );
              }),
            )}
            {/* scale legend */}
            <g transform={`translate(${labelW},${top + rows.length * cellH + 10})`}>
              {Array.from({ length: 24 }, (_, i) => {
                const t = i / 23;
                const v = mode === "sequential" ? t * vmax : (t * 2 - 1) * vmax;
                return <rect key={i} x={(i * legendW) / 24} y={0} width={legendW / 24 + 0.5} height={7} style={{ fill: `rgb(${fill(v).join(",")})` }} />;
              })}
              <text className="tick-label" x={0} y={19} textAnchor="start">{mode === "sequential" ? "0" : `−${formatScale(vmax)}`}</text>
              <text className="tick-label" x={legendW} y={19} textAnchor="end">{formatScale(vmax)}</text>
              {legendLabel && <text className="tick-label" x={legendW + 8} y={8}>{legendLabel}</text>}
            </g>
          </svg>
        </div>
      )}
      {hover && (
        <div className="chart-tip" style={{ left: Math.max(4, Math.min(hover.x + 14, window.innerWidth - 340)), top: Math.min(hover.y + 14, window.innerHeight - 140) }}>
          {typeof hover.tip === "string" ? hover.tip : (
            <>
              {hover.tip.title && <strong>{hover.tip.title}</strong>}
              {hover.tip.rows?.map(([k, v], i) => <div className="tip-row" key={i}><strong>{v}</strong><span>{k}</span></div>)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function formatScale(v: number): string {
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}
