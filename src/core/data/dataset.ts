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
  /** True for tables the user brought in from a file; they do not depend on the corpus. */
  imported?: boolean;
  /** The main measure of the table, preselected as the outcome in the statistics lab. */
  primary?: string;
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
  spec: { name: string; type?: ColumnType; label?: string; primary?: boolean }[],
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
  const ds: Dataset = { id: `ds${++datasetCounter}`, name, unit, description, columns, rowCount: rows.length };
  const primary = spec.find((s) => s.primary)?.name;
  if (primary) ds.primary = primary;
  return ds;
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
export function aggregateDataset(
  ds: Dataset,
  by: string[],
  aggs: Aggregation[],
  name: string,
  unit: string,
  opts: { keepConstant?: boolean } = {},
): Dataset {
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
  // Variables with a single value inside every group (e.g. the condition of a recording) can be carried over.
  const taken = new Set([...by, ...aggs.map((a) => a.as ?? `${a.fn}_${a.column}`)]);
  const constant = opts.keepConstant
    ? ds.columns.filter((c) => {
        if (taken.has(c.name) || aggs.some((a) => a.fn !== "count" && a.column === c.name)) return false;
        for (const idx of groups.values()) {
          const first = c.values[idx[0]!]!;
          for (const i of idx) if (!Object.is(c.values[i]!, first)) return false;
        }
        return true;
      })
    : [];
  for (const [key, idx] of groups) {
    const row: Row = {};
    key.split("\u0001").forEach((v, j) => (row[by[j]!] = v));
    for (const c of constant) row[c.name] = c.values[idx[0]!]!;
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
    ...constant.map((c) => ({ name: c.name, type: c.type, ...(c.label ? { label: c.label } : {}) })),
    ...aggs.map((a) => ({ name: a.as ?? `${a.fn}_${a.column}`, type: "number" as const })),
  ];
  const out = datasetFromRows(name, unit, `Aggregated from “${ds.name}” by ${by.join(", ")}.`, rows, spec);
  const main = aggs.find((a) => a.fn !== "count" && a.column === ds.primary);
  if (main) out.primary = main.as ?? `${main.fn}_${main.column}`;
  return out;
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

/** The separator of delimited text: whichever of comma, semicolon and tab splits the header row most often. */
export function detectDelimiter(text: string): string {
  const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  const counts: [string, number][] = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![0];
}

/** Parse delimited text (comma, semicolon or tab; quotes per RFC 4180). */
export function parseDelimited(text: string): string[][] {
  const sep = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, "");
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

const MISSING = new Set(["", "na", "nan", "n/a", "null", "."]);

/**
 * Turn delimited text with a header row into a dataset. A column is numeric if every
 * non-empty cell is a number; decimal commas are understood in files that are not
 * comma-separated.
 */
export function datasetFromDelimited(text: string, name: string): Dataset {
  const table = parseDelimited(text);
  if (table.length < 2) throw new Error("The table needs a header row and at least one row of data.");
  const decimalComma = detectDelimiter(text) !== ",";
  const seen = new Map<string, number>();
  const names = table[0]!.map((h, i) => {
    const base = h.trim() || `V${i + 1}`;
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    return k === 0 ? base : `${base}_${k + 1}`;
  });
  const body = table.slice(1);
  const parse = (cell: string): number => {
    if (MISSING.has(cell.toLowerCase())) return NaN;
    const c = decimalComma && /^[-+]?\d*,\d+(e[-+]?\d+)?$/i.test(cell) ? cell.replace(",", ".") : cell;
    return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(c) ? Number(c) : Infinity;
  };
  const columns: Column[] = names.map((colName, j) => {
    const cells = body.map((r) => (r[j] ?? "").trim());
    const numbers = Float64Array.from(cells, parse);
    let filled = 0;
    let numeric = true;
    for (const v of numbers) {
      if (v === Infinity) numeric = false;
      else if (!Number.isNaN(v)) filled++;
    }
    if (numeric && filled > 0) return { name: colName, type: "number", values: numbers };
    return { name: colName, type: "string", values: cells.map((c) => (MISSING.has(c.toLowerCase()) ? "" : c)) };
  });
  return { id: `ds${++datasetCounter}`, name, unit: "one row of the imported table", description: "Imported table.", columns, rowCount: body.length, imported: true };
}

/** Decode the bytes of a text file: UTF-8 or UTF-16 (with or without byte-order mark), otherwise Windows-1252. */
export function decodeTextBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** The dataset with one more variable (a variable of the same name is replaced). The identity of the dataset is kept. */
export function withColumn(ds: Dataset, col: Column): Dataset {
  if (col.values.length !== ds.rowCount) throw new Error("The new variable must have one value per row.");
  const at = ds.columns.findIndex((c) => c.name === col.name);
  const columns = at < 0 ? [...ds.columns, col] : ds.columns.map((c, i) => (i === at ? col : c));
  return { ...ds, columns };
}

/** A variable name that is not yet used in the dataset. */
export function freeColumnName(ds: Dataset, base: string): string {
  const names = new Set(ds.columns.map((c) => c.name));
  if (!names.has(base)) return base;
  for (let k = 2; ; k++) if (!names.has(`${base}_${k}`)) return `${base}_${k}`;
}

/**
 * Do several rows of the table come from the same recording? Tests that treat rows as
 * independent observations overstate the evidence for such tables (pseudo-replication).
 * Returns the variable that names the recording, the number of recordings and the mean
 * number of rows per recording — or undefined if every recording has one row.
 */
export function nestingOf(ds: Dataset): { variable: string; groups: number; perGroup: number } | undefined {
  for (const name of ["source_file", "file", "dyad"]) {
    const c = column(ds, name);
    if (!c || c.type !== "string") continue;
    const groups = new Set(c.values.filter((v) => v.trim() !== "")).size;
    if (groups >= 1 && groups < ds.rowCount) return { variable: name, groups, perGroup: ds.rowCount / groups };
  }
  return undefined;
}

