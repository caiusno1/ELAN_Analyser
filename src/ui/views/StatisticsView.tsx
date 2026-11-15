import { useRef, useState } from "react";
import { analyseAlignment } from "../../core/analysis/alignment.ts";
import { ALL_VALUES } from "../../core/analysis/common.ts";
import { describeLayer } from "../../core/analysis/descriptives.ts";
import { DEFAULT_TURN_TAKING, analyseTurnTaking } from "../../core/analysis/turntaking.ts";
import type { Dataset } from "../../core/data/dataset.ts";
import { useAlignmentOptions, useAlignmentSettings } from "../alignmentOptions.tsx";
import { useLayers, useViewState } from "../hooks.ts";
import { Button, Callout, Card, defaultLayer, Field, LayerSelect, Select, Tabs } from "../kit.tsx";
import { AnovaPanel } from "../stats/AnovaPanel.tsx";
import { ContingencyPanel } from "../stats/ContingencyPanel.tsx";
import { CorrelationPanel } from "../stats/CorrelationPanel.tsx";
import { DataPanel } from "../stats/DataPanel.tsx";
import { RatesPanel } from "../stats/RatesPanel.tsx";
import { RegressionPanel } from "../stats/RegressionPanel.tsx";
import { TTestPanel } from "../stats/TTestPanel.tsx";
import { useStore } from "../store.ts";

type AnalysisId = "data" | "ttest" | "anova" | "correlation" | "contingency" | "rates" | "regression";

const ANALYSES: { id: AnalysisId; label: string; question: string }[] = [
  { id: "data", label: "Data", question: "Look at the table, reshape it, add variables." },
  { id: "ttest", label: "Two groups", question: "Bayesian t-test: do two groups, or two measurements of the same cases, differ?" },
  { id: "anova", label: "Several groups", question: "Bayesian ANOVA: do the means of several groups differ?" },
  { id: "correlation", label: "Correlation", question: "Do two numeric variables go together?" },
  { id: "contingency", label: "Contingency table", question: "Are two categorical variables associated?" },
  { id: "rates", label: "Counts & rates", question: "Compare how often something happens, or test a proportion." },
  { id: "regression", label: "Multilevel model", question: "Regression for nested data: annotations within speakers within recordings." },
];

export function StatisticsView() {
  const datasets = useStore((s) => s.datasets);
  const activeId = useStore((s) => s.activeDataset);
  const setActive = useStore((s) => s.setActiveDataset);
  const [analysis, setAnalysis] = useViewState<AnalysisId>("stats.analysis", "data");
  const [adding, setAdding] = useState(false);
  const ds = datasets.find((d) => d.id === activeId) ?? datasets[datasets.length - 1];

  if (!ds) return <NewTable first />;
  const current = ANALYSES.find((a) => a.id === analysis) ?? ANALYSES[0]!;
  return (
    <div className="stack">
      <div className="card">
        <div className="card-body">
          <div className="row">
            <label className="muted" htmlFor="stats-table">Table</label>
            <div style={{ flex: "1 1 240px", minWidth: 0, maxWidth: 520 }}>
              <Select id="stats-table" value={ds.id} onChange={setActive} options={datasets.map((d) => ({ value: d.id, label: `${d.name} — ${d.rowCount.toLocaleString("en-US")} rows` }))} />
            </div>
            <span className="chip accent">One row = {ds.unit}</span>
            <span className="spacer" />
            <Button small icon={adding ? "close" : "plus"} onClick={() => setAdding(!adding)}>{adding ? "Close" : "New table"}</Button>
          </div>
        </div>
      </div>
      {adding && <NewTable onDone={() => setAdding(false)} />}
      <div>
        <Tabs tabs={ANALYSES.map((a) => ({ id: a.id, label: a.label }))} value={current.id} onChange={setAnalysis} />
        <p className="muted" style={{ margin: "8px 0 0" }}>{current.question}</p>
      </div>
      {current.id === "data" && <DataPanel key={ds.id} ds={ds} />}
      {current.id === "ttest" && <TTestPanel key={ds.id} ds={ds} />}
      {current.id === "anova" && <AnovaPanel key={ds.id} ds={ds} />}
      {current.id === "correlation" && <CorrelationPanel key={ds.id} ds={ds} />}
      {current.id === "contingency" && <ContingencyPanel key={ds.id} ds={ds} />}
      {current.id === "rates" && <RatesPanel key={ds.id} ds={ds} />}
      {current.id === "regression" && <RegressionPanel key={ds.id} ds={ds} />}
    </div>
  );
}

/** Ways to get a table into the lab: from an analysis page, straight from the corpus, or from a file. */
function NewTable({ first, onDone }: { first?: boolean; onDone?: () => void }) {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const addDataset = useStore((s) => s.addDataset);
  const importTables = useStore((s) => s.importTables);
  const importTableText = useStore((s) => s.importTableText);
  const setView = useStore((s) => s.setView);
  const toast = useStore((s) => s.toast);
  const layers = useLayers();
  const [layer, setLayer] = useViewState("stats.new.layer", defaultLayer(layers, "categorical", /gest/i));
  const info = layers.find((l) => l.name === layer);
  // The same settings as on the Lexical alignment page, so that the table agrees with what is shown there.
  const [alignSettings] = useAlignmentSettings();
  const { options: alignOptions } = useAlignmentOptions({ ...alignSettings, layer: info?.kind === "text" ? layer : "" });
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | undefined>();
  const input = useRef<HTMLInputElement | null>(null);

  const open = (ds: Dataset | undefined, emptyMessage: string) => {
    if (!ds || ds.rowCount === 0) {
      toast(emptyMessage, "error");
      return;
    }
    addDataset(ds);
    onDone?.();
  };
  const several = (info?.participants.length ?? 0) >= 2;

  return (
    <div className="stack">
      {first && (
        <Callout kind="info">
          The statistics lab works on tables. Every analysis page has a button <strong>Analyse in Statistics</strong> that sends its result table here — for example the alignment scores per speaker, or the floor transfer offsets of every
          change of speaker. You can also start from one of the tables below.
        </Callout>
      )}
      <div className="cols-2">
        {layers.length > 0 && (
          <Card title="Table from the corpus" sub="Built with the default settings of the analysis pages.">
            <Field label="Layer" htmlFor="stats-new-layer"><LayerSelect id="stats-new-layer" value={layer} onChange={setLayer} /></Field>
            <div className="stack" style={{ marginTop: 12, gap: 8 }}>
              <QuickRow title="Single annotations" text="One row per annotation with its value, start and duration." onClick={() => open(describeLayer(files, scheme, { layer, filter: ALL_VALUES, byValue: true }).annotations, "This layer has no annotations.")} />
              <QuickRow
                title="Rates and durations per tier"
                text="One row per tier: number of annotations, rate per minute, mean duration."
                onClick={() => open(describeLayer(files, scheme, { layer, filter: ALL_VALUES, byValue: false }).dataset, "This layer has no annotations.")}
              />
              <QuickRow
                title="Changes of speaker"
                text="One row per floor transfer with its offset (gap or overlap)."
                disabled={!several}
                onClick={() => open(analyseTurnTaking(files, scheme, { layer, ...DEFAULT_TURN_TAKING }).dataset, "No changes of speaker were found in this layer.")}
              />
              <QuickRow
                title="Lexical alignment per speaker"
                text="One row per speaker and recording: share of tokens taken up from the partner (with the settings of the Lexical alignment page)."
                disabled={!several || info?.kind !== "text"}
                onClick={() => open(analyseAlignment(files, scheme, alignOptions).dataset, "No dialogue with two speakers was found in this layer.")}
              />
            </div>
            <p className="faint" style={{ margin: "10px 0 0" }}>
              For other settings and other analyses use the analysis pages, e.g. <button className="link" onClick={() => setView("alignment")}>Lexical alignment</button> or <button className="link" onClick={() => setView("turntaking")}>Turn-taking</button>.
            </p>
          </Card>
        )}
        <Card title="Table from a file" sub="CSV or tab-separated text with one header row, e.g. exported from R, Excel or ELAN.">
          <input
            ref={input}
            type="file"
            accept=".csv,.tsv,.tab,.txt,text/csv,text/tab-separated-values,text/plain"
            multiple
            hidden
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (list.length) void importTables(list).then(() => onDone?.());
            }}
          />
          <div className="row">
            <Button icon="upload" onClick={() => input.current?.click()}>Choose a file …</Button>
            <span className="muted">or drop it anywhere on the page</span>
          </div>
          <div style={{ height: 12 }} />
          <Field label="Or paste the table here" htmlFor="stats-paste" error={error}>
            <textarea
              id="stats-paste"
              className="input mono"
              rows={5}
              value={pasted}
              spellCheck={false}
              placeholder={"speaker\tcondition\tgestures_per_min\nA\tface-to-face\t7.4\nB\tscreen\t3.1"}
              onChange={(e) => {
                setPasted(e.target.value);
                setError(undefined);
              }}
            />
          </Field>
          <div className="row" style={{ marginTop: 10 }}>
            <Button
              kind="primary"
              disabled={pasted.trim() === ""}
              onClick={() => {
                const err = importTableText(pasted, "Pasted table");
                setError(err);
                if (!err) {
                  setPasted("");
                  onDone?.();
                }
              }}
            >
              Create table
            </Button>
          </div>
          <p className="faint" style={{ margin: "10px 0 0" }}>Columns that contain only numbers become numeric variables; decimal commas are understood in semicolon- or tab-separated files. Empty cells and NA count as missing.</p>
        </Card>
      </div>
    </div>
  );
}

function QuickRow({ title, text, onClick, disabled }: { title: string; text: string; onClick: () => void; disabled?: boolean }) {
  return (
    <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start", gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div className="muted">{text}</div>
      </div>
      <Button small icon="table" onClick={onClick} disabled={disabled} title={disabled ? "Needs a layer with tiers of at least two participants" : undefined}>Open</Button>
    </div>
  );
}
