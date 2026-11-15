import { useMemo, useState } from "react";
import { ALL_VALUES, formatDuration, formatTime, type ValueFilter } from "../../core/analysis/common.ts";
import type { Pairing } from "../../core/analysis/cooccurrence.ts";
import { addDerivedLayer, derive, DERIVE_LABEL, removeDerivedLayer, splitByLayer, type DeriveOp } from "../../core/analysis/tieralgebra.ts";
import { layerTiers, roleOf } from "../../core/corpus/corpus.ts";
import { derivedTiersToEaf } from "../../core/eaf/export.ts";
import { zipStore } from "../../core/zip.ts";
import { DEFAULT_TEXT_SETTINGS, useAlignmentOptions, useAlignmentSettings, useTokenizer } from "../alignmentOptions.tsx";
import { ChartCard } from "../charts/ChartCard.tsx";
import { XYChart, type Mark } from "../charts/XYChart.tsx";
import { useLayerValues, useLayers, useViewState } from "../hooks.ts";
import { Button, Callout, Card, CheckList, DataTable, defaultLayer, downloadBytes, downloadText, Empty, Field, FilterField, fmt, LayerSelect, MethodNote, NumberField, PairingSelect, Segmented, Select, Tabs, TextField, Tile } from "../kit.tsx";
import { useStore } from "../store.ts";

type Kind = DeriveOp["kind"];

const KIND_ORDER: Kind[] = ["overlap", "with", "exclude", "union", "pool", "gaps", "filter", "recode", "chain", "window", "tokens", "floor", "alignment"];

interface Settings {
  kind: Kind;
  layer: string;
  layerY: string;
  filter: ValueFilter;
  filterY: ValueFilter;
  pairing: Pairing;
  label: "x" | "y" | "both";
  /** Seconds. */
  minDuration: number;
  maxDuration: number;
  pattern: string;
  replacement: string;
  layers: string[];
  text: string;
  /** Milliseconds. */
  maxGap: number;
  join: "text" | "count" | "first";
  anchor: "start" | "end" | "span";
  before: number;
  after: number;
  minPause: number;
}

const clean = (s: string) => s.replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "");

function suggestName(s: Settings): string {
  switch (s.kind) {
    case "overlap": return clean(`${s.layer}_and_${s.layerY}`);
    case "with": return clean(`${s.layer}_with_${s.layerY}`);
    case "exclude": return clean(`${s.layer}_without_${s.layerY}`);
    case "union": return "merged";
    case "pool": return "pooled";
    case "gaps": return clean(`${s.layer}_gaps`);
    case "filter": return clean(`${s.layer}_filtered`);
    case "recode": return clean(`${s.layer}_recoded`);
    case "chain": return clean(`${s.layer}_joined`);
    case "window": return clean(`${s.layer}_${s.anchor === "span" ? "window" : `at_${s.anchor}`}`);
    case "tokens": return clean(`${s.layer}_words`);
    case "floor": return "floor";
    case "alignment": return clean(`${s.layer}_alignment`);
  }
}

export function DeriveView() {
  const files = useStore((st) => st.files);
  const scheme = useStore((st) => st.scheme);
  const replaceCorpus = useStore((st) => st.replaceCorpus);
  const showInTimeline = useStore((st) => st.showInTimeline);
  const toast = useStore((st) => st.toast);
  const layers = useLayers();
  const [tab, setTab] = useViewState<"new" | "existing" | "split">("derive.tab", "new");
  const speech = defaultLayer(layers, "text", /speech|utter|trans/i);
  const [s, setS] = useViewState<Settings>("derive.settings", {
    kind: "overlap",
    layer: defaultLayer(layers, "categorical", /gest/i),
    layerY: defaultLayer(layers, "categorical", /gaze/i, defaultLayer(layers, "categorical", /gest/i)),
    filter: ALL_VALUES,
    filterY: ALL_VALUES,
    pairing: "same",
    label: "both",
    minDuration: 0,
    maxDuration: 0,
    pattern: "",
    replacement: "",
    layers: [],
    text: "",
    maxGap: 300,
    join: "text",
    anchor: "end",
    before: 500,
    after: 500,
    minPause: 180,
  });
  const patch = (p: Partial<Settings>) => setS((prev) => ({ ...prev, ...p }));
  const [name, setName] = useViewState("derive.name", "");
  const [previewFile, setPreviewFile] = useViewState("derive.file", "");
  const [span, setSpan] = useViewState<"minute" | "all">("derive.span", "minute");

  const twoLayers = s.kind === "overlap" || s.kind === "with" || s.kind === "exclude";
  const textOnly = s.kind === "tokens" || s.kind === "alignment" || s.kind === "floor";
  const layer = layers.some((l) => l.name === s.layer) ? s.layer : "";
  // Operations on transcriptions start from the speech layer unless a text layer is chosen already.
  const mainLayer = textOnly && layers.find((l) => l.name === layer)?.kind !== "text" ? speech : layer;
  const layerY = layers.some((l) => l.name === s.layerY) ? s.layerY : "";
  const values = useLayerValues(mainLayer);
  const valuesY = useLayerValues(layerY);
  const { tokenizer } = useTokenizer(s.kind === "tokens" ? mainLayer : "", DEFAULT_TEXT_SETTINGS);
  // Alignment instances are computed with the settings of the Lexical alignment page, so that the tier holds what that page counts.
  const [alignSettings] = useAlignmentSettings();
  const { options: alignOptions } = useAlignmentOptions({ ...alignSettings, layer: s.kind === "alignment" ? mainLayer : "" });

  const op = useMemo<DeriveOp | undefined>(() => {
    if (s.kind === "union") return s.layers.length >= 1 ? { kind: "union", layers: s.layers, label: s.text || "active" } : undefined;
    if (s.kind === "pool") return s.layers.length >= 2 ? { kind: "pool", layers: s.layers, prefix: s.label !== "x" } : undefined;
    if (!mainLayer) return undefined;
    switch (s.kind) {
      case "filter": return { kind: "filter", layer: mainLayer, filter: s.filter, minDuration: s.minDuration * 1000, maxDuration: s.maxDuration * 1000 };
      case "recode": return { kind: "recode", layer: mainLayer, pattern: s.pattern, replacement: s.replacement };
      case "overlap": return layerY ? { kind: "overlap", layerX: mainLayer, layerY, pairing: s.pairing, label: s.label, filterX: s.filter, filterY: s.filterY } : undefined;
      case "with": return layerY ? { kind: "with", layerX: mainLayer, layerY, pairing: s.pairing, filterX: s.filter, filterY: s.filterY } : undefined;
      case "exclude": return layerY ? { kind: "exclude", layerX: mainLayer, layerY, pairing: s.pairing, filterX: s.filter, filterY: s.filterY } : undefined;
      case "gaps": return { kind: "gaps", layer: mainLayer, label: s.text || "gap", minDuration: s.minDuration * 1000 };
      case "chain": return { kind: "chain", layer: mainLayer, maxGap: s.maxGap, join: s.join };
      case "tokens": return { kind: "tokens", layer: mainLayer, tokenizer };
      case "window": return { kind: "window", layer: mainLayer, anchor: s.anchor, before: s.before, after: s.after };
      case "floor": return { kind: "floor", options: { layer: mainLayer, minPause: s.minPause, minDuration: 0 } };
      case "alignment": return { kind: "alignment", options: alignOptions };
    }
  }, [s, mainLayer, layerY, tokenizer, alignOptions]);

  const result = useMemo(() => (op && tab === "new" ? derive(files, scheme, op) : undefined), [files, scheme, op, tab]);

  const stats = useMemo(() => {
    if (!result) return undefined;
    let annotations = 0;
    let duration = 0;
    const inFiles = new Set<string>();
    const counts = new Map<string, { n: number; duration: number }>();
    for (const t of result.tiers) {
      if (t.annotations.length) inFiles.add(t.fileId);
      for (const a of t.annotations) {
        annotations++;
        duration += a.end - a.start;
        const c = counts.get(a.value) ?? { n: 0, duration: 0 };
        c.n++;
        c.duration += a.end - a.start;
        counts.set(a.value, c);
      }
    }
    const top = [...counts].sort((a, b) => b[1].n - a[1].n).slice(0, 200).map(([value, c]) => ({ value, n: c.n, duration: c.duration }));
    return { annotations, duration, files: inFiles.size, distinct: counts.size, top };
  }, [result]);

  const suggestion = suggestName({ ...s, layer: mainLayer, layerY });
  const wanted = clean(name) || suggestion;
  const existing = new Set(layers.map((l) => l.name));
  let finalName = wanted;
  for (let k = 2; existing.has(finalName); k++) finalName = `${wanted}_${k}`;

  // ---- preview strip -------------------------------------------------------------------
  const filesWithResult = useMemo(() => {
    const ids = new Set((result?.tiers ?? []).filter((t) => t.annotations.length).map((t) => t.fileId));
    return files.filter((f) => ids.has(f.id));
  }, [files, result]);
  const shownFile = filesWithResult.find((f) => f.id === previewFile) ?? filesWithResult[0];
  const strip = useMemo(() => {
    if (!shownFile || !result || !op) return undefined;
    const sourceLayers = op.kind === "union" || op.kind === "pool" ? op.layers : op.kind === "overlap" || op.kind === "with" || op.kind === "exclude" ? [op.layerX, op.layerY] : op.kind === "floor" || op.kind === "alignment" ? [op.options.layer] : [op.layer];
    const rows: { label: string; derived: boolean; annotations: { start: number; end: number; value: string }[] }[] = [];
    for (const l of sourceLayers) for (const lt of layerTiers([shownFile], scheme, l)) rows.push({ label: lt.tier.id, derived: false, annotations: lt.tier.annotations });
    for (const t of result.tiers.filter((d) => d.fileId === shownFile.id)) rows.push({ label: t.participant ? `${t.participant}_${finalName}` : finalName, derived: true, annotations: t.annotations });
    const first = Math.min(...rows.filter((r) => r.derived).flatMap((r) => (r.annotations[0] ? [r.annotations[0].start] : [])));
    const from = span === "all" || !Number.isFinite(first) ? 0 : Math.max(0, first - 3000);
    const to = span === "all" ? shownFile.doc.duration : Math.min(shownFile.doc.duration, from + 60000);
    const marks: Mark[] = [false, true].map((derived) => ({
      type: "rect" as const,
      color: derived ? "var(--series-1)" : "var(--text-3)",
      opacity: derived ? 1 : 0.55,
      data: rows.flatMap((r, i) =>
        r.derived !== derived
          ? []
          : r.annotations
              .filter((a) => a.end > from && a.start < to)
              .slice(0, 4000)
              .map((a) => ({
                x0: Math.max(a.start, from) / 1000,
                x1: Math.min(a.end, to) / 1000,
                y0: rows.length - i - 0.82,
                y1: rows.length - i - 0.18,
                tip: { title: a.value || "(empty)", rows: [["tier", r.label], ["from", formatTime(a.start)], ["duration", `${fmt((a.end - a.start) / 1000, 3)} s`]] as [string, string][] },
              })),
      ),
    }));
    return { rows, marks, from, to };
  }, [shownFile, result, op, scheme, finalName, span]);

  // ---- existing derived layers ----------------------------------------------------------
  const derivedLayers = useMemo(() => {
    const acc = new Map<string, { layer: string; tiers: number; annotations: number; files: Set<string>; first?: { fileId: string; tierId: string; start: number; end: number } }>();
    for (const f of files) {
      for (const t of f.doc.tiers) {
        if (!t.derived) continue;
        const l = roleOf(scheme, t.id).layer;
        const e = acc.get(l) ?? { layer: l, tiers: 0, annotations: 0, files: new Set<string>() };
        e.tiers++;
        e.annotations += t.annotations.length;
        e.files.add(f.id);
        if (!e.first && t.annotations[0]) e.first = { fileId: f.id, tierId: t.id, start: t.annotations[0].start, end: t.annotations[0].end };
        acc.set(l, e);
      }
    }
    return [...acc.values()];
  }, [files, scheme]);

  const add = () => {
    if (!result || !stats) return;
    const r = addDerivedLayer(files, scheme, result.tiers, finalName);
    replaceCorpus(r.files, r.scheme);
    setName("");
    toast(`Layer “${finalName}” added: ${r.added} tier${r.added === 1 ? "" : "s"}, ${stats.annotations.toLocaleString("en-US")} annotations. It can now be used in every analysis.`);
  };

  const exportDerived = (only?: string) => {
    const wantedLayers = only ? new Set([only]) : undefined;
    const out = files.flatMap((f) => {
      const xml = derivedTiersToEaf(f, scheme, wantedLayers);
      return xml ? [{ name: `${f.name}_derived.eaf`, data: new TextEncoder().encode(xml) }] : [];
    });
    if (out.length === 0) return;
    const ok = out.length === 1 ? downloadText(out[0]!.name, new TextDecoder().decode(out[0]!.data), "application/xml") : downloadBytes(`${only ?? "derived_tiers"}.zip`, zipStore(out), "application/zip");
    if (!ok) toast("The browser did not allow the download.", "error");
  };

  return (
    <div className="stack">
      <Tabs
        tabs={[
          { id: "new", label: "New derived layer" },
          { id: "existing", label: `Derived layers (${derivedLayers.length})` },
          { id: "split", label: "Split recordings" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "new" && (
        <div className="view-grid">
          <div className="stack">
            <Card title="Operation">
              <Field label="What to compute" htmlFor="dv-kind" hint={DERIVE_LABEL[s.kind].description}>
                <Select id="dv-kind" value={s.kind} onChange={(kind) => patch({ kind })} options={KIND_ORDER.map((k) => ({ value: k, label: DERIVE_LABEL[k].title }))} />
              </Field>

              {s.kind === "union" || s.kind === "pool" ? (
                <Field label={s.kind === "pool" ? "Layers to pool" : "Layers to merge"}>
                  <CheckList options={layers.map((l) => ({ value: l.name, label: l.name }))} selected={s.layers.filter((l) => existing.has(l))} onChange={(v) => patch({ layers: v })} />
                </Field>
              ) : (
                <Field label={twoLayers ? "Layer X" : "Layer"} htmlFor="dv-layer">
                  <LayerSelect id="dv-layer" value={mainLayer} onChange={(v) => patch({ layer: v, filter: ALL_VALUES })} {...(textOnly ? { kinds: ["text" as const] } : {})} />
                </Field>
              )}

              {(s.kind === "filter" || twoLayers) && <FilterField id="dv-filter" label={twoLayers ? "Values of X" : "Values to keep"} value={s.filter} onChange={(filter) => patch({ filter })} values={values} />}

              {twoLayers && (
                <>
                  <Field label="Layer Y" htmlFor="dv-layer-y"><LayerSelect id="dv-layer-y" value={layerY} onChange={(v) => patch({ layerY: v, filterY: ALL_VALUES })} /></Field>
                  <FilterField id="dv-filter-y" label="Values of Y" value={s.filterY} onChange={(filterY) => patch({ filterY })} values={valuesY} />
                  <Field label="Which tiers go together" htmlFor="dv-pairing"><PairingSelect id="dv-pairing" value={s.pairing} onChange={(pairing) => patch({ pairing })} /></Field>
                </>
              )}
              {s.kind === "pool" && (
                <Field label="Values" hint="With the layer name in front, values of different layers stay apart, e.g. gaze:partner and head:nod.">
                  <Segmented value={s.label === "x" ? "x" : "both"} onChange={(label) => patch({ label })} options={[{ value: "both", label: "layer:value" }, { value: "x", label: "value only" }]} />
                </Field>
              )}
              {s.kind === "overlap" && (
                <Field label="Value of the new annotations">
                  <Segmented value={s.label} onChange={(label) => patch({ label })} options={[{ value: "both", label: "X + Y" }, { value: "x", label: "X" }, { value: "y", label: "Y" }]} />
                </Field>
              )}

              {s.kind === "filter" && (
                <div className="field-row" style={{ marginTop: 9 }}>
                  <Field label="At least (s)" htmlFor="dv-min"><NumberField id="dv-min" value={s.minDuration} min={0} step={0.1} onChange={(minDuration) => patch({ minDuration })} /></Field>
                  <Field label="At most (s)" htmlFor="dv-max" hint="0 = no limit"><NumberField id="dv-max" value={s.maxDuration} min={0} step={0.1} onChange={(maxDuration) => patch({ maxDuration })} /></Field>
                </div>
              )}

              {s.kind === "recode" && (
                <>
                  <Field label="Replace (regular expression)" htmlFor="dv-pattern" hint="For example ^(iconic|metaphoric)$ to merge two categories." error={result?.error}>
                    <TextField id="dv-pattern" mono value={s.pattern} onChange={(pattern) => patch({ pattern })} invalid={!!result?.error} />
                  </Field>
                  <Field label="by" htmlFor="dv-repl" hint="$1, $2 … insert the bracketed groups of the pattern.">
                    <TextField id="dv-repl" mono value={s.replacement} onChange={(replacement) => patch({ replacement })} />
                  </Field>
                </>
              )}

              {(s.kind === "union" || s.kind === "gaps") && (
                <Field label="Value of the new annotations" htmlFor="dv-text">
                  <TextField id="dv-text" value={s.text} onChange={(text) => patch({ text })} placeholder={s.kind === "gaps" ? "gap" : "active"} />
                </Field>
              )}
              {s.kind === "gaps" && (
                <Field label="Shortest gap that counts (s)" htmlFor="dv-gapmin">
                  <NumberField id="dv-gapmin" value={s.minDuration} min={0} step={0.1} onChange={(minDuration) => patch({ minDuration })} />
                </Field>
              )}

              {s.kind === "chain" && (
                <>
                  <Field label="Join across gaps up to (ms)" htmlFor="dv-maxgap"><NumberField id="dv-maxgap" value={s.maxGap} min={0} step={50} onChange={(maxGap) => patch({ maxGap })} /></Field>
                  <Field label="Value of the joined annotation">
                    <Segmented value={s.join} onChange={(join) => patch({ join })} options={[{ value: "text", label: "Texts joined" }, { value: "first", label: "First value" }, { value: "count", label: "Number of parts" }]} />
                  </Field>
                </>
              )}

              {s.kind === "window" && (
                <>
                  <Field label="Window around">
                    <Segmented value={s.anchor} onChange={(anchor) => patch({ anchor })} options={[{ value: "start", label: "the start" }, { value: "end", label: "the end" }, { value: "span", label: "the whole annotation" }]} />
                  </Field>
                  <div className="field-row" style={{ marginTop: 9 }}>
                    <Field label="Before (ms)" htmlFor="dv-before"><NumberField id="dv-before" value={s.before} min={0} step={100} onChange={(before) => patch({ before })} /></Field>
                    <Field label="After (ms)" htmlFor="dv-after"><NumberField id="dv-after" value={s.after} min={0} step={100} onChange={(after) => patch({ after })} /></Field>
                  </div>
                </>
              )}

              {s.kind === "floor" && (
                <Field label="Shortest silence that splits a speaker's talk (ms)" htmlFor="dv-pause" hint="Shorter silences inside one speaker's talk are bridged.">
                  <NumberField id="dv-pause" value={s.minPause} min={0} step={20} onChange={(minPause) => patch({ minPause })} />
                </Field>
              )}
              {s.kind === "alignment" && <p className="faint" style={{ margin: "9px 0 0" }}>Uses the settings of the Lexical alignment page (unit, shortest expression, look-back, function words), so the tier holds exactly the instances counted there.</p>}
            </Card>

            <Card title="Add to the corpus">
              <Field label="Name of the new layer" htmlFor="dv-name" hint={finalName !== wanted ? `“${wanted}” exists already; the layer will be called “${finalName}”.` : "Tiers are named participant_layer, as in the rest of the corpus."}>
                <TextField id="dv-name" value={name} onChange={setName} placeholder={suggestion} mono />
              </Field>
              <div className="row" style={{ marginTop: 10 }}>
                <Button kind="primary" icon="plus" disabled={!result || !!result.error || !stats || stats.annotations === 0 || !finalName} onClick={add}>Add layer</Button>
              </div>
            </Card>

            <MethodNote title="What derived tiers are for">
              <p>
                A derived tier is computed from other tiers and then behaves like any tier of the corpus: it shows up in the timeline, and it can be counted, cross-tabulated, tested and combined again. This turns questions such as
                “how often do iconic gestures occur while the speaker looks at the partner?” into two steps — derive the overlap, then analyse it.
              </p>
              <p>
                Tiers are matched within a recording by participant (“same participant”), across participants, or in all combinations. Your .eaf files are never changed; derived tiers live in this session and can be exported as
                separate .eaf files to merge in ELAN.
              </p>
            </MethodNote>
          </div>

          <div className="stack">
            {!op ? (
              <Empty title={s.kind === "union" ? "Tick the layers to merge" : s.kind === "pool" ? "Tick at least two layers to pool" : "Choose the layers to work on"} />
            ) : result?.error ? (
              <Callout kind="warning">{result.error}</Callout>
            ) : !stats || stats.annotations === 0 ? (
              <Empty title="This operation gives no annotations">Check the filters and the pairing of tiers: with these settings nothing is left.</Empty>
            ) : (
              <>
                <div className="tiles">
                  <Tile label="New annotations" value={stats.annotations.toLocaleString("en-US")} />
                  <Tile label="On tiers" value={String(result!.tiers.length)} hint={`in ${stats.files} of ${files.length} files`} />
                  <Tile label="Total duration" value={formatDuration(stats.duration)} />
                  <Tile label="Different values" value={stats.distinct.toLocaleString("en-US")} />
                </div>
                {strip && shownFile && (
                  <ChartCard title="Preview" sub={`${shownFile.name}, ${formatTime(strip.from, false)} – ${formatTime(strip.to, false)}. Grey: source tiers; blue: the new tier.`}>
                    <div className="row" style={{ marginBottom: 8 }}>
                      <div style={{ flex: "0 1 240px", minWidth: 0 }}><Select value={shownFile.id} onChange={setPreviewFile} options={filesWithResult.map((f) => ({ value: f.id, label: f.name }))} /></div>
                      <Segmented value={span} onChange={setSpan} options={[{ value: "minute", label: "One minute" }, { value: "all", label: "Whole recording" }]} />
                    </div>
                    <XYChart
                      height={48 + strip.rows.length * 30}
                      x={{ type: "linear", domain: [strip.from / 1000, strip.to / 1000], label: "time (s)" }}
                      y={{ type: "linear", domain: [0, strip.rows.length], tickValues: strip.rows.map((_, i) => strip.rows.length - i - 0.5), format: (v) => strip.rows[Math.round(strip.rows.length - v - 0.5)]?.label ?? "" }}
                      marks={strip.marks}
                      legend={[{ label: "source tiers", color: "var(--text-3)", kind: "rect" }, { label: "new tier", color: "var(--series-1)", kind: "rect" }]}
                      ariaLabel="Source tiers and the derived tier on a time axis"
                    />
                  </ChartCard>
                )}
                <Card title="Values of the new layer" flush>
                  <DataTable
                    rows={stats.top}
                    maxHeight={300}
                    rowKey={(r) => r.value}
                    columns={[
                      { key: "value", header: "Value", value: (r) => r.value || "(empty)", wrap: true },
                      { key: "n", header: "Annotations", value: (r) => r.n, numeric: true, digits: 0 },
                      { key: "dur", header: "Total duration (s)", value: (r) => r.duration / 1000, numeric: true },
                      { key: "mean", header: "Mean duration (s)", value: (r) => r.duration / r.n / 1000, numeric: true },
                    ]}
                  />
                </Card>
              </>
            )}
          </div>
        </div>
      )}

      {tab === "existing" &&
        (derivedLayers.length === 0 ? (
          <Empty title="No derived layers yet" action={<Button onClick={() => setTab("new")}>Compute one</Button>}>Layers you add under “New derived layer” are listed here, where you can export or remove them.</Empty>
        ) : (
          <Card
            title="Derived layers in this session"
            sub="They are used like any other layer. Exports contain only the derived tiers; merge them with your original files in ELAN (File › Merge Transcriptions)."
            actions={<Button small icon="download" onClick={() => exportDerived()}>Export all (.eaf)</Button>}
            flush
          >
            <DataTable
              rows={derivedLayers}
              rowKey={(r) => r.layer}
              columns={[
                { key: "layer", header: "Layer", value: (r) => r.layer },
                { key: "tiers", header: "Tiers", value: (r) => r.tiers, numeric: true, digits: 0 },
                { key: "files", header: "Files", value: (r) => r.files.size, numeric: true, digits: 0 },
                { key: "n", header: "Annotations", value: (r) => r.annotations, numeric: true, digits: 0 },
                {
                  key: "actions",
                  header: "",
                  value: () => "",
                  render: (r) => (
                    <div className="row end">
                      <Button small kind="ghost" icon="timeline" disabled={!r.first} onClick={() => r.first && showInTimeline(r.first)}>Timeline</Button>
                      <Button small kind="ghost" icon="download" onClick={() => exportDerived(r.layer)}>.eaf</Button>
                      <Button
                        small
                        kind="ghost"
                        icon="trash"
                        onClick={() => {
                          const out = removeDerivedLayer(files, scheme, r.layer);
                          replaceCorpus(out.files, out.scheme);
                          toast(`Layer “${r.layer}” removed.`);
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </Card>
        ))}

      {tab === "split" && <SplitRecordings />}
    </div>
  );
}

/** Cut every recording at the annotations of a layer (rounds, tasks, topics) into recordings of their own. */
function SplitRecordings() {
  const files = useStore((st) => st.files);
  const scheme = useStore((st) => st.scheme);
  const replaceCorpus = useStore((st) => st.replaceCorpus);
  const toast = useStore((st) => st.toast);
  const layers = useLayers();
  const [layer, setLayer] = useViewState("split.layer", defaultLayer(layers, "categorical", /round|phase|task|trial|topic|block/i));
  const [filter, setFilter] = useViewState<ValueFilter>("split.filter", ALL_VALUES);
  const [variable, setVariable] = useViewState("split.variable", "");
  const [confirm, setConfirm] = useState(false);
  const values = useLayerValues(layer);
  const varName = variable.trim() || layer;
  const split = useMemo(() => (layer ? splitByLayer(files, scheme, layer, filter, varName) : undefined), [files, scheme, layer, filter, varName]);
  const sources = new Set((split?.files ?? []).map((f) => f.meta.source_file)).size;
  const total = (split?.files ?? []).reduce((sum, f) => sum + f.doc.duration, 0);

  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Split at the annotations of a layer">
          <Field label="Layer that marks the parts" htmlFor="sp-layer" hint="For example a tier with task phases, rounds or topics.">
            <LayerSelect id="sp-layer" value={layer} onChange={(v) => { setLayer(v); setFilter(ALL_VALUES); setConfirm(false); }} />
          </Field>
          <FilterField id="sp-filter" label="Parts to keep" value={filter} onChange={(f) => { setFilter(f); setConfirm(false); }} values={values} />
          <Field label="Name of the new file variable" htmlFor="sp-var" hint="It holds the value of the annotation each part was cut from.">
            <TextField id="sp-var" value={variable} onChange={setVariable} placeholder={layer} mono />
          </Field>
          <div className="row" style={{ marginTop: 12 }}>
            {confirm ? (
              <>
                <Button
                  kind="primary"
                  onClick={() => {
                    if (!split) return;
                    replaceCorpus(split.files);
                    setConfirm(false);
                    toast(`The corpus now consists of ${split.files.length} parts.`);
                  }}
                >
                  Replace the corpus by {split?.files.length ?? 0} parts
                </Button>
                <Button onClick={() => setConfirm(false)}>Cancel</Button>
              </>
            ) : (
              <Button kind="primary" disabled={!split || split.files.length === 0 || !!split.error} onClick={() => setConfirm(true)}>Split the recordings</Button>
            )}
          </div>
        </Card>
        <MethodNote title="When to split">
          <p>
            Many designs vary a condition <em>within</em> a recording: rounds of a game, task phases, topics. After splitting, every part is a recording of its own, with time starting at zero and the part's label stored in a file
            variable — so every analysis can compare the parts like conditions.
          </p>
          <p>
            The name of the original file is kept in the variable <span className="mono">source_file</span>; use it as a grouping variable in the multilevel model, because parts of one recording are not independent. Annotations that
            cross a boundary are cut. Your files on disk are not changed; load them again to undo the split.
          </p>
        </MethodNote>
      </div>
      <div className="stack">
        {!split || split.files.length === 0 ? (
          <Empty title="Nothing to split">{split?.error ?? "The chosen layer has no annotations (with these values)."}</Empty>
        ) : (
          <>
            <div className="tiles">
              <Tile label="Parts" value={split.files.length.toLocaleString("en-US")} hint={`from ${sources} of ${files.length} recordings`} />
              <Tile label="Total duration" value={formatDuration(total)} />
              <Tile label="Mean duration" value={formatDuration(total / split.files.length)} />
            </div>
            <Card title="The parts" sub="This is what the corpus will consist of." flush>
              <DataTable
                rows={split.files}
                maxHeight={460}
                rowKey={(f) => f.id}
                columns={[
                  { key: "name", header: "New recording", value: (f) => f.name },
                  { key: "var", header: varName, value: (f) => f.meta[varName] ?? "" },
                  { key: "src", header: "source_file", value: (f) => f.meta.source_file ?? "" },
                  { key: "dur", header: "Duration (s)", value: (f) => f.doc.duration / 1000, numeric: true },
                  { key: "n", header: "Annotations", value: (f) => f.doc.tiers.reduce((sum, t) => sum + t.annotations.length, 0), numeric: true, digits: 0 },
                ]}
              />
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
