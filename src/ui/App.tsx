import { useEffect, useMemo, useState, type ReactNode } from "react";
import { corpusOverview } from "../core/analysis/descriptives.ts";
import { formatDuration } from "../core/analysis/common.ts";
import { BrandMark, icons, type IconName } from "./icons.tsx";
import { useStore, type ViewId } from "./store.ts";
import { AgreementView } from "./views/AgreementView.tsx";
import { AlignmentView } from "./views/AlignmentView.tsx";
import { CooccurrenceView } from "./views/CooccurrenceView.tsx";
import { CorpusView } from "./views/CorpusView.tsx";
import { DeriveView } from "./views/DeriveView.tsx";
import { DescriptivesView } from "./views/DescriptivesView.tsx";
import { LexiconView } from "./views/LexiconView.tsx";
import { MethodsView } from "./views/MethodsView.tsx";
import { RecurrenceView } from "./views/RecurrenceView.tsx";
import { SearchView } from "./views/SearchView.tsx";
import { SequencesView } from "./views/SequencesView.tsx";
import { StatisticsView } from "./views/StatisticsView.tsx";
import { TemporalView } from "./views/TemporalView.tsx";
import { TiersView } from "./views/TiersView.tsx";
import { TimelineView } from "./views/TimelineView.tsx";
import { TimingView } from "./views/TimingView.tsx";
import { TurnTakingView } from "./views/TurnTakingView.tsx";

interface NavEntry {
  id: ViewId;
  label: string;
  icon: IconName;
  title: string;
  lede: string;
  /** Works without any file loaded. */
  always?: boolean;
}

const NAV: { group: string; items: NavEntry[] }[] = [
  {
    group: "Data",
    items: [
      { id: "corpus", label: "Corpus", icon: "corpus", title: "Corpus", lede: "The .eaf files you are working with and their variables.", always: true },
      { id: "tiers", label: "Tiers & layers", icon: "tiers", title: "Tiers & layers", lede: "Which tiers hold the same kind of annotation, and for which participant." },
      { id: "derive", label: "Derived tiers", icon: "derive", title: "Derived tiers", lede: "Compute new tiers from existing ones: overlaps, gaps, filters, windows." },
    ],
  },
  {
    group: "Explore",
    items: [
      { id: "timeline", label: "Timeline", icon: "timeline", title: "Timeline", lede: "All tiers of a recording on a time axis, with analysis overlays." },
      { id: "search", label: "Search", icon: "search", title: "Search", lede: "Find annotations by text, duration and what they overlap with." },
      { id: "descriptives", label: "Descriptives", icon: "descriptives", title: "Descriptives", lede: "How often, how long, how much of the time." },
    ],
  },
  {
    group: "Analyse",
    items: [
      { id: "alignment", label: "Lexical alignment", icon: "alignment", title: "Lexical alignment", lede: "Speakers re-using each other's words and expressions." },
      { id: "cooccurrence", label: "Co-occurrence", icon: "cooccurrence", title: "Co-occurrence", lede: "Which annotations of two layers overlap in time, and how that compares with chance." },
      { id: "turntaking", label: "Turn-taking", icon: "turntaking", title: "Turn-taking", lede: "Gaps, overlaps and floor transfer offsets between speakers." },
      { id: "timing", label: "Timing", icon: "timing", title: "Timing", lede: "When one kind of event happens relative to another." },
      { id: "sequences", label: "Sequences", icon: "sequences", title: "Sequences", lede: "What follows what: n-grams and transition probabilities." },
      { id: "recurrence", label: "Recurrence", icon: "recurrence", title: "Recurrence", lede: "Cross-recurrence of two behaviour streams: who repeats whom, and how soon." },
      { id: "temporal", label: "Temporal structure", icon: "temporal", title: "Temporal structure", lede: "Bursts, lulls and changes in rate over a recording." },
      { id: "lexicon", label: "Lexicon", icon: "lexicon", title: "Lexicon", lede: "Word frequencies, lexical diversity, key words and concordances." },
      { id: "agreement", label: "Agreement", icon: "agreement", title: "Inter-annotator agreement", lede: "How well two raters agree on segmentation and labels." },
    ],
  },
  {
    group: "Infer",
    items: [
      { id: "statistics", label: "Statistics", icon: "statistics", title: "Bayesian statistics", lede: "Bayes factors and posterior estimates for any table produced by the analyses." },
    ],
  },
  {
    group: "Reference",
    items: [{ id: "methods", label: "Methods", icon: "methods", title: "Methods & references", lede: "What each analysis computes, and where it comes from.", always: true }],
  },
];

const VIEWS: Record<ViewId, () => ReactNode> = {
  corpus: () => <CorpusView />,
  tiers: () => <TiersView />,
  derive: () => <DeriveView />,
  timeline: () => <TimelineView />,
  search: () => <SearchView />,
  descriptives: () => <DescriptivesView />,
  alignment: () => <AlignmentView />,
  cooccurrence: () => <CooccurrenceView />,
  turntaking: () => <TurnTakingView />,
  timing: () => <TimingView />,
  sequences: () => <SequencesView />,
  recurrence: () => <RecurrenceView />,
  temporal: () => <TemporalView />,
  lexicon: () => <LexiconView />,
  agreement: () => <AgreementView />,
  statistics: () => <StatisticsView />,
  methods: () => <MethodsView />,
};

export function App() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  const isDemo = useStore((s) => s.isDemo);
  const busy = useStore((s) => s.busy);
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  const loadFiles = useStore((s) => s.loadFiles);
  const [dragging, setDragging] = useState(false);

  // Open with the example corpus so that every view shows something real to work with.
  useEffect(() => {
    if (useStore.getState().files.length === 0) useStore.getState().loadDemo();
  }, []);

  // Dropping .eaf files anywhere adds them to the corpus.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      void loadFiles(Array.from(e.dataTransfer?.files ?? []));
      setView("corpus");
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [loadFiles, setView]);

  const overview = useMemo(() => corpusOverview(files, scheme), [files, scheme]);
  const entry = NAV.flatMap((g) => g.items).find((i) => i.id === view)!;
  const empty = files.length === 0;

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">ELAN Analyser</div>
            <div className="brand-sub">analysis workbench</div>
          </div>
        </div>
        <nav className="nav" aria-label="Views">
          {NAV.map((g) => (
            <div key={g.group} style={{ display: "contents" }}>
              <div className="nav-group">{g.group}</div>
              {g.items.map((it) => (
                <button key={it.id} className="nav-item" aria-current={it.id === view ? "page" : undefined} disabled={empty && !it.always} onClick={() => setView(it.id)}>
                  {icons[it.icon]}
                  {it.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="rail-foot">Files are read in your browser and never uploaded.</div>
      </aside>
      <div className="main">
        <header className="topbar">
          <h1>{entry.title}</h1>
          <div className="lede">{entry.lede}</div>
          {busy && <span className="corpus-chip">{busy}</span>}
          {!empty && (
            <span className="corpus-chip" title="Size of the corpus">
              {isDemo && <span className="chip warning">example data</span>}
              <span className="num">{overview.files} file{overview.files === 1 ? "" : "s"}</span>
              <span className="num">{formatDuration(overview.duration)}</span>
              <span className="num">{overview.annotations.toLocaleString("en-US")} annotations</span>
            </span>
          )}
        </header>
        <main className="view">{empty && !entry.always ? <CorpusView /> : VIEWS[view]()}</main>
      </div>
      {dragging && (
        <div style={{ position: "fixed", inset: 0, zIndex: 80, display: "grid", placeItems: "center", background: "color-mix(in srgb, var(--bg) 82%, transparent)", pointerEvents: "none" }}>
          <div className="dropzone over" style={{ background: "var(--surface)", minWidth: 280 }}>
            <strong>Drop .eaf files to add them to the corpus</strong>
          </div>
        </div>
      )}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.kind === "error" ? " error" : ""}`} onClick={() => dismissToast(t.id)}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
