/**
 * A dataset is a small column-oriented table: the common currency between the analysis
 * modules (which produce datasets) and the statistics lab (which consumes them).
 */

export type ColumnType = "number" | "string";

export interface NumberColumn {
  name: string;
  type: "number";
  values: Float64Array;
  /** Short explanation shown in the variable view. */
  label?: string;
}

export interface StringColumn {
  name: string;
  type: "string";
  values: string[];
  label?: string;
}

export type Column = NumberColumn | StringColumn;

export interface Dataset {
  id: string;
  name: string;
  /** What one row stands for, e.g. "one annotation". */
  unit: string;
  description: string;
  columns: Column[];
  rowCount: number;
}

export type Cell = number | string;
export type Row = Record<string, Cell>;

let datasetCounter = 0;

/** Build a dataset from row objects; column types are taken from `types` or inferred. */
export function datasetFromRows(
  name: string,
  unit: string,
  description: string,
  rows: Row[],
  spec: { name: string; type?: ColumnType; label?: string }[],
): Dataset {
  const columns: Column[] = spec.map((s) => {
    const type: ColumnType = s.type ?? (rows.some((r) => typeof r[s.name] === "string") ? "string" : "number");
    if (type === "number") {
      const values = new Float64Array(rows.length);
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i]![s.name];
        values[i] = typeof v === "number" ? v : v === undefined || v === "" ? NaN : Number(v);
      }
      const col: NumberColumn = { name: s.name, type, values };
      if (s.label) col.label = s.label;
      return col;
    }
    const values = rows.map((r) => {
      const v = r[s.name];
      return v === undefined ? "" : String(v);
    });
    const col: StringColumn = { name: s.name, type, values };
    if (s.label) col.label = s.label;
    return col;
  });
  return { id: `ds${++datasetCounter}`, name, unit, description, columns, rowCount: rows.length };
}

export function column(ds: Dataset, name: string): Column | undefined {
  return ds.columns.find((c) => c.name === name);
}

export function numberColumn(ds: Dataset, name: string): Float64Array {
  const c = column(ds, name);
  if (!c) throw new Error(`The dataset has no variable "${name}".`);
  if (c.type === "number") return c.values;
  return Float64Array.from(c.values, (v) => (v.trim() === "" ? NaN : Number(v)));
}

export function stringColumn(ds: Dataset, name: string): string[] {
  const c = column(ds, name);
  if (!c) throw new Error(`The dataset has no variable "${name}".`);
  if (c.type === "string") return c.values;
  return Array.from(c.values, (v) => (Number.isNaN(v) ? "" : formatNumber(v)));
}

/** Distinct values of a column in natural sort order. */
export function levelsOf(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function cellAt(col: Column, i: number): Cell {
  return col.values[i]!;
}

/** Keep the rows for which `keep` is true. */
export function filterDataset(ds: Dataset, keep: (i: number) => boolean, name = ds.name): Dataset {
  const idx: number[] = [];
  for (let i = 0; i < ds.rowCount; i++) if (keep(i)) idx.push(i);
  const columns: Column[] = ds.columns.map((c) =>
    c.type === "number"
      ? { ...c, values: Float64Array.from(idx, (i) => c.values[i]!) }
      : { ...c, values: idx.map((i) => c.values[i]!) },
  );
  return { ...ds, id: `ds${++datasetCounter}`, name, columns, rowCount: idx.length };
}

export interface Aggregation {
  /** Source column. */
  column: string;
  fn: "mean" | "median" | "sum" | "count" | "sd" | "min" | "max";
  /** Name of the result column (default: fn_column). */
  as?: string;
}

/** Group rows by the given string columns and aggregate numeric ones. */
export function aggregateDataset(ds: Dataset, by: string[], aggs: Aggregation[], name: string, unit: string): Dataset {
  const keys = by.map((b) => stringColumn(ds, b));
  const groups = new Map<string, number[]>();
  for (let i = 0; i < ds.rowCount; i++) {
    const key = keys.map((k) => k[i]!).join("\u0001");
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(i);
  }
  const rows: Row[] = [];
  const sources = aggs.map((a) => (a.fn === "count" ? undefined : numberColumn(ds, a.column)));
  for (const [key, idx] of groups) {
    const row: Row = {};
    key.split("\u0001").forEach((v, j) => (row[by[j]!] = v));
    aggs.forEach((a, ai) => {
      const outName = a.as ?? `${a.fn}_${a.column}`;
      if (a.fn === "count") {
        row[outName] = idx.length;
        return;
      }
      const vals = idx.map((i) => sources[ai]![i]!).filter((v) => !Number.isNaN(v));
      row[outName] = reduce(vals, a.fn);
    });
    rows.push(row);
  }
  const spec = [
    ...by.map((b) => ({ name: b, type: "string" as const })),
    ...aggs.map((a) => ({ name: a.as ?? `${a.fn}_${a.column}`, type: "number" as const })),
  ];
  return datasetFromRows(name, unit, `Aggregated from “${ds.name}” by ${by.join(", ")}.`, rows, spec);
}

function reduce(vals: number[], fn: Aggregation["fn"]): number {
  const n = vals.length;
  if (n === 0) return NaN;
  switch (fn) {
    case "sum":
      return vals.reduce((s, v) => s + v, 0);
    case "mean":
      return vals.reduce((s, v) => s + v, 0) / n;
    case "min":
      return Math.min(...vals);
    case "max":
      return Math.max(...vals);
    case "median": {
      const s = [...vals].sort((a, b) => a - b);
      return n % 2 ? s[(n - 1) / 2]! : 0.5 * (s[n / 2 - 1]! + s[n / 2]!);
    }
    case "sd": {
      if (n < 2) return NaN;
      const m = vals.reduce((s, v) => s + v, 0) / n;
      return Math.sqrt(vals.reduce((s, v) => s + (v - m) * (v - m), 0) / (n - 1));
    }
    case "count":
      return n;
  }
}

/** Compact number formatting for tables and CSV. */
export function formatNumber(v: number, digits = 6): string {
  if (Number.isNaN(v)) return "";
  if (!Number.isFinite(v)) return v > 0 ? "Inf" : "-Inf";
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  return String(Number(v.toPrecision(digits)));
}

function csvEscape(s: string, sep: string): string {
  return s.includes(sep) || s.includes('"') || s.includes("\n") || s.includes("\r") ? `"${s.replace(/"/g, '""')}"` : s;
}

export function datasetToCsv(ds: Dataset, sep = ","): string {
  const lines: string[] = [ds.columns.map((c) => csvEscape(c.name, sep)).join(sep)];
  for (let i = 0; i < ds.rowCount; i++) {
    lines.push(
      ds.columns
        .map((c) => (c.type === "number" ? formatNumber(c.values[i]!, 10) : csvEscape(c.values[i]!, sep)))
        .join(sep),
    );
  }
  return lines.join("\n") + "\n";
}

/** Parse delimited text (comma, semicolon or tab; quotes per RFC 4180). */
export function parseDelimited(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts: [string, number][] = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  const sep = counts[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"' && cur === "") inQuotes = true;
    else if (ch === sep) {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}
