import { useMemo } from "react";
import { ALL_VALUES, type ValueFilter } from "../../core/analysis/common.ts";
import { linkLayer, type LinkOptions } from "../../core/analysis/link.ts";
import { listParticipants } from "../../core/corpus/corpus.ts";
import { aggregateDataset, column, filterDataset, freeColumnName, levelsOf, withColumn, type Aggregation, type Column, type Dataset } from "../../core/data/dataset.ts";
import { mean, ranks, sd, summarize } from "../../core/stats/describe.ts";
import { ChartCard } from "../charts/ChartCard.tsx";
import { Histogram } from "../charts/Histogram.tsx";
import { XYChart } from "../charts/XYChart.tsx";
import { useLayerValues, useLayers, useViewState } from "../hooks.ts";
import { Button, Callout, Card, CheckList, DataTable, DatasetCsvButton, defaultLayer, Field, FilterField, fmt, LayerSelect, NumberField, pct, Segmented, Select, TextField, Toggle, type ColumnDef } from "../kit.tsx";
import { useStore } from "../store.ts";
import { groupingOptions, numberOf, splitByGroup, textOf, variableOptions } from "./common.tsx";

const PREVIEW_ROWS = 20000;

interface VarRow {
  name: string;
  type: "number" | "text";
  valid: number;
  missing: number;
  distinct: number;
  mean: number;
  sd: number;
  min: number;
  median: number;
  max: number;
  note: string;
}

function describeColumn(c: Column): VarRow {
  if (c.type === "number") {
    const vals = Array.from(c.values).filter((v) => Number.isFinite(v));
    const s = summarize(vals);
    return { name: c.name, type: "number", valid: vals.length, missing: c.values.length - vals.length, distinct: new Set(vals).size, mean: s.mean, sd: s.sd, min: s.min, median: s.median, max: s.max, note: c.label ?? "" };
  }
  const counts = new Map<string, number>();
  let missing = 0;
  for (const v of c.values) {
    if (v.trim() === "") missing++;
    else counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const note = top.map(([v, n]) => `${v} (${n})`).join(", ") + (counts.size > top.length ? ", …" : "");
  return { name: c.name, type: "text", valid: c.values.length - missing, missing, distinct: counts.size, mean: NaN, sd: NaN, min: NaN, median: NaN, max: NaN, note: c.label ? `${c.label} — ${note}` : note };
}

type Tool = "aggregate" | "filter" | "compute" | "link";

const FUNCTIONS: { value: Aggregation["fn"]; label: string }[] = [
  { value: "mean", label: "mean" },
  { value: "median", label: "median" },
  { value: "sum", label: "sum" },
  { value: "sd", label: "standard deviation" },
  { value: "min", label: "minimum" },
  { value: "max", label: "maximum" },
];

type Op = "log" | "log10" | "sqrt" | "z" | "center" | "rank" | "diff" | "sum" | "product" | "ratio" | "paste";

const OPS: Record<Op, { label: string; binary: boolean; text?: boolean; name: (a: string, b: string) => string }> = {
  log: { label: "natural logarithm of A", binary: false, name: (a) => `log_${a}` },
  log10: { label: "logarithm to base 10 of A", binary: false, name: (a) => `log10_${a}` },
  sqrt: { label: "square root of A", binary: false, name: (a) => `sqrt_${a}` },
  z: { label: "A standardised (mean 0, SD 1)", binary: false, name: (a) => `z_${a}` },
  center: { label: "A centred on its mean", binary: false, name: (a) => `c_${a}` },
  rank: { label: "rank of A", binary: false, name: (a) => `rank_${a}` },
  diff: { label: "A − B", binary: true, name: (a, b) => `${a}_minus_${b}` },
  sum: { label: "A + B", binary: true, name: (a, b) => `${a}_plus_${b}` },
  product: { label: "A × B", binary: true, name: (a, b) => `${a}_x_${b}` },
  ratio: { label: "A / B", binary: true, name: (a, b) => `${a}_per_${b}` },
  paste: { label: "A and B joined into one label", binary: true, text: true, name: (a, b) => `${a}_${b}` },
};

function compute(ds: Dataset, op: Op, a: string, b: string, name: string): Column {
  const n = ds.rowCount;
  if (op === "paste") {
    const values: string[] = [];
    for (let i = 0; i < n; i++) {
      const x = textOf(ds, a, i);
      const y = textOf(ds, b, i);
      values.push(x === "" || y === "" ? "" : `${x}:${y}`);
    }
    return { name, type: "string", values, label: `${a} and ${b} joined` };
  }
  const xs = Float64Array.from({ length: n }, (_, i) => numberOf(ds, a, i));
  const out = new Float64Array(n).fill(NaN);
  const finite = Array.from(xs).filter((v) => Number.isFinite(v));
  if (op === "z" || op === "center") {
    const m = mean(finite);
    const s = op === "z" ? sd(finite) : 1;
    for (let i = 0; i < n; i++) out[i] = (xs[i]! - m) / s;
  } else if (op === "rank") {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (Number.isFinite(xs[i]!)) idx.push(i);
    const r = ranks(idx.map((i) => xs[i]!));
    idx.forEach((i, k) => (out[i] = r[k]!));
  } else if (OPS[op].binary) {
    for (let i = 0; i < n; i++) {
      const x = xs[i]!;
      const y = numberOf(ds, b, i);
      out[i] = op === "diff" ? x - y : op === "sum" ? x + y : op === "product" ? x * y : y === 0 ? NaN : x / y;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const x = xs[i]!;
      out[i] = op === "sqrt" ? (x >= 0 ? Math.sqrt(x) : NaN) : x > 0 ? (op === "log" ? Math.log(x) : Math.log10(x)) : NaN;
    }
  }
  for (let i = 0; i < n; i++) if (!Number.isFinite(out[i]!)) out[i] = NaN;
  return { name, type: "number", values: out, label: OPS[op].label.replace(/\bA\b/, a).replace(/\bB\b/, b) };
}

export function DataPanel({ ds }: { ds: Dataset }) {
  const addDataset = useStore((s) => s.addDataset);
  const updateDataset = useStore((s) => s.updateDataset);
  const removeDataset = useStore((s) => s.removeDataset);
  const toast = useStore((s) => s.toast);
  const [tool, setTool] = useViewState<Tool>(`stats.data.tool.${ds.id}`, "aggregate");
  const [selected, setSelected] = useViewState(`stats.data.var.${ds.id}`, ds.columns.find((c) => c.type === "number")?.name ?? ds.columns[0]?.name ?? "");
  const [split, setSplit] = useViewState(`stats.data.split.${ds.id}`, "");
  const [logScale, setLogScale] = useViewState(`stats.data.log.${ds.id}`, false);

  const variables = useMemo(() => ds.columns.map(describeColumn), [ds]);
  const selectedCol = column(ds, selected) ?? ds.columns[0];
  const groupings = groupingOptions(ds, "no split");

  const preview = useMemo(() => Array.from({ length: Math.min(ds.rowCount, PREVIEW_ROWS) }, (_, i) => i), [ds]);
  const previewColumns = useMemo<ColumnDef<number>[]>(
    () => ds.columns.map((c) => ({ key: c.name, header: c.name, value: (i: number) => c.values[i]!, numeric: c.type === "number", ...(c.label ? { title: c.label } : {}) })),
    [ds],
  );

  return (
    <div className="view-grid">
      <div className="stack">
        <Card title={ds.name}>
          <p style={{ margin: 0 }}>{ds.description}</p>
          <div className="row" style={{ marginTop: 8 }}>
            <span className="chip accent">One row = {ds.unit}</span>
            <span className="chip">{ds.rowCount.toLocaleString("en-US")} rows</span>
            <span className="chip">{ds.columns.length} variables</span>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <DatasetCsvButton dataset={ds} />
            <Button small kind="ghost" icon="trash" onClick={() => removeDataset(ds.id)}>Remove table</Button>
          </div>
        </Card>
        <Card title="Reshape" sub="Each tool makes a new table; the original stays as it is.">
          <Segmented<Tool> value={tool} onChange={setTool} options={[{ value: "aggregate", label: "Aggregate" }, { value: "filter", label: "Filter" }, { value: "compute", label: "Compute" }, { value: "link", label: "Link" }]} />
          {tool === "aggregate" && <AggregateTool ds={ds} onResult={(d) => addDataset(d)} />}
          {tool === "filter" && <FilterTool ds={ds} onResult={(d) => addDataset(d)} />}
          {tool === "compute" && (
            <ComputeTool
              ds={ds}
              onResult={(col) => {
                updateDataset(withColumn(ds, col));
                setSelected(col.name);
                toast(`Variable “${col.name}” added.`);
              }}
            />
          )}
          {tool === "link" && (
            <LinkTool
              ds={ds}
              onResult={(col) => {
                updateDataset(withColumn(ds, col));
                setSelected(col.name);
                toast(`Variable “${col.name}” added from the corpus.`);
              }}
            />
          )}
        </Card>
        <details className="note">
          <summary>Which table for which question?</summary>
          <div>
            <p>
              The Bayesian tests (t-test, ANOVA, correlation, contingency table) assume that every row is an independent observation. Annotations of one speaker or one recording are not independent of each other, so for these tests
              first <strong>aggregate</strong> to one row per speaker or per recording.
            </p>
            <p>
              The <strong>multilevel model</strong> is the alternative: it works on the single annotations and takes the nesting into account through grouping variables. When speakers carry the same label in every file (A, B), join file
              and participant into one variable with <strong>Compute</strong> first.
            </p>
            <p>
              <strong>Link</strong> looks up what was annotated on any layer at the time of each row — for example the gaze of the previous speaker at every change of speaker — and adds it as a variable. That turns questions across
              modalities into an ordinary comparison or regression.
            </p>
          </div>
        </details>
      </div>

      <div className="stack">
        <Card title="Variables" sub="Click a row to see the distribution." flush>
          <DataTable<VarRow>
            rows={variables}
            maxHeight={300}
            rowKey={(r) => r.name}
            onRowClick={(r) => setSelected(r.name)}
            selected={(r) => r.name === selectedCol?.name}
            csvName={`${ds.name}_variables`}
            columns={[
              { key: "name", header: "Variable", value: (r) => r.name },
              { key: "type", header: "Type", value: (r) => r.type },
              { key: "valid", header: "Valid", value: (r) => r.valid, numeric: true, digits: 0 },
              { key: "missing", header: "Missing", value: (r) => r.missing, numeric: true, digits: 0 },
              { key: "distinct", header: "Distinct", value: (r) => r.distinct, numeric: true, digits: 0 },
              { key: "mean", header: "Mean", value: (r) => r.mean, numeric: true },
              { key: "sd", header: "SD", value: (r) => r.sd, numeric: true },
              { key: "min", header: "Min", value: (r) => r.min, numeric: true },
              { key: "median", header: "Median", value: (r) => r.median, numeric: true },
              { key: "max", header: "Max", value: (r) => r.max, numeric: true },
              { key: "note", header: "Description / most frequent values", value: (r) => r.note, wrap: true },
            ]}
          />
        </Card>

        {selectedCol && (
          <ChartCard title={`Distribution of ${selectedCol.name}`} sub={selectedCol.label}>
            <div className="row" style={{ marginBottom: 10 }}>
              <div style={{ flex: "0 1 220px", minWidth: 0 }}><Select value={selectedCol.name} onChange={setSelected} options={variableOptions(ds)} /></div>
              {selectedCol.type === "number" && (
                <div style={{ flex: "0 1 220px", minWidth: 0 }}>
                  <Select value={groupings.some((g) => g.value === split) && split !== selectedCol.name ? split : ""} onChange={setSplit} options={groupings.filter((g) => g.value !== selectedCol.name).map((g) => (g.value ? { ...g, label: `split by ${g.label}` } : g))} />
                </div>
              )}
              {selectedCol.type === "number" && <Toggle checked={logScale} onChange={setLogScale}>Log scale</Toggle>}
            </div>
            <Distribution ds={ds} col={selectedCol} split={groupings.some((g) => g.value === split) && split !== selectedCol.name ? split : ""} log={logScale} />
          </ChartCard>
        )}

        <Card title="Data" sub={ds.rowCount > PREVIEW_ROWS ? `The first ${PREVIEW_ROWS.toLocaleString("en-US")} of ${ds.rowCount.toLocaleString("en-US")} rows. Analyses use all rows.` : undefined} flush>
          <DataTable<number> rows={preview} columns={previewColumns} maxHeight={420} rowKey={(i) => i} />
        </Card>
      </div>
    </div>
  );
}

function Distribution({ ds, col, split, log }: { ds: Dataset; col: Column; split: string; log: boolean }) {
  const data = useMemo(() => {
    if (col.type === "string") {
      const counts = new Map<string, number>();
      for (const v of col.values) if (v.trim() !== "") counts.set(v, (counts.get(v) ?? 0) + 1);
      const sorted = [...counts].sort((a, b) => b[1] - a[1]);
      return { kind: "levels" as const, levels: sorted.slice(0, 30), more: sorted.length - Math.min(30, sorted.length), total: sorted.reduce((s, [, n]) => s + n, 0) };
    }
    if (split) {
      const groups = splitByGroup(ds, col.name, split).groups;
      return { kind: "numeric" as const, series: groups.slice(0, 8).map((g) => ({ label: g.label, values: g.values })) };
    }
    return { kind: "numeric" as const, series: [{ label: col.name, values: Array.from(col.values).filter((v) => Number.isFinite(v)) }] };
  }, [ds, col, split]);

  if (data.kind === "levels") {
    if (data.levels.length === 0) return <p className="muted">This variable has no values.</p>;
    return (
      <>
        <XYChart
          height={Math.max(120, 44 + data.levels.length * 22)}
          x={{ type: "linear", zero: true, label: "rows" }}
          y={{ type: "band", domain: data.levels.map(([v]) => v), padding: 0.25 }}
          marks={[{ type: "bar", horizontal: true, data: data.levels.map(([v, n]) => ({ x: v, y: n, tip: { title: v, rows: [["rows", String(n)], ["share", pct(n / data.total)]] } })) }]}
          ariaLabel={`Number of rows per value of ${col.name}`}
        />
        {data.more > 0 && <p className="faint" style={{ margin: "6px 0 0" }}>{data.more} rarer values are not shown.</p>}
      </>
    );
  }
  const canLog = data.series.every((s) => s.values.every((v) => v > 0));
  if (data.series.every((s) => s.values.length === 0)) return <p className="muted">This variable has no values.</p>;
  return (
    <>
      <Histogram series={data.series} xLabel={col.name} log={log && canLog} />
      {log && !canLog && <p className="faint" style={{ margin: "6px 0 0" }}>A log scale needs values above zero.</p>}
    </>
  );
}

function AggregateTool({ ds, onResult }: { ds: Dataset; onResult: (d: Dataset) => void }) {
  const groupings = groupingOptions(ds);
  const numeric = variableOptions(ds, "number");
  const [by, setBy] = useViewState<string[]>(`stats.agg.by.${ds.id}`, []);
  const [vars, setVars] = useViewState<string[]>(`stats.agg.vars.${ds.id}`, []);
  const [fn, setFn] = useViewState<Aggregation["fn"]>(`stats.agg.fn.${ds.id}`, "mean");
  const valid = by.filter((b) => groupings.some((g) => g.value === b));
  const sources = vars.filter((v) => numeric.some((o) => o.value === v) && !valid.includes(v));
  const run = () => {
    const aggs: Aggregation[] = [...sources.map((v) => ({ column: v, fn })), { column: valid[0]!, fn: "count", as: freeName(ds, "n_rows", valid, sources, fn) }];
    onResult(aggregateDataset(ds, valid, aggs, `${ds.name} per ${valid.join(" × ")}`, `one ${valid.join(" × ")}`, { keepConstant: true }));
  };
  return (
    <>
      <Field label="One row per" hint="For example: file and participant, to get one value per speaker.">
        {groupings.length ? <CheckList options={groupings} selected={valid} onChange={setBy} /> : <span className="muted">This table has no grouping variables.</span>}
      </Field>
      <Field label="Summarise">
        <CheckList options={numeric.filter((o) => !valid.includes(o.value))} selected={sources} onChange={setVars} />
      </Field>
      <Field label="by their" htmlFor="agg-fn"><Select id="agg-fn" value={fn} onChange={setFn} options={FUNCTIONS} /></Field>
      <p className="faint" style={{ margin: "8px 0 0" }}>The number of rows per group is added, and variables that do not change within a group (such as the condition of a recording) are kept.</p>
      <div className="row" style={{ marginTop: 10 }}>
        <Button kind="primary" disabled={valid.length === 0} onClick={run}>Create table</Button>
      </div>
    </>
  );
}

/** Name for the row-count column that does not collide with the group or summary columns. */
function freeName(ds: Dataset, base: string, by: string[], sources: string[], fn: string): string {
  const used = new Set([...by, ...sources.map((s) => `${fn}_${s}`), ...ds.columns.map((c) => c.name)]);
  let name = base;
  for (let k = 2; used.has(name); k++) name = `${base}_${k}`;
  return name;
}

function FilterTool({ ds, onResult }: { ds: Dataset; onResult: (d: Dataset) => void }) {
  const [variable, setVariable] = useViewState(`stats.filter.var.${ds.id}`, ds.columns[0]?.name ?? "");
  const col = column(ds, variable) ?? ds.columns[0];
  const levels = useMemo(() => (col?.type === "string" ? levelsOf(col.values.filter((v) => v.trim() !== "")) : []), [col]);
  const range = useMemo(() => {
    if (col?.type !== "number") return { min: 0, max: 0 };
    const vals = Array.from(col.values).filter((v) => Number.isFinite(v));
    return vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : { min: 0, max: 0 };
  }, [col]);
  const [keep, setKeep] = useViewState<string[] | undefined>(`stats.filter.keep.${ds.id}.${variable}`, undefined);
  const [lo, setLo] = useViewState<number | undefined>(`stats.filter.lo.${ds.id}.${variable}`, undefined);
  const [hi, setHi] = useViewState<number | undefined>(`stats.filter.hi.${ds.id}.${variable}`, undefined);
  const kept = keep ?? levels;
  const from = lo ?? range.min;
  const to = hi ?? range.max;
  const manyLevels = levels.length > 80;
  const matching = useMemo(() => {
    let n = 0;
    if (col?.type === "string") {
      const set = new Set(kept);
      for (const v of col.values) if (set.has(v)) n++;
    } else if (col) for (const v of col.values) if (v >= from && v <= to) n++;
    return n;
  }, [col, kept, from, to]);
  if (!col) return null;
  const run = () => {
    const set = new Set(kept);
    const out = filterDataset(ds, (i) => (col.type === "string" ? set.has(col.values[i]!) : col.values[i]! >= from && col.values[i]! <= to), `${ds.name} [${col.type === "string" ? `${col.name}: ${kept.length <= 3 ? kept.join(", ") : `${kept.length} values`}` : `${col.name} ${fmt(from)}–${fmt(to)}`}]`);
    onResult({ ...out, description: `Rows of “${ds.name}” selected by ${col.name}.` });
  };
  return (
    <>
      <Field label="Keep rows by" htmlFor="flt-var"><Select id="flt-var" value={col.name} onChange={setVariable} options={variableOptions(ds)} /></Field>
      {col.type === "string" ? (
        manyLevels ? (
          <Callout kind="info">This variable has {levels.length} different values — too many to list. Filter on another variable.</Callout>
        ) : (
          <Field label="Values to keep">
            <CheckList options={levels.map((l) => ({ value: l, label: l }))} selected={kept} onChange={setKeep} />
          </Field>
        )
      ) : (
        <div className="field-row" style={{ marginTop: 9 }}>
          <Field label="From" htmlFor="flt-lo"><NumberField id="flt-lo" value={from} onChange={setLo} /></Field>
          <Field label="To" htmlFor="flt-hi"><NumberField id="flt-hi" value={to} onChange={setHi} /></Field>
        </div>
      )}
      <p className="faint" style={{ margin: "8px 0 0" }}>{matching.toLocaleString("en-US")} of {ds.rowCount.toLocaleString("en-US")} rows match.</p>
      <div className="row" style={{ marginTop: 10 }}>
        <Button kind="primary" disabled={matching === 0 || matching === ds.rowCount || (col.type === "string" && manyLevels)} onClick={run}>Create table</Button>
      </div>
    </>
  );
}

function ComputeTool({ ds, onResult }: { ds: Dataset; onResult: (col: Column) => void }) {
  const numeric = variableOptions(ds, "number");
  const all = variableOptions(ds);
  const [op, setOp] = useViewState<Op>(`stats.compute.op.${ds.id}`, numeric.length ? "log" : "paste");
  const info = OPS[op];
  const choices = info.text ? all : numeric;
  const [a, setA] = useViewState(`stats.compute.a.${ds.id}`, "");
  const [b, setB] = useViewState(`stats.compute.b.${ds.id}`, "");
  const [name, setName] = useViewState(`stats.compute.name.${ds.id}`, "");
  const va = choices.some((o) => o.value === a) ? a : choices[0]?.value ?? "";
  const vb = choices.some((o) => o.value === b) ? b : choices[1]?.value ?? choices[0]?.value ?? "";
  const suggested = va ? freeColumnName(ds, info.name(va, vb).replace(/[^\p{L}\p{N}_]+/gu, "_")) : "";
  const finalName = name.trim() || suggested;
  const taken = ds.columns.some((c) => c.name === finalName);
  return (
    <>
      <Field label="New variable" htmlFor="cmp-op">
        <Select id="cmp-op" value={op} onChange={setOp} options={(Object.keys(OPS) as Op[]).map((k) => ({ value: k, label: OPS[k].label }))} />
      </Field>
      <div className="field-row" style={{ marginTop: 9 }}>
        <Field label="A" htmlFor="cmp-a"><Select id="cmp-a" value={va} onChange={setA} options={choices} /></Field>
        {info.binary && <Field label="B" htmlFor="cmp-b"><Select id="cmp-b" value={vb} onChange={setB} options={choices} /></Field>}
      </div>
      <Field label="Name" htmlFor="cmp-name" error={taken ? "A variable of this name exists already and would be replaced." : undefined}>
        <TextField id="cmp-name" value={name} onChange={setName} placeholder={suggested} mono />
      </Field>
      <div className="row" style={{ marginTop: 10 }}>
        <Button
          kind="primary"
          disabled={!va || (info.binary && (!vb || va === vb)) || !finalName}
          onClick={() => {
            onResult(compute(ds, op, va, vb, finalName));
            setName("");
          }}
        >
          Add variable
        </Button>
      </div>
    </>
  );
}

/** Add a variable that says what was annotated on a layer at the time of each row. */
function LinkTool({ ds, onResult }: { ds: Dataset; onResult: (col: Column) => void }) {
  const files = useStore((st) => st.files);
  const scheme = useStore((st) => st.scheme);
  const layers = useLayers();
  const numeric = variableOptions(ds, "number");
  // The variable that names the recording: the one whose values are file names of the corpus.
  const fileNames = useMemo(() => new Set(files.map((f) => f.name)), [files]);
  const fileColumn = useMemo(() => ds.columns.find((c) => c.type === "string" && c.values.slice(0, 200).some((v) => fileNames.has(v.trim())))?.name ?? "", [ds, fileNames]);
  // Variables that name a participant of the corpus.
  const people = useMemo(() => {
    const known = new Set(listParticipants(files, scheme));
    return ds.columns.filter((c) => c.type === "string" && c.name !== fileColumn && c.values.length > 0 && c.values.slice(0, 200).every((v) => v.trim() === "" || known.has(v.trim()))).map((c) => c.name);
  }, [ds, files, scheme, fileColumn]);
  const timeDefault = (numeric.find((o) => /^(time|start|reference_time)(_s)?$/i.test(o.value)) ?? numeric.find((o) => /time|start/i.test(o.value)) ?? numeric[0])?.value ?? "";

  const [layer, setLayer] = useViewState(`stats.link.layer.${ds.id}`, defaultLayer(layers, "categorical", /gaze|gest/i));
  const [filter, setFilter] = useViewState<ValueFilter>(`stats.link.filter.${ds.id}`, ALL_VALUES);
  const [time, setTime] = useViewState(`stats.link.time.${ds.id}`, timeDefault);
  const [who, setWho] = useViewState(`stats.link.who.${ds.id}`, people[0] ? `same:${people[0]}` : "any");
  const [before, setBefore] = useViewState(`stats.link.before.${ds.id}`, 0);
  const [after, setAfter] = useViewState(`stats.link.after.${ds.id}`, 0);
  const [output, setOutput] = useViewState<LinkOptions["output"]>(`stats.link.output.${ds.id}`, "value");
  const [name, setName] = useViewState(`stats.link.name.${ds.id}`, "");
  const values = useLayerValues(layer);

  const whoOptions = [{ value: "any", label: "any tier of the layer" }, ...people.flatMap((p) => [{ value: `same:${p}`, label: `the participant in “${p}”` }, { value: `other:${p}`, label: `the partner of “${p}”` }])];
  const whoValue = whoOptions.some((o) => o.value === who) ? who : "any";
  const timeColumn = numeric.some((o) => o.value === time) ? time : timeDefault;
  const usable = files.length > 0 && fileColumn !== "" && timeColumn !== "" && layers.some((l) => l.name === layer);
  const suggested = freeColumnName(ds, (output === "present" ? `has_${layer}` : `${layer}_at_${timeColumn.replace(/_s$/, "")}`).replace(/[^\p{L}\p{N}_]+/gu, "_"));
  const finalName = name.trim() || suggested;

  const result = useMemo(() => {
    if (!usable) return undefined;
    const opts: LinkOptions = { layer, filter, fileColumn, timeColumn, participant: whoValue === "any" ? "any" : (whoValue.slice(0, whoValue.indexOf(":")) as "same" | "other"), before, after, output };
    if (whoValue !== "any") opts.participantColumn = whoValue.slice(whoValue.indexOf(":") + 1);
    return linkLayer(ds, files, scheme, opts, finalName);
  }, [usable, ds, files, scheme, layer, filter, fileColumn, timeColumn, whoValue, before, after, output, finalName]);

  if (files.length === 0 || fileColumn === "" || numeric.length === 0) {
    return <div style={{ marginTop: 10 }}><Callout kind="info">Linking needs a table that names its recording and a time in seconds — for example single annotations, changes of speaker, alignment instances or search results of the corpus that is loaded.</Callout></div>;
  }
  return (
    <>
      <Field label="Layer to look up" htmlFor="lnk-layer"><LayerSelect id="lnk-layer" value={layer} onChange={(v) => { setLayer(v); setFilter(ALL_VALUES); }} /></Field>
      <FilterField id="lnk-filter" label="Values that count" value={filter} onChange={setFilter} values={values} />
      <Field label="Time of the row (s)" htmlFor="lnk-time" hint={`Recordings are matched by the variable “${fileColumn}”.`}><Select id="lnk-time" value={timeColumn} onChange={setTime} options={numeric} /></Field>
      <Field label="Whose tier" htmlFor="lnk-who"><Select id="lnk-who" value={whoValue} onChange={setWho} options={whoOptions} /></Field>
      <div className="field-row" style={{ marginTop: 9 }}>
        <Field label="From (ms before)" htmlFor="lnk-before"><NumberField id="lnk-before" value={before} min={0} step={100} onChange={setBefore} /></Field>
        <Field label="to (ms after)" htmlFor="lnk-after"><NumberField id="lnk-after" value={after} min={0} step={100} onChange={setAfter} /></Field>
      </div>
      <p className="faint" style={{ margin: "4px 0 9px" }}>{before || after ? "The annotation that fills most of this window is taken." : "0 and 0: the annotation at exactly that moment."}</p>
      <Field label="New variable holds">
        <Segmented value={output} onChange={setOutput} options={[{ value: "value", label: "the value" }, { value: "present", label: "yes / no" }]} />
      </Field>
      <Field label="Name" htmlFor="lnk-name" error={result?.error}>
        <TextField id="lnk-name" value={name} onChange={setName} placeholder={suggested} mono />
      </Field>
      {result && (
        <p className="faint" style={{ margin: "8px 0 0" }}>
          {result.matched.toLocaleString("en-US")} of {ds.rowCount.toLocaleString("en-US")} rows have an annotation there{output === "value" ? "; the others get “(none)”" : ""}.
          {result.unlinked > 0 && ` ${result.unlinked.toLocaleString("en-US")} rows belong to no recording of the corpus or have no time and stay empty.`}
        </p>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <Button
          kind="primary"
          disabled={!result || !!result.error || !finalName}
          onClick={() => {
            if (!result) return;
            onResult(result.column);
            setName("");
          }}
        >
          Add variable
        </Button>
      </div>
    </>
  );
}
