import { scaleBand, scaleLinear, scaleLog, type ScaleBand, type ScaleContinuousNumeric } from "d3-scale";
import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useWidth } from "../hooks.ts";
import { fmt } from "../kit.tsx";

/**
 * A small declarative chart component: two scales plus a list of marks. All analysis
 * views draw with it, so marks, axes, legends and tooltips look and behave the same
 * everywhere (thin marks, hairline grid, one axis per dimension, hover on every mark).
 */

export type Tip = string | { title?: string; rows?: [string, string][] };

export type AxisSpec =
  | { type: "linear"; domain?: [number, number]; zero?: boolean; nice?: boolean; label?: string; format?: (v: number) => string; ticks?: number; grid?: boolean }
  | { type: "log"; domain?: [number, number]; label?: string; format?: (v: number) => string; grid?: boolean }
  | { type: "band"; domain: string[]; label?: string; padding?: number };

type XY = number | string;

export type Mark =
  | { type: "rect"; data: { x0: number; x1: number; y0: number; y1: number; color?: string; tip?: Tip; onClick?: () => void }[]; color?: string; opacity?: number }
  | { type: "bar"; data: { x: XY; y: number; base?: number; color?: string; tip?: Tip; onClick?: () => void }[]; color?: string; horizontal?: boolean; group?: { index: number; count: number } }
  | { type: "line"; points: [number, number][]; color: string; width?: number; dash?: string; label?: string }
  | { type: "area"; points: [number, number, number][]; color: string; opacity?: number }
  | { type: "dot"; data: { x: XY; y: XY; color?: string; r?: number; tip?: Tip; onClick?: () => void; jitter?: number }[]; color?: string; r?: number; ring?: boolean; opacity?: number }
  | { type: "interval"; data: { x: XY; lo: number; hi: number; color?: string }[]; color?: string; horizontal?: boolean; width?: number; cap?: boolean }
  | { type: "rule"; x?: number; y?: number; color?: string; dash?: string; label?: string }
  | { type: "text"; data: { x: XY; y: XY; text: string; anchor?: "start" | "middle" | "end"; dx?: number; dy?: number }[] };

export interface LegendItem {
  label: string;
  color: string;
  kind?: "rect" | "line" | "dot";
  dash?: boolean;
}

export function Legend({ items }: { items: LegendItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="chart-legend">
      {items.map((it) => (
        <span className="key" key={it.label}>
          {it.kind === "line" ? (
            <span className="line-key" style={{ borderTopColor: it.color, borderTopStyle: it.dash ? "dashed" : "solid" }} />
          ) : (
            <span className="swatch" style={{ background: it.color, borderRadius: it.kind === "dot" ? "50%" : 2 }} />
          )}
          {it.label}
        </span>
      ))}
    </div>
  );
}

function TipBox({ tip, x, y }: { tip: Tip; x: number; y: number }) {
  // Keep the box inside the window.
  const left = Math.min(x + 14, window.innerWidth - 340);
  const top = Math.min(y + 14, window.innerHeight - 140);
  return (
    <div className="chart-tip" style={{ left: Math.max(4, left), top }} role="status">
      {typeof tip === "string" ? (
        tip
      ) : (
        <>
          {tip.title && <strong>{tip.title}</strong>}
          {tip.rows?.map(([k, v], i) => (
            <div className="tip-row" key={i}>
              <strong>{v}</strong>
              <span>{k}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

type AnyScale = ScaleContinuousNumeric<number, number> | ScaleBand<string>;

function isBand(s: AnyScale): s is ScaleBand<string> {
  return "bandwidth" in s;
}

function position(s: AnyScale, v: XY): number {
  if (isBand(s)) return (s(String(v)) ?? NaN) + s.bandwidth() / 2;
  return s(Number(v));
}

/** Data extent of all marks along one dimension. */
function extentOf(marks: Mark[], dim: "x" | "y"): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  const add = (v: unknown) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  };
  for (const m of marks) {
    switch (m.type) {
      case "rect":
        for (const d of m.data) {
          add(dim === "x" ? d.x0 : d.y0);
          add(dim === "x" ? d.x1 : d.y1);
        }
        break;
      case "bar":
        for (const d of m.data) {
          const valueDim = m.horizontal ? "x" : "y";
          if (dim === valueDim) {
            add(d.y);
            add(d.base ?? 0);
          } else add(d.x);
        }
        break;
      case "line":
        for (const p of m.points) add(dim === "x" ? p[0] : p[1]);
        break;
      case "area":
        for (const p of m.points) {
          if (dim === "x") add(p[0]);
          else {
            add(p[1]);
            add(p[2]);
          }
        }
        break;
      case "dot":
      case "text":
        for (const d of m.data) add(dim === "x" ? d.x : d.y);
        break;
      case "interval":
        for (const d of m.data) {
          const valueDim = m.horizontal ? "x" : "y";
          if (dim === valueDim) {
            add(d.lo);
            add(d.hi);
          } else add(d.x);
        }
        break;
      case "rule":
        add(dim === "x" ? m.x : m.y);
        break;
    }
  }
  if (lo === Infinity) return [0, 1];
  if (lo === hi) return [lo - 1, hi + 1];
  return [lo, hi];
}

function buildScale(spec: AxisSpec, marks: Mark[], dim: "x" | "y", range: [number, number]): AnyScale {
  if (spec.type === "band") return scaleBand<string>().domain(spec.domain).range(range).paddingInner(spec.padding ?? 0.25).paddingOuter((spec.padding ?? 0.25) / 2);
  const [lo, hi] = spec.domain ?? extentOf(marks, dim);
  if (spec.type === "log") {
    const l = lo > 0 ? lo : 1e-3;
    return scaleLog().domain([l, Math.max(hi, l * 10)]).range(range).nice();
  }
  let a = lo;
  let b = hi;
  if (!spec.domain) {
    if (spec.zero) {
      a = Math.min(0, a);
      b = Math.max(0, b);
    }
    // A little headroom so that marks do not touch the frame.
    const pad = (b - a) * 0.04;
    if (!(spec.zero && a === 0)) a -= pad;
    if (!(spec.zero && b === 0)) b += pad;
  }
  const s = scaleLinear().domain([a, b]).range(range);
  return spec.domain || spec.nice === false ? s : s.nice();
}

/** Path of a bar with a rounded data end and a square base. */
function barPath(x: number, y: number, w: number, h: number, horizontal: boolean, negative: boolean): string {
  const r = Math.min(4, w / 2, h / 2);
  if (r <= 0.5) return `M${x},${y}h${w}v${h}h${-w}z`;
  if (!horizontal) {
    return negative
      ? `M${x},${y}h${w}v${h - r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - 2 * r)}a${r},${r} 0 0 1 ${-r},${-r}z`
      : `M${x},${y + h}v${-(h - r)}a${r},${r} 0 0 1 ${r},${-r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}z`;
  }
  return negative
    ? `M${x + w},${y}v${h}h${-(w - r)}a${r},${r} 0 0 1 ${-r},${-r}v${-(h - 2 * r)}a${r},${r} 0 0 1 ${r},${-r}z`
    : `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export interface XYChartProps {
  x: AxisSpec;
  y: AxisSpec;
  marks: Mark[];
  height?: number;
  legend?: LegendItem[];
  /** For line charts: a vertical hairline that reads out every labelled line at the pointer. */
  crosshair?: boolean;
  /** Format of the x value in the crosshair read-out. */
  crosshairFormat?: (x: number) => string;
  ariaLabel: string;
  /** Extra SVG content drawn inside the plot area (receives the scales). */
  children?: (scales: { x: AnyScale; y: AnyScale; width: number; height: number }) => ReactNode;
}

export function XYChart({ x, y, marks, height = 260, legend, crosshair, crosshairFormat, ariaLabel, children }: XYChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<{ tip: Tip; x: number; y: number } | undefined>();
  const [cross, setCross] = useState<number | undefined>();
  const svgRef = useRef<SVGSVGElement | null>(null);

  const layout = useMemo(() => {
    const w = Math.max(width, 160);
    // Left margin from the widest y tick label.
    let left = 44;
    if (y.type === "band") left = Math.min(180, 14 + Math.max(...y.domain.map((d) => truncate(d, 26).length), 3) * 6.3);
    if (y.label) left += 16;
    const bandX = x.type === "band" ? x.domain : undefined;
    const slot = bandX ? (w - left - 12) / Math.max(bandX.length, 1) : Infinity;
    const longest = bandX ? Math.max(...bandX.map((d) => truncate(d, 22).length), 1) * 6.2 : 0;
    const rotate = !!bandX && longest > slot - 4;
    const bottom = (rotate ? Math.min(92, 16 + longest * 0.62) : 22) + (x.label ? 18 : 0);
    const top = 10;
    const right = 14;
    const pw = Math.max(40, w - left - right);
    const ph = Math.max(40, height - top - bottom);
    const xs = buildScale(x, marks, "x", [0, pw]);
    const ys = buildScale(y, marks, "y", y.type === "band" ? [0, ph] : [ph, 0]);
    return { w, left, top, right, bottom, pw, ph, xs, ys, rotate };
  }, [width, height, x, y, marks]);
  const { w, left, top, pw, ph, xs, ys, rotate } = layout;

  const show = useCallback((t: Tip | undefined, e: ReactPointerEvent) => {
    if (t === undefined) setTip(undefined);
    else setTip({ tip: t, x: e.clientX, y: e.clientY });
  }, []);

  const xTicks = isBand(xs) ? [] : xs.ticks(Math.max(2, Math.min(10, Math.floor(pw / 78))));
  const yTicks = isBand(ys) ? [] : ys.ticks(Math.max(2, Math.min(8, Math.floor(ph / 38))));
  const xFmt = x.type !== "band" && x.format ? x.format : (v: number) => (isBand(xs) ? String(v) : xs.tickFormat(8)(v));
  const yFmt = y.type !== "band" && y.format ? y.format : (v: number) => (isBand(ys) ? String(v) : ys.tickFormat(6)(v));
  const lines = marks.filter((m): m is Extract<Mark, { type: "line" }> => m.type === "line" && !!m.label);

  const onMove = (e: ReactPointerEvent<SVGRectElement>) => {
    if (!crosshair || isBand(xs) || lines.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const xv = xs.invert(px);
    // Snap to the nearest data position of the first line.
    let best = lines[0]!.points[0]?.[0] ?? xv;
    let bestD = Infinity;
    for (const p of lines[0]!.points) {
      const d = Math.abs(p[0] - xv);
      if (d < bestD) {
        bestD = d;
        best = p[0];
      }
    }
    setCross(best);
    const rows: [string, string][] = lines.map((l) => {
      let near = l.points[0];
      let dist = Infinity;
      for (const p of l.points) {
        const d = Math.abs(p[0] - best);
        if (d < dist) {
          dist = d;
          near = p;
        }
      }
      return [l.label!, near ? fmt(near[1]) : "–"];
    });
    setTip({ tip: { title: crosshairFormat ? crosshairFormat(best) : fmt(best), rows }, x: e.clientX, y: e.clientY });
  };

  const body: ReactNode[] = [];
  marks.forEach((m, mi) => {
    switch (m.type) {
      case "rect": {
        if (isBand(xs) || isBand(ys)) break;
        m.data.forEach((d, i) => {
          const x0 = xs(d.x0);
          const x1 = xs(d.x1);
          const y0 = ys(d.y0);
          const y1 = ys(d.y1);
          const rw = Math.max(0.5, Math.abs(x1 - x0) - 1);
          body.push(
            <rect
              key={`${mi}-${i}`} x={Math.min(x0, x1) + 0.5} y={Math.min(y0, y1)} width={rw} height={Math.abs(y1 - y0)}
              rx={Math.min(2, rw / 2)} style={{ fill: d.color ?? m.color ?? "var(--series-1)", opacity: m.opacity ?? 1, cursor: d.onClick ? "pointer" : undefined }}
              onPointerMove={d.tip ? (e) => show(d.tip, e) : undefined} onPointerLeave={d.tip ? (e) => show(undefined, e) : undefined} onClick={d.onClick}
            />,
          );
        });
        break;
      }
      case "bar": {
        const cat = m.horizontal ? ys : xs;
        const val = m.horizontal ? xs : ys;
        if (!isBand(cat) || isBand(val)) break;
        const bw = cat.bandwidth();
        const count = m.group?.count ?? 1;
        const thick = Math.max(1, Math.min(24, (bw - (count - 1) * 2) / count));
        const totalW = thick * count + (count - 1) * 2;
        m.data.forEach((d, i) => {
          const c0 = cat(String(d.x));
          if (c0 === undefined) return;
          const start = c0 + (bw - totalW) / 2 + (m.group?.index ?? 0) * (thick + 2);
          const v0 = val(d.base ?? 0);
          const v1 = val(d.y);
          const neg = d.y < (d.base ?? 0);
          const len = Math.abs(v1 - v0);
          const path = m.horizontal
            ? barPath(Math.min(v0, v1), start, len, thick, true, neg)
            : barPath(start, Math.min(v0, v1), thick, len, false, neg);
          const handlers = { onPointerMove: d.tip ? (e: ReactPointerEvent) => show(d.tip, e) : undefined, onPointerLeave: d.tip ? (e: ReactPointerEvent) => show(undefined, e) : undefined, onClick: d.onClick };
          body.push(<path key={`${mi}-${i}`} d={path} style={{ fill: d.color ?? m.color ?? "var(--series-1)" }} />);
          // The hit area covers the whole slot, not just the painted bar.
          body.push(
            m.horizontal
              ? <rect key={`${mi}-${i}-hit`} x={0} y={c0} width={pw} height={bw} style={{ fill: "transparent", cursor: d.onClick ? "pointer" : undefined }} {...handlers} />
              : <rect key={`${mi}-${i}-hit`} x={start - 1} y={0} width={thick + 2} height={ph} style={{ fill: "transparent", cursor: d.onClick ? "pointer" : undefined }} {...handlers} />,
          );
        });
        break;
      }
      case "line": {
        const pts = m.points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (pts.length === 0) break;
        const dAttr = pts.map((p, i) => `${i ? "L" : "M"}${position(xs, p[0]).toFixed(1)},${position(ys, p[1]).toFixed(1)}`).join("");
        body.push(<path key={mi} d={dAttr} fill="none" strokeLinejoin="round" strokeLinecap="round" style={{ stroke: m.color, strokeWidth: m.width ?? 2, strokeDasharray: m.dash }} />);
        break;
      }
      case "area": {
        const pts = m.points.filter((p) => p.every(Number.isFinite));
        if (pts.length === 0) break;
        const up = pts.map((p, i) => `${i ? "L" : "M"}${position(xs, p[0]).toFixed(1)},${position(ys, p[2]).toFixed(1)}`).join("");
        const down = [...pts].reverse().map((p) => `L${position(xs, p[0]).toFixed(1)},${position(ys, p[1]).toFixed(1)}`).join("");
        body.push(<path key={mi} d={`${up}${down}Z`} style={{ fill: m.color, opacity: m.opacity ?? 0.14 }} />);
        break;
      }
      case "dot": {
        m.data.forEach((d, i) => {
          const cx = position(xs, d.x) + (d.jitter ?? 0);
          const cy = position(ys, d.y);
          if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
          const r = d.r ?? m.r ?? 4;
          body.push(
            <circle key={`${mi}-${i}`} cx={cx} cy={cy} r={r} style={{ fill: d.color ?? m.color ?? "var(--series-1)", stroke: m.ring === false ? "none" : "var(--surface)", strokeWidth: m.ring === false ? 0 : 1.5, opacity: m.opacity ?? 1 }} />,
          );
          if (d.tip || d.onClick) {
            body.push(
              <circle
                key={`${mi}-${i}-hit`} cx={cx} cy={cy} r={Math.max(r + 4, 10)} style={{ fill: "transparent", cursor: d.onClick ? "pointer" : undefined }}
                onPointerMove={d.tip ? (e) => show(d.tip, e) : undefined} onPointerLeave={d.tip ? (e) => show(undefined, e) : undefined} onClick={d.onClick}
              />,
            );
          }
        });
        break;
      }
      case "interval": {
        m.data.forEach((d, i) => {
          const c = position(m.horizontal ? ys : xs, d.x);
          const val = m.horizontal ? xs : ys;
          if (isBand(val) || !Number.isFinite(c)) return;
          const a = val(d.lo);
          const b = val(d.hi);
          const st = { stroke: d.color ?? m.color ?? "var(--text-2)", strokeWidth: m.width ?? 1.5 };
          const cap = m.cap ? 4 : 0;
          body.push(
            m.horizontal
              ? <g key={`${mi}-${i}`} style={st}><line x1={a} x2={b} y1={c} y2={c} />{cap > 0 && <><line x1={a} x2={a} y1={c - cap} y2={c + cap} /><line x1={b} x2={b} y1={c - cap} y2={c + cap} /></>}</g>
              : <g key={`${mi}-${i}`} style={st}><line x1={c} x2={c} y1={a} y2={b} />{cap > 0 && <><line x1={c - cap} x2={c + cap} y1={a} y2={a} /><line x1={c - cap} x2={c + cap} y1={b} y2={b} /></>}</g>,
          );
        });
        break;
      }
      case "rule": {
        const st = { stroke: m.color ?? "var(--text-3)", strokeWidth: 1, strokeDasharray: m.dash };
        if (m.x !== undefined && !isBand(xs)) {
          const px = xs(m.x);
          body.push(<g key={mi}><line x1={px} x2={px} y1={0} y2={ph} style={st} />{m.label && <text className="mark-label" x={px + 4} y={10}>{m.label}</text>}</g>);
        }
        if (m.y !== undefined && !isBand(ys)) {
          const py = ys(m.y);
          body.push(<g key={`${mi}y`}><line x1={0} x2={pw} y1={py} y2={py} style={st} />{m.label && <text className="mark-label" x={pw - 2} y={py - 4} textAnchor="end">{m.label}</text>}</g>);
        }
        break;
      }
      case "text": {
        m.data.forEach((d, i) => {
          const px = position(xs, d.x);
          const py = position(ys, d.y);
          if (!Number.isFinite(px) || !Number.isFinite(py)) return;
          body.push(<text key={`${mi}-${i}`} className="mark-label" x={px + (d.dx ?? 0)} y={py + (d.dy ?? 0)} textAnchor={d.anchor ?? "middle"}>{d.text}</text>);
        });
        break;
      }
    }
  });

  return (
    <div className="chart" ref={ref}>
      {legend && <Legend items={legend} />}
      {width > 0 && (
        <svg ref={svgRef} width={w} height={height} role="img" aria-label={ariaLabel}>
          <g transform={`translate(${left},${top})`}>
            {/* grid and axes */}
            {yTicks.map((t) => (
              <line key={`gy${t}`} className="gridline" x1={0} x2={pw} y1={(ys as ScaleContinuousNumeric<number, number>)(t)} y2={(ys as ScaleContinuousNumeric<number, number>)(t)} />
            ))}
            {x.type !== "band" && x.grid && xTicks.map((t) => (
              <line key={`gx${t}`} className="gridline" y1={0} y2={ph} x1={(xs as ScaleContinuousNumeric<number, number>)(t)} x2={(xs as ScaleContinuousNumeric<number, number>)(t)} />
            ))}
            <line className="baseline" x1={0} x2={pw} y1={ph} y2={ph} />
            <g className="axis">
              {yTicks.map((t) => (
                <text key={`ty${t}`} x={-8} y={(ys as ScaleContinuousNumeric<number, number>)(t)} dy="0.32em" textAnchor="end">{yFmt(t)}</text>
              ))}
              {isBand(ys) && ys.domain().map((d) => (
                <text key={`by${d}`} x={-8} y={(ys(d) ?? 0) + ys.bandwidth() / 2} dy="0.32em" textAnchor="end"><title>{d}</title>{truncate(d, 26)}</text>
              ))}
              {xTicks.map((t) => (
                <text key={`tx${t}`} x={(xs as ScaleContinuousNumeric<number, number>)(t)} y={ph + 15} textAnchor="middle">{xFmt(t)}</text>
              ))}
              {isBand(xs) && xs.domain().map((d) => {
                const cx = (xs(d) ?? 0) + xs.bandwidth() / 2;
                return rotate
                  ? <text key={`bx${d}`} transform={`translate(${cx},${ph + 12}) rotate(-38)`} textAnchor="end"><title>{d}</title>{truncate(d, 22)}</text>
                  : <text key={`bx${d}`} x={cx} y={ph + 15} textAnchor="middle"><title>{d}</title>{truncate(d, 22)}</text>;
              })}
            </g>
            {x.label && <text className="axis-title" x={pw / 2} y={height - top - 5} textAnchor="middle">{x.label}</text>}
            {y.label && <text className="axis-title" transform={`translate(${-left + 12},${ph / 2}) rotate(-90)`} textAnchor="middle">{y.label}</text>}
            {body}
            {children?.({ x: xs, y: ys, width: pw, height: ph })}
            {crosshair && cross !== undefined && !isBand(xs) && <line x1={xs(cross)} x2={xs(cross)} y1={0} y2={ph} style={{ stroke: "var(--text-3)", strokeWidth: 1 }} />}
            {crosshair && (
              <rect x={0} y={0} width={pw} height={ph} style={{ fill: "transparent" }} onPointerMove={onMove} onPointerLeave={() => { setCross(undefined); setTip(undefined); }} />
            )}
          </g>
        </svg>
      )}
      {tip && <TipBox {...tip} />}
    </div>
  );
}
