import { useMemo, useRef, useState } from "react";
import { formatDuration } from "../../core/analysis/common.ts";
import { corpusOverview } from "../../core/analysis/descriptives.ts";
import { annotationCount } from "../../core/eaf/model.ts";
import { generateDemoCorpus } from "../../core/demo/demoCorpus.ts";
import { useLayers, useMetaVariables } from "../hooks.ts";
import { Button, Callout, Card, downloadText, Empty, Field, TextField, Tile } from "../kit.tsx";
import { useStore } from "../store.ts";

export function CorpusView() {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const isDemo = useStore((s) => s.isDemo);
  const loadFiles = useStore((s) => s.loadFiles);
  const loadDemo = useStore((s) => s.loadDemo);
  const removeFile = useStore((s) => s.removeFile);
  const clearCorpus = useStore((s) => s.clearCorpus);
  const setMeta = useStore((s) => s.setMeta);
  const addVariable = useStore((s) => s.addVariable);
  const removeVariable = useStore((s) => s.removeVariable);
  const metaFromFileNames = useStore((s) => s.metaFromFileNames);
  const importMetaCsv = useStore((s) => s.importMetaCsv);
  const setView = useStore((s) => s.setView);
  const toast = useStore((s) => s.toast);
  const variables = useMetaVariables();
  const layers = useLayers();
  const overview = useMemo(() => corpusOverview(files, scheme), [files, scheme]);
  const input = useRef<HTMLInputElement | null>(null);
  const csvInput = useRef<HTMLInputElement | null>(null);
  const [newVar, setNewVar] = useState("");
  const [pattern, setPattern] = useState("(?<dyad>dyad\\d+)_(?<condition>\\w+)");
  const [patternError, setPatternError] = useState<string | undefined>();
  const [confirmClear, setConfirmClear] = useState(false);
  const warnings = files.flatMap((f) => f.doc.warnings.map((w) => `${f.name}: ${w}`));

  const picker = (
    <>
      <input
        ref={input} type="file" accept=".eaf,.xml" multiple hidden
        onChange={(e) => {
          void loadFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <Button kind="primary" icon="upload" onClick={() => input.current?.click()}>
        Add .eaf files
      </Button>
    </>
  );

  if (files.length === 0) {
    return (
      <div className="stack" style={{ maxWidth: 720, margin: "24px auto" }}>
        <div className="dropzone">
          <h2 style={{ fontSize: 17 }}>Add ELAN files to begin</h2>
          <p style={{ maxWidth: "52ch" }}>
            Drop one or more <span className="mono">.eaf</span> files anywhere on this page, or choose them here. They are read in your browser — nothing is uploaded.
          </p>
          <div className="row">
            {picker}
            <Button onClick={loadDemo}>Load the example corpus</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {isDemo && (
        <Callout>
          <strong>This is an example corpus with simulated data</strong>: twelve dyads solving a picture-matching task, six face to face and six separated by a screen. Add your own files to replace it.{" "}
          <button
            className="btn small ghost" style={{ marginLeft: 4 }}
            onClick={() => {
              for (const d of generateDemoCorpus()) downloadText(d.fileName, d.xml, "application/xml");
            }}
          >
            Download the example .eaf files
          </button>
        </Callout>
      )}
      <div className="tiles">
        <Tile label="Files" value={overview.files} />
        <Tile label="Recording time" value={formatDuration(overview.duration)} hint="end of the last annotation, summed" />
        <Tile label="Tiers" value={overview.tiers} hint={`${overview.layers} layer${overview.layers === 1 ? "" : "s"}`} />
        <Tile label="Annotations" value={overview.annotations.toLocaleString("en-US")} />
        <Tile label="Participants" value={overview.participants} hint="per file, summed" />
      </div>

      <Card
        title="Files"
        sub="File variables (condition, dyad, language …) can be used as factors in every analysis."
        actions={
          <>
            {picker}
            {confirmClear ? (
              <>
                <Button small onClick={() => { clearCorpus(); setConfirmClear(false); }}>Remove all files</Button>
                <Button small kind="ghost" onClick={() => setConfirmClear(false)}>Keep</Button>
              </>
            ) : (
              <Button kind="ghost" icon="trash" onClick={() => setConfirmClear(true)}>Clear</Button>
            )}
          </>
        }
        flush
      >
        <div className="table-wrap" style={{ maxHeight: 420 }}>
          <table className="data">
            <thead>
              <tr>
                <th>File</th>
                <th className="n">Duration</th>
                <th className="n">Tiers</th>
                <th className="n">Annotations</th>
                {variables.map((v) => (
                  <th key={v}>
                    {v}{" "}
                    <button className="btn small ghost" style={{ height: 18, padding: "0 3px" }} title={`Remove the variable “${v}”`} aria-label={`Remove the variable ${v}`} onClick={() => removeVariable(v)}>
                      ×
                    </button>
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.id}>
                  <td title={f.doc.fileName}>
                    {f.name}
                    {f.doc.warnings.length > 0 && <span className="chip warning" style={{ marginLeft: 6 }} title={f.doc.warnings.join("\n")}>{f.doc.warnings.length} warning{f.doc.warnings.length === 1 ? "" : "s"}</span>}
                  </td>
                  <td className="n mono">{formatDuration(f.doc.duration)}</td>
                  <td className="n">{f.doc.tiers.length}</td>
                  <td className="n">{annotationCount(f.doc).toLocaleString("en-US")}</td>
                  {variables.map((v) => (
                    <td key={v} style={{ padding: "2px 6px" }}>
                      <input className="cell-input" aria-label={`${v} of ${f.name}`} value={f.meta[v] ?? ""} onChange={(e) => setMeta(f.id, v, e.target.value)} />
                    </td>
                  ))}
                  <td className="n">
                    <Button small kind="ghost" icon="trash" title={`Remove ${f.name}`} onClick={() => removeFile(f.id)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="cols-2">
        <Card title="File variables" sub="Type them into the table above, or fill them in from here.">
          <Field label="Add a variable" htmlFor="new-var">
            <div className="row">
              <div style={{ flex: "1 1 140px" }}><TextField id="new-var" value={newVar} onChange={setNewVar} placeholder="e.g. condition" /></div>
              <Button icon="plus" disabled={!newVar.trim() || variables.includes(newVar.trim())} onClick={() => { addVariable(newVar); setNewVar(""); }}>Add</Button>
            </div>
          </Field>
          <Field
            label="Take variables from the file names" htmlFor="name-pattern" error={patternError}
            hint={<>A regular expression; each named group <span className="mono">(?&lt;name&gt;…)</span> becomes a variable.</>}
          >
            <div className="row">
              <div style={{ flex: "1 1 180px" }}><TextField id="name-pattern" mono value={pattern} onChange={(v) => { setPattern(v); setPatternError(undefined); }} invalid={!!patternError} /></div>
              <Button onClick={() => setPatternError(metaFromFileNames(pattern))}>Apply</Button>
            </div>
          </Field>
          <Field label="Import a table" hint="CSV or tab-separated; first column = file name, further columns = variables.">
            <input
              ref={csvInput} type="file" accept=".csv,.tsv,.txt" hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) toast(importMetaCsv(await file.text()));
              }}
            />
            <div><Button icon="upload" onClick={() => csvInput.current?.click()}>Choose a table …</Button></div>
          </Field>
        </Card>

        <Card title="Layers" sub="Tiers that hold the same kind of annotation." actions={<Button small onClick={() => setView("tiers")}>Edit tiers & layers</Button>} flush>
          <div className="table-wrap" style={{ maxHeight: 300 }}>
            <table className="data">
              <thead>
                <tr><th>Layer</th><th>Content</th><th className="n">Tiers</th><th className="n">Files</th><th>Participants</th><th className="n">Annotations</th></tr>
              </thead>
              <tbody>
                {layers.map((l) => (
                  <tr key={l.name}>
                    <td>{l.name}</td>
                    <td className="muted">{l.kind === "text" ? "text" : l.kind === "categorical" ? `${l.distinctValues} categories` : l.kind}</td>
                    <td className="n">{l.tierCount}</td>
                    <td className="n">{l.fileCount}</td>
                    <td className="muted">{l.participants.join(", ") || "–"}</td>
                    <td className="n">{l.annotationCount.toLocaleString("en-US")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {warnings.length > 0 && (
        <Card title="Reading problems" sub="These files were read, but not everything in them could be used.">
          <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)" }}>
            {warnings.slice(0, 40).map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Card>
      )}
      {layers.length === 0 && <Empty title="These files contain no tiers" />}
    </div>
  );
}
