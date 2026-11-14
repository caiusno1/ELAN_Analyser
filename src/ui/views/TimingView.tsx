import { useMemo } from "react";
import { ALL_VALUES, formatTime, type ValueFilter } from "../../core/analysis/common.ts";
import type { Pairing } from "../../core/analysis/cooccurrence.ts";
import { analyseLags, stateProfile, type Anchor, type LagOptions } from "../../core/analysis/timing.ts";
import { evidenceLabel } from "../../core/stats/bayes/proportions.ts";
import { effectPosterior, oneSampleStats, tTestBayesFactors } from "../../core/stats/bayes/ttest.ts";
import { ChartCard } from "../charts/ChartCard.tsx";
import { XYChart } from "../charts/XYChart.tsx";
import { useLayerValues, useLayers, useViewState } from "../hooks.ts";
import { Callout, Card, DataTable, DatasetCsvButton, defaultLayer, Empty, Field, FilterField, fmt, fmtBf, LayerSelect, MethodNote, NumberField, PairingSelect, pct, Segmented, Select, SendToStats, Tabs, Tile } from "../kit.tsx";
import { useStore } from "../store.ts";

const ANCHORS: { value: Anchor; label: string }[] = [{ value: "start", label: "start" }, { value: "end", label: "end" }, { value: "middle", label: "middle" }];

export function TimingView() {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const showInTimeline = useStore((s) => s.showInTimeline);
  const layers = useLayers();
  const [tab, setTab] = useViewState<"lags" | "state">("timing.tab", "lags");
  const [layerX, setLayerX] = useViewState("timing.x", defaultLayer(layers, "text", /speech|utter|trans/i));
  const [filterX, setFilterX] = useViewState<ValueFilter>("timing.fx", ALL_VALUES);
  const [anchorX, setAnchorX] = useViewState<Anchor>("timing.ax", "end");
  const [layerY, setLayerY] = useViewState("timing.y", defaultLayer(layers, "categorical", /head|nod|gest/i, layerX));
  const [filterY, setFilterY] = useViewState<ValueFilter>("timing.fy", ALL_VALUES);
  const [anchorY, setAnchorY] = useViewState<Anchor>("timing.ay", "start");
  const [pairing, setPairing] = useViewState<Pairing>("timing.pairing", "other");
  const [mode, setMode] = useViewState<LagOptions["mode"]>("timing.mode", "all");
  const [window, setWindow] = useViewState("timing.window", 2000);
  const [binWidth, setBinWidth] = useViewState("timing.bin", 200);
  const [step, setStep] = useViewState("timing.step", 100);
  const valuesX = useLayerValues(layerX);
  const valuesY = useLayerValues(layerY);

  const lags = useMemo(
    () => (tab === "lags" && layerX && layerY ? analyseLags(files, scheme, { layerX, filterX, anchorX, layerY, filterY, anchorY, pairing, mode, window, binWidth }) : undefined),
    [tab, files, scheme, layerX, filterX, anchorX, layerY, filterY, anchorY, pairing, mode, window, binWidth],
  );
  const profile = useMemo(
    () => (tab === "state" && layerX && layerY ? stateProfile(files, scheme, { layerX, filterX, anchorX, layerY, filterY, pairing, window, step }) : undefined),
    [tab, files, scheme, layerX, filterX, anchorX, layerY, filterY, pairing, window, step],
  );
  const test = useMemo(() => {
    // With every target in a symmetric window the mean lag says little; test it only
    // for one lag per reference event (nearest / next).
    if (!lags || lags.lags.length < 3 || mode === "all") return undefined;
    const stat = oneSampleStats(lags.lags);
    if (!Number.isFinite(stat.t)) return undefined;
    return { stat, bf: tTestBayesFactors(stat), post: effectPosterior(stat) };
  }, [lags, mode]);
  const peak = useMemo(() => {
    if (!lags || mode !== "all") return undefined;
    let best: { from: number; to: number; ratio: number } | undefined;
    for (const b of lags.bins) {
      if (b.expected <= 0) continue;
      const ratio = b.count / b.expected;
      if (!best || ratio > best.ratio) best = { from: b.from, to: b.to, ratio };
    }
    return best;
  }, [lags, mode]);
  const fileName = useMemo(() => new Map(files.map((f) => [f.id, f.name])), [files]);

  if (!layerX || !layerY) return <Empty title="Choose two layers" />;
  const yState = filterY.mode === "values" && filterY.values?.length ? filterY.values.join(" / ") : filterY.mode === "regex" ? `/${filterY.pattern}/` : "any annotation";

  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Settings">
          <div className="panel-title">Reference events</div>
          <Field label="Layer" htmlFor="ti-x"><LayerSelect id="ti-x" value={layerX} onChange={setLayerX} /></Field>
          <FilterField id="ti-fx" label="Values" value={filterX} onChange={setFilterX} values={valuesX} />
          <Field label="Time point of each annotation"><Segmented value={anchorX} onChange={setAnchorX} options={ANCHORS} /></Field>
          <div className="panel-title" style={{ marginTop: 14 }}>{tab === "lags" ? "Target events" : "State"}</div>
          <Field label="Layer" htmlFor="ti-y"><LayerSelect id="ti-y" value={layerY} onChange={setLayerY} /></Field>
          <FilterField id="ti-fy" label="Values" value={filterY} onChange={setFilterY} values={valuesY} />
          {tab === "lags" && <Field label="Time point of each annotation"><Segmented value={anchorY} onChange={setAnchorY} options={ANCHORS} /></Field>}
          <div className="panel-title" style={{ marginTop: 14 }}>How they are related</div>
          <Field label="Which tiers are compared" htmlFor="ti-pair"><PairingSelect id="ti-pair" value={pairing} onChange={setPairing} /></Field>
          {tab === "lags" && (
            <Field label="Targets per reference event" htmlFor="ti-mode" hint={mode === "all" ? "Every target in the window: a cross-correlogram." : mode === "nearest" ? "Only the closest target: an asynchrony." : "Only the first target afterwards: a latency."}>
              <Select id="ti-mode" value={mode} onChange={setMode} options={[{ value: "all", label: "All in the window" }, { value: "nearest", label: "The nearest one" }, { value: "next", label: "The next one" }]} />
            </Field>
          )}
          <div className="field-row" style={{ marginTop: 9 }}>
            <Field label="Window ± (ms)" htmlFor="ti-window"><NumberField id="ti-window" value={window} min={100} max={600000} step={250} onChange={setWindow} /></Field>
            {tab === "lags"
              ? <Field label="Bin width (ms)" htmlFor="ti-bin"><NumberField id="ti-bin" value={binWidth} min={10} max={60000} step={50} onChange={setBinWidth} /></Field>
              : <Field label="Time step (ms)" htmlFor="ti-step"><NumberField id="ti-step" value={step} min={10} max={5000} step={10} onChange={setStep} /></Field>}
          </div>
        </Card>
        <MethodNote refs={["Kendon (1967) Acta Psychol 26", "Schegloff (1984)", "ter Bekke, Drijvers & Holler (2024) Cogn Sci 48", "Stivers et al. (2009) PNAS 106"]}>
          <p>
            <strong>Event lags</strong> take one time point from every reference annotation and every target annotation and collect the differences target − reference inside the window. With “all in the window” this is a
            cross-correlogram; the line shows the count expected if the targets were unrelated to the reference events.
          </p>
          <p>
            <strong>State around events</strong> asks, for each moment before and after the reference events, in what share of them the state layer carries a (matching) annotation — for example, how likely a speaker is to look at the
            partner around the end of a turn. The band is a 95% credible interval; the line marked “overall” is the share of all time spent in the state.
          </p>
        </MethodNote>
      </div>
      <div className="stack">
        <section className="card">
          <Tabs value={tab} onChange={setTab} tabs={[{ id: "lags", label: "Event lags" }, { id: "state", label: "State around events" }]} />
          <div className="stack" style={{ padding: "12px 14px 14px" }}>
            {tab === "lags" && lags && (
              <>
                {lags.error && <Callout kind="critical">{lags.error}</Callout>}
                {lags.references === 0 || lags.targets === 0 ? (
                  <Empty title="No events to relate">There are {lags.references} reference and {lags.targets} target events in tiers that fit the chosen rule.</Empty>
                ) : (
                  <>
                    <div className="tiles">
                      <Tile label="Reference events" value={lags.references.toLocaleString("en-US")} hint={`${pct(lags.referencesWithTarget / lags.references)} have a target in the window`} />
                      <Tile label="Median lag" value={`${fmt(lags.summary.median, 3)} ms`} hint={`quartiles ${fmt(lags.summary.q1, 3)} to ${fmt(lags.summary.q3, 3)}`} />
                      <Tile label="Target first" value={pct(lags.summary.shareBefore)} hint="lags below zero" />
                      {peak ? (
                        <Tile label="Strongest coupling" value={`${fmt(peak.from)} to ${fmt(peak.to)} ms`} hint={`${fmt(peak.ratio, 2)} × the count expected without coupling`} />
                      ) : (
                        <Tile label="Lags" value={lags.summary.n.toLocaleString("en-US")} />
                      )}
                    </div>
                    <ChartCard
                      title={`${layerY} (${anchorY}) relative to ${layerX} (${anchorX})`}
                      sub="Negative lags: the target came first."
                      table={{ columns: ["from (ms)", "to (ms)", "count", ...(mode === "all" ? ["expected"] : [])], rows: lags.bins.map((b) => [b.from, b.to, b.count, ...(mode === "all" ? [b.expected] : [])]) }}
                    >
                      <XYChart
                        height={280}
                        x={{ type: "linear", domain: [-window, window], label: "lag (ms): target − reference" }}
                        y={{ type: "linear", zero: true, label: "target events" }}
                        legend={mode === "all" ? [{ label: "observed", color: "var(--series-1)" }, { label: "expected without coupling", color: "var(--text-2)", kind: "line", dash: true }] : []}
                        marks={[
                          { type: "rect", data: lags.bins.map((b) => ({ x0: b.from, x1: b.to, y0: 0, y1: b.count, tip: { title: `${fmt(b.from)} to ${fmt(b.to)} ms`, rows: [["observed", String(b.count)], ...(mode === "all" ? [["expected", fmt(b.expected, 2)] as [string, string]] : [])] } })) },
                          ...(mode === "all" ? [{ type: "line" as const, color: "var(--text-2)", dash: "5 4", width: 1.5, points: lags.bins.flatMap((b) => [[b.from, b.expected], [b.to, b.expected]] as [number, number][]) }] : []),
                          { type: "rule", x: 0, color: "var(--text-2)" },
                        ]}
                        ariaLabel="Histogram of lags between reference and target events"
                      />
                    </ChartCard>
                    {test && (
                      <Card title="Is the average lag different from zero?" sub="Bayesian one-sample t-test on the lags.">
                        <div className="bf">
                          <span className="bf-value">BF₁₀ = {fmtBf(test.bf.logBf10)}</span>
                          <span className="bf-text">
                            {(() => {
                              const ev = evidenceLabel(test.bf.logBf10);
                              return ev.favours === "H1" ? `${cap(ev.strength)} evidence for a lag ${test.stat.mean > 0 ? "after" : "before"} the reference.` : ev.favours === "H0" ? `${cap(ev.strength)} evidence for no systematic lag.` : "No evidence either way.";
                            })()}
                          </span>
                        </div>
                        <p className="muted" style={{ marginTop: 6 }}>
                          Mean lag {fmt(test.stat.mean, 3)} ms (SD {fmt(test.stat.sd, 3)}, n = {test.stat.n}). Standardised effect δ: median {fmt(test.post.median)}, 95% credible interval {fmt(test.post.ci[0])} to {fmt(test.post.ci[1])}.
                          This treats the lags as independent; with several speakers or files, fit a multilevel model on the table in Statistics.
                        </p>
                      </Card>
                    )}
                    <Card title="Instances" sub="Click a row to see it in the timeline." actions={<><SendToStats dataset={lags.dataset} /><DatasetCsvButton dataset={lags.dataset} /></>} flush>
                      <DataTable
                        rows={lags.instances}
                        maxHeight={280}
                        csvName="lags"
                        onRowClick={(r) => showInTimeline({ fileId: r.fileId, start: Math.min(r.refTime, r.targetTime), end: Math.max(r.refTime, r.targetTime) + 1, tierId: r.xTier })}
                        columns={[
                          { key: "file", header: "File", value: (r) => fileName.get(r.fileId) ?? "" },
                          { key: "x", header: layerX, value: (r) => r.xValue },
                          { key: "y", header: layerY, value: (r) => r.yValue },
                          { key: "t", header: "Reference at", value: (r) => r.refTime, render: (r) => <span className="mono">{formatTime(r.refTime)}</span>, numeric: true },
                          { key: "lag", header: "Lag (ms)", value: (r) => r.lag, numeric: true, digits: 0 },
                        ]}
                      />
                    </Card>
                  </>
                )}
              </>
            )}
            {tab === "state" && profile && (
              <>
                {profile.error && <Callout kind="critical">{profile.error}</Callout>}
                {profile.references === 0 ? (
                  <Empty title="No reference events">No annotations of “{layerX}” match the filter in tiers that fit the chosen rule.</Empty>
                ) : (
                  <ChartCard
                    title={`${layerY}: ${yState}, around the ${anchorX} of ${layerX}`}
                    sub={`${profile.references.toLocaleString("en-US")} reference events. Band: 95% credible interval.`}
                    table={{ columns: ["time (ms)", "share", "lower", "upper"], rows: Array.from(profile.t, (t, i) => [t, profile.p[i]!, profile.lower[i]!, profile.upper[i]!]) }}
                  >
                    <XYChart
                      height={300}
                      crosshair
                      crosshairFormat={(v) => `${v > 0 ? "+" : ""}${fmt(v)} ms`}
                      x={{ type: "linear", domain: [-window, window], label: `time relative to the ${anchorX} of the reference annotation (ms)` }}
                      y={{ type: "linear", domain: [0, 1], label: "share of events with the state present", format: (v) => `${Math.round(v * 100)}%` }}
                      legend={[{ label: "state present", color: "var(--series-1)", kind: "line" }, { label: "overall share of time", color: "var(--text-2)", kind: "line", dash: true }]}
                      marks={[
                        { type: "area", color: "var(--series-1)", points: Array.from(profile.t, (t, i) => [t, profile.lower[i]!, profile.upper[i]!] as [number, number, number]) },
                        { type: "line", color: "var(--series-1)", label: "state present", points: Array.from(profile.t, (t, i) => [t, profile.p[i]!] as [number, number]) },
                        { type: "line", color: "var(--text-2)", dash: "5 4", width: 1.5, points: [[-window, profile.baseline], [window, profile.baseline]] },
                        { type: "rule", x: 0, color: "var(--text-2)" },
                      ]}
                      ariaLabel="Share of reference events at which the state is present, by time relative to the event"
                    />
                  </ChartCard>
                )}
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
