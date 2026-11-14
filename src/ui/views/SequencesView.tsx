import { useMemo } from "react";
import { ALL_VALUES, formatTime, type ValueFilter } from "../../core/analysis/common.ts";
import { buildSequences, lagProfile, markovOrders, ngrams, sequenceEntropy, transitionDataset, transitionTable, type NGramRow } from "../../core/analysis/sequences.ts";
import { ChartCard } from "../charts/ChartCard.tsx";
import { Heatmap } from "../charts/Heatmap.tsx";
import { XYChart } from "../charts/XYChart.tsx";
import { useLayerValues, useLayers, useViewState } from "../hooks.ts";
import { Callout, Card, CheckList, DataTable, defaultLayer, Empty, Field, FilterField, fmt, fmtBf, MethodNote, NumberField, pct, Segmented, Select, SendToStats, Tile, Toggle } from "../kit.tsx";
import { useStore } from "../store.ts";

type CellMode = "probability" | "count" | "lift";

export function SequencesView() {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const showInTimeline = useStore((s) => s.showInTimeline);
  const layers = useLayers();
  const [selected, setSelected] = useViewState<string[]>("seq.layers", [defaultLayer(layers, "categorical", /phase|gest|gaze/i)].filter(Boolean));
  const [stream, setStream] = useViewState<"tier" | "file">("seq.stream", "tier");
  const [labelParticipant, setLabelParticipant] = useViewState("seq.participant", false);
  const [collapse, setCollapse] = useViewState("seq.collapse", false);
  const [breakGap, setBreakGap] = useViewState("seq.gap", 0);
  const [filter, setFilter] = useViewState<ValueFilter>("seq.filter", ALL_VALUES);
  const [mode, setMode] = useViewState<CellMode>("seq.mode", "probability");
  const [n, setN] = useViewState("seq.n", 3);
  const [from, setFrom] = useViewState("seq.from", "");
  const [to, setTo] = useViewState("seq.to", "");
  const values = useLayerValues(selected[0] ?? "");

  const seq = useMemo(
    () => (selected.length ? buildSequences(files, scheme, { layers: selected, stream, labelParticipant, collapseRepeats: collapse, breakGap, filter }) : undefined),
    [files, scheme, selected, stream, labelParticipant, collapse, breakGap, filter],
  );
  const cells = useMemo(() => (seq ? transitionTable(seq) : []), [seq]);
  const orders = useMemo(() => (seq && seq.symbols.length >= 2 && seq.symbols.length <= 60 ? markovOrders(seq, 2) : []), [seq]);
  const entropy = useMemo(() => (seq ? sequenceEntropy(seq) : undefined), [seq]);
  const grams = useMemo(() => (seq ? ngrams(seq, n, 1).slice(0, 2000) : []), [seq, n]);
  const dataset = useMemo(() => (seq ? transitionDataset(seq, `Transitions: ${selected.join(" + ")}`) : undefined), [seq, selected]);
  const fromSym = seq?.symbols.includes(from) ? from : seq?.symbols[0] ?? "";
  const toSym = seq?.symbols.includes(to) ? to : seq?.symbols[1] ?? seq?.symbols[0] ?? "";
  const profile = useMemo(() => (seq && fromSym && toSym ? lagProfile(seq, fromSym, toSym, 8) : []), [seq, fromSym, toSym]);

  if (selected.length === 0 || !seq) {
    return (
      <div className="view-grid">
        <Card title="Settings"><Field label="Layers"><CheckList options={layers.map((l) => ({ value: l.name, label: l.name }))} selected={selected} onChange={setSelected} /></Field></Card>
        <Empty title="Choose at least one layer" />
      </div>
    );
  }
  const MAX = 22;
  const syms = seq.symbols.slice(0, MAX);
  const cellOf = new Map(cells.map((c) => [`${c.from}\u0001${c.to}`, c]));
  const matrix = syms.map((a) =>
    syms.map((b) => {
      const c = cellOf.get(`${a}\u0001${b}`);
      if (!c) return NaN;
      return mode === "probability" ? c.probability : mode === "count" ? c.count : c.lift > 0 ? Math.log2(c.lift) : -3;
    }),
  );
  const bf10 = orders.length >= 2 ? orders[1]!.logMarginal - orders[0]!.logMarginal : NaN;
  const base = seq.totalTransitions ? (seq.transitions.reduce((s, row) => s + (row[seq.symbols.indexOf(toSym)] ?? 0), 0) / seq.totalTransitions) : NaN;

  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Settings">
          <Field label="Layers"><CheckList options={layers.map((l) => ({ value: l.name, label: `${l.name} (${l.annotationCount.toLocaleString("en-US")})` }))} selected={selected} onChange={setSelected} /></Field>
          <Field label="What forms a sequence" hint={stream === "tier" ? "Each tier on its own: what one participant does next." : "All chosen tiers of a file in one stream, ordered by onset: who does what after whom."}>
            <Segmented value={stream} onChange={setStream} options={[{ value: "tier", label: "Each tier" }, { value: "file", label: "Whole file" }]} />
          </Field>
          <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10 }}>
            <Toggle id="sq-part" checked={labelParticipant} onChange={setLabelParticipant}>Tell participants apart (A:nod, B:nod)</Toggle>
            <Toggle id="sq-collapse" checked={collapse} onChange={setCollapse}>Count immediate repeats once</Toggle>
          </div>
          <Field label="Break a sequence after a silence of (ms)" htmlFor="sq-gap" hint="0 = never. Transitions are not counted across a break.">
            <NumberField id="sq-gap" value={breakGap} min={0} max={600000} step={100} onChange={setBreakGap} />
          </Field>
          <FilterField id="sq-filter" label="Values" value={filter} onChange={setFilter} values={values} />
        </Card>
        <MethodNote refs={["Bakeman & Quera (2011) Sequential Analysis and Observational Methods", "Strelioff, Crutchfield & Hübler (2007) Phys Rev E 76"]}>
          <p>
            Annotations are ordered by onset. The matrix shows, for each event (row), what comes next (column). <strong>Probability</strong> is the posterior mean of P(next | current) with a uniform Dirichlet prior on each row, and comes
            with a credible interval in the table. <strong>vs. base rate</strong> divides it by how often the next event occurs after anything (log₂ scale).
          </p>
          <p>
            The order comparison scores three models of the same sequences by their marginal likelihood: events are independent (order 0), depend on the previous event (order 1), or on the previous two (order 2).
          </p>
        </MethodNote>
      </div>
      <div className="stack">
        {seq.error && <Callout kind="critical">{seq.error}</Callout>}
        {seq.totalEvents === 0 ? (
          <Empty title="No events">Nothing on the chosen layers matches the filter.</Empty>
        ) : (
          <>
            <div className="tiles">
              <Tile label="Events" value={seq.totalEvents.toLocaleString("en-US")} hint={`${seq.symbols.length} different`} />
              <Tile label="Transitions" value={seq.totalTransitions.toLocaleString("en-US")} />
              <Tile label="Uncertainty about the next event" value={entropy ? `${fmt(entropy.conditional, 2)} bits` : "–"} hint={entropy ? `${fmt(entropy.entropy, 2)} bits without knowing the current one` : undefined} />
              {orders.length >= 2 && <Tile label="Depends on the previous event" value={`BF₁₀ = ${fmtBf(bf10)}`} hint="order 1 against order 0" />}
            </div>
            <ChartCard
              title="What follows what"
              sub="Row: current event. Column: next event."
              actions={<Segmented value={mode} onChange={setMode} options={[{ value: "probability", label: "Probability" }, { value: "count", label: "Count" }, { value: "lift", label: "vs. base rate" }]} />}
              table={{ columns: ["current", ...syms], rows: syms.map((a, i) => [a, ...matrix[i]!]) }}
            >
              <Heatmap
                rows={syms}
                cols={syms}
                values={matrix}
                mode={mode === "lift" ? "diverging" : "sequential"}
                {...(mode === "probability" ? { max: 1 } : mode === "lift" ? { max: 3 } : {})}
                rowLabel="current"
                colLabel="next"
                legendLabel={mode === "probability" ? "P(next | current)" : mode === "count" ? "transitions" : "log₂ lift"}
                cellText={(r, c) => {
                  const v = matrix[r]![c]!;
                  return Number.isNaN(v) ? "" : mode === "probability" ? (v >= 0.005 ? `${Math.round(v * 100)}%` : "") : mode === "count" ? (v ? String(v) : "") : v.toFixed(1);
                }}
                tip={(r, c) => {
                  const cell = cellOf.get(`${syms[r]}\u0001${syms[c]}`);
                  return cell
                    ? { title: `${cell.from} → ${cell.to}`, rows: [["transitions", String(cell.count)], ["probability", `${pct(cell.probability)} (${pct(cell.ci[0])} – ${pct(cell.ci[1])})`], ["base rate", pct(cell.baseRate)], ["probability that it exceeds the base rate", fmt(cell.pAboveBase, 3)]] }
                    : `${syms[r]} never occurs before another event`;
                }}
                onCell={(r, c) => { setFrom(syms[r]!); setTo(syms[c]!); }}
                ariaLabel="Transition matrix between event types"
              />
              {seq.symbols.length > MAX && <p className="faint">Showing the {MAX} most frequent of {seq.symbols.length} event types.</p>}
            </ChartCard>
            <div className="cols-2">
              <Card title="How much history matters" sub="Posterior probability of each Markov order (equal prior odds).">
                {orders.length ? (
                  <XYChart
                    height={170}
                    x={{ type: "band", domain: orders.map((o) => `order ${o.order}`) }}
                    y={{ type: "linear", domain: [0, 1], label: "posterior probability", format: (v) => `${Math.round(v * 100)}%` }}
                    marks={[{ type: "bar", data: orders.map((o) => ({ x: `order ${o.order}`, y: o.posterior, tip: { title: `Order ${o.order}`, rows: [["posterior probability", pct(o.posterior)], ["free parameters", String(o.parameters)], ["ln marginal likelihood", fmt(o.logMarginal, 5)]] } })) }]}
                    ariaLabel="Posterior probability of Markov orders 0, 1 and 2"
                  />
                ) : (
                  <p className="muted">The comparison needs between 2 and 60 different event types.</p>
                )}
                <p className="muted" style={{ marginTop: 6 }}>Order 0: events are independent. Order 1: the next event depends on the current one. Order 2: on the current and the previous one.</p>
              </Card>
              <ChartCard
                title={`${toSym} after ${fromSym}`}
                sub="Probability by distance in events. Click a cell of the matrix to choose a pair."
                actions={
                  <>
                    <Select value={fromSym} onChange={setFrom} options={seq.symbols.slice(0, 200).map((s) => ({ value: s, label: s }))} />
                    <Select value={toSym} onChange={setTo} options={seq.symbols.slice(0, 200).map((s) => ({ value: s, label: s }))} />
                  </>
                }
                table={{ columns: ["events later", "probability", "n"], rows: profile.map((p) => [p.lag, p.probability, p.n]) }}
              >
                <XYChart
                  height={190}
                  crosshair
                  crosshairFormat={(v) => `${v} event${v === 1 ? "" : "s"} later`}
                  x={{ type: "linear", domain: [1, 8], label: "events later" }}
                  y={{ type: "linear", zero: true, label: "probability", format: (v) => `${Math.round(v * 100)}%` }}
                  legend={[{ label: `${toSym} after ${fromSym}`, color: "var(--series-1)", kind: "line" }, { label: "base rate", color: "var(--text-2)", kind: "line", dash: true }]}
                  marks={[
                    { type: "line", color: "var(--series-1)", label: `${toSym} after ${fromSym}`, points: profile.map((p) => [p.lag, p.probability]) },
                    { type: "dot", color: "var(--series-1)", data: profile.map((p) => ({ x: p.lag, y: p.probability })) },
                    { type: "line", color: "var(--text-2)", dash: "5 4", width: 1.5, points: [[1, base], [8, base]] },
                  ]}
                  ariaLabel="Probability of one event following another, by distance"
                />
              </ChartCard>
            </div>
            <div className="cols-2">
              <Card title="Recurring sequences" sub="Click a row for an example in the timeline." actions={<Segmented value={String(n)} onChange={(v) => setN(Number(v))} options={[2, 3, 4, 5].map((k) => ({ value: String(k), label: `${k} events` }))} />} flush>
                <DataTable<NGramRow>
                  rows={grams}
                  maxHeight={300}
                  csvName={`sequences_${n}`}
                  onRowClick={(g) => showInTimeline({ fileId: g.example.fileId, start: g.example.start, end: g.example.end })}
                  columns={[
                    { key: "gram", header: "Sequence", value: (g) => g.gram.join(" → ") },
                    { key: "count", header: "Count", value: (g) => g.count, numeric: true },
                    { key: "files", header: "Files", value: (g) => g.files, numeric: true },
                    { key: "ex", header: "Example at", value: (g) => g.example.start, render: (g) => <span className="mono">{formatTime(g.example.start, false)}</span>, numeric: true },
                  ]}
                />
              </Card>
              <Card title="Transitions" actions={<SendToStats dataset={dataset} />} flush>
                <DataTable
                  rows={cells.filter((c) => c.count > 0)}
                  maxHeight={300}
                  csvName="transitions"
                  initialSort={{ key: "count", dir: -1 }}
                  columns={[
                    { key: "from", header: "Current", value: (c) => c.from },
                    { key: "to", header: "Next", value: (c) => c.to },
                    { key: "count", header: "Count", value: (c) => c.count, numeric: true },
                    { key: "p", header: "Probability", value: (c) => c.probability, render: (c) => pct(c.probability), numeric: true },
                    { key: "ci", header: "95% CrI", value: (c) => c.ci[0], render: (c) => `${pct(c.ci[0], 0)} – ${pct(c.ci[1], 0)}`, numeric: true },
                    { key: "lift", header: "× base rate", value: (c) => c.lift, numeric: true, digits: 2 },
                  ]}
                />
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
