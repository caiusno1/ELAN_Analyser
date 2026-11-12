import { layerTiers, listMetaVariables, roleOf, type CorpusFile, type TierScheme } from "../corpus/corpus.ts";
import { datasetFromRows, type Dataset, type Row } from "../data/dataset.ts";
import { totalDuration, unionIntervals } from "../intervals.ts";
import { summarize } from "../stats/describe.ts";
import { rateSummary } from "../stats/bayes/proportions.ts";
import { compileFilter, DEFAULT_NORMALIZATION, metaCells, normalizeValue, type ValueFilter, type ValueNormalization } from "./common.ts";

/**
 * Descriptive statistics of a layer: how often, how long, how much of the time — per
 * file, participant and (optionally) annotation value. These are the numbers ELAN's own
 * "annotation statistics" give, here for the whole corpus at once and with rates.
 */

export interface DescriptiveOptions {
  layer: string;
  filter?: ValueFilter;
  /** Report each annotation value separately. */
  byValue: boolean;
  normalization?: ValueNormalization;
  participants?: ReadonlySet<string>;
}

export interface DescriptiveRow {
  fileId: string;
  file: string;
  participant: string;
  tier: string;
  value: string;
  /** Number of annotations. */
  n: number;
  /** Total annotated time in seconds. */
  totalDuration: number;
  meanDuration: number;
  medianDuration: number;
  sdDuration: number;
  minDuration: number;
  maxDuration: number;
  /** Annotations per minute of recording. */
  ratePerMin: number;
  /** 95% credible interval of the rate (Jeffreys prior). */
  rateCi: [number, number];
  /** Share of the recording covered by these annotations (0–1). */
  coverage: number;
  /** Time of the first annotation in seconds. */
  latency: number;
  /** Observation time of the file in seconds. */
  observed: number;
}

export interface DescriptiveResult {
  rows: DescriptiveRow[];
  /** Durations (s) of every annotation, grouped as in `rows`, for distribution plots. */
  durations: Map<string, Float64Array>;
  dataset: Dataset;
  /** One row per annotation. */
  annotations: Dataset;
  error?: string;
}

export function describeLayer(files: CorpusFile[], scheme: TierScheme, opts: DescriptiveOptions): DescriptiveResult {
  const { test, error } = compileFilter(opts.filter);
  const norm = opts.normalization ?? DEFAULT_NORMALIZATION;
  const metaVars = listMetaVariables(files);
  const rows: DescriptiveRow[] = [];
  const durations = new Map<string, Float64Array>();
  const annRows: Row[] = [];
  const tierOpts = opts.participants ? { participants: opts.participants } : {};

  for (const lt of layerTiers(files, scheme, opts.layer, tierOpts)) {
    const observedMs = lt.file.doc.duration;
    const groups = new Map<string, { start: number; end: number }[]>();
    for (const a of lt.tier.annotations) {
      if (!test(a.value)) continue;
      const value = normalizeValue(a.value, norm);
      const key = opts.byValue ? value : "(all)";
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(a);
      annRows.push({
        file: lt.file.name,
        ...metaCells(lt.file, metaVars),
        participant: lt.participant,
        tier: lt.tier.id,
        value,
        start_s: a.start / 1000,
        end_s: a.end / 1000,
        duration_s: (a.end - a.start) / 1000,
        words: value.split(/\s+/).filter(Boolean).length,
      });
    }
    for (const [value, anns] of groups) {
      const d = Float64Array.from(anns, (a) => (a.end - a.start) / 1000);
      const s = summarize(d);
      const observed = observedMs / 1000;
      const rate = observed > 0 ? rateSummary(anns.length, observed / 60) : undefined;
      const row: DescriptiveRow = {
        fileId: lt.file.id,
        file: lt.file.name,
        participant: lt.participant,
        tier: lt.tier.id,
        value,
        n: anns.length,
        totalDuration: s.sum,
        meanDuration: s.mean,
        medianDuration: s.median,
        sdDuration: s.sd,
        minDuration: s.min,
        maxDuration: s.max,
        ratePerMin: rate ? rate.rate : NaN,
        rateCi: rate ? rate.ci : [NaN, NaN],
        coverage: observedMs > 0 ? totalDuration(unionIntervals(anns)) / observedMs : NaN,
        latency: anns.length ? anns[0]!.start / 1000 : NaN,
        observed,
      };
      rows.push(row);
      durations.set(`${lt.file.id}\u0001${lt.tier.id}\u0001${value}`, d);
    }
  }

  const fileById = new Map(files.map((f) => [f.id, f]));
  const dsRows: Row[] = rows.map((r) => ({
    file: r.file,
    ...metaCells(fileById.get(r.fileId)!, metaVars),
    participant: r.participant,
    tier: r.tier,
    value: r.value,
    n: r.n,
    total_duration_s: r.totalDuration,
    mean_duration_s: r.meanDuration,
    median_duration_s: r.medianDuration,
    sd_duration_s: r.sdDuration,
    rate_per_min: r.ratePerMin,
    coverage: r.coverage,
    latency_s: r.latency,
    observed_min: r.observed / 60,
  }));
  const metaSpec = metaVars.map((v) => ({ name: v, type: "string" as const, label: "file variable" }));
  const dataset = datasetFromRows(
    `Descriptives: ${opts.layer}`,
    opts.byValue ? "one value on one tier" : "one tier",
    `Counts, durations and rates of the layer “${opts.layer}”.`,
    dsRows,
    [
      { name: "file", type: "string" }, ...metaSpec,
      { name: "participant", type: "string" }, { name: "tier", type: "string" }, { name: "value", type: "string" },
      { name: "n", type: "number", label: "number of annotations" },
      { name: "total_duration_s", type: "number" }, { name: "mean_duration_s", type: "number" },
      { name: "median_duration_s", type: "number" }, { name: "sd_duration_s", type: "number" },
      { name: "rate_per_min", type: "number", label: "annotations per minute of recording" },
      { name: "coverage", type: "number", label: "share of the recording covered (0–1)" },
      { name: "latency_s", type: "number", label: "time of the first annotation" },
      { name: "observed_min", type: "number", label: "length of the recording in minutes (exposure)" },
    ],
  );
  const annotations = datasetFromRows(
    `Annotations: ${opts.layer}`,
    "one annotation",
    `Every annotation of the layer “${opts.layer}”.`,
    annRows,
    [
      { name: "file", type: "string" }, ...metaSpec,
      { name: "participant", type: "string" }, { name: "tier", type: "string" }, { name: "value", type: "string" },
      { name: "start_s", type: "number" }, { name: "end_s", type: "number" }, { name: "duration_s", type: "number" },
      { name: "words", type: "number", label: "number of whitespace-separated words in the value" },
    ],
  );
  const result: DescriptiveResult = { rows, durations, dataset, annotations };
  if (error) result.error = error;
  return result;
}

/** Overview numbers for the corpus page. */
export interface CorpusOverview {
  files: number;
  tiers: number;
  annotations: number;
  /** Summed recording time in ms. */
  duration: number;
  participants: number;
  layers: number;
}

export function corpusOverview(files: CorpusFile[], scheme: TierScheme): CorpusOverview {
  let tiers = 0;
  let annotations = 0;
  let duration = 0;
  const participants = new Set<string>();
  const layers = new Set<string>();
  for (const f of files) {
    duration += f.doc.duration;
    for (const t of f.doc.tiers) {
      tiers++;
      annotations += t.annotations.length;
      const role = roleOf(scheme, t.id);
      layers.add(role.layer);
      if (role.participant) participants.add(`${f.id}\u0001${role.participant}`);
    }
  }
  return { files: files.length, tiers, annotations, duration, participants: participants.size, layers: layers.size };
}
