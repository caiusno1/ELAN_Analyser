import { useMemo } from "react";
import { ALL_VALUES, formatDuration, formatTime, metaCells, type ValueFilter } from "../../core/analysis/common.ts";
import { searchAnnotations, type SearchHit, type SearchOptions } from "../../core/analysis/search.ts";
import { datasetFromRows, type Row } from "../../core/data/dataset.ts";
import { ChartCard } from "../charts/ChartCard.tsx";
import { XYChart } from "../charts/XYChart.tsx";
import { useDebounced, useLayerValues, useLayers, useMetaVariables, useViewState } from "../hooks.ts";
import { Callout, Card, CheckList, DataTable, DatasetCsvButton, Empty, Field, FilterField, fmt, LayerSelect, MethodNote, NumberField, pct, Segmented, Select, SendToStats, TextField, Tile, Toggle } from "../kit.tsx";
import { useStore } from "../store.ts";

const LIMIT = 20000;

interface Settings {
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  layers: string[];
  minDuration: number;
  maxDuration: number;
  overlapLayer: string;
  overlapMode: "overlaps" | "does not overlap";
  overlapFilter: ValueFilter;
  sameParticipant: boolean;
  groupBy: string;
}

export function SearchView() {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const showInTimeline = useStore((s) => s.showInTimeline);
  const layers = useLayers();
  const variables = useMetaVariables();
  const [s, setS] = useViewState<Settings>("search.settings", {
    pattern: "",
    regex: false,
    caseSensitive: false,
    layers: [],
    minDuration: 0,
    maxDuration: 0,
    overlapLayer: "",
    overlapMode: "overlaps",
    overlapFilter: ALL_VALUES,
    sameParticipant: true,
    groupBy: "file",
  });
  const patch = (p: Partial<Settings>) => setS((prev) => ({ ...prev, ...p }));
  const pattern = useDebounced(s.pattern, 200);
  const overlapValues = useLayerValues(s.overlapLayer);

  const res = useMemo(() => {
    const opts: SearchOptions = {
      layers: s.layers.filter((l) => layers.some((x) => x.name === l)),
      pattern,
      regex: s.regex,
      caseSensitive: s.caseSensitive,
      minDuration: s.minDuration * 1000,
      maxDuration: s.maxDuration * 1000,
    };
    if (s.overlapLayer && layers.some((l) => l.name === s.overlapLayer)) opts.overlap = { layer: s.overlapLayer, filter: s.overlapFilter, mode: s.overlapMode, sameParticipant: s.sameParticipant };
    return searchAnnotations(files, scheme, opts, LIMIT);
  }, [files, scheme, layers, pattern, s.regex, s.caseSensitive, s.layers, s.minDuration, s.maxDuration, s.overlapLayer, s.overlapFilter, s.overlapMode, s.sameParticipant]);

  const fileById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const groupOptions = [
    { value: "file", label: "file" },
    { value: "participant", label: "participant" },
    { value: "layer", label: "layer" },
    { value: "value", label: "annotation value" },
    ...variables.map((v) => ({ value: `meta:${v}`, label: v })),
  ];
  const groupBy = groupOptions.some((o) => o.value === s.groupBy) ? s.groupBy : "file";

  const summary = useMemo(() => {
    const keyOf = (h: SearchHit): string =>
      groupBy === "file" ? h.fileName : groupBy === "participant" ? h.participant || "(none)" : groupBy === "layer" ? h.layer : groupBy === "value" ? h.value.trim() || "(empty)" : fileById.get(h.fileId)?.meta[groupBy.slice(5)] || "(none)";
    const counts = new Map<string, number>();
    const inFiles = new Set<string>();
    let total = 0;
    for (const h of res.hits) {
      counts.set(keyOf(h), (counts.get(keyOf(h)) ?? 0) + 1);
      inFiles.add(h.fileId);
      total += h.end - h.start;
    }
    const groups = [...counts].sort((a, b) => b[1] - a[1]);
    return { groups: groups.slice(0, 30), more: Math.max(0, groups.length - 30), files: inFiles.size, total };
  }, [res.hits, groupBy, fileById]);

  const dataset = useMemo(() => {
    if (res.hits.length === 0) return undefined;
    const rows: Row[] = res.hits.map((h) => ({
      file: h.fileName,
      ...metaCells(fileById.get(h.fileId)!, variables),
      layer: h.layer,
      participant: h.participant,
      tier: h.tierId,
      value: h.value,
      start_s: h.start / 1000,
      duration_s: (h.end - h.start) / 1000,
    }));
    return datasetFromRows(`Search: ${pattern || "all annotations"}`, "one annotation found", "Annotations found by the search.", rows, [
      { name: "file", type: "string" },
      ...variables.map((v) => ({ name: v, type: "string" as const, label: "file variable" })),
      { name: "layer", type: "string" },
      { name: "participant", type: "string" },
      { name: "tier", type: "string" },
      { name: "value", type: "string" },
      { name: "start_s", type: "number" },
      { name: "duration_s", type: "number", primary: true },
    ]);
  }, [res.hits, fileById, variables, pattern]);

  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Find annotations">
          <Field label="Text" htmlFor="sr-pattern" error={res.error} hint={s.regex ? "Regular expression, e.g. ^(yes|yeah)\\b or \\buh+m?\\b" : "Leave empty to find every annotation."}>
            <TextField id="sr-pattern" value={s.pattern} onChange={(pattern) => patch({ pattern })} placeholder={s.regex ? "regular expression" : "word or phrase"} mono={s.regex} invalid={!!res.error} />
          </Field>
          <div className="row" style={{ marginTop: 8 }}>
            <Toggle id="sr-regex" checked={s.regex} onChange={(regex) => patch({ regex })}>Regular expression</Toggle>
            <Toggle id="sr-case" checked={s.caseSensitive} onChange={(caseSensitive) => patch({ caseSensitive })}>Match case</Toggle>
          </div>
          <Field label="In layers" hint="None ticked: all layers.">
            <CheckList options={layers.map((l) => ({ value: l.name, label: `${l.name} (${l.annotationCount.toLocaleString("en-US")})` }))} selected={s.layers} onChange={(v) => patch({ layers: v })} />
          </Field>
          <div className="field-row" style={{ marginTop: 9 }}>
            <Field label="At least (s)" htmlFor="sr-min"><NumberField id="sr-min" value={s.minDuration} min={0} step={0.1} onChange={(minDuration) => patch({ minDuration })} /></Field>
            <Field label="At most (s)" htmlFor="sr-max" hint="0 = no limit"><NumberField id="sr-max" value={s.maxDuration} min={0} step={0.1} onChange={(maxDuration) => patch({ maxDuration })} /></Field>
          </div>
        </Card>
        <Card title="While something else happens" sub="Keep only annotations that overlap — or do not overlap — an annotation of another layer.">
          <Field label="Other layer" htmlFor="sr-olayer"><LayerSelect id="sr-olayer" value={s.overlapLayer} onChange={(overlapLayer) => patch({ overlapLayer, overlapFilter: ALL_VALUES })} allowNone="no condition" /></Field>
          {s.overlapLayer && (
            <>
              <Field label="The annotation">
                <Segmented value={s.overlapMode} onChange={(overlapMode) => patch({ overlapMode })} options={[{ value: "overlaps", label: "overlaps it" }, { value: "does not overlap", label: "does not overlap it" }]} />
              </Field>
              <FilterField id="sr-ofilter" label={`Values of “${s.overlapLayer}”`} value={s.overlapFilter} onChange={(overlapFilter) => patch({ overlapFilter })} values={overlapValues} />
              <div style={{ marginTop: 9 }}>
                <Toggle id="sr-same" checked={s.sameParticipant} onChange={(sameParticipant) => patch({ sameParticipant })}>Tiers of the same participant only</Toggle>
              </div>
            </>
          )}
        </Card>
        <MethodNote title="How the search works">
          <p>
            The text is matched against the value of every annotation of the chosen layers — as a plain substring, or as a regular expression. Durations refer to the annotation itself. The overlap condition looks at the other layer in the
            same recording: an annotation counts as overlapping if it shares any stretch of time with a matching annotation there.
          </p>
          <p>Results can be opened in the timeline (click a row), exported, or sent to the statistics lab as a table with one row per annotation found.</p>
        </MethodNote>
      </div>

      <div className="stack">
        {res.error ? (
          <Callout kind="warning">{res.error}</Callout>
        ) : res.total === 0 ? (
          <Empty title="Nothing found">No annotation matches these conditions. Check the spelling, or search in more layers.</Empty>
        ) : (
          <>
            <div className="tiles">
              <Tile label="Annotations found" value={res.total.toLocaleString("en-US")} hint={res.total > res.hits.length ? `the first ${res.hits.length.toLocaleString("en-US")} are listed` : undefined} />
              <Tile label="In files" value={`${summary.files} of ${files.length}`} />
              <Tile label="Total duration" value={formatDuration(summary.total)} />
              <Tile label="Mean duration" value={`${fmt(summary.total / res.hits.length / 1000, 3)} s`} />
            </div>
            <ChartCard
              title="Where they are"
              sub={summary.more ? `The ${summary.groups.length} largest groups; ${summary.more} more are not shown.` : undefined}
              table={{ columns: [groupOptions.find((o) => o.value === groupBy)!.label, "annotations"], rows: summary.groups.map(([k, n]) => [k, n]) }}
            >
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="muted">Count by</span>
                <div style={{ flex: "0 1 220px", minWidth: 0 }}><Select value={groupBy} onChange={(v) => patch({ groupBy: v })} options={groupOptions} /></div>
              </div>
              <XYChart
                height={Math.max(110, 44 + summary.groups.length * 20)}
                x={{ type: "linear", zero: true, label: "annotations found" }}
                y={{ type: "band", domain: summary.groups.map(([k]) => k), padding: 0.25 }}
                marks={[{ type: "bar", horizontal: true, data: summary.groups.map(([k, n]) => ({ x: k, y: n, tip: { title: k, rows: [["annotations", String(n)], ["share", pct(n / res.hits.length)]] } })) }]}
                ariaLabel="Number of annotations found per group"
              />
            </ChartCard>
            <Card title="Results" sub="Click a row to see it in the timeline." actions={<><SendToStats dataset={dataset} /><DatasetCsvButton dataset={dataset} /></>} flush>
              <DataTable<SearchHit>
                rows={res.hits}
                maxHeight={520}
                rowKey={(h, i) => `${h.fileId}:${h.tierId}:${h.start}:${i}`}
                onRowClick={(h) => showInTimeline({ fileId: h.fileId, start: h.start, end: h.end, tierId: h.tierId })}
                columns={[
                  { key: "file", header: "File", value: (h) => h.fileName },
                  { key: "tier", header: "Tier", value: (h) => h.tierId },
                  { key: "start", header: "Start", value: (h) => h.start, render: (h) => formatTime(h.start), numeric: true },
                  { key: "dur", header: "Duration (s)", value: (h) => (h.end - h.start) / 1000, numeric: true },
                  { key: "before", header: "Before", value: (h) => h.before, render: (h) => <span className="muted" style={{ display: "block", textAlign: "right" }}>{clip(h.before, true)}</span> },
                  { key: "value", header: "Annotation", value: (h) => h.value, render: (h) => <strong style={{ display: "block", minWidth: 200, fontWeight: 600 }}>{h.value}</strong>, wrap: true },
                  { key: "after", header: "After", value: (h) => h.after, render: (h) => <span className="muted">{clip(h.after, false)}</span> },
                ]}
              />
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

/** Shorten the neighbouring annotation, keeping the end that is next to the hit. */
function clip(text: string, keepEnd: boolean): string {
  const max = 36;
  if (text.length <= max) return text;
  return keepEnd ? `…${text.slice(text.length - max)}` : `${text.slice(0, max)}…`;
}
