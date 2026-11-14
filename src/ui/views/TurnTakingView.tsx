import { useMemo } from "react";
import { ALL_VALUES, formatDuration, formatTime, type ValueFilter } from "../../core/analysis/common.ts";
import { analyseTurnTaking, DEFAULT_TURN_TAKING, FLOOR_LABEL, type FloorKind, type FloorTransfer } from "../../core/analysis/turntaking.ts";
import { median } from "../../core/stats/describe.ts";
import { ChartCard } from "../charts/ChartCard.tsx";
import { GroupChart } from "../charts/GroupChart.tsx";
import { binValues } from "../charts/Histogram.tsx";
import { XYChart } from "../charts/XYChart.tsx";
import { useLayerValues, useLayers, useMetaVariables, useViewState } from "../hooks.ts";
import { Callout, Card, DataTable, DatasetCsvButton, defaultLayer, Empty, Field, FilterField, fmt, LayerSelect, MethodNote, NumberField, pct, Select, SendToStats, Tile } from "../kit.tsx";
import { useStore } from "../store.ts";

const STATE_COLOR: Record<FloorKind, string> = {
  speech: "var(--series-1)",
  gap: "var(--series-other)",
  pause: "var(--surface-3)",
  "overlap-between": "var(--series-8)",
  "overlap-within": "var(--series-4)",
  silence: "var(--surface-2)",
};

export function TurnTakingView() {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const showInTimeline = useStore((s) => s.showInTimeline);
  const layers = useLayers();
  const variables = useMetaVariables();
  const [layer, setLayer] = useViewState("tt.layer", defaultLayer(layers, "text", /speech|utter|trans|orth/i));
  const [filter, setFilter] = useViewState<ValueFilter>("tt.filter", ALL_VALUES);
  const [minPause, setMinPause] = useViewState("tt.minPause", DEFAULT_TURN_TAKING.minPause);
  const [minDuration, setMinDuration] = useViewState("tt.minDuration", DEFAULT_TURN_TAKING.minDuration);
  const [groupBy, setGroupBy] = useViewState("tt.group", variables[variables.length - 1] ?? "direction");
  const values = useLayerValues(layer);
  const res = useMemo(() => (layer ? analyseTurnTaking(files, scheme, { layer, filter, minPause, minDuration }) : undefined), [files, scheme, layer, filter, minPause, minDuration]);
  const fileById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);

  const bins = useMemo(() => (res ? binValues(res.ftos, { lo: -1500, hi: 2500, bins: 40, trim: 0 }) : []), [res]);
  const states = useMemo(() => {
    const total: Record<FloorKind, number> = { speech: 0, gap: 0, pause: 0, "overlap-between": 0, "overlap-within": 0, silence: 0 };
    for (const f of res?.files ?? []) for (const k of Object.keys(total) as FloorKind[]) total[k] += f.stateTime[k];
    const sum = Object.values(total).reduce((a, b) => a + b, 0);
    return (Object.keys(total) as FloorKind[]).map((k) => ({ kind: k, ms: total[k], share: sum ? total[k] / sum : 0 }));
  }, [res]);
  const groups = useMemo(() => {
    // Median offset per file (and direction), grouped by the chosen variable.
    const acc = new Map<string, { values: number[]; names: string[] }>();
    for (const f of res?.files ?? []) {
      const byDir = new Map<string, number[]>();
      for (const t of f.transfers) {
        const key = groupBy === "direction" ? `${t.from}→${t.to}` : "all";
        byDir.set(key, [...(byDir.get(key) ?? []), t.fto]);
      }
      for (const [dir, ftos] of byDir) {
        const label = groupBy === "direction" ? dir : fileById.get(f.fileId)?.meta[groupBy] || "(none)";
        const g = acc.get(label) ?? { values: [], names: [] };
        g.values.push(median(ftos));
        g.names.push(f.fileName);
        acc.set(label, g);
      }
    }
    return [...acc.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([label, g]) => ({ label, ...g }));
  }, [res, groupBy, fileById]);

  if (!layer) return <Empty title="Choose the layer that holds the speech">Turn-taking needs one speech tier per participant.</Empty>;
  if (!res) return null;
  const transfers = res.files.flatMap((f) => f.transfers);
  const fileName = (id: string) => fileById.get(id)?.name ?? "";

  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Settings">
          <Field label="Speech layer" htmlFor="tt-layer"><LayerSelect id="tt-layer" value={layer} onChange={setLayer} /></Field>
          <FilterField id="tt-filter" label="Annotations that count as speech" value={filter} onChange={setFilter} values={values} />
          <Field label="Shortest pause that splits a talkspurt (ms)" htmlFor="tt-pause" hint="Shorter silences inside one speaker's talk are bridged.">
            <NumberField id="tt-pause" value={minPause} min={0} max={5000} step={20} onChange={setMinPause} />
          </Field>
          <Field label="Ignore annotations shorter than (ms)" htmlFor="tt-min" hint="For example 500 to leave out brief feedback such as “mhm”.">
            <NumberField id="tt-min" value={minDuration} min={0} max={10000} step={50} onChange={setMinDuration} />
          </Field>
        </Card>
        <MethodNote refs={["Sacks, Schegloff & Jefferson (1974) Language 50", "Heldner & Edlund (2010) J Phon 38", "Stivers et al. (2009) PNAS 106", "Levinson & Torreira (2015) Front Psychol 6"]}>
          <p>
            Each speaker's annotations are joined into talkspurts. Silences and overlaps are then classified by who talks before and after: a silence between different speakers is a <strong>gap</strong>, within one speaker a{" "}
            <strong>pause</strong>; an overlap that ends in a change of speaker is a <strong>between-speaker overlap</strong>.
          </p>
          <p>
            The <strong>floor transfer offset</strong> (FTO) of a change of speaker is the length of the gap, or minus the length of the overlap. Across languages it peaks a little above zero — around 200 ms.
          </p>
          <p>Offsets from one conversation are not independent observations. To compare conditions, use one value per file, or a multilevel model with the file as grouping factor, in Statistics.</p>
        </MethodNote>
      </div>
      <div className="stack">
        {res.error && <Callout kind="critical">{res.error}</Callout>}
        {res.files.length === 0 ? (
          <Empty title="No conversation found on this layer">Turn-taking needs at least two speakers per file on the layer “{layer}”.</Empty>
        ) : (
          <>
            <div className="tiles">
              <Tile label="Changes of speaker" value={res.summary.transfers.toLocaleString("en-US")} hint={`in ${res.files.length} file${res.files.length === 1 ? "" : "s"}`} />
              <Tile label="Median transfer offset" value={`${fmt(res.summary.median, 3)} ms`} hint={`mean ${fmt(res.summary.mean, 3)} ms, SD ${fmt(res.summary.sd, 3)} ms`} />
              <Tile label="With overlap" value={pct(res.summary.overlapShare)} hint={`gap: ${pct(res.summary.gapShare)}`} />
              <Tile label="Within ±200 ms" value={pct(res.summary.within200)} hint="smooth transitions" />
            </div>
            {res.skipped.length > 0 && <Callout kind="warning">Left out (fewer than two speakers): {res.skipped.slice(0, 8).join(", ")}{res.skipped.length > 8 ? " …" : ""}</Callout>}
            <div className="cols-2">
              <ChartCard
                title="Floor transfer offsets"
                sub="Negative: the next speaker started before the previous one had finished."
                table={{ columns: ["from (ms)", "to (ms)", "transfers"], rows: bins.map((b) => [b.x0, b.x1, b.n]) }}
              >
                <XYChart
                  x={{ type: "linear", label: "floor transfer offset (ms)", nice: false }}
                  y={{ type: "linear", zero: true, label: "changes of speaker" }}
                  marks={[
                    { type: "rect", data: bins.map((b) => ({ x0: b.x0, x1: b.x1, y0: 0, y1: b.n, color: b.x1 <= 0 ? "var(--series-8)" : "var(--series-1)", tip: { title: `${b.x0} to ${b.x1} ms`, rows: [["changes of speaker", String(b.n)]] } })) },
                    { type: "rule", x: 0, color: "var(--text-2)" },
                    { type: "rule", x: res.summary.median, color: "var(--text)", label: `median ${fmt(res.summary.median, 3)} ms` },
                  ]}
                  legend={[{ label: "overlap", color: "var(--series-8)" }, { label: "gap", color: "var(--series-1)" }]}
                  ariaLabel="Histogram of floor transfer offsets"
                />
                <p className="faint">Offsets beyond −1.5 s and +2.5 s are collected in the outermost bars.</p>
              </ChartCard>
              <ChartCard
                title="Median offset per recording"
                sub="One dot per file; black: group mean with 95% credible interval."
                actions={
                  <Select value={groupBy} onChange={setGroupBy} options={[...variables.map((v) => ({ value: v, label: `by ${v}` })), { value: "direction", label: "by direction" }]} />
                }
                table={{ columns: [groupBy, "files", "mean of medians (ms)"], rows: groups.map((g) => [g.label, g.values.length, g.values.reduce((a, b) => a + b, 0) / g.values.length]) }}
              >
                <GroupChart groups={groups} yLabel="median offset (ms)" xLabel={groupBy} />
              </ChartCard>
            </div>
            <Card title="Where the time goes" sub="Share of the recording time in each floor state, all files.">
              <div style={{ display: "flex", height: 28, gap: 2 }} role="img" aria-label={states.map((s) => `${FLOOR_LABEL[s.kind]}: ${pct(s.share)}`).join(", ")}>
                {states.filter((s) => s.share > 0).map((s) => (
                  <div key={s.kind} title={`${FLOOR_LABEL[s.kind]}: ${pct(s.share)} (${formatDuration(s.ms)})`} style={{ flex: `${s.share} 0 0`, background: STATE_COLOR[s.kind], borderRadius: 4, minWidth: 2, display: "grid", placeItems: "center", overflow: "hidden", color: s.kind === "speech" || s.kind === "overlap-between" ? "#fff" : "var(--text)", fontSize: 11.5 }}>
                    {s.share > 0.07 ? pct(s.share, 0) : ""}
                  </div>
                ))}
              </div>
              <div className="chart-legend" style={{ marginTop: 8 }}>
                {states.filter((s) => s.share > 0).map((s) => (
                  <span className="key" key={s.kind}><span className="swatch" style={{ background: STATE_COLOR[s.kind] }} />{FLOOR_LABEL[s.kind]} {pct(s.share)}</span>
                ))}
              </div>
            </Card>
            <div className="cols-2">
              <Card title="Speakers" actions={<><SendToStats dataset={res.speakerDataset} /><DatasetCsvButton dataset={res.speakerDataset} /></>} flush>
                <DataTable
                  rows={res.files.flatMap((f) => f.bySpeaker.map((s) => ({ f, s })))}
                  maxHeight={300}
                  csvName="speaking_time"
                  columns={[
                    { key: "file", header: "File", value: (r) => r.f.fileName },
                    { key: "sp", header: "Speaker", value: (r) => r.s.speaker },
                    { key: "share", header: "Speaking share", value: (r) => r.s.share, render: (r) => pct(r.s.share), numeric: true },
                    { key: "spurts", header: "Talkspurts", value: (r) => r.s.talkspurts, numeric: true },
                    { key: "mean", header: "Mean (s)", value: (r) => r.s.meanTalkspurt / 1000, numeric: true },
                    { key: "turns", header: "Turns taken", value: (r) => r.s.turnsTaken, numeric: true },
                    { key: "fto", header: "Median FTO (ms)", value: (r) => r.s.medianFto, numeric: true, digits: 3 },
                  ]}
                />
              </Card>
              <Card title="Changes of speaker" sub="Click a row to see it in the timeline." actions={<><SendToStats dataset={res.dataset} /><DatasetCsvButton dataset={res.dataset} /></>} flush>
                <DataTable<FloorTransfer>
                  rows={transfers}
                  maxHeight={300}
                  csvName="floor_transfers"
                  onRowClick={(t) => showInTimeline({ fileId: t.fileId, start: t.time - Math.max(0, t.fto), end: t.time + Math.max(0, -t.fto) + 1 })}
                  columns={[
                    { key: "file", header: "File", value: (t) => fileName(t.fileId) },
                    { key: "dir", header: "From → to", value: (t) => `${t.from} → ${t.to}` },
                    { key: "time", header: "At", value: (t) => t.time, render: (t) => <span className="mono">{formatTime(t.time, false)}</span>, numeric: true },
                    { key: "fto", header: "Offset (ms)", value: (t) => t.fto, numeric: true, digits: 0 },
                    { key: "kind", header: "Kind", value: (t) => t.kind },
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
