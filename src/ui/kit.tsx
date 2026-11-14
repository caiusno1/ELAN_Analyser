import { useMemo, useState, type ReactNode } from "react";
import type { ValueFilter } from "../core/analysis/common.ts";
import { PAIRING_LABEL, type Pairing } from "../core/analysis/cooccurrence.ts";
import type { LayerInfo } from "../core/corpus/corpus.ts";
import { datasetToCsv, type Dataset } from "../core/data/dataset.ts";
import { useLayers } from "./hooks.ts";
import { icons, type IconName } from "./icons.tsx";
import { useStore } from "./store.ts";

// ---- formatting -------------------------------------------------------------------------

/** Format a number for display with a sensible number of digits. */
export function fmt(v: number | undefined | null, digits = 3): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "–";
  if (!Number.isFinite(v)) return v > 0 ? "∞" : "−∞";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (Number.isInteger(v) && a < 1e9) return v.toLocaleString("en-US");
  if (a >= 1e6 || a < 1e-4) return v.toExponential(2).replace("e+", "e").replace("-", "−");
  const s = a >= 100 ? v.toFixed(Math.max(0, digits - 2)) : a >= 10 ? v.toFixed(Math.max(0, digits - 1)) : a >= 1 ? v.toFixed(digits) : v.toPrecision(digits);
  return s.replace("-", "−");
}

export function pct(v: number, digits = 1): string {
  return Number.isNaN(v) ? "–" : `${(100 * v).toFixed(digits)}%`;
}

/** A Bayes factor from its natural log, written the way JASP does. */
export function fmtBf(logBf: number): string {
  if (Number.isNaN(logBf)) return "–";
  if (logBf === Infinity) return "∞";
  if (logBf === -Infinity) return "0";
  const l10 = logBf / Math.LN10;
  if (Math.abs(l10) >= 5) {
    const e = Math.floor(l10);
    const m = Math.pow(10, l10 - e);
    return `${m.toFixed(2)}×10${superscript(e)}`;
  }
  const bf = Math.exp(logBf);
  return bf >= 100 ? bf.toFixed(0) : bf >= 10 ? bf.toFixed(1) : bf >= 1 ? bf.toFixed(2) : bf.toPrecision(3);
}

function superscript(n: number): string {
  const map: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
  return String(n).split("").map((c) => map[c] ?? c).join("");
}

// ---- files --------------------------------------------------------------------------------

/** Offer text as a file download; returns false if the browser refuses. */
export function downloadText(fileName: string, text: string, mime = "text/plain"): boolean {
  try {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---- layout -------------------------------------------------------------------------------

export function Card({ title, sub, actions, children, flush }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode; flush?: boolean }) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          <div className="sub">{sub}</div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={flush ? "card-body flush" : "card-body"}>{children}</div>
    </section>
  );
}

export function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {hint && <div className="tile-hint">{hint}</div>}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Callout({ kind = "info", children }: { kind?: "info" | "warning" | "critical"; children: ReactNode }) {
  return (
    <div className={`callout${kind === "info" ? "" : ` ${kind}`}`} role={kind === "info" ? undefined : "alert"}>
      {kind === "info" ? icons.info : icons.alert}
      <div>{children}</div>
    </div>
  );
}

/** Collapsible explanation of how a result is computed, with references. */
export function MethodNote({ title = "How this is computed", children, refs }: { title?: string; children: ReactNode; refs?: string[] }) {
  return (
    <details className="note">
      <summary>{title}</summary>
      <div>
        {children}
        {refs && refs.length > 0 && (
          <p className="refs">
            {refs.map((r, i) => (
              <span key={i}>
                {r}
                {i < refs.length - 1 ? " · " : ""}
              </span>
            ))}
          </p>
        )}
      </div>
    </details>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---- controls -----------------------------------------------------------------------------

export function Button({ children, onClick, kind, small, icon, disabled, title }: { children?: ReactNode; onClick?: () => void; kind?: "primary" | "ghost"; small?: boolean; icon?: IconName; disabled?: boolean; title?: string }) {
  const cls = ["btn", kind, small ? "small" : ""].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} onClick={onClick} disabled={disabled} title={title} aria-label={children ? undefined : title}>
      {icon && icons[icon]}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string | undefined; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <div className="error">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Select<T extends string>({ id, value, onChange, options, disabled }: { id?: string; value: T; onChange: (v: T) => void; options: { value: T; label: string; disabled?: boolean }[]; disabled?: boolean }) {
  return (
    <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value as T)} disabled={disabled}>
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function NumberField({ id, value, onChange, min, max, step }: { id?: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  const [text, setText] = useState<string | undefined>(undefined);
  return (
    <input
      id={id}
      className="input num"
      type="number"
      inputMode="decimal"
      value={text ?? String(value)}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        setText(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(v) && (min === undefined || v >= min) && (max === undefined || v <= max)) onChange(v);
      }}
      onBlur={() => setText(undefined)}
    />
  );
}

export function TextField({ id, value, onChange, placeholder, invalid, mono }: { id?: string; value: string; onChange: (v: string) => void; placeholder?: string; invalid?: boolean; mono?: boolean }) {
  return (
    <input
      id={id}
      className={mono ? "input mono" : "input"}
      type="text"
      value={value}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function Toggle({ id, checked, onChange, children }: { id?: string; checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="switch">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" />
      <span>{children}</span>
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function CheckList({ options, selected, onChange }: { options: { value: string; label: string }[]; selected: string[]; onChange: (v: string[]) => void }) {
  const set = new Set(selected);
  return (
    <div className="checklist">
      {options.map((o) => (
        <label key={o.value} title={o.label}>
          <input
            type="checkbox"
            checked={set.has(o.value)}
            onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value))}
          />
          <span>{o.label}</span>
        </label>
      ))}
      {options.length === 0 && <span className="faint">nothing to choose from</span>}
    </div>
  );
}

const KIND_LABEL: Record<LayerInfo["kind"], string> = { text: "text", categorical: "categories", numeric: "numbers", empty: "empty" };

/** Choose one of the corpus layers. */
export function LayerSelect({ id, value, onChange, kinds, allowNone }: { id?: string; value: string; onChange: (v: string) => void; kinds?: LayerInfo["kind"][]; allowNone?: string }) {
  const layers = useLayers();
  const shown = kinds ? layers.filter((l) => kinds.includes(l.kind) || l.name === value) : layers;
  return (
    <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {allowNone !== undefined && <option value="">{allowNone}</option>}
      {!allowNone && value === "" && <option value="">choose a layer …</option>}
      {shown.map((l) => (
        <option key={l.name} value={l.name}>
          {l.name} — {KIND_LABEL[l.kind]}, {l.annotationCount.toLocaleString("en-US")} annotations
        </option>
      ))}
    </select>
  );
}

/** Pick a default layer: the first one of the wanted kind, preferring one whose name matches. */
export function defaultLayer(layers: LayerInfo[], kind: LayerInfo["kind"] | undefined, prefer?: RegExp, exclude?: string): string {
  const pool = layers.filter((l) => (!kind || l.kind === kind) && l.name !== exclude);
  // Among matching names the shortest wins ("gesture" before "gesture_phase").
  const hit = prefer ? pool.filter((l) => prefer.test(l.name)).sort((a, b) => a.name.length - b.name.length)[0] : undefined;
  return (hit ?? pool[0] ?? layers.find((l) => l.name !== exclude) ?? layers[0])?.name ?? "";
}

export function PairingSelect({ id, value, onChange }: { id?: string; value: Pairing; onChange: (v: Pairing) => void }) {
  return <Select id={id} value={value} onChange={onChange} options={(Object.keys(PAIRING_LABEL) as Pairing[]).map((p) => ({ value: p, label: PAIRING_LABEL[p] }))} />;
}

/** Editor for a value filter: everything, a regular expression, or a list of values. */
export function FilterField({ label, value, onChange, values, id }: { label: string; value: ValueFilter; onChange: (f: ValueFilter) => void; values?: string[]; id: string }) {
  let error: string | undefined;
  if (value.mode === "regex" && value.pattern) {
    try {
      new RegExp(value.pattern, "u");
    } catch (e) {
      error = (e as Error).message;
    }
  }
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <Segmented
        value={value.mode}
        onChange={(mode) => onChange(mode === "all" ? { mode } : mode === "regex" ? { mode, pattern: value.pattern ?? "" } : { mode, values: value.values ?? [] })}
        options={[
          { value: "all", label: "All" },
          { value: "values", label: "Pick values" },
          { value: "regex", label: "Pattern" },
        ]}
      />
      {value.mode === "regex" && <TextField id={id} mono value={value.pattern ?? ""} onChange={(pattern) => onChange({ ...value, pattern })} placeholder="regular expression, e.g. ^(iconic|deictic)$" invalid={!!error} />}
      {value.mode === "values" && (
        <CheckList options={(values ?? []).slice(0, 300).map((v) => ({ value: v, label: v }))} selected={value.values ?? []} onChange={(vs) => onChange({ ...value, values: vs })} />
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

// ---- tables -------------------------------------------------------------------------------

export interface ColumnDef<T> {
  key: string;
  header: string;
  /** Value used for sorting and CSV export. */
  value: (row: T) => string | number;
  /** Custom cell content. */
  render?: (row: T) => ReactNode;
  numeric?: boolean;
  /** Decimal digits for numeric columns. */
  digits?: number;
  title?: string;
  wrap?: boolean;
}

export function DataTable<T>({ rows, columns, onRowClick, maxHeight = 420, pageSize = 100, initialSort, csvName, rowKey, selected }: {
  rows: T[];
  columns: ColumnDef<T>[];
  onRowClick?: (row: T) => void;
  maxHeight?: number;
  pageSize?: number;
  initialSort?: { key: string; dir: 1 | -1 };
  csvName?: string;
  rowKey?: (row: T, i: number) => string | number;
  selected?: (row: T) => boolean;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | undefined>(initialSort);
  const [shown, setShown] = useState(pageSize);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    return [...rows].sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      if (typeof va === "number" && typeof vb === "number") {
        // Missing values last, whatever the direction.
        if (Number.isNaN(va)) return Number.isNaN(vb) ? 0 : 1;
        if (Number.isNaN(vb)) return -1;
        return (va - vb) * sort.dir;
      }
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * sort.dir;
    });
  }, [rows, columns, sort]);
  const toCsv = () =>
    [columns.map((c) => JSON.stringify(c.header)).join(","), ...sorted.map((r) => columns.map((c) => {
      const v = c.value(r);
      return typeof v === "number" ? (Number.isNaN(v) ? "" : String(v)) : JSON.stringify(v);
    }).join(","))].join("\n");
  const toast = useStore((s) => s.toast);
  return (
    <div>
      <div className="table-wrap" style={{ maxHeight }}>
        <table className="data">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`sortable${c.numeric ? " n" : ""}`}
                  title={c.title}
                  aria-sort={sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
                  onClick={() => setSort(sort?.key === c.key ? { key: c.key, dir: sort.dir === 1 ? -1 : 1 } : { key: c.key, dir: c.numeric ? -1 : 1 })}
                >
                  {c.header}
                  {sort?.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, shown).map((r, i) => (
              <tr key={rowKey ? rowKey(r, i) : i} className={`${onRowClick ? "clickable" : ""}${selected?.(r) ? " selected" : ""}`} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                {columns.map((c) => {
                  const v = c.value(r);
                  return (
                    <td key={c.key} className={`${c.numeric ? "n" : ""}${c.wrap ? " wrap" : ""}`} title={typeof v === "string" && v.length > 40 ? v : undefined}>
                      {c.render ? c.render(r) : typeof v === "number" ? fmt(v, c.digits ?? 3) : v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-foot">
        <span>
          {rows.length.toLocaleString("en-US")} row{rows.length === 1 ? "" : "s"}
          {shown < rows.length ? ` · showing ${shown}` : ""}
        </span>
        {shown < rows.length && (
          <Button small kind="ghost" onClick={() => setShown(shown + pageSize * 5)}>
            Show more
          </Button>
        )}
        <span className="spacer" />
        {rows.length > 0 && (
          <>
            <Button small kind="ghost" icon="copy" onClick={async () => toast((await copyText(toCsv())) ? "Table copied." : "Copying is not allowed here.", "info")}>
              Copy
            </Button>
            {csvName && (
              <Button small kind="ghost" icon="download" onClick={() => downloadText(`${csvName}.csv`, toCsv(), "text/csv")}>
                CSV
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Button that hands a dataset to the statistics lab. */
export function SendToStats({ dataset, label = "Analyse in Statistics" }: { dataset: Dataset | undefined; label?: string }) {
  const addDataset = useStore((s) => s.addDataset);
  return (
    <Button small icon="send" disabled={!dataset || dataset.rowCount === 0} onClick={() => dataset && addDataset(dataset)} title="Open this table in the statistics lab">
      {label}
    </Button>
  );
}

export function DatasetCsvButton({ dataset }: { dataset: Dataset | undefined }) {
  return (
    <Button small kind="ghost" icon="download" disabled={!dataset || dataset.rowCount === 0} onClick={() => dataset && downloadText(`${dataset.name.replace(/[^\w.-]+/g, "_")}.csv`, datasetToCsv(dataset), "text/csv")}>
      CSV
    </Button>
  );
}
