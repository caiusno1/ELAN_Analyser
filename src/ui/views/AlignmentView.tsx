import { useEffect, useMemo, useRef, useState } from "react";
import {
  alignmentSurrogates, analyseAlignment, F_ALIGNED, F_SELF, type AlignInstance, type AlignmentResult, type FileAlignment, type SurrogateKind, type SurrogateResult,
} from "../../core/analysis/alignment.ts";
import { formatTime } from "../../core/analysis/common.ts";
import { evidenceLabel } from "../../core/stats/bayes/proportions.ts";
import { effectPosterior, oneSampleStats, tTestBayesFactors } from "../../core/stats/bayes/ttest.ts";
import { AlignmentSettingsFields, useAlignmentOptions, useAlignmentSettings } from "../alignmentOptions.tsx";
import { ChartCard } from "../charts/ChartCard.tsx";
import { GroupChart } from "../charts/GroupChart.tsx";
import { XYChart } from "../charts/XYChart.tsx";
import { useMetaVariables, useParticipantList, useViewState } from "../hooks.ts";
import { Button, Callout, Card, DataTable, DatasetCsvButton, Empty, Field, fmt, fmtBf, MethodNote, NumberField, pct, Segmented, Select, SendToStats, Tabs, Tile, Toggle } from "../kit.tsx";
import { participantColor, useStore } from "../store.ts";

type Tab = "transcript" | "lexicon" | "speakers" | "chance" | "time";

export function AlignmentView() {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const [settings, patch] = useAlignmentSettings();
  const { options, stopLabel } = useAlignmentOptions(settings);
  const [tab, setTab] = useViewState<Tab>("alignment.tab", "transcript");
  const result = useMemo(() => (options.layer ? analyseAlignment(files, scheme, options) : undefined), [files, scheme, options]);

  if (!options.layer) return <Empty title="No transcription layer found">Lexical alignment needs a layer with transcribed speech of at least two participants.</Empty>;
  const directions = new Map<string, number>();
  for (const f of result?.files ?? []) for (const i of f.instances) directions.set(`${i.primeSpeaker} → ${i.speaker}`, (directions.get(`${i.primeSpeaker} → ${i.speaker}`) ?? 0) + 1);
  const dirText = [...directions.entries()].sort().slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(" · ");

  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Settings">
          <AlignmentSettingsFields value={settings} onChange={patch} stopLabel={stopLabel} />
        </Card>
        <MethodNote
          refs={[
            "Pickering & Garrod (2004) Behav Brain Sci 27",
            "Dubuisson Duplessis, Clavel & Landragin (2017) SIGDIAL; Dubuisson Duplessis et al. (2021) Lang Resour Eval 55",
            "Fusaroli et al. (2012) Psychol Sci 23",
            "Duran, Paxton & Fusaroli (2019) Psychol Methods 24",
            "Healey, Purver & Howes (2014) PLoS ONE 9",
          ]}
        >
          <p>
            An <strong>alignment instance</strong> is the longest stretch of a turn — at least the chosen number of words, with at least one content word — that another speaker produced earlier within the look-back window. The first time a
            speaker takes over an expression is an <em>adoption</em>; later uses are <em>re-uses</em>.
          </p>
          <p>
            <strong>Expression repetition</strong> is the share of a speaker's words that lie inside such instances; the <strong>shared expression lexicon</strong> lists every expression re-used in this way. Turn-by-turn overlap is also
            reported as local linguistic alignment and cosine similarity between each turn and the partner's preceding turn.
          </p>
          <p>Because people who talk about the same things share words anyway, compare the observed values with the chance level under “Chance level”.</p>
        </MethodNote>
      </div>

      <div className="stack">
        {result && result.files.length === 0 ? (
          <Empty title="No dialogue found on this layer">The layer “{options.layer}” has fewer than two speakers in every file. Check the participants under “Tiers & layers”.</Empty>
        ) : result ? (
          <>
            <div className="tiles">
              <Tile label="Alignment instances" value={result.totals.instances.toLocaleString("en-US")} hint={dirText || undefined} />
              <Tile label="Words in re-used expressions" value={pct(result.totals.er)} hint={`${result.totals.alignedTokens.toLocaleString("en-US")} of ${result.totals.tokens.toLocaleString("en-US")} words`} />
              <Tile label="Adoptions" value={result.totals.adoptions.toLocaleString("en-US")} hint="expressions taken over for the first time" />
              <Tile label="Shared expressions" value={result.files.reduce((s, f) => s + f.overall.els, 0).toLocaleString("en-US")} hint={`in ${result.files.length} dialogue${result.files.length === 1 ? "" : "s"}`} />
            </div>
            {result.skipped.length > 0 && (
              <Callout kind="warning">
                {result.skipped.length} file{result.skipped.length === 1 ? " was" : "s were"} left out because the layer has fewer than two speakers there: {result.skipped.slice(0, 6).join(", ")}
                {result.skipped.length > 6 ? " …" : ""}
              </Callout>
            )}
            <section className="card">
              <Tabs<Tab>
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: "transcript", label: "Transcript" },
                  { id: "lexicon", label: "Shared expressions" },
                  { id: "speakers", label: "Speakers & files" },
                  { id: "chance", label: "Chance level" },
                  { id: "time", label: "Over time" },
                ]}
              />
              {tab === "transcript" && <TranscriptPanel result={result} />}
              {tab === "lexicon" && <LexiconPanel result={result} />}
              {tab === "speakers" && <SpeakersPanel result={result} />}
              {tab === "chance" && <ChancePanel />}
              {tab === "time" && <TimePanel result={result} />}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---- transcript -----------------------------------------------------------------------------

function TranscriptPanel({ result }: { result: AlignmentResult }) {
  const showInTimeline = useStore((s) => s.showInTimeline);
  const participants = useParticipantList();
  const [fileId, setFileId] = useViewState("alignment.file", result.files[0]?.fileId ?? "");
  const [highlight, setHighlight] = useViewState("alignment.highlight", true);
  const [showSelf, setShowSelf] = useViewState("alignment.self", false);
  const [onlyAligned, setOnlyAligned] = useViewState("alignment.only", false);
  const [expression] = useViewState<string | undefined>("alignment.expression", undefined);
  const [limit, setLimit] = useState(400);
  const [tip, setTip] = useState<{ x: number; y: number; inst: AlignInstance } | undefined>();
  const [flash, setFlash] = useState<number | undefined>();
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const fa: FileAlignment | undefined = result.files.find((f) => f.fileId === fileId) ?? result.files[0];

  const byUnit = useMemo(() => {
    const m = new Map<number, AlignInstance[]>();
    for (const i of fa?.instances ?? []) m.set(i.unit, [...(m.get(i.unit) ?? []), i]);
    return m;
  }, [fa]);
  useEffect(() => setLimit(400), [fileId]);
  if (!fa) return null;
  const units = onlyAligned ? fa.units.filter((u) => byUnit.has(u.index)) : fa.units;

  const jumpTo = (unit: number) => {
    const el = rowRefs.current.get(unit);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlash(unit);
    setTimeout(() => setFlash((f) => (f === unit ? undefined : f)), 1600);
  };

  return (
    <div>
      <div className="row" style={{ padding: "10px 14px" }}>
        <div style={{ flex: "0 1 220px", minWidth: 150 }}>
          <Select value={fa.fileId} onChange={setFileId} options={result.files.map((f) => ({ value: f.fileId, label: f.fileName }))} />
        </div>
        <Toggle id="al-highlight" checked={highlight} onChange={setHighlight}>Highlight alignment</Toggle>
        <Toggle id="al-self" checked={showSelf} onChange={setShowSelf}>Mark self-repetition</Toggle>
        <Toggle id="al-only" checked={onlyAligned} onChange={setOnlyAligned}>Only turns with alignment</Toggle>
        <span className="spacer" />
        <span className="muted num">
          <strong style={{ color: "var(--text)" }}>{fa.instances.length}</strong> instances · {fa.bySpeaker.map((m) => `${m.speaker} ${pct(m.er, 0)}`).join(" · ")}
        </span>
      </div>
      {highlight && (
        <div className="chart-legend" style={{ padding: "0 14px" }}>
          <span className="key"><span className="tok aligned">re-used from the other speaker</span></span>
          <span className="key"><span className="tok aligned adoption">used for the first time (adoption)</span></span>
          {showSelf && <span className="key"><span className="tok self">repeats own earlier words</span></span>}
          <span className="faint">Hover a highlight for its source; click to go there.</span>
        </div>
      )}
      <div className="transcript">
        {units.slice(0, limit).map((u) => {
          const insts = byUnit.get(u.index) ?? [];
          return (
            <div
              className="turn" key={u.index}
              ref={(el) => { if (el) rowRefs.current.set(u.index, el); else rowRefs.current.delete(u.index); }}
              style={flash === u.index ? { background: "var(--accent-soft)" } : undefined}
            >
              <button className="time" title="Show in the timeline" onClick={() => showInTimeline({ fileId: fa.fileId, start: u.start, end: u.end, tierId: u.tierId })}>
                {formatTime(u.start, false)}
              </button>
              <span className="who" style={{ color: "var(--text)" }}>
                <span className="swatch" style={{ background: participantColor(participants, u.speaker), marginRight: 5 }} />
                {u.speaker}
              </span>
              <span className="text">
                {u.tokens.map((t, k) => {
                  const inst = insts.find((i) => k >= i.from && k < i.to);
                  const aligned = highlight && (u.flags[k]! & F_ALIGNED) !== 0 && inst;
                  const self = showSelf && (u.flags[k]! & F_SELF) !== 0;
                  const focused = expression && inst && inst.expression === expression;
                  const cls = ["tok", aligned ? "aligned" : "", aligned && inst.kind === "adoption" ? "adoption" : "", self ? "self" : "", focused ? "focus" : ""].filter(Boolean).join(" ");
                  return (
                    <span key={k}>
                      {aligned ? (
                        <span
                          className={cls}
                          onPointerEnter={(e) => setTip({ x: e.clientX, y: e.clientY, inst })}
                          onPointerLeave={() => setTip(undefined)}
                          onClick={() => jumpTo(inst.primeUnit)}
                        >
                          {t.text}
                        </span>
                      ) : (
                        <span className={cls}>{t.text}</span>
                      )}{" "}
                    </span>
                  );
                })}
              </span>
            </div>
          );
        })}
      </div>
      <div className="table-foot">
        <span>{units.length.toLocaleString("en-US")} turn{units.length === 1 ? "" : "s"}{limit < units.length ? ` · showing ${limit}` : ""}</span>
        {limit < units.length && <Button small kind="ghost" onClick={() => setLimit(limit + 1000)}>Show more</Button>}
      </div>
      {tip && (
        <div className="chart-tip" style={{ left: Math.max(4, Math.min(tip.x + 14, window.innerWidth - 340)), top: Math.min(tip.y + 18, window.innerHeight - 130) }}>
          <strong>“{tip.inst.expression}”</strong>
          <div className="tip-row">
            <span>
              said by {tip.inst.primeSpeaker} at {formatTime(tip.inst.primeTime, false)}, {tip.inst.distanceUnits} turn{tip.inst.distanceUnits === 1 ? "" : "s"} earlier
            </span>
          </div>
          <div className="tip-row"><span>{tip.inst.kind === "adoption" ? `${tip.inst.speaker} uses it for the first time` : `${tip.inst.speaker} has used it before`}</span></div>
        </div>
      )}
    </div>
  );
}

// ---- shared expression lexicon ---------------------------------------------------------------

interface LexRow {
  expression: string;
  n: number;
  instances: number;
  dialogues: number;
  initiators: string;
  firstFile: string;
  firstFileId: string;
  firstTime: number;
}

function LexiconPanel({ result }: { result: AlignmentResult }) {
  const setView = useStore((s) => s.setViewState);
  const [expression, setExpression] = useViewState<string | undefined>("alignment.expression", undefined);
  const rows = useMemo(() => {
    const acc = new Map<string, LexRow & { init: Set<string> }>();
    for (const f of result.files) {
      for (const e of f.lexicon) {
        let r = acc.get(e.expression);
        if (!r) {
          r = { expression: e.expression, n: e.n, instances: 0, dialogues: 0, initiators: "", firstFile: f.fileName, firstFileId: f.fileId, firstTime: e.establishedAt, init: new Set() };
          acc.set(e.expression, r);
        }
        r.instances += e.instances;
        r.dialogues++;
        r.init.add(e.initiator);
      }
    }
    return [...acc.values()].map((r) => ({ ...r, initiators: [...r.init].sort().join(", ") }));
  }, [result]);
  return (
    <div>
      <p className="muted" style={{ padding: "10px 14px 4px" }}>
        Every expression that one speaker took over from another. Click a row to mark the expression in the transcript.
      </p>
      <DataTable<LexRow>
        rows={rows}
        csvName="shared_expressions"
        initialSort={{ key: "instances", dir: -1 }}
        selected={(r) => r.expression === expression}
        onRowClick={(r) => {
          setExpression(r.expression === expression ? undefined : r.expression);
          setView("alignment.file", r.firstFileId);
          setView("alignment.tab", "transcript");
        }}
        columns={[
          { key: "expression", header: "Expression", value: (r) => r.expression },
          { key: "n", header: "Words", value: (r) => r.n, numeric: true },
          { key: "instances", header: "Re-uses", value: (r) => r.instances, numeric: true, title: "Alignment instances of this expression" },
          { key: "dialogues", header: "Dialogues", value: (r) => r.dialogues, numeric: true, title: "Number of files in which it became shared" },
          { key: "initiators", header: "Introduced by", value: (r) => r.initiators },
          { key: "first", header: "First shared in", value: (r) => r.firstFile },
          { key: "time", header: "at", value: (r) => r.firstTime, render: (r) => <span className="mono">{formatTime(r.firstTime, false)}</span>, numeric: true },
        ]}
      />
    </div>
  );
}

// ---- speakers and files ----------------------------------------------------------------------

function SpeakersPanel({ result }: { result: AlignmentResult }) {
  const files = useStore((s) => s.files);
  const variables = useMetaVariables();
  const [groupVar, setGroupVar] = useViewState("alignment.group", variables.find((v) => new Set(files.map((f) => f.meta[v])).size > 1 && new Set(files.map((f) => f.meta[v])).size <= 8) ?? "speaker");
  const [measure, setMeasure] = useViewState<"er" | "per100" | "cosine" | "adoptions">("alignment.measure", "er");
  const fileById = new Map(files.map((f) => [f.id, f]));
  const label = { er: "Words in re-used expressions (share)", per100: "Alignment instances per 100 words", cosine: "Cosine similarity to the partner's preceding turn", adoptions: "Adoptions" }[measure];
  const groups = useMemo(() => {
    const acc = new Map<string, { values: number[]; names: string[] }>();
    for (const f of result.files) {
      for (const m of f.bySpeaker) {
        const key = groupVar === "speaker" ? m.speaker : fileById.get(f.fileId)?.meta[groupVar] || "(none)";
        const dir = f.directions.find((d) => d.to === m.speaker);
        const v = measure === "er" ? m.er : measure === "per100" ? (m.tokens ? (100 * m.instances) / m.tokens : NaN) : measure === "cosine" ? dir?.cosine ?? NaN : m.adoptions;
        const g = acc.get(key) ?? { values: [], names: [] };
        g.values.push(v);
        g.names.push(`${f.fileName} · ${m.speaker}`);
        acc.set(key, g);
      }
    }
    return [...acc.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([k, g]) => ({ label: k, values: g.values, names: g.names }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, groupVar, measure]);
  const rows = result.files.flatMap((f) => f.bySpeaker.map((m) => ({ f, m })));
  return (
    <div className="stack" style={{ padding: "12px 14px 14px" }}>
      <div className="row">
        <Field label="Measure" htmlFor="al-measure">
          <Select
            id="al-measure" value={measure} onChange={setMeasure}
            options={[{ value: "er", label: "Share of words in re-used expressions" }, { value: "per100", label: "Instances per 100 words" }, { value: "cosine", label: "Cosine similarity to preceding turn" }, { value: "adoptions", label: "Number of adoptions" }]}
          />
        </Field>
        <Field label="Compare by" htmlFor="al-group">
          <Select id="al-group" value={groupVar} onChange={setGroupVar} options={[{ value: "speaker", label: "speaker" }, ...variables.map((v) => ({ value: v, label: v }))]} />
        </Field>
        <span className="spacer" />
        <SendToStats dataset={result.dataset} label="Test differences in Statistics" />
        <DatasetCsvButton dataset={result.dataset} />
      </div>
      <ChartCard title={label} sub="One dot per speaker and file; black: group mean with 95% credible interval." table={{ columns: [groupVar, "n", "mean"], rows: groups.map((g) => [g.label, g.values.length, g.values.reduce((s, v) => s + (Number.isNaN(v) ? 0 : v), 0) / Math.max(1, g.values.filter((v) => !Number.isNaN(v)).length)]) }}>
        <GroupChart groups={groups} yLabel={label} xLabel={groupVar} zero />
      </ChartCard>
      <DataTable
        rows={rows}
        csvName="alignment_by_speaker"
        columns={[
          { key: "file", header: "File", value: (r) => r.f.fileName },
          { key: "speaker", header: "Speaker", value: (r) => r.m.speaker },
          { key: "tokens", header: "Words", value: (r) => r.m.tokens, numeric: true },
          { key: "instances", header: "Instances", value: (r) => r.m.instances, numeric: true },
          { key: "er", header: "In re-used expr.", value: (r) => r.m.er, render: (r) => pct(r.m.er), numeric: true, title: "Expression repetition: share of the speaker's words inside alignment instances" },
          { key: "adoptions", header: "Adoptions", value: (r) => r.m.adoptions, numeric: true },
          { key: "initiated", header: "Introduced", value: (r) => r.m.initiated, numeric: true, title: "Shared expressions this speaker introduced" },
          { key: "ser", header: "Self-repetition", value: (r) => r.m.ser, render: (r) => pct(r.m.ser), numeric: true },
          { key: "els", header: "Shared expr. (dialogue)", value: (r) => r.f.overall.els, numeric: true },
        ]}
      />
    </div>
  );
}

// ---- chance level ---------------------------------------------------------------------------

function ChancePanel() {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const [settings] = useAlignmentSettings();
  const { options } = useAlignmentOptions(settings);
  const [kind, setKind] = useViewState<SurrogateKind>("alignment.surrogate", "shuffle");
  const [n, setN] = useViewState("alignment.surrogateN", 100);
  const [measure, setMeasure] = useViewState<"cosine" | "er">("alignment.chanceMeasure", "cosine");
  const [res, setRes] = useState<SurrogateResult | undefined>();
  const [running, setRunning] = useState(false);
  const run = () => {
    setRunning(true);
    // Yield to the browser so that the button state is painted before the computation starts.
    setTimeout(() => {
      setRes(alignmentSurrogates(files, scheme, options, kind, n, 1));
      setRunning(false);
    }, 30);
  };
  // Results belong to the settings they were computed with.
  useEffect(() => setRes(undefined), [options, kind, n, files]);

  const test = useMemo(() => {
    if (!res) return undefined;
    const diffs = res.rows.map((r) => (measure === "cosine" ? r.cosine - r.cosineSurrogate : r.er - r.erSurrogate)).filter((d) => Number.isFinite(d));
    if (diffs.length < 3) return { diffs, enough: false as const };
    const stat = oneSampleStats(diffs);
    if (!Number.isFinite(stat.t)) return { diffs, enough: false as const };
    return { diffs, enough: true as const, stat, bf: tTestBayesFactors(stat), post: effectPosterior(stat) };
  }, [res, measure]);
  const fakePossible = files.length >= 2;

  return (
    <div className="stack" style={{ padding: "12px 14px 14px" }}>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <Field label="Chance model">
          <Segmented value={kind} onChange={setKind} options={[{ value: "shuffle", label: "Shuffled turns" }, { value: "fake-pairs", label: "Fake pairs" }]} />
        </Field>
        <Field label="Surrogates per file" htmlFor="al-n">
          <div style={{ width: 90 }}><NumberField id="al-n" value={n} min={10} max={2000} step={10} onChange={setN} /></div>
        </Field>
        <Button kind="primary" icon="play" onClick={run} disabled={running || (kind === "fake-pairs" && !fakePossible)}>{running ? "Computing …" : "Compute chance level"}</Button>
      </div>
      <p className="muted" style={{ maxWidth: "78ch" }}>
        {kind === "shuffle"
          ? "Each speaker's turns are randomly re-ordered within the dialogue. Vocabulary and turn structure stay the same; what is lost is who said what right after whom. Use it to ask whether speakers echo the turn they are responding to."
          : "Each speaker is combined with the same-role speaker of another recording — two people who did the same task but never talked to each other. Use it to ask whether partners share more words than the task and topic alone explain."}
      </p>
      {kind === "fake-pairs" && !fakePossible && <Callout kind="warning">Fake pairs need at least two files.</Callout>}
      {res && test && (
        <>
          <div className="row">
            <Segmented value={measure} onChange={setMeasure} options={[{ value: "cosine", label: "Turn-by-turn similarity" }, { value: "er", label: "Words in re-used expressions" }]} />
            <span className="spacer" />
            <SendToStats dataset={res.dataset} />
          </div>
          {test.enough ? (
            <Card title="Is alignment above chance?" sub="Bayesian one-sample t-test on the differences observed − chance, one value per file.">
              <div className="bf">
                <span className="bf-value">BF₊₀ = {fmtBf(test.bf.logBfPlus0)}</span>
                <span className="bf-text">
                  {(() => {
                    const ev = evidenceLabel(test.bf.logBfPlus0);
                    return ev.favours === "H1"
                      ? `${capitalise(ev.strength)} evidence that alignment exceeds the chance level.`
                      : ev.favours === "H0"
                        ? `${capitalise(ev.strength)} evidence that alignment does not exceed the chance level.`
                        : "The data do not favour either hypothesis.";
                  })()}
                </span>
              </div>
              <p className="muted" style={{ marginTop: 6 }}>
                Mean difference {fmt(test.stat.mean)} (SD {fmt(test.stat.sd)}, {test.stat.n} files). Standardised effect δ: median {fmt(test.post.median)}, 95% credible interval {fmt(test.post.ci[0])} to {fmt(test.post.ci[1])}. Two-sided
                BF₁₀ = {fmtBf(test.bf.logBf10)}. Prior on δ: Cauchy(0, 0.707).
              </p>
            </Card>
          ) : (
            <Callout>With fewer than three files there is no test across files; compare each observed value with the range of its surrogates below.</Callout>
          )}
          <ChartCard
            title={measure === "cosine" ? "Similarity to the partner's preceding turn" : "Share of words in re-used expressions"}
            sub="Dot: observed. Bar: central 95% of the surrogate dialogues."
            table={{ columns: ["file", "observed", "chance (mean)", "chance 2.5%", "chance 97.5%"], rows: res.rows.map((r) => (measure === "cosine" ? [r.file, r.cosine, r.cosineSurrogate, r.cosineRange[0], r.cosineRange[1]] : [r.file, r.er, r.erSurrogate, r.erRange[0], r.erRange[1]])) }}
          >
            <XYChart
              height={Math.max(180, 60 + res.rows.length * 22)}
              x={{ type: "linear", label: measure === "cosine" ? "cosine similarity" : "share of words", grid: true, zero: true }}
              y={{ type: "band", domain: res.rows.map((r) => r.file), padding: 0.5 }}
              legend={[{ label: "observed", color: "var(--series-1)", kind: "dot" }, { label: "chance (95% of surrogates)", color: "var(--series-other)", kind: "line" }]}
              marks={[
                { type: "interval", horizontal: true, color: "var(--series-other)", width: 5, data: res.rows.map((r) => ({ x: r.file, lo: measure === "cosine" ? r.cosineRange[0] : r.erRange[0], hi: measure === "cosine" ? r.cosineRange[1] : r.erRange[1] })) },
                { type: "dot", data: res.rows.map((r) => ({ x: measure === "cosine" ? r.cosine : r.er, y: r.file, tip: { title: r.file, rows: [["observed", fmt(measure === "cosine" ? r.cosine : r.er)], ["chance (mean of surrogates)", fmt(measure === "cosine" ? r.cosineSurrogate : r.erSurrogate)]] } })) },
              ]}
              ariaLabel="Observed alignment and the range of surrogate dialogues, per file"
            />
          </ChartCard>
        </>
      )}
    </div>
  );
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---- over time -------------------------------------------------------------------------------

function TimePanel({ result }: { result: AlignmentResult }) {
  const bins = useMemo(() => {
    const k = 10;
    const counts = new Array<number>(k).fill(0);
    const tokens = new Array<number>(k).fill(0);
    for (const f of result.files) {
      const dur = Math.max(1, f.units[f.units.length - 1]?.end ?? 1);
      for (const i of f.instances) counts[Math.min(k - 1, Math.floor((i.start / dur) * k))]! += i.n;
      for (const u of f.units) tokens[Math.min(k - 1, Math.floor((u.start / dur) * k))]! += u.tokens.length;
    }
    return counts.map((c, i) => ({ from: i / k, to: (i + 1) / k, share: tokens[i]! ? c / tokens[i]! : NaN, tokens: tokens[i]! }));
  }, [result]);
  const lag = useMemo(() => {
    const out: { lag: number; other: number; self: number }[] = [];
    for (let l = 1; l <= 10; l++) {
      let so = 0;
      let no = 0;
      let ss = 0;
      let ns = 0;
      for (const f of result.files) {
        const p = f.lagProfile[l - 1];
        if (!p) continue;
        if (!Number.isNaN(p.other)) {
          so += p.other * p.nOther;
          no += p.nOther;
        }
        if (!Number.isNaN(p.self)) {
          ss += p.self * p.nSelf;
          ns += p.nSelf;
        }
      }
      out.push({ lag: l, other: no ? so / no : NaN, self: ns ? ss / ns : NaN });
    }
    return out;
  }, [result]);
  return (
    <div className="cols-2" style={{ padding: "12px 14px 14px" }}>
      <ChartCard
        title="Alignment over the course of the dialogue"
        sub="Share of words in re-used expressions, by tenth of the recording (all files)."
        table={{ columns: ["part of the recording", "share of words", "words"], rows: bins.map((b) => [`${Math.round(b.from * 100)}–${Math.round(b.to * 100)}%`, b.share, b.tokens]) }}
      >
        <XYChart
          x={{ type: "linear", domain: [0, 1], label: "position in the recording", format: (v) => `${Math.round(v * 100)}%` }}
          y={{ type: "linear", zero: true, label: "share of words", format: (v) => `${Math.round(v * 100)}%` }}
          marks={[{ type: "rect", data: bins.map((b) => ({ x0: b.from, x1: b.to, y0: 0, y1: b.share, tip: { title: `${Math.round(b.from * 100)}–${Math.round(b.to * 100)}% of the recording`, rows: [["of words are in re-used expressions", pct(b.share)], ["words", String(b.tokens)]] } })) }]}
          ariaLabel="Share of words in re-used expressions by tenth of the recording"
        />
      </ChartCard>
      <ChartCard
        title="Similarity to earlier turns"
        sub="Mean cosine similarity between a turn and the turn k turns before it."
        table={{ columns: ["turns back", "other speaker", "same speaker"], rows: lag.map((l) => [l.lag, l.other, l.self]) }}
      >
        <XYChart
          crosshair
          crosshairFormat={(v) => `${v} turn${v === 1 ? "" : "s"} back`}
          x={{ type: "linear", domain: [1, 10], label: "turns back", ticks: 10 }}
          y={{ type: "linear", zero: true, label: "cosine similarity" }}
          legend={[{ label: "other speaker's turn", color: "var(--series-1)", kind: "line" }, { label: "own earlier turn", color: "var(--series-2)", kind: "line" }]}
          marks={[
            { type: "line", label: "other speaker's turn", color: "var(--series-1)", points: lag.map((l) => [l.lag, l.other]) },
            { type: "line", label: "own earlier turn", color: "var(--series-2)", points: lag.map((l) => [l.lag, l.self]) },
            { type: "dot", color: "var(--series-1)", data: lag.map((l) => ({ x: l.lag, y: l.other })) },
            { type: "dot", color: "var(--series-2)", data: lag.map((l) => ({ x: l.lag, y: l.self })) },
          ]}
          ariaLabel="Cosine similarity to earlier turns of the other and of the same speaker, by distance in turns"
        />
      </ChartCard>
    </div>
  );
}
