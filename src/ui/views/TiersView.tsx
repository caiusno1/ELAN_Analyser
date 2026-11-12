import { useMemo } from "react";
import { detectKind, roleOf } from "../../core/corpus/corpus.ts";
import { Button, Callout, Card, MethodNote } from "../kit.tsx";
import { participantColor, useStore } from "../store.ts";
import { useParticipantList } from "../hooks.ts";

interface TierRow {
  name: string;
  files: number;
  annotations: number;
  types: string;
  attribute: string;
  kind: string;
  derived: boolean;
}

export function TiersView() {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const setRole = useStore((s) => s.setRole);
  const resetScheme = useStore((s) => s.resetScheme);
  const participants = useParticipantList();

  const rows = useMemo(() => {
    const acc = new Map<string, TierRow & { typeSet: Set<string>; attrSet: Set<string>; sample: string[] }>();
    for (const f of files) {
      for (const t of f.doc.tiers) {
        let r = acc.get(t.id);
        if (!r) {
          r = { name: t.id, files: 0, annotations: 0, types: "", attribute: "", kind: "", derived: !!t.derived, typeSet: new Set(), attrSet: new Set(), sample: [] };
          acc.set(t.id, r);
        }
        r.files++;
        r.annotations += t.annotations.length;
        if (t.linguisticTypeRef) r.typeSet.add(t.linguisticTypeRef);
        if (t.participant) r.attrSet.add(t.participant);
        for (let i = 0; i < t.annotations.length && r.sample.length < 600; i += Math.max(1, Math.floor(t.annotations.length / 100))) r.sample.push(t.annotations[i]!.value);
      }
    }
    return [...acc.values()].map((r) => {
      const k = detectKind(r.sample);
      return { ...r, types: [...r.typeSet].join(", "), attribute: [...r.attrSet].join(", "), kind: k.kind === "categorical" ? `${k.distinct} categories` : k.kind };
    });
  }, [files]);
  const edited = rows.filter((r) => !roleOf(scheme, r.name).auto && !r.derived).length;
  const layerNames = useMemo(() => [...new Set(Object.values(scheme).map((r) => r.layer))].sort(), [scheme]);

  return (
    <div className="stack">
      <Callout>
        Analyses work on <strong>layers</strong>: groups of tiers that hold the same kind of annotation for different participants — for example <span className="mono">A_gesture</span> and{" "}
        <span className="mono">B_gesture</span> form the layer <span className="mono">gesture</span>. The grouping below was detected from tier names, participant attributes and tier types. Correct it wherever it is wrong.
      </Callout>
      <Card
        title="Tiers"
        sub={`${rows.length} different tier names in ${files.length} file${files.length === 1 ? "" : "s"}${edited ? ` · ${edited} edited by hand` : ""}`}
        actions={<Button small icon="reset" onClick={resetScheme} title="Discard manual edits and detect layers and participants again">Detect again</Button>}
        flush
      >
        <datalist id="layer-names">{layerNames.map((l) => <option key={l} value={l} />)}</datalist>
        <datalist id="participant-names">{participants.map((p) => <option key={p} value={p} />)}</datalist>
        <div className="table-wrap" style={{ maxHeight: "calc(100vh - 300px)", minHeight: 240 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Tier name</th>
                <th>Layer</th>
                <th>Participant</th>
                <th>Content</th>
                <th className="n">Files</th>
                <th className="n">Annotations</th>
                <th title="Tier type (linguistic type) in the .eaf files">Tier type</th>
                <th title="PARTICIPANT attribute in the .eaf files">Participant attribute</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const role = roleOf(scheme, r.name);
                return (
                  <tr key={r.name}>
                    <td className="mono">
                      {r.name}
                      {r.derived && <span className="chip accent" style={{ marginLeft: 6 }}>derived</span>}
                      {!role.auto && !r.derived && <span className="chip" style={{ marginLeft: 6 }}>edited</span>}
                    </td>
                    <td style={{ padding: "2px 6px" }}>
                      <input className="cell-input" list="layer-names" aria-label={`Layer of ${r.name}`} value={role.layer} onChange={(e) => setRole(r.name, { layer: e.target.value })} />
                    </td>
                    <td style={{ padding: "2px 6px" }}>
                      <span className="row" style={{ flexWrap: "nowrap", gap: 4 }}>
                        <span className="swatch" style={{ background: role.participant ? participantColor(participants, role.participant) : "transparent" }} />
                        <input className="cell-input" list="participant-names" aria-label={`Participant of ${r.name}`} value={role.participant} placeholder="–" onChange={(e) => setRole(r.name, { participant: e.target.value })} />
                      </span>
                    </td>
                    <td className="muted">{r.kind}</td>
                    <td className="n">{r.files}</td>
                    <td className="n">{r.annotations.toLocaleString("en-US")}</td>
                    <td className="muted">{r.types || "–"}</td>
                    <td className="muted">{r.attribute || "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <MethodNote title="How layers and participants are detected">
        <p>
          If a tier has a PARTICIPANT attribute, that is its participant. Otherwise the tier names of each file are compared: when the same name occurs with different first or last parts (
          <span className="mono">A_speech</span> / <span className="mono">B_speech</span>, <span className="mono">xds@CHI</span> / <span className="mono">xds@FA1</span>), that part is taken as the participant and the rest as the layer.
          Parts that usually name something else — <span className="mono">left</span>, <span className="mono">right</span>, <span className="mono">LH</span>, <span className="mono">RH</span> — are not treated as participants.
        </p>
        <p>Tiers without a recognisable participant form a layer of their own, named after the tier.</p>
      </MethodNote>
    </div>
  );
}
