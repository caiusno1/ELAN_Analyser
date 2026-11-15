import { Fragment, useMemo } from "react";
import { METHODS, NEW_QUESTIONS, STATISTICS, USE_CASES, VIEW_NAME } from "../../reference/content.ts";
import { REFERENCES, reference, shortCitation } from "../../reference/references.ts";
import { useViewState } from "../hooks.ts";
import { Button, Callout, Card, Tabs, TextField } from "../kit.tsx";
import { useStore, type ViewId } from "../store.ts";

type Tab = "published" | "new" | "methods" | "statistics" | "references";

/** Views that work without a corpus. */
const ALWAYS: ReadonlySet<ViewId> = new Set<ViewId>(["corpus", "statistics", "methods"]);

export function MethodsView() {
  const [tab, setTab] = useViewState<Tab>("methods.tab", "published");
  const [query, setQuery] = useViewState("methods.query", "");
  const setView = useStore((s) => s.setView);
  const hasCorpus = useStore((s) => s.files.length > 0);

  const cite = (ids: string[] | undefined) =>
    ids && ids.length > 0 ? (
      <p className="faint" style={{ margin: "8px 0 0" }}>
        {ids.map((id, i) => (
          <Fragment key={id}>
            {i > 0 && " · "}
            <button
              className="link"
              style={{ color: "inherit" }}
              title={reference(id).text}
              onClick={() => {
                setQuery(shortCitation(id).replace(/ \(\d{4}\)$/, "").replace(" et al.", ""));
                setTab("references");
              }}
            >
              {shortCitation(id)}
            </button>
          </Fragment>
        ))}
      </p>
    ) : null;
  const open = (view: ViewId) => (
    <Button small icon={view} disabled={!hasCorpus && !ALWAYS.has(view)} onClick={() => setView(view)}>
      Open {VIEW_NAME[view]}
    </Button>
  );

  const found = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return q ? REFERENCES.filter((r) => r.text.toLocaleLowerCase().includes(q)) : REFERENCES;
  }, [query]);

  return (
    <div className="stack">
      <Tabs<Tab>
        tabs={[
          { id: "published", label: "Questions from the literature" },
          { id: "new", label: "Questions that become possible" },
          { id: "methods", label: "How each analysis works" },
          { id: "statistics", label: "Statistics" },
          { id: "references", label: `References (${REFERENCES.length})` },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "published" && (
        <>
          <p className="muted prose" style={{ margin: 0 }}>
            What researchers have asked of time-aligned annotations of talk, gesture and gaze — and where each analysis is found here. Every result table can be taken to the statistics lab for inference across speakers and recordings.
          </p>
          <div className="cols-2">
            {USE_CASES.map((u) => (
              <Card key={u.question} title={u.question} actions={open(u.view)}>
                <p className="prose" style={{ margin: 0 }}>{u.literature}</p>
                <p className="prose" style={{ margin: "8px 0 0" }}><strong>Here.</strong> {u.here}</p>
                {cite(u.refs)}
              </Card>
            ))}
          </div>
        </>
      )}

      {tab === "new" && (
        <>
          <p className="muted prose" style={{ margin: 0 }}>
            These analyses are rarely published — not because the questions are uninteresting, but because each needs several tools and custom scripts in between: tiers have to be combined, events linked across modalities, chance levels
            simulated, and the nesting of annotations in speakers and recordings modelled. Here the pieces are connected, so each one is a short recipe. They are suggestions for analyses, not established findings.
          </p>
          <div className="cols-2">
            {NEW_QUESTIONS.map((q) => (
              <Card key={q.title} title={q.title} actions={open(q.view)}>
                <p className="prose" style={{ margin: 0 }}>{q.why}</p>
                <ol className="prose" style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                  {q.steps.map((step) => <li key={step} style={{ marginTop: 3 }}>{step}</li>)}
                </ol>
                {cite(q.refs)}
              </Card>
            ))}
          </div>
        </>
      )}

      {tab === "methods" && (
        <div className="cols-2">
          {METHODS.map((m) => (
            <Card key={m.view} title={m.title} sub={m.summary} actions={open(m.view)}>
              <ul className="prose" style={{ margin: 0, paddingLeft: 18 }}>
                {m.points.map((pt) => <li key={pt} style={{ marginTop: 3 }}>{pt}</li>)}
              </ul>
              {m.caveat && <div style={{ marginTop: 10 }}><Callout kind="info">{m.caveat}</Callout></div>}
              {cite(m.refs)}
            </Card>
          ))}
        </div>
      )}

      {tab === "statistics" && (
        <div className="cols-2">
          {STATISTICS.map((t) => (
            <Card key={t.title} title={t.title} actions={t === STATISTICS[0] ? open("statistics") : undefined}>
              {t.paragraphs.map((para, i) => <p key={para} className="prose" style={{ margin: i === 0 ? 0 : "8px 0 0" }}>{para}</p>)}
              {cite(t.refs)}
            </Card>
          ))}
        </div>
      )}

      {tab === "references" && (
        <Card title="References" sub="Work that the analyses and their defaults are based on.">
          <div style={{ maxWidth: 360 }}>
            <TextField value={query} onChange={setQuery} placeholder="Filter by author, title or year" />
          </div>
          {found.length === 0 ? (
            <p className="muted" style={{ margin: "12px 0 0" }}>No reference matches “{query}”.</p>
          ) : (
            <ul className="prose refs" style={{ margin: "12px 0 0", padding: 0, listStyle: "none" }}>
              {found.map((r) => <li key={r.id} style={{ marginTop: 6, paddingLeft: 22, textIndent: -22 }}>{r.text}</li>)}
            </ul>
          )}
          <p className="faint" style={{ margin: "14px 0 0" }}>
            ELAN is developed by the Max Planck Institute for Psycholinguistics, The Language Archive, Nijmegen. This program is an independent project and is not affiliated with or endorsed by the institute.
          </p>
        </Card>
      )}
    </div>
  );
}
