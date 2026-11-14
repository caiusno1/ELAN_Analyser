import { useEffect, useMemo, useRef } from "react";
import type { Pairing } from "../../core/analysis/cooccurrence.ts";
import { analyseRecurrence, DEFAULT_RECURRENCE, type RecurrencePair } from "../../core/analysis/recurrence.ts";
import { DEFAULT_TEXT_SETTINGS, TextSettingsFields, useTokenizer, type TextSettings } from "../alignmentOptions.tsx";
import { ChartCard } from "../charts/ChartCard.tsx";
import { XYChart } from "../charts/XYChart.tsx";
import { useLayers, useThemeColors, useViewState, useWidth } from "../hooks.ts";
import { Callout, Card, DataTable, DatasetCsvButton, defaultLayer, Empty, Field, fmt, LayerSelect, MethodNote, NumberField, pct, Segmented, Select, SendToStats, Tile, Toggle } from "../kit.tsx";
import { useStore } from "../store.ts";

/** The recurrence plot itself: a dot wherever x_i equals y_j. */
function RecurrencePlot({ pair }: { pair: RecurrencePair }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const colors = useThemeColors(["series-1", "surface", "grid", "text-3", "border-strong"] as const);
  const size = Math.max(160, Math.min(width, 460));
  useEffect(() => {
    const c = canvas.current;
    if (!c || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const pad = 26;
    c.width = Math.round(size * dpr);
    c.height = Math.round(size * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = colors.surface;
    ctx.fillRect(0, 0, size, size);
    const plot = size - pad - 6;
    const { x, y, nx, ny } = pair;
    // For long sequences several elements share a pixel: accumulate into a grid.
    const cells = Math.min(Math.round(plot), Math.max(nx, ny));
    const grid = new Float32Array(cells * cells);
    const byValue = new Map<number, number[]>();
    for (let j = 0; j < ny; j++) {
      if (y[j]! < 0) continue;
      const list = byValue.get(y[j]!);
      if (list) list.push(j);
      else byValue.set(y[j]!, [j]);
    }
    let max = 0;
    for (let i = 0; i < nx; i++) {
      const list = x[i]! >= 0 ? byValue.get(x[i]!) : undefined;
      if (!list) continue;
      const gx = Math.min(cells - 1, Math.floor((i / nx) * cells));
      for (const j of list) {
        const gy = Math.min(cells - 1, Math.floor((j / ny) * cells));
        const k = gy * cells + gx;
        grid[k] = grid[k]! + 1;
        if (grid[k]! > max) max = grid[k]!;
      }
    }
    const px = plot / cells;
    ctx.fillStyle = colors["series-1"];
    for (let gy = 0; gy < cells; gy++) {
      for (let gx = 0; gx < cells; gx++) {
        const v = grid[gy * cells + gx]!;
        if (v === 0) continue;
        ctx.globalAlpha = 0.25 + 0.75 * Math.min(1, v / Math.max(1, max * 0.6));
        // y grows upwards, as in the usual recurrence plot.
        ctx.fillRect(pad + gx * px, 6 + plot - (gy + 1) * px, Math.max(px, 1), Math.max(px, 1));
      }
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors["border-strong"];
    ctx.strokeRect(pad + 0.5, 6.5, plot, plot);
    // The line of equal position.
    ctx.strokeStyle = colors["text-3"];
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad, 6 + plot);
    ctx.lineTo(pad + plot, 6);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = colors["text-3"];
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${pair.xLabel} →`, pad + plot / 2, size - 6);
    ctx.save();
    ctx.translate(11, 6 + plot / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${pair.yLabel} →`, 0, 0);
    ctx.restore();
  }, [pair, width, size, colors]);
  return (
    <div ref={ref}>
      <canvas ref={canvas} style={{ width: size, height: size, display: "block" }} role="img" aria-label={`Recurrence plot of ${pair.xLabel} against ${pair.yLabel}: ${pct(pair.rr)} of the compared positions match`} />
    </div>
  );
}

export function RecurrenceView() {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const layers = useLayers();
  const [layerX, setLayerX] = useViewState("rec.x", defaultLayer(layers, "categorical", /gaze|gest/i));
  const [layerY, setLayerY] = useViewState("rec.y", layerX);
  const [pairing, setPairing] = useViewState<Pairing>("rec.pairing", "other");
  const [unit, setUnit] = useViewState<"events" | "time">("rec.unit", "time");
  const [step, setStep] = useViewState("rec.step", DEFAULT_RECURRENCE.step);
  const [maxLag, setMaxLag] = useViewState("rec.lag", 24);
  const [minLine, setMinLine] = useViewState("rec.minLine", 2);
  const [matchNone, setMatchNone] = useViewState("rec.none", false);
  const [text, setText] = useViewState<TextSettings>("rec.text", DEFAULT_TEXT_SETTINGS);
  const [pairIndex, setPairIndex] = useViewState("rec.pair", 0);
  const kindX = layers.find((l) => l.name === layerX)?.kind;
  const words = kindX === "text" && unit === "events";
  const { tokenizer, stopLabel } = useTokenizer(words ? layerX : "", text);

  const res = useMemo(
    () => (layerX && layerY ? analyseRecurrence(files, scheme, { layerX, layerY, pairing, unit, step, maxLag, minLine, matchNone, ...(words ? { tokenizer } : {}) }) : undefined),
    [files, scheme, layerX, layerY, pairing, unit, step, maxLag, minLine, matchNone, words, tokenizer],
  );
  if (!layerX || !layerY) return <Empty title="Choose a layer" />;
  if (!res) return null;
  const pair = res.pairs[Math.min(pairIndex, res.pairs.length - 1)];
  const lagUnit = res.lagUnitMs ? `seconds` : words ? "words" : "events";
  const lagScale = res.lagUnitMs ? res.lagUnitMs / 1000 : 1;
  const mean = (f: (p: RecurrencePair) => number) => {
    const v = res.pairs.map(f).filter((x) => Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  };
  const profile = res.meanProfile.filter((p) => Number.isFinite(p.rr));
  const peak = profile.reduce((a, b) => (b.rr > a.rr ? b : a), profile[0] ?? { lag: 0, rr: NaN, expected: NaN });

  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Settings">
          <Field label="Layer of X" htmlFor="rc-x"><LayerSelect id="rc-x" value={layerX} onChange={(v) => { setLayerX(v); if (layerY === layerX) setLayerY(v); }} /></Field>
          <Field label="Layer of Y" htmlFor="rc-y" hint="The same layer compares participants with each other."><LayerSelect id="rc-y" value={layerY} onChange={setLayerY} /></Field>
          <Field label="Which tiers are compared" htmlFor="rc-pair">
            <Select
              id="rc-pair" value={pairing} onChange={setPairing}
              options={[{ value: "other", label: "different participants" }, { value: "same", label: layerX === layerY ? "each tier with itself" : "same participant" }, { value: "any", label: "all tier pairs" }]}
            />
          </Field>
          <Field label="What is one step" hint={unit === "time" ? "The tiers are sampled at regular intervals; stretches without annotation count as “nothing”." : words ? "One step per (content) word." : "One step per annotation."}>
            <Segmented value={unit} onChange={setUnit} options={[{ value: "time", label: "Time" }, { value: "events", label: kindX === "text" ? "Words" : "Annotations" }]} />
          </Field>
          {unit === "time" && (
            <>
              <Field label="Sampling interval (ms)" htmlFor="rc-step"><NumberField id="rc-step" value={step} min={20} max={10000} step={50} onChange={setStep} /></Field>
              <div style={{ marginTop: 9 }}><Toggle id="rc-none" checked={matchNone} onChange={setMatchNone}>“Nothing” matching “nothing” counts</Toggle></div>
            </>
          )}
          <div className="field-row" style={{ marginTop: 9 }}>
            <Field label="Largest lag (steps)" htmlFor="rc-lag"><NumberField id="rc-lag" value={maxLag} min={1} max={500} step={1} onChange={(v) => setMaxLag(Math.round(v))} /></Field>
            <Field label="Shortest line" htmlFor="rc-line"><NumberField id="rc-line" value={minLine} min={2} max={50} step={1} onChange={(v) => setMinLine(Math.round(v))} /></Field>
          </div>
          {words && <TextSettingsFields value={text} onChange={(p) => setText((prev) => ({ ...prev, ...p }))} stopLabel={stopLabel} idPrefix="rc" />}
        </Card>
        <MethodNote refs={["Dale & Spivey (2006) Lang Learn 56", "Richardson & Dale (2005) Cogn Sci 29", "Coco & Dale (2014) Front Psychol 5", "Louwerse et al. (2012) Cogn Sci 36", "Fusaroli, Konvalinka & Wallot (2014)"]}>
          <p>
            Two sequences <em>recur</em> at (i, j) when element i of X equals element j of Y. The <strong>recurrence rate</strong> is the share of matching positions within the analysed lags; its chance level follows from how often
            each value occurs in the two sequences.
          </p>
          <p>
            The <strong>lag profile</strong> gives the recurrence rate along each diagonal j − i. A peak at a positive lag means Y tends to show what X showed that many steps earlier — X leads. <strong>Determinism</strong> is the share
            of matches that form diagonal runs of at least the chosen length: stretches where one sequence follows the other, not just single coincidences.
          </p>
        </MethodNote>
      </div>
      <div className="stack">
        {res.error && <Callout kind="critical">{res.error}</Callout>}
        {res.pairs.length === 0 || !pair ? (
          <Empty title="No tier pairs to compare">No file has tiers of “{layerX}” and “{layerY}” that fit the chosen rule and hold at least two elements.</Empty>
        ) : (
          <>
            <div className="tiles">
              <Tile label="Tier pairs" value={res.pairs.length} />
              <Tile label="Recurrence rate" value={pct(mean((p) => p.rr))} hint={`chance: ${pct(mean((p) => p.expectedRr))}`} />
              <Tile label="Determinism" value={pct(mean((p) => p.det))} hint={`longest run: ${Math.max(...res.pairs.map((p) => p.maxLine))} steps`} />
              <Tile label="Strongest at lag" value={`${fmt(peak.lag * lagScale, 3)} ${lagUnit}`} hint={peak.lag > 0 ? "X leads" : peak.lag < 0 ? "Y leads" : "simultaneous"} />
            </div>
            <div className="cols-2">
              <ChartCard
                title="Recurrence by lag"
                sub={`Mean over ${res.pairs.length} tier pair${res.pairs.length === 1 ? "" : "s"}. Positive lag: Y repeats X later. The axis does not start at zero.`}
                table={{ columns: [`lag (${lagUnit})`, "recurrence rate", "chance"], rows: res.meanProfile.map((p) => [p.lag * lagScale, p.rr, p.expected]) }}
              >
                <XYChart
                  height={280}
                  crosshair
                  crosshairFormat={(v) => `lag ${fmt(v, 3)} ${lagUnit}`}
                  x={{ type: "linear", label: `lag (${lagUnit}): position in Y − position in X` }}
                  y={{ type: "linear", label: "recurrence rate", format: (v) => `${(v * 100).toFixed(1)}%` }}
                  legend={[{ label: "recurrence rate", color: "var(--series-1)", kind: "line" }, { label: "chance", color: "var(--text-2)", kind: "line", dash: true }]}
                  marks={[
                    { type: "line", color: "var(--series-1)", label: "recurrence rate", points: profile.map((p) => [p.lag * lagScale, p.rr]) },
                    { type: "line", color: "var(--text-2)", dash: "5 4", width: 1.5, label: "chance", points: profile.map((p) => [p.lag * lagScale, p.expected]) },
                    { type: "rule", x: 0, color: "var(--text-3)" },
                  ]}
                  ariaLabel="Recurrence rate by lag between the two sequences"
                />
              </ChartCard>
              <Card
                title="Recurrence plot"
                sub={`${pair.nx.toLocaleString("en-US")} × ${pair.ny.toLocaleString("en-US")} steps`}
                actions={<Select value={String(Math.min(pairIndex, res.pairs.length - 1))} onChange={(v) => setPairIndex(Number(v))} options={res.pairs.map((p, i) => ({ value: String(i), label: `${p.fileName}: ${p.xLabel} × ${p.yLabel}` }))} />}
              >
                <RecurrencePlot pair={pair} />
                <p className="faint" style={{ marginTop: 6 }}>A dot marks a position where both sequences show the same value. Dots above the dashed line: Y shows it later than X.</p>
              </Card>
            </div>
            <Card title="Tier pairs" actions={<><SendToStats dataset={res.dataset} /><DatasetCsvButton dataset={res.dataset} /></>} flush>
              <DataTable<RecurrencePair>
                rows={res.pairs}
                maxHeight={300}
                csvName="recurrence"
                onRowClick={(p) => setPairIndex(res.pairs.indexOf(p))}
                selected={(p) => p === pair}
                columns={[
                  { key: "file", header: "File", value: (p) => p.fileName },
                  { key: "x", header: "X", value: (p) => p.xLabel },
                  { key: "y", header: "Y", value: (p) => p.yLabel },
                  { key: "rr", header: "Recurrence", value: (p) => p.rr, render: (p) => pct(p.rr), numeric: true },
                  { key: "chance", header: "Chance", value: (p) => p.expectedRr, render: (p) => pct(p.expectedRr), numeric: true },
                  { key: "det", header: "Determinism", value: (p) => p.det, render: (p) => pct(p.det), numeric: true },
                  { key: "line", header: "Mean run", value: (p) => p.meanLine, numeric: true, digits: 2 },
                  { key: "max", header: "Longest run", value: (p) => p.maxLine, numeric: true },
                  { key: "peak", header: `Peak lag (${lagUnit})`, value: (p) => p.peakLag * lagScale, numeric: true, digits: 3 },
                  { key: "asym", header: "X leads − Y leads", value: (p) => p.asymmetry, numeric: true, digits: 3, title: "Mean recurrence at positive minus negative lags" },
                ]}
              />
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
