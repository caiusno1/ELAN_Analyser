import { useMemo } from "react";
import { DEFAULT_ALIGNMENT, type AlignmentOptions, type LookBack } from "../core/analysis/alignment.ts";
import { collectTokens } from "../core/analysis/lexicon.ts";
import { DEFAULT_TOKENIZER, guessStopLanguage, STOP_WORDS, topFrequentTypes, type TokenizerOptions } from "../core/text/tokenize.ts";
import { useLayers, useViewState } from "./hooks.ts";
import { defaultLayer, Field, LayerSelect, NumberField, Segmented, Select, TextField, Toggle } from "./kit.tsx";
import { useStore } from "./store.ts";

/** Settings of the lexical-alignment analysis, shared by the alignment view and the timeline overlay. */
export interface AlignmentSettings {
  layer: string;
  unit: "turn" | "annotation";
  minN: number;
  lookBack: "all" | "turns" | "seconds";
  lookBackTurns: number;
  lookBackSeconds: number;
  /** "auto": the list of the detected language; a language name; "frequent"; "custom"; "none". */
  stop: string;
  frequentK: number;
  customStop: string;
  lowercase: boolean;
  stripPunctuation: boolean;
  removeBracketed: boolean;
  dropPattern: string;
}

export interface TextSettings {
  stop: string;
  frequentK: number;
  customStop: string;
  lowercase: boolean;
  stripPunctuation: boolean;
  removeBracketed: boolean;
  dropPattern: string;
}

export const DEFAULT_TEXT_SETTINGS: TextSettings = {
  stop: "auto",
  frequentK: 30,
  customStop: "",
  lowercase: DEFAULT_TOKENIZER.lowercase,
  stripPunctuation: DEFAULT_TOKENIZER.stripPunctuation,
  removeBracketed: DEFAULT_TOKENIZER.removeBracketed,
  dropPattern: DEFAULT_TOKENIZER.dropPattern,
};

/** Build tokenizer options (including the stop-word set) for a layer from the text settings. */
export function useTokenizer(layer: string, s: TextSettings): { tokenizer: TokenizerOptions; stopLabel: string; detected: string | undefined } {
  const files = useStore((st) => st.files);
  const scheme = useStore((st) => st.scheme);
  const base = useMemo<TokenizerOptions>(
    () => ({ lowercase: s.lowercase, stripPunctuation: s.stripPunctuation, removeBracketed: s.removeBracketed, dropPattern: s.dropPattern, stopWords: new Set() }),
    [s.lowercase, s.stripPunctuation, s.removeBracketed, s.dropPattern],
  );
  // Token sample of the layer, needed for language detection and the frequency-based list.
  const sample = useMemo(() => (layer ? collectTokens(files, scheme, layer, base).map((t) => t.norm) : []), [files, scheme, layer, base]);
  const detected = useMemo(() => guessStopLanguage(sample), [sample]);
  return useMemo(() => {
    let words: string[] = [];
    let stopLabel = "none";
    if (s.stop === "auto") {
      words = detected ? STOP_WORDS[detected]! : [];
      stopLabel = detected ? `${detected} (detected)` : "none (language not recognised)";
    } else if (s.stop === "frequent") {
      words = topFrequentTypes(sample, s.frequentK);
      stopLabel = `the ${s.frequentK} most frequent words`;
    } else if (s.stop === "custom") {
      words = s.customStop.split(/[\s,;]+/).map((w) => (s.lowercase ? w.toLocaleLowerCase() : w)).filter(Boolean);
      stopLabel = `${words.length} custom words`;
    } else if (STOP_WORDS[s.stop]) {
      words = STOP_WORDS[s.stop]!;
      stopLabel = s.stop;
    }
    return { tokenizer: { ...base, stopWords: new Set(words) }, stopLabel, detected };
  }, [base, s.stop, s.frequentK, s.customStop, s.lowercase, detected, sample]);
}

export function useAlignmentSettings(): [AlignmentSettings, (patch: Partial<AlignmentSettings>) => void] {
  const layers = useLayers();
  const [settings, setSettings] = useViewState<AlignmentSettings>("alignment.settings", {
    layer: defaultLayer(layers, "text", /speech|utter|trans|text|word|orth/i),
    unit: DEFAULT_ALIGNMENT.unit,
    minN: DEFAULT_ALIGNMENT.minN,
    lookBack: "all",
    lookBackTurns: 10,
    lookBackSeconds: 30,
    ...DEFAULT_TEXT_SETTINGS,
  });
  return [settings, (patch) => setSettings((prev) => ({ ...prev, ...patch }))];
}

export function useAlignmentOptions(settings: AlignmentSettings): { options: AlignmentOptions; stopLabel: string } {
  const { tokenizer, stopLabel } = useTokenizer(settings.layer, settings);
  const options = useMemo<AlignmentOptions>(() => {
    const lookBack: LookBack =
      settings.lookBack === "turns" ? { kind: "turns", n: settings.lookBackTurns } : settings.lookBack === "seconds" ? { kind: "seconds", s: settings.lookBackSeconds } : { kind: "all" };
    return { layer: settings.layer, tokenizer, unit: settings.unit, minN: settings.minN, maxN: DEFAULT_ALIGNMENT.maxN, lookBack };
  }, [settings.layer, settings.unit, settings.minN, settings.lookBack, settings.lookBackTurns, settings.lookBackSeconds, tokenizer]);
  return { options, stopLabel };
}

/** Form controls for how text is split into words and which words count as function words. */
export function TextSettingsFields<T extends TextSettings>({ value, onChange, stopLabel, idPrefix }: { value: T; onChange: (patch: Partial<TextSettings>) => void; stopLabel: string; idPrefix: string }) {
  return (
    <>
      <Field label="Function words" htmlFor={`${idPrefix}-stop`} hint={`In use: ${stopLabel}. They are kept in the text but never count as content.`}>
        <Select
          id={`${idPrefix}-stop`}
          value={value.stop}
          onChange={(stop) => onChange({ stop })}
          options={[
            { value: "auto", label: "Detect the language" },
            ...Object.keys(STOP_WORDS).map((l) => ({ value: l, label: `${l} list` })),
            { value: "frequent", label: "Most frequent words" },
            { value: "custom", label: "My own list" },
            { value: "none", label: "None (all words count)" },
          ]}
        />
      </Field>
      {value.stop === "frequent" && (
        <Field label="How many of the most frequent words" htmlFor={`${idPrefix}-k`}>
          <NumberField id={`${idPrefix}-k`} value={value.frequentK} min={1} max={500} step={5} onChange={(frequentK) => onChange({ frequentK })} />
        </Field>
      )}
      {value.stop === "custom" && (
        <Field label="Words to ignore" htmlFor={`${idPrefix}-custom`} hint="Separated by spaces, commas or line breaks.">
          <textarea id={`${idPrefix}-custom`} className="input" value={value.customStop} onChange={(e) => onChange({ customStop: e.target.value })} />
        </Field>
      )}
      <details style={{ marginTop: 9 }}>
        <summary className="muted" style={{ cursor: "pointer" }}>How text is split into words</summary>
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 7 }}>
          <Toggle id={`${idPrefix}-lower`} checked={value.lowercase} onChange={(lowercase) => onChange({ lowercase })}>Ignore upper/lower case</Toggle>
          <Toggle id={`${idPrefix}-punct`} checked={value.stripPunctuation} onChange={(stripPunctuation) => onChange({ stripPunctuation })}>Strip punctuation</Toggle>
          <Toggle id={`${idPrefix}-brackets`} checked={value.removeBracketed} onChange={(removeBracketed) => onChange({ removeBracketed })}>Leave out text in brackets</Toggle>
          <Field label="Drop words matching" htmlFor={`${idPrefix}-drop`} hint="Regular expression, e.g. for fillers: ^(uh|um|äh|ähm)$">
            <TextField id={`${idPrefix}-drop`} mono value={value.dropPattern} onChange={(dropPattern) => onChange({ dropPattern })} />
          </Field>
        </div>
      </details>
    </>
  );
}

export function AlignmentSettingsFields({ value, onChange, stopLabel }: { value: AlignmentSettings; onChange: (patch: Partial<AlignmentSettings>) => void; stopLabel: string }) {
  return (
    <>
      <Field label="Transcription layer" htmlFor="al-layer">
        <LayerSelect id="al-layer" value={value.layer} onChange={(layer) => onChange({ layer })} kinds={["text"]} />
      </Field>
      <Field label="Unit of dialogue" hint={value.unit === "turn" ? "Consecutive annotations of one speaker form one turn." : "Every annotation is a unit of its own."}>
        <Segmented value={value.unit} onChange={(unit) => onChange({ unit })} options={[{ value: "turn", label: "Turns" }, { value: "annotation", label: "Annotations" }]} />
      </Field>
      <Field label="Shortest expression that counts" htmlFor="al-min" hint="In words. 1 counts single re-used content words; 2 or more only multi-word expressions.">
        <NumberField id="al-min" value={value.minN} min={1} max={6} step={1} onChange={(minN) => onChange({ minN: Math.round(minN) })} />
      </Field>
      <Field label="How far back a re-use may reach">
        <Segmented
          value={value.lookBack}
          onChange={(lookBack) => onChange({ lookBack })}
          options={[{ value: "all", label: "Whole dialogue" }, { value: "turns", label: "Turns" }, { value: "seconds", label: "Seconds" }]}
        />
      </Field>
      {value.lookBack === "turns" && (
        <Field label="Number of preceding turns" htmlFor="al-turns">
          <NumberField id="al-turns" value={value.lookBackTurns} min={1} max={500} step={1} onChange={(lookBackTurns) => onChange({ lookBackTurns })} />
        </Field>
      )}
      {value.lookBack === "seconds" && (
        <Field label="Seconds before the re-use" htmlFor="al-secs">
          <NumberField id="al-secs" value={value.lookBackSeconds} min={1} max={3600} step={5} onChange={(lookBackSeconds) => onChange({ lookBackSeconds })} />
        </Field>
      )}
      <TextSettingsFields value={value} onChange={onChange} stopLabel={stopLabel} idPrefix="al" />
    </>
  );
}
