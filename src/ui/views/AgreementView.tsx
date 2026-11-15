import { useMemo } from "react";
import { analyseAgreement, DENSE_KAPPA_CATEGORIES, UNLINKED } from "../../core/analysis/agreement.ts";
import { formatDuration, formatTime } from "../../core/analysis/common.ts";
import { ChartCard } from "../charts/ChartCard.tsx";
import { Heatmap } from "../charts/Heatmap.tsx";
import { Histogram } from "../charts/Histogram.tsx";
import { useLayers, useViewState } from "../hooks.ts";
import { Callout, Card, DataTable, DatasetCsvButton, Empty, Field, fmt, LayerSelect, MethodNote, NumberField, pct, Segmented, SendToStats, Tile } from "../kit.tsx";
import { useStore } from "../store.ts";

function verdict(k: number): string {
  if (Number.isNaN(k)) return "";
  if (k < 0.2) return "slight";
  if (k < 0.4) return "fair";
  if (k < 0.6) return "moderate";
  if (k < 0.8) return "substantial";
  return "almost perfect";
}

export function AgreementView() {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const showInTimeline = useStore((s) => s.showInTimeline);
  const layers = useLayers();
  // Guess a pair of layers that look like two raters' versions of the same thing.
  const guess = useMemo(() => {
    for (const a of layers) {
      const b = layers.find((l) => l.name !== a.name && l.name.startsWith(a.name) && /r\d|rater|coder|ann|_2|v2/i.test(l.name.slice(a.name.length)));
      if (b) return [a.name, b.name] as const;
    }
    // No such pair: leave the choice to the user rather than compare two unrelated layers.
    return ["", ""] as const;
  }, [layers]);
  const [layerA, setLayerA] = useViewState("agr.a", guess[0]);
  const [layerB, setLayerB] = useViewState("agr.b", guess[1]);
  const [minOverlap, setMinOverlap] = useViewState("agr.min", 60);
  const [matrix, setMatrix] = useViewState<"units" | "time">("agr.matrix", "units");
  const res = useMemo(() => (layerA && layerB && layerA !== layerB ? analyseAgreement(files, scheme, { layerA, layerB, minOverlap: minOverlap / 100 }) : undefined), [files, scheme, layerA, layerB, minOverlap]);
  const fileName = useMemo(() => new Map(files.map((f) => [f.id, f.name])), [files]);

  const settings = (
    <div className="stack">
      <Card title="Settings">
        <Field label="Rater 1" htmlFor="ag-a"><LayerSelect id="ag-a" value={layerA} onChange={setLayerA} /></Field>
        <Field label="Rater 2" htmlFor="ag-b"><LayerSelect id="ag-b" value={layerB} onChange={setLayerB} /></Field>
        <Field label="Overlap needed to count as the same unit (%)" htmlFor="ag-min" hint="Share of the longer of the two annotations that must be covered by both.">
          <NumberField id="ag-min" value={minOverlap} min={1} max={100} step={5} onChange={setMinOverlap} />
        </Field>
      </Card>
      <MethodNote refs={["Cohen (1960) Educ Psychol Meas 20", "Holle & Rein (2015) Behav Res Methods 47", "Mathet, Widlöcher & Métivier (2015) Comput Linguist 41", "Broemeling (2009) Bayesian Methods for Measures of Agreement"]}>
        <p>
          The tiers of the two layers are paired by participant. An annotation of rater 1 and one of rater 2 are <strong>linked</strong> when they overlap enough; each annotation is linked at most once, best overlap first. Annotations
          without a partner go into the category “{UNLINKED}”.
        </p>
        <p>
          <strong>Unit κ</strong> is Cohen's κ over all units, so it also penalises annotations only one rater made. <strong>Label κ</strong> uses the linked units only: agreement on the category, given agreement that there is something
          to categorise. <strong>Time κ</strong> compares what the raters coded at every moment, including “nothing”.
        </p>
        <p>Each κ comes with a posterior distribution (Dirichlet prior on the confusion matrix), from which the credible interval and the probability of exceeding 0.6 or 0.8 are read.</p>
      </MethodNote>
    </div>
  );

  if (!res) {
    return (
      <div className="view-grid">
        {settings}
        <Empty title="Choose the two layers to compare">Each layer should hold one rater's annotations of the same recordings, with one tier per participant.</Empty>
      </div>
    );
  }
  const total = res.confusion.flat().reduce((a, b) => a + b, 0);
  // A matrix of hundreds of values cannot be read: show the most frequent ones and fold the rest.
  const folded = foldMatrix(res.categories, matrix === "units" ? res.confusion : res.timeConfusion.map((r) => r.map((v) => v / 1000)), MAX_MATRIX);
  const shownMatrix = folded.values;
  const none = folded.labels.length - 1;

  return (
    <div className="view-grid">
      {settings}
      <div className="stack">
        {res.tierPairs === 0 ? (
          <Empty title="No tiers to compare">No file has a tier of “{layerA}” and a tier of “{layerB}” for the same participant.</Empty>
        ) : (
          <>
            <div className="tiles">
              <Tile label="Unit κ" value={fmt(res.unitKappa.kappa, 2)} hint={`95% CrI ${fmt(res.unitKappa.ci[0], 2)} – ${fmt(res.unitKappa.ci[1], 2)} · ${verdict(res.unitKappa.kappa)}`} />
              <Tile label="Label κ (linked units)" value={fmt(res.labelKappa.kappa, 2)} hint={`95% CrI ${fmt(res.labelKappa.ci[0], 2)} – ${fmt(res.labelKappa.ci[1], 2)} · ${verdict(res.labelKappa.kappa)}`} />
              <Tile label="Time κ" value={fmt(res.timeKappa.kappa, 2)} hint={`same code ${pct(res.timeKappa.observed)} of the time`} />
              <Tile label="Linked units" value={res.linked.toLocaleString("en-US")} hint={`only rater 1: ${res.unlinkedA} · only rater 2: ${res.unlinkedB}`} />
            </div>
            <Card title="How sure can we be?" sub={res.unitKappa.method === "bootstrap" ? `Posterior probabilities for the usual benchmarks. With more than ${DENSE_KAPPA_CATEGORIES} values the intervals come from a Bayesian bootstrap over the observed units.` : "Posterior probabilities for the usual benchmarks."}>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Measure</th><th className="n">κ</th><th className="n">Agreement</th><th className="n">By chance</th><th className="n">Posterior median</th><th className="n">95% CrI</th><th className="n">P(κ &gt; 0.6)</th><th className="n">P(κ &gt; 0.8)</th></tr></thead>
                  <tbody>
                    {[{ name: "Units (segmentation and label)", k: res.unitKappa }, { name: "Labels of linked units", k: res.labelKappa }].map(({ name, k }) => (
                      <tr key={name}>
                        <td>{name}</td><td className="n">{fmt(k.kappa, 3)}</td><td className="n">{pct(k.observed)}</td><td className="n">{pct(k.expected)}</td>
                        <td className="n">{fmt(k.median, 3)}</td><td className="n">{fmt(k.ci[0], 2)} – {fmt(k.ci[1], 2)}</td><td className="n">{fmt(k.pAbove06, 3)}</td><td className="n">{fmt(k.pAbove08, 3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <div className="cols-2">
              <ChartCard
                title="Who coded what"
                sub={`${matrix === "units" ? `Rows: ${layerA}. Columns: ${layerB}. ${total} units.` : "Seconds both raters assigned to each pair of codes."}${folded.others ? ` The ${MAX_MATRIX} most frequent values are shown; ${folded.others} more are combined.` : ""}`}
                actions={<Segmented value={matrix} onChange={setMatrix} options={[{ value: "units", label: "Units" }, { value: "time", label: "Time" }]} />}
                table={{ columns: [layerA, ...folded.labels], rows: folded.labels.map((c, i) => [c, ...shownMatrix[i]!]) }}
              >
                <Heatmap
                  rows={folded.labels}
                  cols={folded.labels}
                  values={shownMatrix.map((r, i) => r.map((v, j) => (matrix === "units" && i === none && j === none ? NaN : v)))}
                  mode="sequential"
                  rowLabel="rater 1"
                  colLabel="rater 2"
                  legendLabel={matrix === "units" ? "units" : "seconds"}
                  cellText={(r, c) => {
                    const v = shownMatrix[r]![c]!;
                    return matrix === "units" ? (r === none && c === none ? "" : String(v)) : v >= 100 ? v.toFixed(0) : v.toFixed(1);
                  }}
                  tip={(r, c) => ({ title: `${folded.labels[r]} / ${folded.labels[c]}`, rows: [[matrix === "units" ? "units" : "time", matrix === "units" ? String(shownMatrix[r]![c]!) : formatDuration(shownMatrix[r]![c]! * 1000)]] })}
                  ariaLabel="Confusion matrix of the two raters"
                />
              </ChartCard>
              <ChartCard title="Boundary differences" sub={`Rater 2 − rater 1, linked units. Median absolute difference ${fmt(res.boundary.medianAbs, 3)} ms.`}>
                {res.onsetDiff.length >= 3 ? (
                  <>
                    <Histogram series={[{ label: "onsets", values: res.onsetDiff }, { label: "offsets", values: res.offsetDiff }]} xLabel="difference (ms)" height={230} />
                    <p className="muted">Onsets: mean {fmt(res.boundary.onsetMean, 3)} ms (SD {fmt(res.boundary.onsetSd, 3)}). Offsets: mean {fmt(res.boundary.offsetMean, 3)} ms (SD {fmt(res.boundary.offsetSd, 3)}).</p>
                  </>
                ) : <Empty title="Too few linked units" />}
              </ChartCard>
            </div>
            <div className="cols-2">
              <Card title="By category" sub="One category against all others." flush>
                <DataTable
                  rows={res.perCategory}
                  maxHeight={280}
                  csvName="agreement_by_category"
                  columns={[
                    { key: "c", header: "Category", value: (r) => r.category },
                    { key: "n1", header: "Rater 1", value: (r) => r.n1, numeric: true },
                    { key: "n2", header: "Rater 2", value: (r) => r.n2, numeric: true },
                    { key: "both", header: "Both", value: (r) => r.both, numeric: true },
                    { key: "k", header: "κ", value: (r) => r.kappa, numeric: true, digits: 2 },
                  ]}
                />
              </Card>
              <Card title="Disagreements" sub="Click a row to see it in the timeline." actions={<><SendToStats dataset={res.dataset} label="Per tier pair in Statistics" /><DatasetCsvButton dataset={res.dataset} /></>} flush>
                <DataTable
                  rows={res.disagreements}
                  maxHeight={280}
                  csvName="disagreements"
                  onRowClick={(d) => showInTimeline({ fileId: d.fileId, start: d.start, end: d.end, tierId: d.tierA })}
                  columns={[
                    { key: "file", header: "File", value: (d) => fileName.get(d.fileId) ?? "" },
                    { key: "t", header: "At", value: (d) => d.start, render: (d) => <span className="mono">{formatTime(d.start, false)}</span>, numeric: true },
                    { key: "a", header: "Rater 1", value: (d) => d.a },
                    { key: "b", header: "Rater 2", value: (d) => d.b },
                    { key: "tier", header: "Tier", value: (d) => d.tierA },
                  ]}
                />
              </Card>
            </div>
            {res.linked < 20 && <Callout kind="warning">Only {res.linked} linked units: the κ values are very uncertain, as their credible intervals show.</Callout>}
          </>
        )}
      </div>
    </div>
  );
}

const MAX_MATRIX = 24;

/**
 * The confusion matrix restricted to the `keep` most frequent values (the values come sorted
 * by frequency); all others are summed into one row and column. The last entry, "no
 * annotation", stays last.
 */
function foldMatrix(categories: string[], values: number[][], keep: number): { labels: string[]; values: number[][]; others: number } {
  const last = categories.length - 1;
  if (last <= keep) return { labels: categories, values, others: 0 };
  const at = (i: number) => (i === last ? keep + 1 : i < keep ? i : keep);
  const out = Array.from({ length: keep + 2 }, () => new Array<number>(keep + 2).fill(0));
  for (let i = 0; i <= last; i++) for (let j = 0; j <= last; j++) out[at(i)]![at(j)]! += values[i]![j]!;
  return { labels: [...categories.slice(0, keep), "(other values)", categories[last]!], values: out, others: last - keep };
}
