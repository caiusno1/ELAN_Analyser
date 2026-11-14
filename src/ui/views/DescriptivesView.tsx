import { useMemo } from "react";
import { ALL_VALUES, formatDuration, type ValueFilter } from "../../core/analysis/common.ts";
import { describeLayer, type DescriptiveRow } from "../../core/analysis/descriptives.ts";
import { median } from "../../core/stats/describe.ts";
import { ChartCard } from "../charts/ChartCard.tsx";
import { GroupChart } from "../charts/GroupChart.tsx";
import { Histogram } from "../charts/Histogram.tsx";
import { useLayerValues, useLayers, useMetaVariables, useViewState } from "../hooks.ts";
import { Callout, Card, DataTable, DatasetCsvButton, defaultLayer, Empty, Field, FilterField, fmt, LayerSelect, MethodNote, pct, Segmented, Select, SendToStats, Tile, Toggle } from "../kit.tsx";
import { useStore } from "../store.ts";

type Measure = "ratePerMin" | "coverage" | "meanDuration" | "medianDuration" | "n";

const MEASURE_LABEL: Record<Measure, string> = {
  ratePerMin: "Annotations per minute",
  coverage: "Share of the recording covered",
  meanDuration: "Mean duration (s)",
  medianDuration: "Median duration (s)",
  n: "Number of annotations",
};

export function DescriptivesView() {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const layers = useLayers();
  const variables = useMetaVariables();
  const [layer, setLayer] = useViewState("desc.layer", defaultLayer(layers, "categorical", /gest/i));
  const [filter, setFilter] = useViewState<ValueFilter>("desc.filter", ALL_VALUES);
  const [byValue, setByValue] = useViewState("desc.byValue", true);
  const [groupBy, setGroupBy] = useViewState("desc.group", "value");
  const [measure, setMeasure] = useViewState<Measure>("desc.measure", "ratePerMin");
  const [logScale, setLogScale] = useViewState("desc.log", true);
  const values = useLayerValues(layer);
  const res = useMemo(() => (layer ? describeLayer(files, scheme, { layer, filter, byValue }) : undefined), [files, scheme, layer, filter, byValue]);
  const fileMeta = useMemo(() => new Map(files.map((f) => [f.id, f.meta])), [files]);

  const groupOptions = [
    ...(byValue ? [{ value: "value", label: "annotation value" }] : []),
    { value: "participant", label: "participant" },
    ...variables.map((v) => ({ value: v, label: v })),
    { value: "none", label: "no grouping" },
  ];
  const group = groupOptions.some((o) => o.value === groupBy) ? groupBy : groupOptions[0]!.value;
  const keyOf = (r: DescriptiveRow) => (group === "value" ? r.value : group === "participant" ? r.participant || "(none)" : group === "none" ? "all" : fileMeta.get(r.fileId)?.[group] || "(none)");

  const { durationSeries, groups, pooled } = useMemo(() => {
    const durBy = new Map<string, number[]>();
    const valBy = new Map<string, { values: number[]; names: string[] }>();
    let n = 0;
    let total = 0;
    const all: number[] = [];
    const tiersSeen = new Map<string, number>();
    for (const r of res?.rows ?? []) {
      const k = keyOf(r);
      const d = res!.durations.get(`${r.fileId}\u0001${r.tier}\u0001${r.value}`);
      if (d) {
        const list = durBy.get(k) ?? [];
        for (const v of d) {
          list.push(v);
          all.push(v);
        }
        durBy.set(k, list);
      }
      const g = valBy.get(k) ?? { values: [], names: [] };
      g.values.push(r[measure]);
      g.names.push(`${r.file}${r.participant ? ` · ${r.participant}` : ""}${byValue ? ` · ${r.value}` : ""}`);
      valBy.set(k, g);
      n += r.n;
      total += r.totalDuration;
      tiersSeen.set(`${r.fileId}\u0001${r.tier}`, r.observed);
    }
    const observedMin = [...tiersSeen.values()].reduce((s, v) => s + v, 0) / 60;
    const order = [...durBy.entries()].sort((a, b) => b[1].length - a[1].length).map((e) => e[0]);
    const top = order.slice(0, 6);
    return {
      durationSeries: top.map((k) => ({ label: k, values: durBy.get(k)! })),
      groups: [...valBy.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).slice(0, 14).map(([k, g]) => ({ label: k, values: g.values, names: g.names })),
      pooled: { n, total, median: all.length ? median(all) : NaN, rate: observedMin > 0 ? n / observedMin : NaN, moreGroups: order.length > 6 },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res, group, measure, byValue, fileMeta]);

  if (!layer) return <Empty title="Choose a layer" />;
  if (!res) return null;

  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Settings">
          <Field label="Layer" htmlFor="de-layer"><LayerSelect id="de-layer" value={layer} onChange={setLayer} /></Field>
          <FilterField id="de-filter" label="Values" value={filter} onChange={setFilter} values={values} />
          <div style={{ marginTop: 10 }}>
            <Toggle id="de-byvalue" checked={byValue} onChange={setByValue}>Each annotation value separately</Toggle>
          </div>
        </Card>
        <MethodNote>
          <p>
            <strong>Rate</strong> is the number of annotations divided by the length of the recording (the end of its last annotation on any tier), with a 95% credible interval for a Poisson rate under the Jeffreys prior.{" "}
            <strong>Coverage</strong> is the share of the recording during which an annotation is present.
          </p>
          <p>Durations are usually right-skewed, so the histogram uses a logarithmic axis by default; for modelling durations, the log-normal family in Statistics is the natural choice.</p>
        </MethodNote>
      </div>
      <div className="stack">
        {res.error && <Callout kind="critical">{res.error}</Callout>}
        {res.rows.length === 0 ? (
          <Empty title="No annotations">Nothing on the layer “{layer}” matches the filter.</Empty>
        ) : (
          <>
            <div className="tiles">
              <Tile label="Annotations" value={pooled.n.toLocaleString("en-US")} />
              <Tile label="Annotated time" value={formatDuration(pooled.total * 1000)} />
              <Tile label="Median duration" value={formatDuration(pooled.median * 1000)} />
              <Tile label="Per minute" value={fmt(pooled.rate)} hint="per tier, all recordings pooled" />
            </div>
            <div className="row">
              <Field label="Compare by" htmlFor="de-group"><Select id="de-group" value={group} onChange={setGroupBy} options={groupOptions} /></Field>
              <Field label="Measure" htmlFor="de-measure">
                <Select id="de-measure" value={measure} onChange={setMeasure} options={(Object.keys(MEASURE_LABEL) as Measure[]).map((m) => ({ value: m, label: MEASURE_LABEL[m] }))} />
              </Field>
              <span className="spacer" />
              <SendToStats dataset={res.dataset} label="Summary table in Statistics" />
              <SendToStats dataset={res.annotations} label="Single annotations in Statistics" />
            </div>
            <div className="cols-2">
              <ChartCard
                title={MEASURE_LABEL[measure]}
                sub={`One dot per tier${byValue ? " and value" : ""}; black: group mean with 95% credible interval.`}
                table={{ columns: [group, "n", "mean"], rows: groups.map((g) => [g.label, g.values.length, g.values.filter((v) => !Number.isNaN(v)).reduce((s, v) => s + v, 0) / Math.max(1, g.values.filter((v) => !Number.isNaN(v)).length)]) }}
              >
                <GroupChart groups={groups} yLabel={MEASURE_LABEL[measure]} xLabel={groupOptions.find((o) => o.value === group)!.label} zero />
              </ChartCard>
              <ChartCard
                title="Durations"
                sub={durationSeries.length > 1 ? `Share of each group's annotations per duration bin${pooled.moreGroups ? " (six largest groups)" : ""}.` : "Number of annotations per duration bin."}
                actions={<Segmented value={logScale ? "log" : "linear"} onChange={(v) => setLogScale(v === "log")} options={[{ value: "log", label: "Log" }, { value: "linear", label: "Linear" }]} />}
              >
                <Histogram series={durationSeries} xLabel="duration (s)" log={logScale} format={(v) => (v < 10 ? String(Number(v.toPrecision(2))) : fmt(v, 2))} />
              </ChartCard>
            </div>
            <Card title="By tier" sub="Click a column to sort." actions={<DatasetCsvButton dataset={res.dataset} />} flush>
              <DataTable<DescriptiveRow>
                rows={res.rows}
                csvName={`descriptives_${layer}`}
                columns={[
                  { key: "file", header: "File", value: (r) => r.file },
                  { key: "participant", header: "Participant", value: (r) => r.participant || "–" },
                  ...(byValue ? [{ key: "value", header: "Value", value: (r: DescriptiveRow) => r.value }] : []),
                  { key: "n", header: "n", value: (r) => r.n, numeric: true },
                  { key: "rate", header: "Per min", value: (r) => r.ratePerMin, numeric: true, digits: 2, title: "Annotations per minute of recording" },
                  { key: "rateci", header: "95% CrI", value: (r) => r.rateCi[0], render: (r) => `${fmt(r.rateCi[0], 2)} – ${fmt(r.rateCi[1], 2)}`, numeric: true, title: "Credible interval of the rate" },
                  { key: "cov", header: "Coverage", value: (r) => r.coverage, render: (r) => pct(r.coverage), numeric: true },
                  { key: "total", header: "Total (s)", value: (r) => r.totalDuration, numeric: true, digits: 2 },
                  { key: "mean", header: "Mean (s)", value: (r) => r.meanDuration, numeric: true },
                  { key: "median", header: "Median (s)", value: (r) => r.medianDuration, numeric: true },
                  { key: "sd", header: "SD (s)", value: (r) => r.sdDuration, numeric: true },
                  { key: "min", header: "Min (s)", value: (r) => r.minDuration, numeric: true },
                  { key: "max", header: "Max (s)", value: (r) => r.maxDuration, numeric: true },
                  { key: "latency", header: "First at (s)", value: (r) => r.latency, numeric: true, digits: 1 },
                ]}
              />
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
