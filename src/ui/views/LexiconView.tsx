import { useMemo } from "react";
import { formatTime } from "../../core/analysis/common.ts";
import { collectTokens, concordance, countTypes, diversityDataset, frequencyList, keyness, type ConcordanceLine, type FrequencyRow, type KeynessRow, type TokenRecord } from "../../core/analysis/lexicon.ts";
import { numberColumn, stringColumn } from "../../core/data/dataset.ts";
import { DEFAULT_TEXT_SETTINGS, TextSettingsFields, useTokenizer, type TextSettings } from "../alignmentOptions.tsx";
import { ChartCard } from "../charts/ChartCard.tsx";
import { GroupChart } from "../charts/GroupChart.tsx";
import { XYChart } from "../charts/XYChart.tsx";
import { useDebounced, useLayers, useMetaVariables, useViewState } from "../hooks.ts";
import { Callout, Card, DataTable, DatasetCsvButton, defaultLayer, Empty, Field, fmt, LayerSelect, MethodNote, NumberField, Select, SendToStats, Tabs, TextField, Tile, Toggle } from "../kit.tsx";
import { useStore } from "../store.ts";

type Tab = "frequency" | "diversity" | "keyness" | "concordance";

export function LexiconView() {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const layers = useLayers();
  const variables = useMetaVariables();
  const [layer, setLayer] = useViewState("lex.layer", defaultLayer(layers, "text", /speech|utter|trans|text|word|orth/i));
  const [text, setText] = useViewState<TextSettings>("lex.text", DEFAULT_TEXT_SETTINGS);
  const [tab, setTab] = useViewState<Tab>("lex.tab", "frequency");
  const [contentOnly, setContentOnly] = useViewState("lex.content", true);
  const { tokenizer, stopLabel } = useTokenizer(layer, text);
  const tokens = useMemo(() => (layer ? collectTokens(files, scheme, layer, tokenizer) : []), [files, scheme, layer, tokenizer]);
  const fileMeta = useMemo(() => new Map(files.map((f) => [f.id, f.meta])), [files]);

  if (!layer) return <Empty title="No transcription layer found">The lexicon needs a layer with transcribed text.</Empty>;
  const types = new Set(tokens.map((t) => t.norm)).size;

  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Settings">
          <Field label="Transcription layer" htmlFor="lx-layer"><LayerSelect id="lx-layer" value={layer} onChange={setLayer} kinds={["text"]} /></Field>
          <TextSettingsFields value={text} onChange={(p) => setText((prev) => ({ ...prev, ...p }))} stopLabel={stopLabel} idPrefix="lx" />
          <div style={{ marginTop: 10 }}>
            <Toggle id="lx-content" checked={contentOnly} onChange={setContentOnly}>Leave function words out of the lists</Toggle>
          </div>
        </Card>
        <MethodNote refs={["Gries (2008) Int J Corpus Linguist 13", "Covington & McFall (2010) J Quant Linguist 17", "McCarthy & Jarvis (2010) Behav Res Methods 42", "Monroe, Colaresi & Quinn (2008) Polit Anal 16"]}>
          <p>
            <strong>Dispersion</strong> (DP) is 0 when a word is spread over the files exactly like the corpus as a whole, and approaches 1 when it is concentrated in few files. <strong>MATTR</strong> and <strong>MTLD</strong> are
            measures of lexical diversity that, unlike the type–token ratio, do not shrink with text length.
          </p>
          <p>
            <strong>Key words</strong> are ranked by a Bayesian log odds ratio with an informative Dirichlet prior (“Fightin' Words”): the prior is the pooled word distribution, so words with little data are pulled towards “no
            difference” instead of topping the list.
          </p>
        </MethodNote>
      </div>
      <div className="stack">
        <div className="tiles">
          <Tile label="Words (tokens)" value={tokens.length.toLocaleString("en-US")} />
          <Tile label="Different words (types)" value={types.toLocaleString("en-US")} />
          <Tile label="Function words" value={tokens.length ? `${Math.round((100 * tokens.filter((t) => t.stop).length) / tokens.length)}%` : "–"} hint={stopLabel} />
        </div>
        <section className="card">
          <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "frequency", label: "Frequencies" }, { id: "diversity", label: "Diversity" }, { id: "keyness", label: "Key words" }, { id: "concordance", label: "Concordance" }]} />
          {tab === "frequency" && <FrequencyPanel tokens={tokens} contentOnly={contentOnly} />}
          {tab === "diversity" && <DiversityPanel layer={layer} tokenizer={tokenizer} variables={variables} />}
          {tab === "keyness" && <KeynessPanel tokens={tokens} contentOnly={contentOnly} variables={variables} fileMeta={fileMeta} />}
          {tab === "concordance" && <ConcordancePanel tokens={tokens} />}
        </section>
      </div>
    </div>
  );
}

function FrequencyPanel({ tokens, contentOnly }: { tokens: TokenRecord[]; contentOnly: boolean }) {
  const setViewState = useStore((s) => s.setViewState);
  const rows = useMemo(() => frequencyList(tokens).filter((r) => !contentOnly || !r.stop), [tokens, contentOnly]);
  const zipf = rows.slice(0, 400).map((r, i) => [i + 1, r.count] as [number, number]);
  return (
    <div className="stack" style={{ padding: "12px 14px 14px" }}>
      <div className="cols-2">
        <ChartCard title="Most frequent words" sub="Occurrences per 1,000 words." table={{ columns: ["word", "per 1,000"], rows: rows.slice(0, 20).map((r) => [r.type, r.perThousand]) }}>
          <XYChart
            height={Math.max(180, 40 + Math.min(rows.length, 20) * 19)}
            x={{ type: "linear", zero: true, label: "per 1,000 words", grid: true }}
            y={{ type: "band", domain: rows.slice(0, 20).map((r) => r.type), padding: 0.3 }}
            marks={[{ type: "bar", horizontal: true, data: rows.slice(0, 20).map((r) => ({ x: r.type, y: r.perThousand, tip: { title: r.type, rows: [["occurrences", String(r.count)], ["per 1,000 words", fmt(r.perThousand)], ["files", String(r.files)]] } })) }]}
            ariaLabel="The twenty most frequent words"
          />
        </ChartCard>
        <ChartCard title="Rank and frequency" sub="Both axes logarithmic (Zipf's law predicts a straight line)." table={{ columns: ["rank", "count"], rows: zipf.slice(0, 60) }}>
          {zipf.length >= 3 ? (
            <XYChart
              height={260}
              x={{ type: "log", label: "rank", format: (v) => String(Math.round(v)) }}
              y={{ type: "log", label: "occurrences", format: (v) => String(Math.round(v)) }}
              marks={[{ type: "dot", r: 2.5, ring: false, data: zipf.map(([x, y]) => ({ x, y })) }]}
              ariaLabel="Word frequency by rank on logarithmic axes"
            />
          ) : <Empty title="Not enough words" />}
        </ChartCard>
      </div>
      <DataTable<FrequencyRow>
        rows={rows}
        csvName="word_frequencies"
        maxHeight={360}
        onRowClick={(r) => { setViewState("lex.query", r.type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); setViewState("lex.tab", "concordance"); }}
        columns={[
          { key: "type", header: "Word", value: (r) => r.type },
          { key: "count", header: "Count", value: (r) => r.count, numeric: true },
          { key: "pt", header: "Per 1,000", value: (r) => r.perThousand, numeric: true, digits: 2 },
          { key: "files", header: "Files", value: (r) => r.files, numeric: true },
          { key: "speakers", header: "Speakers", value: (r) => r.speakers, numeric: true },
          { key: "dp", header: "Dispersion (DP)", value: (r) => r.dp, numeric: true, digits: 2, title: "0 = evenly spread over the files, 1 = concentrated in few" },
        ]}
      />
      <p className="faint">Click a word to see it in context.</p>
    </div>
  );
}

function DiversityPanel({ layer, tokenizer, variables }: { layer: string; tokenizer: Parameters<typeof collectTokens>[3]; variables: string[] }) {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const [measure, setMeasure] = useViewState("lex.divMeasure", "mattr");
  const [groupBy, setGroupBy] = useViewState("lex.divGroup", variables[variables.length - 1] ?? "participant");
  const ds = useMemo(() => diversityDataset(files, scheme, layer, tokenizer, variables), [files, scheme, layer, tokenizer, variables]);
  const labels: Record<string, string> = { mattr: "Moving-average TTR (window 50)", mtld: "MTLD", ttr: "Type–token ratio", guiraud: "Guiraud's index", types: "Types", tokens: "Tokens", tokens_per_min: "Words per minute", yule_k: "Yule's K" };
  const groups = useMemo(() => {
    const y = numberColumn(ds, measure);
    const g = stringColumn(ds, groupBy);
    const file = stringColumn(ds, "file");
    const part = stringColumn(ds, "participant");
    const acc = new Map<string, { values: number[]; names: string[] }>();
    for (let i = 0; i < ds.rowCount; i++) {
      const k = g[i] || "(none)";
      const e = acc.get(k) ?? { values: [], names: [] };
      e.values.push(y[i]!);
      e.names.push(`${file[i]} · ${part[i]}`);
      acc.set(k, e);
    }
    return [...acc.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([label, e]) => ({ label, ...e }));
  }, [ds, measure, groupBy]);
  return (
    <div className="stack" style={{ padding: "12px 14px 14px" }}>
      <div className="row">
        <Field label="Measure" htmlFor="lx-div"><Select id="lx-div" value={measure} onChange={setMeasure} options={Object.entries(labels).map(([value, label]) => ({ value, label }))} /></Field>
        <Field label="Compare by" htmlFor="lx-divg"><Select id="lx-divg" value={groupBy} onChange={setGroupBy} options={[{ value: "participant", label: "participant" }, ...variables.map((v) => ({ value: v, label: v }))]} /></Field>
        <span className="spacer" />
        <SendToStats dataset={ds} />
        <DatasetCsvButton dataset={ds} />
      </div>
      <ChartCard title={labels[measure] ?? measure} sub="One dot per speaker and file; black: group mean with 95% credible interval.">
        <GroupChart groups={groups} yLabel={labels[measure] ?? measure} xLabel={groupBy} />
      </ChartCard>
      {measure === "ttr" && <Callout>The type–token ratio falls as texts get longer. Prefer MATTR or MTLD when speakers differ in how much they say.</Callout>}
    </div>
  );
}

function KeynessPanel({ tokens, contentOnly, variables, fileMeta }: { tokens: TokenRecord[]; contentOnly: boolean; variables: string[]; fileMeta: Map<string, Record<string, string>> }) {
  const [by, setBy] = useViewState("lex.keyBy", variables[variables.length - 1] ?? "participant");
  const [prior, setPrior] = useViewState("lex.keyPrior", 500);
  const levelOf = (t: TokenRecord) => (by === "participant" ? t.participant : fileMeta.get(t.fileId)?.[by] ?? "") || "(none)";
  const levels = useMemo(() => [...new Set(tokens.map(levelOf))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [tokens, by, fileMeta]); // eslint-disable-line react-hooks/exhaustive-deps
  const [a, setA] = useViewState("lex.keyA", "");
  const [b, setB] = useViewState("lex.keyB", "");
  const la = levels.includes(a) ? a : levels[0] ?? "";
  const lb = levels.includes(b) && b !== la ? b : levels.find((l) => l !== la) ?? "";
  const rows = useMemo(() => {
    if (!la || !lb) return [];
    return keyness(countTypes(tokens.filter((t) => levelOf(t) === la), contentOnly), countTypes(tokens.filter((t) => levelOf(t) === lb), contentOnly), prior);
  }, [tokens, la, lb, contentOnly, prior, by, fileMeta]); // eslint-disable-line react-hooks/exhaustive-deps
  if (levels.length < 2) return <div style={{ padding: 14 }}><Empty title="Nothing to compare">Key words compare two groups, for example two participants or two conditions.</Empty></div>;
  const top = [...rows.slice(0, 12), ...rows.slice(-12).filter((r) => !rows.slice(0, 12).includes(r))];
  return (
    <div className="stack" style={{ padding: "12px 14px 14px" }}>
      <div className="row">
        <Field label="Groups defined by" htmlFor="lx-kby"><Select id="lx-kby" value={by} onChange={setBy} options={[{ value: "participant", label: "participant" }, ...variables.map((v) => ({ value: v, label: v }))]} /></Field>
        <Field label="Group A" htmlFor="lx-ka"><Select id="lx-ka" value={la} onChange={setA} options={levels.map((l) => ({ value: l, label: l }))} /></Field>
        <Field label="Group B" htmlFor="lx-kb"><Select id="lx-kb" value={lb} onChange={setB} options={levels.filter((l) => l !== la).map((l) => ({ value: l, label: l }))} /></Field>
        <Field label="Prior strength (words)" htmlFor="lx-kp"><div style={{ width: 100 }}><NumberField id="lx-kp" value={prior} min={1} max={100000} step={100} onChange={setPrior} /></div></Field>
      </div>
      <ChartCard
        title={`Words typical of ${la} and of ${lb}`}
        sub="Log odds ratio with 95% credible interval; the twelve most typical words of each group."
        table={{ columns: ["word", "log odds ratio", "lower", "upper"], rows: top.map((r) => [r.type, r.logOdds, r.ci[0], r.ci[1]]) }}
      >
        <XYChart
          height={Math.max(200, 50 + top.length * 19)}
          x={{ type: "linear", label: `← more typical of ${lb}        log odds ratio        more typical of ${la} →`, grid: true }}
          y={{ type: "band", domain: top.map((r) => r.type), padding: 0.4 }}
          marks={[
            { type: "rule", x: 0, color: "var(--text-2)" },
            { type: "interval", horizontal: true, data: top.map((r) => ({ x: r.type, lo: r.ci[0], hi: r.ci[1] })), color: "var(--text-3)" },
            { type: "dot", data: top.map((r) => ({ x: r.logOdds, y: r.type, color: r.logOdds >= 0 ? "var(--series-1)" : "var(--series-2)", tip: { title: r.type, rows: [[`in ${la}`, `${r.countA} (${fmt(r.rateA, 2)} per 1,000)`], [`in ${lb}`, `${r.countB} (${fmt(r.rateB, 2)} per 1,000)`], [`probability that it is more typical of ${la}`, fmt(r.pA, 3)]] } })) },
          ]}
          legend={[{ label: `typical of ${la}`, color: "var(--series-1)", kind: "dot" }, { label: `typical of ${lb}`, color: "var(--series-2)", kind: "dot" }]}
          ariaLabel="Key words of two groups with credible intervals"
        />
      </ChartCard>
      <DataTable<KeynessRow>
        rows={rows}
        csvName={`keywords_${la}_vs_${lb}`}
        maxHeight={320}
        columns={[
          { key: "type", header: "Word", value: (r) => r.type },
          { key: "a", header: la, value: (r) => r.countA, numeric: true },
          { key: "b", header: lb, value: (r) => r.countB, numeric: true },
          { key: "lo", header: "Log odds ratio", value: (r) => r.logOdds, numeric: true, digits: 2 },
          { key: "ci", header: "95% CrI", value: (r) => r.ci[0], render: (r) => `${fmt(r.ci[0], 2)} – ${fmt(r.ci[1], 2)}`, numeric: true },
          { key: "p", header: `P(more typical of ${la})`, value: (r) => r.pA, numeric: true, digits: 3 },
        ]}
      />
    </div>
  );
}

function ConcordancePanel({ tokens }: { tokens: TokenRecord[] }) {
  const showInTimeline = useStore((s) => s.showInTimeline);
  const [query, setQuery] = useViewState("lex.query", "");
  const [context, setContext] = useViewState("lex.context", 6);
  const q = useDebounced(query, 200);
  const res = useMemo(() => concordance(tokens, q, context), [tokens, q, context]);
  return (
    <div className="stack" style={{ padding: "12px 14px 14px" }}>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div style={{ flex: "1 1 260px" }}>
          <Field label="Word or phrase" htmlFor="lx-q" hint="Each word is a regular expression matched against a whole word: red · colou?r · the .* one" error={res.error}>
            <TextField id="lx-q" mono value={query} onChange={setQuery} placeholder="type a word …" invalid={!!res.error} />
          </Field>
        </div>
        <Field label="Words of context" htmlFor="lx-ctx"><div style={{ width: 90 }}><NumberField id="lx-ctx" value={context} min={1} max={30} step={1} onChange={(v) => setContext(Math.round(v))} /></div></Field>
      </div>
      {q.trim() === "" ? (
        <Empty title="Search for a word to see every place it occurs" />
      ) : (
        <>
          <p className="muted"><strong className="num" style={{ color: "var(--text)" }}>{res.total.toLocaleString("en-US")}</strong> occurrence{res.total === 1 ? "" : "s"}{res.total > res.lines.length ? ` · showing the first ${res.lines.length}` : ""}</p>
          <div className="table-wrap" style={{ maxHeight: 440 }}>
            <table className="data">
              <tbody>
                {res.lines.slice(0, 500).map((l: ConcordanceLine, i) => (
                  <tr key={i} className="clickable" onClick={() => showInTimeline({ fileId: l.fileId, start: l.start, end: l.end, tierId: l.tierId })}>
                    <td className="faint" style={{ width: 1 }}>{l.fileName}</td>
                    <td className="mono faint" style={{ width: 1 }}>{formatTime(l.start, false)}</td>
                    <td style={{ width: 1 }}>{l.participant}</td>
                    <td style={{ maxWidth: "none" }}><div className="kwic"><span className="l">{l.left}</span><span className="m">{l.match}</span><span className="r">{l.right}</span></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
