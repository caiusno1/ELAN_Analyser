import { useMemo } from "react";
import { ALL_VALUES, formatTime, type ValueFilter } from "../../core/analysis/common.ts";
import { analyseTemporal, type TierTemporal } from "../../core/analysis/temporal.ts";
import { evidenceLabel } from "../../core/stats/bayes/proportions.ts";
import { median } from "../../core/stats/describe.ts";
import { ChartCard } from "../charts/ChartCard.tsx";
import { Histogram } from "../charts/Histogram.tsx";
import { XYChart } from "../charts/XYChart.tsx";
import { useLayerValues, useLayers, useViewState } from "../hooks.ts";
import { Callout, Card, DataTable, DatasetCsvButton, defaultLayer, Empty, Field, FilterField, fmt, fmtBf, LayerSelect, MethodNote, NumberField, Select, SendToStats, Tile } from "../kit.tsx";
import { useStore } from "../store.ts";

export function TemporalView() {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const layers = useLayers();
  const [layer, setLayer] = useViewState("temp.layer", defaultLayer(layers, "categorical", /gest/i));
  const [filter, setFilter] = useViewState<ValueFilter>("temp.filter", ALL_VALUES);
  const [bin, setBin] = useViewState("temp.bin", 15);
  const [tierIndex, setTierIndex] = useViewState("temp.tier", 0);
  const values = useLayerValues(layer);
  const res = useMemo(() => (layer ? analyseTemporal(files, scheme, { layer, filter, bin: bin * 1000 }) : undefined), [files, scheme, layer, filter, bin]);

  if (!layer) return <Empty title="Choose a layer" />;
  if (!res) return null;
  const tier: TierTemporal | undefined = res.tiers[Math.min(tierIndex, res.tiers.length - 1)];
  const finite = (xs: number[]) => xs.filter((x) => Number.isFinite(x));
  const bs = finite(res.tiers.map((t) => t.burst.bCorrected));
  const ms = finite(res.tiers.map((t) => t.burst.memory));
  const changed = res.tiers.filter((t) => t.change && t.change.logBf10 > Math.log(3)).length;
  const tested = res.tiers.filter((t) => t.change).length;
  const intervals = tier ? Float64Array.from({ length: Math.max(0, tier.times.length - 1) }, (_, i) => (tier.times[i + 1]! - tier.times[i]!) / 1000).filter((v) => v > 0) : new Float64Array(0);
  const ev = tier?.change ? evidenceLabel(tier.change.logBf10) : undefined;

  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Settings">
          <Field label="Layer" htmlFor="tm-layer"><LayerSelect id="tm-layer" value={layer} onChange={setLayer} /></Field>
          <FilterField id="tm-filter" label="Values" value={filter} onChange={setFilter} values={values} />
          <Field label="Width of the time bins (s)" htmlFor="tm-bin"><NumberField id="tm-bin" value={bin} min={1} max={3600} step={5} onChange={setBin} /></Field>
        </Card>
        <MethodNote refs={["Goh & Barabási (2008) EPL 81", "Kim & Jo (2016) Phys Rev E 94", "Abney, Paxton, Dale & Kello (2014) J Exp Psychol Gen 143", "Abney, Dale, Louwerse & Kello (2018) Cogn Sci 42", "Scargle et al. (2013) Astrophys J 764"]}>
          <p>
            Each annotation counts as an event at its onset. <strong>Burstiness</strong> B compares the spread of the times between events with their mean: −1 for a perfectly regular rhythm, 0 for events at random moments, towards 1
            for bursts separated by long lulls (shown with the correction for short sequences). <strong>Memory</strong> is the correlation between consecutive intervals.
          </p>
          <p>
            The <strong>Allan factor</strong> compares the event counts of neighbouring time windows; a curve that rises with window size means that events cluster at many time scales at once.
          </p>
          <p>
            The <strong>change-point analysis</strong> compares a constant event rate with one that switches once at an unknown time, and gives the posterior of that time. <strong>Bayesian blocks</strong> finds the most probable division
            into any number of constant-rate phases.
          </p>
        </MethodNote>
      </div>
      <div className="stack">
        {res.error && <Callout kind="critical">{res.error}</Callout>}
        {res.tiers.length === 0 || !tier ? (
          <Empty title="No events">Nothing on the layer “{layer}” matches the filter.</Empty>
        ) : (
          <>
            <div className="tiles">
              <Tile label="Tiers" value={res.tiers.length} hint={`${res.tiers.reduce((s, t) => s + t.times.length, 0).toLocaleString("en-US")} events`} />
              <Tile label="Burstiness (median)" value={bs.length ? fmt(median(bs), 2) : "–"} hint="−1 regular · 0 random · 1 bursty" />
              <Tile label="Memory (median)" value={ms.length ? fmt(median(ms), 2) : "–"} hint="correlation of consecutive intervals" />
              <Tile label="Rate changes" value={`${changed} of ${tested}`} hint="tiers with BF₁₀ > 3 for a change in rate" />
            </div>
            <ChartCard
              title="Rate over the course of the recordings"
              sub="Events per minute by tenth of the recording, all tiers pooled. Band: 95% credible interval."
              table={{ columns: ["part of the recording", "per minute", "lower", "upper"], rows: res.timeCourse.map((d) => [`${Math.round(d.from * 100)}–${Math.round(d.to * 100)}%`, d.rate, d.lower, d.upper]) }}
            >
              <XYChart
                height={230}
                crosshair
                crosshairFormat={(v) => `${Math.round(v * 100)}% of the recording`}
                x={{ type: "linear", domain: [0, 1], label: "position in the recording", format: (v) => `${Math.round(v * 100)}%` }}
                y={{ type: "linear", zero: true, label: "events per minute" }}
                marks={[
                  { type: "area", color: "var(--series-1)", points: res.timeCourse.map((d) => [(d.from + d.to) / 2, d.lower, d.upper]) },
                  { type: "line", color: "var(--series-1)", label: "events per minute", points: res.timeCourse.map((d) => [(d.from + d.to) / 2, d.rate]) },
                  { type: "dot", color: "var(--series-1)", data: res.timeCourse.map((d) => ({ x: (d.from + d.to) / 2, y: d.rate })) },
                ]}
                ariaLabel="Event rate by tenth of the recording"
              />
            </ChartCard>

            <div className="row" style={{ marginTop: 6 }}>
              <h2 style={{ fontSize: 14, fontWeight: 650 }}>One tier in detail</h2>
              <div style={{ flex: "0 1 300px", minWidth: 160 }}>
                <Select value={String(Math.min(tierIndex, res.tiers.length - 1))} onChange={(v) => setTierIndex(Number(v))} options={res.tiers.map((t, i) => ({ value: String(i), label: `${t.fileName} · ${t.tierId}` }))} />
              </div>
            </div>
              <div className="cols-2">
                <ChartCard
                  title="Events over time"
                  sub={`Bars: events per ${bin}-s bin. Line: Bayesian blocks (${tier.blocks.length} phase${tier.blocks.length === 1 ? "" : "s"}).`}
                  table={{ columns: ["phase starts", "phase ends", "events", "per minute"], rows: tier.blocks.map((b) => [formatTime(b.start, false), formatTime(b.end, false), b.events, b.rate]) }}
                >
                  <XYChart
                    height={220}
                    x={{ type: "linear", domain: [0, tier.duration], label: "time", format: (v) => formatTime(v, false), nice: false }}
                    y={{ type: "linear", zero: true, label: "events per minute" }}
                    legend={[{ label: `per ${bin}-s bin`, color: "var(--series-1)" }, { label: "Bayesian blocks", color: "var(--series-2)", kind: "line" }]}
                    marks={[
                      { type: "rect", data: tier.activity.map((a) => ({ x0: a.start, x1: Math.min(a.start + bin * 1000, tier.duration), y0: 0, y1: (a.count / bin) * 60, tip: { title: `${formatTime(a.start, false)} – ${formatTime(a.start + bin * 1000, false)}`, rows: [["events", String(a.count)], ["share of the bin covered", `${Math.round(a.coverage * 100)}%`]] } })), opacity: 0.55 },
                      { type: "line", color: "var(--series-2)", points: tier.blocks.flatMap((b) => [[b.start, b.rate], [b.end, b.rate]] as [number, number][]) },
                    ]}
                    ariaLabel="Events per minute over time with Bayesian blocks"
                  />
                </ChartCard>
                <ChartCard
                  title="When did the rate change?"
                  sub={tier.change ? `BF₁₀ = ${fmtBf(tier.change.logBf10)} for one change against a constant rate.` : "Too few events."}
                  {...(tier.change ? { table: { columns: ["time", "posterior probability"], rows: Array.from(tier.change.times, (t, i) => [formatTime(t, false), tier.change!.posterior[i]!]).filter((_, i) => i % 8 === 0) } } : {})}
                >
                  {tier.change && ev ? (
                    <>
                      <XYChart
                        height={170}
                        x={{ type: "linear", domain: [0, tier.duration], label: "time of the change", format: (v) => formatTime(v, false), nice: false }}
                        y={{ type: "linear", zero: true, label: "posterior" }}
                        marks={[
                          { type: "area", color: "var(--series-1)", opacity: 0.3, points: Array.from(tier.change.times, (t, i) => [t, 0, tier.change!.posterior[i]!] as [number, number, number]) },
                          { type: "line", color: "var(--series-1)", points: Array.from(tier.change.times, (t, i) => [t, tier.change!.posterior[i]!] as [number, number]) },
                        ]}
                        ariaLabel="Posterior distribution of the time of the rate change"
                      />
                      <p className="muted" style={{ marginTop: 4 }}>
                        {ev.favours === "H1"
                          ? `${cap(ev.strength)} evidence for a change: most probably at ${formatTime(tier.change.mode, false)} (95% credible interval ${formatTime(tier.change.ci[0], false)} to ${formatTime(tier.change.ci[1], false)}), from ${fmt(tier.change.rateBefore, 2)} to ${fmt(tier.change.rateAfter, 2)} events per minute.`
                          : ev.favours === "H0"
                            ? `${cap(ev.strength)} evidence for a constant rate of ${fmt(tier.change.rate, 2)} events per minute.`
                            : "No evidence either way."}
                      </p>
                    </>
                  ) : (
                    <Empty title="Not enough events" />
                  )}
                </ChartCard>
              </div>
              <div className="cols-2">
                <ChartCard title="Time between events" sub={`Burstiness ${fmt(tier.burst.bCorrected, 2)}, memory ${fmt(tier.burst.memory, 2)}, coefficient of variation ${fmt(tier.burst.cv, 2)}.`}>
                  {intervals.length >= 3 ? <Histogram series={[{ label: "intervals", values: intervals }]} xLabel="time between onsets (s)" yLabel="intervals" log height={200} format={(v) => (v < 10 ? String(Number(v.toPrecision(2))) : fmt(v, 2))} /> : <Empty title="Not enough events" />}
                </ChartCard>
                <ChartCard
                  title="Clustering across time scales"
                  sub={`Allan factor; exponent ${fmt(tier.allan.slope, 2)}. A flat line at 1 means events at random moments.`}
                  table={{ columns: ["window (s)", "Allan factor", "windows"], rows: tier.allan.points.map((p) => [p.window / 1000, p.af, p.windows]) }}
                >
                  {tier.allan.points.length >= 3 ? (
                    <XYChart
                      height={200}
                      x={{ type: "log", label: "window size (s)", format: (v) => String(Number(v.toPrecision(2))) }}
                      y={{ type: "log", label: "Allan factor", format: (v) => String(Number(v.toPrecision(2))) }}
                      marks={[
                        { type: "line", color: "var(--series-1)", points: tier.allan.points.filter((p) => p.af > 0).map((p) => [p.window / 1000, p.af]) },
                        { type: "dot", color: "var(--series-1)", data: tier.allan.points.filter((p) => p.af > 0).map((p) => ({ x: p.window / 1000, y: p.af, tip: { title: `${fmt(p.window / 1000, 2)} s windows`, rows: [["Allan factor", fmt(p.af, 3)], ["windows", String(p.windows)]] } })) },
                        { type: "rule", y: 1, color: "var(--text-2)", dash: "5 4", label: "random" },
                      ]}
                      ariaLabel="Allan factor by window size on logarithmic axes"
                    />
                  ) : <Empty title="Not enough events" />}
                </ChartCard>
              </div>

            <Card title="All tiers" sub="Click a row to see the tier in detail." actions={<><SendToStats dataset={res.dataset} /><DatasetCsvButton dataset={res.dataset} /></>} flush>
              <DataTable<TierTemporal>
                rows={res.tiers}
                maxHeight={300}
                csvName="temporal_structure"
                onRowClick={(t) => setTierIndex(res.tiers.indexOf(t))}
                selected={(t) => t === tier}
                columns={[
                  { key: "file", header: "File", value: (t) => t.fileName },
                  { key: "p", header: "Participant", value: (t) => t.participant || "–" },
                  { key: "n", header: "Events", value: (t) => t.times.length, numeric: true },
                  { key: "rate", header: "Per min", value: (t) => (t.times.length / t.duration) * 60000, numeric: true, digits: 2 },
                  { key: "b", header: "Burstiness", value: (t) => t.burst.bCorrected, numeric: true, digits: 2 },
                  { key: "m", header: "Memory", value: (t) => t.burst.memory, numeric: true, digits: 2 },
                  { key: "af", header: "Allan exponent", value: (t) => t.allan.slope, numeric: true, digits: 2 },
                  { key: "bf", header: "BF₁₀ change", value: (t) => t.change?.logBf10 ?? NaN, render: (t) => (t.change ? fmtBf(t.change.logBf10) : "–"), numeric: true },
                  { key: "blocks", header: "Phases", value: (t) => t.blocks.length, numeric: true },
                ]}
              />
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
