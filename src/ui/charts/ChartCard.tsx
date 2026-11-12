import { useRef, useState, type ReactNode } from "react";
import { Button, downloadText, fmt } from "../kit.tsx";

/** Serialise an SVG element with all colours and fonts resolved, so that it looks the same outside the app. */
export function serializeSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = svg.querySelectorAll("*");
  const dst = clone.querySelectorAll("*");
  const props = ["fill", "stroke", "stroke-width", "stroke-dasharray", "opacity", "font-size", "font-family", "font-weight", "text-anchor"];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const target = dst[i] as SVGElement;
    for (const p of props) {
      const v = cs.getPropertyValue(p);
      if (v) target.style.setProperty(p, v);
    }
  });
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const w = svg.getAttribute("width") ?? String(svg.clientWidth);
  const h = svg.getAttribute("height") ?? String(svg.clientHeight);
  clone.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("width", "100%");
  bg.setAttribute("height", "100%");
  bg.setAttribute("fill", getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || "#ffffff");
  clone.insertBefore(bg, clone.firstChild);
  return new XMLSerializer().serializeToString(clone);
}

function exportPng(svg: SVGSVGElement, name: string): void {
  const text = serializeSvg(svg);
  const img = new Image();
  const w = svg.clientWidth || Number(svg.getAttribute("width")) || 600;
  const h = svg.clientHeight || Number(svg.getAttribute("height")) || 300;
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = w * 2;
    canvas.height = h * 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0, w, h);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
}

export interface ChartTable {
  columns: string[];
  rows: (string | number)[][];
}

/**
 * A card around a chart with the standard tools: switch to a table of the plotted
 * values (so that nothing is readable by colour or hover alone) and export as SVG / PNG.
 */
export function ChartCard({ title, sub, table, children, exportName, actions }: { title: ReactNode; sub?: ReactNode; table?: ChartTable; children: ReactNode; exportName?: string; actions?: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  const body = useRef<HTMLDivElement | null>(null);
  const name = exportName ?? (typeof title === "string" ? title.replace(/[^\w.-]+/g, "_") : "chart");
  const svg = () => body.current?.querySelector("svg") as SVGSVGElement | null;
  return (
    <section className="card">
      <div className="card-head">
        <h3>{title}</h3>
        <div className="sub">{sub}</div>
        <div className="chart-tools">
          {actions}
          {table && (
            <Button small kind="ghost" icon={asTable ? "chart" : "table"} onClick={() => setAsTable(!asTable)} title={asTable ? "Show the chart" : "Show the values as a table"}>
              {asTable ? "Chart" : "Table"}
            </Button>
          )}
          {!asTable && (
            <>
              <Button small kind="ghost" icon="download" title="Download as SVG (vector)" onClick={() => { const s = svg(); if (s) downloadText(`${name}.svg`, serializeSvg(s), "image/svg+xml"); }}>
                SVG
              </Button>
              <Button small kind="ghost" title="Download as PNG (image)" onClick={() => { const s = svg(); if (s) exportPng(s, name); }}>
                PNG
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="card-body" ref={body}>
        {asTable && table ? (
          <div className="table-wrap" style={{ maxHeight: 320 }}>
            <table className="data">
              <thead>
                <tr>{table.columns.map((c, i) => <th key={i} className={i > 0 ? "n" : ""}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => (
                  <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === "number" ? "n" : ""}>{typeof v === "number" ? fmt(v) : v}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
