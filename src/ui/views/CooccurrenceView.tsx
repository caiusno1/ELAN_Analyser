import { useEffect, useMemo, useState } from "react";
import { ALL_VALUES, formatDuration, formatTime, type ValueFilter } from "../../core/analysis/common.ts";
import {
  ALLEN_DESCRIPTION, ALLEN_RELATIONS, cooccurrence, cooccurrenceSurrogates, NONE, PAIRING_LABEL, type CooccurrenceOptions, type CooccurrenceSurrogates, type CoocInstance, type Pairing,
} from "../../core/analysis/cooccurrence.ts";
import { contingencyLogBf10, cramersV, cramersVPosterior, oddsRatioPosterior } from "../../core/stats/bayes/contingency.ts";
import { evidenceLabel } from "../../core/stats/bayes/proportions.ts";
import { ChartCard } from "../charts/ChartCard.tsx";
import { Heatmap } from "../charts/Heatmap.tsx";
import { XYChart } from "../charts/XYChart.tsx";
import { useLayerValues, useLayers, useViewState } from "../hooks.ts";
import { Button, Callout, Card, DataTable, DatasetCsvButton, defaultLayer, Empty, Field, FilterField, fmt, fmtBf, LayerSelect, MethodNote, NumberField, PairingSelect, pct, Segmented, SendToStats, Tile } from "../kit.tsx";
import { useStore } from "../store.ts";

type CellMode = "count" | "duration" | "share" | "lift";

export function CooccurrenceView() {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const showInTimeline = useStore((s) => s.showInTimeline);
  const layers = useLayers();
  const [layerX, setLayerX] = useViewState("cooc.x", defaultLayer(layers, "categorical", /gest/i));
  const [layerY, setLayerY] = useViewState("cooc.y", defaultLayer(layers, undefined, /speech|utter|trans/i, layerX));
  const [filterX, setFilterX] = useViewState<ValueFilter>("cooc.fx", ALL_VALUES);
  const [filterY, setFilterY] = useViewState<ValueFilter>("cooc.fy", ALL_VALUES);
  const [pairing, setPairing] = useViewState<Pairing>("cooc.pairing", "same");
  const [minOverlap, setMinOverlap] = useViewState("cooc.min", 0);
  const [mode, setMode] = useViewState<CellMode>("cooc.mode", "count");
  const [cell, setCell] = useState<{ x: string; y: string } | undefined>();
  const [sur, setSur] = useState<CooccurrenceSurrogates | undefined>();
  const [running, setRunning] = useState(false);
  const valuesX = useLayerValues(layerX);
  const valuesY = useLayerValues(layerY);

  const options = useMemo<CooccurrenceOptions>(() => ({ layerX, layerY, filterX, filterY, pairing, minOverlap }), [layerX, layerY, filterX, filterY, pairing, minOverlap]);
  const res = useMemo(() => (layerX && layerY ? cooccurrence(files, scheme, options) : undefined), [files, scheme, options, layerX, layerY]);
  useEffect(() => {
    setSur(undefined);
    setCell(undefined);
  }, [options, files]);

  // Many text values make an unreadable matrix: show the most frequent ones.
  const MAX = 24;
  const shown = useMemo(() => {
    if (!res) return undefined;
    const xi = res.xValues.map((_, i) => i).slice(0, MAX);
    const yi = res.yValues.map((_, i) => i).filter((i) => res.yValues[i] !== NONE).slice(0, MAX);
    return { xi, yi, truncated: res.xValues.length > MAX || res.yValues.length - 1 > MAX };
  }, [res]);

  const test = useMemo(() => {
    if (!res) return undefined;
    // Leave out empty rows and columns; they carry no information.
    const rows = res.anchored.map((r, i) => ({ r, label: res.xValues[i]! })).filter((x) => x.r.some((v) => v > 0));
    const colIdx = res.yValues.map((_, j) => j).filter((j) => rows.some((x) => x.r[j]! > 0));
    if (rows.length < 2 || colIdx.length < 2 || rows.length * colIdx.length > 400) return undefined;
    const table = rows.map((x) => colIdx.map((j) => x.r[j]!));
    const logBf = contingencyLogBf10(table, "independentRows", 1);
    const v = cramersVPosterior(table);
    const or = table.length === 2 && table[0]!.length === 2 ? oddsRatioPosterior(table) : undefined;
    return { table, rowLabels: rows.map((x) => x.label), colLabels: colIdx.map((j) => res.yValues[j]!), logBf, v, observedV: cramersV(table), or };
  }, [res]);

  const lagBins = useLagBins(res?.onsetLags ?? NO_LAGS);

  if (!layerX || !layerY) return <Empty title="Choose two layers" />;
  if (!res || !shown) return null;

  const withAny = res.anchored.reduce((s, row) => s + row.slice(0, -1).reduce((a, b) => a + b, 0), 0);
  const totalX = res.xCounts.reduce((a, b) => a + b, 0);
  const assocOf = new Map(res.association.map((a) => [`${a.xValue}\u0001${a.yValue}`, a]));
  const rowsLabels = shown.xi.map((i) => res.xValues[i]!);
  const colLabels = shown.yi.map((j) => res.yValues[j]!);
  const matrix = shown.xi.map((i) =>
    shown.yi.map((j) => {
      const a = assocOf.get(`${res.xValues[i]}\u0001${res.yValues[j]}`);
      switch (mode) {
        case "count": return res.pairCounts[i]![j]!;
        case "duration": return res.overlapMs[i]![j]! / 1000;
        case "share": return res.xCounts[i]! ? res.anchored[i]![j]! / res.xCounts[i]! : NaN;
        case "lift": return a && a.lift > 0 ? Math.log2(a.lift) : a ? -3 : NaN;
      }
    }),
  );
  const instances: CoocInstance[] = cell ? res.instances.filter((i) => i.xValue === cell.x && i.yValue === cell.y) : res.instances;
  const fileName = new Map(files.map((f) => [f.id, f.name]));
  const ev = test ? evidenceLabel(test.logBf) : undefined;
  const relData = ALLEN_RELATIONS.map((r) => ({ r, n: res.relations[r] })).filter((d) => d.n > 0);
  const runSurrogates = () => {
    setRunning(true);
    setTimeout(() => {
      setSur(cooccurrenceSurrogates(files, scheme, options, 200, 1));
      setRunning(false);
    }, 30);
  };

  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Settings">
          <Field label="Layer X (rows)" htmlFor="co-x"><LayerSelect id="co-x" value={layerX} onChange={setLayerX} /></Field>
          <FilterField id="co-fx" label="Values of X" value={filterX} onChange={setFilterX} values={valuesX} />
          <Field label="Layer Y (columns)" htmlFor="co-y"><LayerSelect id="co-y" value={layerY} onChange={setLayerY} /></Field>
          <FilterField id="co-fy" label="Values of Y" value={filterY} onChange={setFilterY} values={valuesY} />
          <Field label="Which tiers are compared" htmlFor="co-pair" hint={pairing === "same" ? "A's X with A's Y." : pairing === "other" ? "A's X with B's Y: what one participant does while the other does something." : "Every X tier with every Y tier of the file."}>
            <PairingSelect id="co-pair" value={pairing} onChange={setPairing} />
          </Field>
          <Field label="Shortest overlap that counts (ms)" htmlFor="co-min">
            <NumberField id="co-min" value={minOverlap} min={0} max={60000} step={40} onChange={setMinOverlap} />
          </Field>
        </Card>
        <MethodNote refs={["Allen (1983) Commun ACM 26", "Gunel & Dickey (1974) Biometrika 61", "Jamil et al. (2017) Behav Res Methods 49", "Kok (2017) Int J Corpus Linguist 22", "Louwerse et al. (2012) Cogn Sci 36"]}>
          <p>
            Two annotations co-occur when they overlap in time. The <strong>count</strong> matrix counts overlapping pairs, the <strong>duration</strong> matrix sums their overlap. For the <strong>share</strong> view and for the test, every X
            annotation is counted exactly once — under the Y value it overlaps most, or under “{NONE}”.
          </p>
          <p>
            <strong>Association</strong> compares the time two values are present together with the time expected if they were independent (log₂ of observed / expected): 0 means chance, +1 twice as much, −1 half as much.
          </p>
          <p>
            The Bayes factor tests whether the X values differ in what they co-occur with (Gunel & Dickey, rows fixed). It treats annotations as independent observations; for data from several speakers, check the result per file in
            Statistics. The time-shift reference rotates the Y tiers by random amounts, which keeps each tier's own rhythm but removes any coupling.
          </p>
        </MethodNote>
      </div>

      <div className="stack">
        {res.error && <Callout kind="critical">{res.error}</Callout>}
        {res.tierPairs === 0 ? (
          <Empty title="No tiers to compare">
            No file has a tier of “{layerX}” and a tier of “{layerY}” that fit the rule “{PAIRING_LABEL[pairing]}”. Try another rule, or check the participants under “Tiers & layers”.
          </Empty>
        ) : (
          <>
            <div className="tiles">
              <Tile label="Overlapping pairs" value={res.totalInstances.toLocaleString("en-US")} hint={`in ${res.tierPairs} tier pair${res.tierPairs === 1 ? "" : "s"}`} />
              <Tile label={`${layerX} that overlap ${layerY}`} value={totalX ? pct(withAny / totalX) : "–"} hint={`${withAny.toLocaleString("en-US")} of ${totalX.toLocaleString("en-US")} annotations`} />
              <Tile label="Time compared" value={formatDuration(res.observedMs)} hint="recording time, summed over tier pairs" />
            </div>

            <ChartCard
              title={`${layerX} × ${layerY}`}
              sub={
                mode === "count" ? "Number of overlapping annotation pairs." : mode === "duration" ? "Seconds of overlap."
                  : mode === "share" ? `Share of each ${layerX} value that falls mainly on each ${layerY} value.` : "Joint time relative to chance (log₂ of observed / expected)."
              }
              actions={
                <Segmented value={mode} onChange={setMode} options={[{ value: "count", label: "Count" }, { value: "duration", label: "Duration" }, { value: "share", label: "Row share" }, { value: "lift", label: "vs. chance" }]} />
              }
              table={{ columns: [layerX, ...colLabels], rows: rowsLabels.map((r, i) => [r, ...matrix[i]!]) }}
            >
              {rowsLabels.length === 0 || colLabels.length === 0 ? (
                <Empty title="Nothing to show">No annotations match the filters.</Empty>
              ) : (
                <>
                  <Heatmap
                    rows={rowsLabels}
                    cols={colLabels}
                    values={matrix}
                    mode={mode === "lift" ? "diverging" : "sequential"}
                    {...(mode === "lift" ? { max: 3 } : mode === "share" ? { max: 1 } : {})}
                    rowLabel={layerX}
                    colLabel={layerY}
                    legendLabel={mode === "count" ? "pairs" : mode === "duration" ? "seconds" : mode === "share" ? "share of row" : "log₂ lift"}
                    cellText={(r, c) => {
                      const v = matrix[r]![c]!;
                      if (Number.isNaN(v)) return "";
                      return mode === "count" ? String(v) : mode === "share" ? `${Math.round(v * 100)}%` : mode === "duration" ? (v >= 100 ? v.toFixed(0) : v.toFixed(1)) : v.toFixed(1);
                    }}
                    tip={(r, c) => {
                      const i = shown.xi[r]!;
                      const j = shown.yi[c]!;
                      const a = assocOf.get(`${res.xValues[i]}\u0001${res.yValues[j]}`);
                      return {
                        title: `${res.xValues[i]} × ${res.yValues[j]}`,
                        rows: [
                          ["overlapping pairs", String(res.pairCounts[i]![j]!)],
                          ["overlap", formatDuration(res.overlapMs[i]![j]!)],
                          [`of “${res.xValues[i]}” fall mainly on “${res.yValues[j]}”`, res.xCounts[i]! ? pct(res.anchored[i]![j]! / res.xCounts[i]!) : "–"],
                          ...(a ? [["joint time, observed / expected", `${formatDuration(a.joint)} / ${formatDuration(a.expected)}`] as [string, string]] : []),
                        ],
                      };
                    }}
                    onCell={(r, c) => setCell({ x: rowsLabels[r]!, y: colLabels[c]! })}
                    ariaLabel={`Co-occurrence of ${layerX} and ${layerY}`}
                  />
                  {shown.truncated && <p className="faint">Showing the {MAX} most frequent values of each layer. Use the value filters to choose others.</p>}
                </>
              )}
            </ChartCard>

            <div className="cols-2">
              <Card title="Do the values differ in what they co-occur with?" sub={`Each ${layerX} annotation counted once, under the ${layerY} value it overlaps most.`}>
                {test && ev ? (
                  <>
                    <div className="bf">
                      <span className="bf-value">BF₁₀ = {fmtBf(test.logBf)}</span>
                      <span className="bf-text">
                        {ev.favours === "H1" ? `${cap(ev.strength)} evidence for an association.` : ev.favours === "H0" ? `${cap(ev.strength)} evidence for independence.` : "No evidence either way."}
                      </span>
                    </div>
                    <p className="muted" style={{ marginTop: 6 }}>
                      Table of {test.rowLabels.length} × {test.colLabels.length} categories, {test.table.flat().reduce((a, b) => a + b, 0)} annotations. Cramér's V = {fmt(test.observedV)}; posterior median {fmt(test.v.median)}, 95%
                      credible interval {fmt(test.v.ci[0])} to {fmt(test.v.ci[1])}.
                      {test.or && (
                        <>
                          {" "}Odds ratio: median {fmt(test.or.oddsRatio.median)}, 95% credible interval {fmt(test.or.oddsRatio.ci[0])} to {fmt(test.or.oddsRatio.ci[1])}; P(odds ratio &gt; 1) = {fmt(test.or.pGreater1)}.
                        </>
                      )}
                    </p>
                    <div className="table-wrap" style={{ maxHeight: 220, marginTop: 8 }}>
                      <table className="data">
                        <thead><tr><th>{layerX}</th>{test.colLabels.map((c) => <th key={c} className="n">{c}</th>)}</tr></thead>
                        <tbody>{test.table.map((r, i) => <tr key={i}><td>{test.rowLabels[i]}</td>{r.map((v, j) => <td key={j} className="n">{v}</td>)}</tr>)}</tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <p className="muted">The test needs at least two values of each layer with annotations (and not more than 400 cells).</p>
                )}
              </Card>

              <Card
                title="Compared with unrelated timing"
                sub="Chance reference from 200 random time shifts of the Y tiers."
                actions={<Button small icon="play" onClick={runSurrogates} disabled={running}>{running ? "Computing …" : sur ? "Recompute" : "Compute"}</Button>}
                flush={!!sur}
              >
                {sur ? (
                  <DataTable
                    maxHeight={250}
                    rows={shown.xi.flatMap((i) => shown.yi.map((j) => ({ i, j }))).filter(({ i, j }) => res.pairCounts[i]![j]! > 0 || sur.counts.mean[i]![j]! > 0.5)}
                    initialSort={{ key: "ratio", dir: -1 }}
                    columns={[
                      { key: "x", header: layerX, value: (c) => res.xValues[c.i]! },
                      { key: "y", header: layerY, value: (c) => res.yValues[c.j]! },
                      { key: "obs", header: "Observed", value: (c) => res.pairCounts[c.i]![c.j]!, numeric: true },
                      { key: "chance", header: "Chance", value: (c) => sur.counts.mean[c.i]![c.j]!, numeric: true, digits: 1 },
                      { key: "range", header: "95% of shifts", value: (c) => sur.counts.lower[c.i]![c.j]!, render: (c) => `${fmt(sur.counts.lower[c.i]![c.j]!, 1)} – ${fmt(sur.counts.upper[c.i]![c.j]!, 1)}`, numeric: true },
                      { key: "ratio", header: "Observed / chance", value: (c) => (sur.counts.mean[c.i]![c.j]! > 0 ? res.pairCounts[c.i]![c.j]! / sur.counts.mean[c.i]![c.j]! : NaN), numeric: true, digits: 2 },
                    ]}
                  />
                ) : (
                  <p className="muted">
                    How many overlapping pairs would there be if {layerY} had the same annotations but unrelated timing? This is a descriptive reference, not a test.
                  </p>
                )}
              </Card>
            </div>

            <div className="cols-2">
              <ChartCard
                title="How the overlapping annotations relate in time"
                sub={`Allen's interval relations, X = ${layerX}, Y = ${layerY}.`}
                table={{ columns: ["relation", "pairs", "meaning"], rows: relData.map((d) => [d.r, d.n, ALLEN_DESCRIPTION[d.r]]) }}
              >
                {relData.length ? (
                  <XYChart
                    height={Math.max(150, 44 + relData.length * 24)}
                    x={{ type: "linear", zero: true, label: "overlapping pairs", grid: true }}
                    y={{ type: "band", domain: relData.map((d) => d.r) }}
                    marks={[{ type: "bar", horizontal: true, data: relData.map((d) => ({ x: d.r, y: d.n, tip: { title: `X ${d.r} Y`, rows: [["pairs", String(d.n)], ["", ALLEN_DESCRIPTION[d.r]]] } })) }]}
                    ariaLabel="Number of overlapping pairs by temporal relation"
                  />
                ) : <Empty title="No overlapping pairs" />}
              </ChartCard>
              <ChartCard
                title={`Onset of ${layerY} relative to onset of ${layerX}`}
                sub="Overlapping pairs only. Negative: Y started first."
                table={{ columns: ["from (ms)", "to (ms)", "pairs"], rows: lagBins.map((b) => [b.x0, b.x1, b.n]) }}
              >
                {lagBins.length ? (
                  <XYChart
                    x={{ type: "linear", label: "onset of Y − onset of X (ms)" }}
                    y={{ type: "linear", zero: true, label: "pairs" }}
                    marks={[
                      { type: "rect", data: lagBins.map((b) => ({ x0: b.x0, x1: b.x1, y0: 0, y1: b.n, tip: { title: `${fmt(b.x0)} to ${fmt(b.x1)} ms`, rows: [["pairs", String(b.n)]] } })) },
                      { type: "rule", x: 0, color: "var(--text-2)" },
                    ]}
                    ariaLabel="Histogram of onset differences between overlapping annotations"
                  />
                ) : <Empty title="No overlapping pairs" />}
              </ChartCard>
            </div>

            <Card
              title={cell ? `Instances: ${cell.x} × ${cell.y}` : "Instances"}
              sub="Click a row to see it in the timeline."
              actions={
                <>
                  {cell && <Button small kind="ghost" icon="close" onClick={() => setCell(undefined)}>All instances</Button>}
                  <SendToStats dataset={res.dataset} label="Per-file association in Statistics" />
                  <DatasetCsvButton dataset={res.dataset} />
                </>
              }
              flush
            >
              <DataTable<CoocInstance>
                rows={instances}
                csvName="cooccurrence_instances"
                maxHeight={320}
                onRowClick={(r) => showInTimeline({ fileId: r.fileId, start: Math.min(r.xStart, r.yStart), end: Math.max(r.xEnd, r.yEnd), tierId: r.xTier })}
                columns={[
                  { key: "file", header: "File", value: (r) => fileName.get(r.fileId) ?? "" },
                  { key: "x", header: layerX, value: (r) => r.xValue },
                  { key: "y", header: layerY, value: (r) => r.yValue },
                  { key: "start", header: "X starts", value: (r) => r.xStart, render: (r) => <span className="mono">{formatTime(r.xStart)}</span>, numeric: true },
                  { key: "overlap", header: "Overlap (ms)", value: (r) => r.overlap, numeric: true, digits: 0 },
                  { key: "lag", header: "Y onset − X onset (ms)", value: (r) => r.yStart - r.xStart, numeric: true, digits: 0 },
                  { key: "rel", header: "Relation (X … Y)", value: (r) => r.relation },
                  { key: "tiers", header: "Tiers", value: (r) => `${r.xTier} · ${r.yTier}` },
                ]}
              />
              {res.totalInstances > res.instances.length && <p className="faint" style={{ padding: "0 14px 10px" }}>The list holds the first {res.instances.length.toLocaleString("en-US")} of {res.totalInstances.toLocaleString("en-US")} pairs.</p>}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

const NO_LAGS = new Float64Array(0);

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Histogram bins for lags, trimmed to the central 98% so that a few outliers do not flatten the plot. */
function useLagBins(lags: Float64Array): { x0: number; x1: number; n: number }[] {
  return useMemo(() => {
    if (lags.length === 0) return [];
    const sorted = Float64Array.from(lags).sort();
    const lo = sorted[Math.floor(0.01 * (sorted.length - 1))]!;
    const hi = sorted[Math.ceil(0.99 * (sorted.length - 1))]!;
    if (hi <= lo) return [{ x0: lo - 50, x1: lo + 50, n: lags.length }];
    const k = Math.max(8, Math.min(40, Math.round(Math.sqrt(lags.length))));
    const raw = (hi - lo) / k;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
    const start = Math.floor(lo / step) * step;
    const n = Math.ceil((hi - start) / step);
    const counts = new Array<number>(n).fill(0);
    for (const l of lags) {
      const b = Math.floor((l - start) / step);
      if (b >= 0 && b < n) counts[b]!++;
    }
    return counts.map((c, i) => ({ x0: start + i * step, x1: start + (i + 1) * step, n: c }));
  }, [lags]);
}
