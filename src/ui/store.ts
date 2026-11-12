import { create } from "zustand";
import { inferScheme, listParticipants, stripExtension, uniqueName, type CorpusFile, type TierRole, type TierScheme } from "../core/corpus/corpus.ts";
import { parseDelimited, type Dataset } from "../core/data/dataset.ts";
import { generateDemoCorpus } from "../core/demo/demoCorpus.ts";
import { decodeXmlBytes, parseEaf } from "../core/eaf/parser.ts";

export type ViewId =
  | "corpus" | "tiers" | "derive" | "timeline" | "search" | "descriptives"
  | "alignment" | "cooccurrence" | "turntaking" | "timing" | "sequences" | "recurrence"
  | "temporal" | "lexicon" | "agreement" | "statistics" | "methods";

export interface Focus {
  fileId: string;
  start: number;
  end: number;
  tierId?: string;
  /** Changes on every request so that repeated jumps to the same place still register. */
  nonce: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

interface AppState {
  files: CorpusFile[];
  scheme: TierScheme;
  view: ViewId;
  datasets: Dataset[];
  activeDataset: string | undefined;
  focus: Focus | undefined;
  viewState: Record<string, unknown>;
  toasts: Toast[];
  busy: string | undefined;
  /** True once the bundled example corpus has been loaded. */
  isDemo: boolean;

  setView: (view: ViewId) => void;
  loadFiles: (list: File[]) => Promise<void>;
  loadDemo: () => void;
  removeFile: (id: string) => void;
  clearCorpus: () => void;
  replaceCorpus: (files: CorpusFile[], scheme?: TierScheme) => void;
  setMeta: (fileId: string, variable: string, value: string) => void;
  addVariable: (name: string) => void;
  removeVariable: (name: string) => void;
  metaFromFileNames: (pattern: string) => string | undefined;
  importMetaCsv: (text: string) => string;
  setRole: (tierName: string, patch: Partial<Pick<TierRole, "layer" | "participant">>) => void;
  resetScheme: () => void;
  addDataset: (ds: Dataset, open?: boolean) => void;
  removeDataset: (id: string) => void;
  setActiveDataset: (id: string) => void;
  showInTimeline: (ref: { fileId: string; start: number; end: number; tierId?: string }) => void;
  setViewState: (key: string, value: unknown) => void;
  toast: (text: string, kind?: "info" | "error") => void;
  dismissToast: (id: number) => void;
}

let fileCounter = 0;
let toastCounter = 0;
let focusCounter = 0;

export const useStore = create<AppState>()((set, get) => ({
  files: [],
  scheme: {},
  view: "corpus",
  datasets: [],
  activeDataset: undefined,
  focus: undefined,
  viewState: {},
  toasts: [],
  busy: undefined,
  isDemo: false,

  setView: (view) => set({ view }),

  loadFiles: async (list) => {
    const eaf = list.filter((f) => /\.(eaf|xml)$/i.test(f.name));
    if (eaf.length === 0) {
      get().toast("No .eaf files found in the selection.", "error");
      return;
    }
    const added: CorpusFile[] = [];
    const names = new Set(get().files.map((f) => f.name));
    let failed = 0;
    for (let i = 0; i < eaf.length; i++) {
      const file = eaf[i]!;
      set({ busy: `Reading ${file.name} (${i + 1} of ${eaf.length})` });
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const doc = parseEaf(decodeXmlBytes(bytes), file.name);
        const name = uniqueName(names, stripExtension(file.name));
        names.add(name);
        added.push({ id: `f${++fileCounter}`, name, doc, meta: {} });
      } catch (e) {
        failed++;
        get().toast((e as Error).message, "error");
      }
      // Let the browser paint between files.
      await new Promise((r) => setTimeout(r, 0));
    }
    const base = get().isDemo ? [] : get().files;
    const variables = [...new Set(base.flatMap((f) => Object.keys(f.meta)))];
    for (const f of added) for (const v of variables) f.meta[v] = "";
    const files = [...base, ...added];
    set({
      files,
      scheme: inferScheme(files, get().isDemo ? undefined : get().scheme),
      busy: undefined,
      isDemo: false,
      datasets: get().isDemo ? [] : get().datasets,
    });
    if (added.length) {
      const warnings = added.reduce((s, f) => s + f.doc.warnings.length, 0);
      get().toast(
        `${added.length} file${added.length === 1 ? "" : "s"} added${failed ? `, ${failed} could not be read` : ""}${warnings ? ` · ${warnings} warning${warnings === 1 ? "" : "s"} (see the Corpus page)` : ""}.`,
      );
    }
  },

  loadDemo: () => {
    const files: CorpusFile[] = generateDemoCorpus().map((d) => ({
      id: `f${++fileCounter}`,
      name: stripExtension(d.fileName),
      doc: parseEaf(d.xml, d.fileName),
      meta: { ...d.meta },
    }));
    set({ files, scheme: inferScheme(files), isDemo: true, datasets: [], activeDataset: undefined, focus: undefined, viewState: {} });
  },

  removeFile: (id) => {
    const files = get().files.filter((f) => f.id !== id);
    set({ files, scheme: inferScheme(files, get().scheme) });
  },

  clearCorpus: () => set({ files: [], scheme: {}, datasets: [], activeDataset: undefined, focus: undefined, isDemo: false, viewState: {} }),

  replaceCorpus: (files, scheme) => set({ files, scheme: scheme ?? inferScheme(files, get().scheme) }),

  setMeta: (fileId, variable, value) =>
    set({ files: get().files.map((f) => (f.id === fileId ? { ...f, meta: { ...f.meta, [variable]: value } } : f)) }),

  addVariable: (name) => {
    const n = name.trim();
    if (!n) return;
    set({ files: get().files.map((f) => (n in f.meta ? f : { ...f, meta: { ...f.meta, [n]: "" } })) });
  },

  removeVariable: (name) =>
    set({
      files: get().files.map((f) => {
        const meta = { ...f.meta };
        delete meta[name];
        return { ...f, meta };
      }),
    }),

  metaFromFileNames: (pattern) => {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "u");
    } catch (e) {
      return `Invalid pattern: ${(e as Error).message}`;
    }
    let matched = 0;
    const files = get().files.map((f) => {
      const m = re.exec(f.name);
      if (!m) return f;
      matched++;
      const meta = { ...f.meta };
      if (m.groups && Object.keys(m.groups).length) {
        for (const [k, v] of Object.entries(m.groups)) meta[k] = v ?? "";
      } else {
        m.slice(1).forEach((v, i) => (meta[`var${i + 1}`] = v ?? ""));
      }
      return { ...f, meta };
    });
    if (matched === 0) return "The pattern does not match any file name.";
    // Every file gets every variable, so that tables stay rectangular.
    const variables = [...new Set(files.flatMap((f) => Object.keys(f.meta)))];
    set({ files: files.map((f) => ({ ...f, meta: Object.fromEntries(variables.map((v) => [v, f.meta[v] ?? ""])) })) });
    get().toast(`Variables set for ${matched} of ${files.length} files.`);
    return undefined;
  },

  importMetaCsv: (text) => {
    const rows = parseDelimited(text);
    if (rows.length < 2) return "The table needs a header row and at least one data row.";
    const header = rows[0]!.map((h) => h.trim());
    const byName = new Map<string, string[]>();
    for (const r of rows.slice(1)) byName.set(stripExtension((r[0] ?? "").trim()), r);
    let matched = 0;
    const files = get().files.map((f) => {
      const r = byName.get(f.name);
      if (!r) return f;
      matched++;
      const meta = { ...f.meta };
      header.slice(1).forEach((h, i) => {
        if (h) meta[h] = (r[i + 1] ?? "").trim();
      });
      return { ...f, meta };
    });
    if (matched === 0) return "No row matches a file name. The first column must contain the file names.";
    const variables = [...new Set(files.flatMap((f) => Object.keys(f.meta)))];
    set({ files: files.map((f) => ({ ...f, meta: Object.fromEntries(variables.map((v) => [v, f.meta[v] ?? ""])) })) });
    return `Variables imported for ${matched} of ${files.length} files.`;
  },

  setRole: (tierName, patch) => {
    const scheme = { ...get().scheme };
    const cur = scheme[tierName] ?? { tierName, layer: tierName, participant: "", auto: true };
    scheme[tierName] = { ...cur, ...patch, auto: false };
    set({ scheme });
  },

  resetScheme: () => {
    // Derived tiers keep their roles; everything else is detected afresh.
    const keep: TierScheme = {};
    for (const f of get().files) for (const t of f.doc.tiers) if (t.derived && get().scheme[t.id]) keep[t.id] = get().scheme[t.id]!;
    set({ scheme: inferScheme(get().files, keep) });
  },

  addDataset: (ds, open = true) => {
    const others = get().datasets.filter((d) => d.name !== ds.name);
    set({ datasets: [...others, ds], activeDataset: ds.id });
    if (open) set({ view: "statistics" });
    else get().toast(`“${ds.name}” is ready in Statistics.`);
  },

  removeDataset: (id) => {
    const datasets = get().datasets.filter((d) => d.id !== id);
    set({ datasets, activeDataset: get().activeDataset === id ? datasets[datasets.length - 1]?.id : get().activeDataset });
  },

  setActiveDataset: (id) => set({ activeDataset: id }),

  showInTimeline: (ref) => set({ focus: { ...ref, nonce: ++focusCounter }, view: "timeline" }),

  setViewState: (key, value) => set({ viewState: { ...get().viewState, [key]: value } }),

  toast: (text, kind = "info") => {
    const id = ++toastCounter;
    set({ toasts: [...get().toasts, { id, text, kind }] });
    setTimeout(() => get().dismissToast(id), kind === "error" ? 9000 : 4500);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** Stable colour of a participant: by position in the sorted list of all participants. */
export function participantColor(all: string[], participant: string): string {
  const i = all.indexOf(participant);
  return i >= 0 && i < 8 ? `var(--series-${i + 1})` : "var(--series-other)";
}

export function useParticipants(): string[] {
  const files = useStore((s) => s.files);
  const scheme = useStore((s) => s.scheme);
  return listParticipants(files, scheme);
}
