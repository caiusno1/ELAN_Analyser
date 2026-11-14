import { useMemo, useRef, useState } from "react";
import type { Dataset } from "../../core/data/dataset.ts";
import { buildModel, formulaOf, type BuiltModel, type ModelSpec } from "../../core/stats/design.ts";
import { kde, quantile } from "../../core/stats/describe.ts";
import { compareWaic, type GlmmFit, type ParamSummary } from "../../core/stats/mcmc/fit.ts";
import { FAMILY_INFO, type Family } from "../../core/stats/mcmc/glmm.ts";
import { ChartCard } from "../charts/ChartCard.tsx";
import { XYChart, type Mark } from "../charts/XYChart.tsx";
import { fitModel, type FitHandle } from "../compute.ts";
import { useViewState } from "../hooks.ts";
import { Button, Callout, Card, CheckList, DataTable, Empty, Field, fmt, fmtBf, MethodNote, NumberField, pct, Select, Toggle } from "../kit.tsx";
import { groupingOptions, variableOptions } from "./common.tsx";

interface Settings {
  outcome: string;
  family: Family;
  predictors: string[];
  asCategory: string[];
  interactionA: string;
  interactionB: string;
  random: string[];
  exposure: string;
  trials: string;
  chains: number;
  warmup: number;
  samples: number;
  bridge: boolean;
}

interface StoredModel {
  id: number;
  name: string;
  spec: ModelSpec;
  formula: string;
  rowsUsed: number;
  rowsDropped: number;
  terms: BuiltModel["terms"];
  fit: GlmmFit;
}

let modelCounter = 0;

function specOf(s: Settings): ModelSpec {
  const spec: ModelSpec = { outcome: s.outcome, family: s.family, predictors: s.predictors, asCategory: s.asCategory.filter((v) => s.predictors.includes(v)), random: s.random };
  if (s.interactionA && s.interactionB && s.interactionA !== s.interactionB && s.predictors.includes(s.interactionA) && s.predictors.includes(s.interactionB)) spec.interactions = [[s.interactionA, s.interactionB]];
  if (s.exposure && (s.family === "poisson" || s.family === "negbinomial")) spec.exposure = s.exposure;
  if (s.trials && s.family === "binomial") spec.trials = s.trials;
  return spec;
}

/** Guess a sensible family from the values of the outcome. */
function guessFamily(ds: Dataset, outcome: string): Family {
  const c = ds.columns.find((col) => col.name === outcome);
  if (!c || c.type !== "number") return "gaussian";
  const vals = Array.from(c.values).filter((v) => Number.isFinite(v));
  if (vals.length === 0) return "gaussian";
  const allInt = vals.every((v) => Number.isInteger(v));
  if (allInt && vals.every((v) => v === 0 || v === 1)) return "bernoulli";
  if (allInt && vals.every((v) => v >= 0)) return "poisson";
  if (/dur|time|latency|_s$|_ms$/i.test(outcome) && vals.every((v) => v > 0)) return "lognormal";
  return "gaussian";
}

export function RegressionPanel({ ds }: { ds: Dataset }) {
  const numeric = variableOptions(ds, "number");
  const all = variableOptions(ds);
  const groupings = groupingOptions(ds);
  const initialOutcome = numeric[numeric.length - 1]?.value ?? "";
  const [s, setS] = useViewState<Settings>(`stats.reg.${ds.id}`, {
    outcome: initialOutcome,
    family: guessFamily(ds, initialOutcome),
    predictors: [],
    asCategory: [],
    interactionA: "",
    interactionB: "",
    random: [],
    exposure: "",
    trials: "",
    chains: 4,
    warmup: 1000,
    samples: 1000,
    bridge: true,
  });
  const patch = (p: Partial<Settings>) => setS((prev) => ({ ...prev, ...p }));
  const [models, setModels] = useViewState<StoredModel[]>(`stats.models.${ds.id}`, []);
  const [selectedId, setSelectedId] = useViewState<number | undefined>(`stats.model.${ds.id}`, undefined);
  const [running, setRunning] = useState<{ fraction: number; phase: string } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const handle = useRef<FitHandle | undefined>(undefined);

  const spec = specOf(s);
  const formula = formulaOf(spec);
  const numericPredictors = s.predictors.filter((p) => ds.columns.find((c) => c.name === p)?.type === "number");
  const isCount = s.family === "poisson" || s.family === "negbinomial";

  const run = () => {
    setError(undefined);
    let built: BuiltModel;
    try {
      built = buildModel(ds, spec);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setRunning({ fraction: 0, phase: "Starting" });
    const h = fitModel(built.input, { chains: s.chains, warmup: s.warmup, samples: s.samples, seed: 2026, bridge: s.bridge }, (fraction, phase) => setRunning({ fraction, phase }));
    handle.current = h;
    h.promise
      .then((fit) => {
        const id = ++modelCounter;
        const stored: StoredModel = { id, name: `Model ${id}`, spec, formula: built.formula, rowsUsed: built.rowsUsed, rowsDropped: built.rowsDropped, terms: built.terms, fit };
        setModels((prev) => [...prev, stored]);
        setSelectedId(id);
        setRunning(undefined);
      })
      .catch((e: Error) => {
        setRunning(undefined);
        if (e.message !== "cancelled") setError(e.message);
      });
  };
  const model = models.find((m) => m.id === selectedId) ?? models[models.length - 1];

  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Multilevel regression">
          <Field label="Outcome" htmlFor="rg-y"><Select id="rg-y" value={s.outcome} onChange={(outcome) => patch({ outcome, family: guessFamily(ds, outcome), predictors: s.predictors.filter((p) => p !== outcome) })} options={numeric} /></Field>
          <Field label="Kind of outcome" htmlFor="rg-fam" hint={`${FAMILY_INFO[s.family].description}; link: ${FAMILY_INFO[s.family].link}.`}>
            <Select id="rg-fam" value={s.family} onChange={(family) => patch({ family })} options={(Object.keys(FAMILY_INFO) as Family[]).map((f) => ({ value: f, label: FAMILY_INFO[f].label }))} />
          </Field>
          {isCount && <Field label="Exposure" htmlFor="rg-exp" hint="Observation time or text length: the model then describes rates."><Select id="rg-exp" value={s.exposure} onChange={(exposure) => patch({ exposure })} options={variableOptions(ds, "number", "none (plain counts)").filter((o) => o.value !== s.outcome)} /></Field>}
          {s.family === "binomial" && <Field label="Number of trials" htmlFor="rg-trials"><Select id="rg-trials" value={s.trials} onChange={(trials) => patch({ trials })} options={variableOptions(ds, "number", "choose …").filter((o) => o.value !== s.outcome)} /></Field>}
          <Field label="Predictors (fixed effects)">
            <CheckList options={all.filter((o) => o.value !== s.outcome && o.value !== s.exposure && o.value !== s.trials)} selected={s.predictors} onChange={(predictors) => patch({ predictors })} />
          </Field>
          {numericPredictors.length > 0 && (
            <Field label="Treat these numbers as categories">
              <CheckList options={numericPredictors.map((p) => ({ value: p, label: p }))} selected={s.asCategory} onChange={(asCategory) => patch({ asCategory })} />
            </Field>
          )}
          {s.predictors.length >= 2 && (
            <div className="field-row" style={{ marginTop: 9 }}>
              <Field label="Interaction of" htmlFor="rg-ia"><Select id="rg-ia" value={s.interactionA} onChange={(interactionA) => patch({ interactionA })} options={[{ value: "", label: "none" }, ...s.predictors.map((p) => ({ value: p, label: p }))]} /></Field>
              <Field label="with" htmlFor="rg-ib"><Select id="rg-ib" value={s.interactionB} onChange={(interactionB) => patch({ interactionB })} options={[{ value: "", label: "none" }, ...s.predictors.filter((p) => p !== s.interactionA).map((p) => ({ value: p, label: p }))]} /></Field>
            </div>
          )}
          <Field label="Grouping variables (random intercepts)" hint="Whatever the rows are nested in: speaker, file, dyad, item …">
            <CheckList options={groupings.filter((o) => o.value !== s.outcome && !s.predictors.includes(o.value))} selected={s.random} onChange={(random) => patch({ random })} />
          </Field>
          <details style={{ marginTop: 9 }}>
            <summary className="muted" style={{ cursor: "pointer" }}>Sampling</summary>
            <div className="field-row" style={{ marginTop: 8 }}>
              <Field label="Chains" htmlFor="rg-chains"><NumberField id="rg-chains" value={s.chains} min={1} max={8} step={1} onChange={(v) => patch({ chains: Math.round(v) })} /></Field>
              <Field label="Draws per chain" htmlFor="rg-samples"><NumberField id="rg-samples" value={s.samples} min={100} max={20000} step={500} onChange={(v) => patch({ samples: Math.round(v) })} /></Field>
            </div>
            <Field label="Warm-up iterations" htmlFor="rg-warm"><NumberField id="rg-warm" value={s.warmup} min={100} max={10000} step={250} onChange={(v) => patch({ warmup: Math.round(v) })} /></Field>
            <div style={{ marginTop: 9 }}><Toggle id="rg-bridge" checked={s.bridge} onChange={(bridge) => patch({ bridge })}>Marginal likelihood (for Bayes factors between models)</Toggle></div>
          </details>
          <div className="callout" style={{ marginTop: 12 }}><div className="mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>{formula}</div></div>
          <div className="row" style={{ marginTop: 10 }}>
            {running ? <Button onClick={() => handle.current?.cancel()}>Cancel</Button> : <Button kind="primary" icon="play" onClick={run} disabled={!s.outcome}>Fit the model</Button>}
          </div>
          {running && (
            <div style={{ marginTop: 10 }}>
              <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(running.fraction * 100)}><div style={{ width: `${Math.round(running.fraction * 100)}%` }} /></div>
              <div className="faint" style={{ marginTop: 4 }}>{running.phase} … {Math.round(running.fraction * 100)}%</div>
            </div>
          )}
          {error && <div style={{ marginTop: 10 }}><Callout kind="critical">{error}</Callout></div>}
        </Card>
        <MethodNote refs={["Hoffman & Gelman (2014) J Mach Learn Res 15", "Vehtari, Gelman, Simpson, Carpenter & Bürkner (2021) Bayesian Anal 16", "Winter & Bürkner (2021) Lang Linguist Compass 15", "Vasishth, Nicenboim, Beckman, Li & Kong (2018) J Phon 71", "Gronau et al. (2017) J Math Psychol 81", "Kruschke (2018) Adv Methods Pract Psychol Sci 1"]}>
          <p>
            A regression with random intercepts for every grouping variable — the right tool when annotations come from several speakers or recordings. The posterior is sampled with the No-U-Turn sampler (the algorithm behind Stan),
            in several chains that must agree (R̂ close to 1).
          </p>
          <p>
            Priors are weakly informative and scale with the data: coefficients of standardised predictors ~ Normal(0, 2.5 · SD of the outcome), or Normal(0, 2.5) on the link scale for counts and proportions; standard deviations ~
            Exponential.
          </p>
          <p>
            For each coefficient the table gives the probability of direction, the share of the posterior inside a region of practical equivalence around zero, and a Bayes factor against “no effect” (Savage–Dickey density ratio).
            Whole models are compared by their marginal likelihood (bridge sampling) and by WAIC.
          </p>
        </MethodNote>
      </div>
      <div className="stack">
        {models.length === 0 || !model ? (
          <Empty title="Specify a model and fit it">
            Choose the outcome, the predictors and — if rows are nested in speakers or files — the grouping variables. Fitting takes from a few seconds to a few minutes.
          </Empty>
        ) : (
          <ModelResult
            model={model}
            models={models}
            onSelect={setSelectedId}
            onRemove={(id) => {
              setModels((prev) => prev.filter((m) => m.id !== id));
              if (selectedId === id) setSelectedId(undefined);
            }}
          />
        )}
      </div>
    </div>
  );
}

function ModelResult({ model, models, onSelect, onRemove }: { model: StoredModel; models: StoredModel[]; onSelect: (id: number) => void; onRemove: (id: number) => void }) {
  const fit = model.fit;
  const d = fit.diagnostics;
  const link = FAMILY_INFO[fit.family].link;
  const ratio = link === "log" || link === "logit";
  const coefs = fit.summaries.filter((p) => p.kind === "coefficient");
  const others = fit.summaries.filter((p) => p.kind !== "coefficient");
  const effects = useMemo(() => {
    const first = fit.groupEffects[0]?.term;
    return fit.groupEffects.filter((e) => e.term === first).sort((a, b) => a.mean - b.mean).slice(0, 60);
  }, [fit]);
  const ppc = useMemo(() => ppcMarks(fit), [fit]);
  const reference = models[0]!;
  const sameRows = models.every((m) => m.rowsUsed === reference.rowsUsed && m.spec.outcome === reference.spec.outcome);
  const best = models.reduce((a, b) => (b.fit.waic.elpd > a.fit.waic.elpd ? b : a), models[0]!);
  const ok = d.maxRhat <= 1.01 && d.divergences === 0 && d.minEss >= 400;

  return (
    <>
      <Card
        title={model.name}
        sub={<span className="mono">{model.formula}</span>}
        actions={models.length > 1 ? <Select value={String(model.id)} onChange={(v) => onSelect(Number(v))} options={models.map((m) => ({ value: String(m.id), label: `${m.name}: ${m.formula}` }))} /> : undefined}
      >
        <div className="row">
          <span className="chip">{FAMILY_INFO[fit.family].label}</span>
          <span className="chip">{model.rowsUsed.toLocaleString("en-US")} rows{model.rowsDropped ? ` (${model.rowsDropped} left out)` : ""}</span>
          <span className="chip">{fit.chains} chains × {fit.drawsPerChain} draws</span>
          <span className={`chip ${d.maxRhat <= 1.01 ? "good" : "critical"}`}>R̂ ≤ {fmt(d.maxRhat, 3)}</span>
          <span className={`chip ${d.minEss >= 400 ? "good" : "warning"}`}>ESS ≥ {Math.round(d.minEss)}</span>
          <span className={`chip ${d.divergences === 0 ? "good" : "critical"}`}>{d.divergences} divergent</span>
          <span className="chip">{fmt(fit.seconds, 2)} s</span>
          <span className="spacer" />
          <Button small kind="ghost" icon="trash" onClick={() => onRemove(model.id)}>Remove</Button>
        </div>
        {!ok && (
          <div style={{ marginTop: 10 }}>
            <Callout kind="warning">
              The sampler reports problems, so treat the numbers with caution.
              {d.maxRhat > 1.01 && " The chains have not fully converged (R̂ above 1.01): run more warm-up iterations and draws."}
              {d.minEss < 400 && " Some estimates rest on few effective draws: run more draws per chain."}
              {d.divergences > 0 && " Divergent transitions point to a posterior that is hard to explore, often because a grouping variable has very few levels or the model is too complex for the data."}
            </Callout>
          </div>
        )}
      </Card>

      <Card title="Effects" sub={ratio ? `Estimates are on the ${link} scale; “ratio” is exp(estimate): ${link === "log" ? "a rate ratio" : "an odds ratio"}.` : "Estimates are in the units of the outcome."} flush>
        <DataTable<ParamSummary>
          rows={[...fit.summaries.filter((p) => p.kind === "intercept"), ...coefs]}
          csvName={`${model.name}_effects`}
          maxHeight={360}
          columns={[
            { key: "name", header: "Term", value: (p) => p.name },
            { key: "mean", header: "Estimate", value: (p) => p.mean, numeric: true },
            { key: "sd", header: "SD", value: (p) => p.sd, numeric: true },
            { key: "ci", header: "95% CrI", value: (p) => p.ci[0], render: (p) => `${fmt(p.ci[0])} – ${fmt(p.ci[1])}`, numeric: true },
            ...(ratio ? [{ key: "ratio", header: "Ratio", value: (p: ParamSummary) => Math.exp(p.median), numeric: true, title: "exp(median)" }] : []),
            { key: "pd", header: "P(direction)", value: (p) => p.pd, render: (p) => (p.kind === "coefficient" ? pct(p.pd) : ""), numeric: true, title: "Posterior probability that the effect has the sign of its estimate" },
            { key: "bf", header: "BF₁₀", value: (p) => p.logBf10 ?? NaN, render: (p) => (p.logBf10 === undefined ? "" : `${p.bfMethod === "normal-tail" ? "≈ " : ""}${fmtBf(p.logBf10)}`), numeric: true, title: "Savage–Dickey Bayes factor against an effect of zero (≈: extrapolated from the tail)" },
            { key: "rope", header: "In ROPE", value: (p) => p.rope ?? NaN, render: (p) => (p.rope === undefined ? "" : pct(p.rope)), numeric: true, title: "Share of the posterior inside the region of practical equivalence around zero" },
            { key: "rhat", header: "R̂", value: (p) => p.rhat, numeric: true, digits: 3 },
            { key: "ess", header: "ESS", value: (p) => p.essBulk, render: (p) => String(Math.round(p.essBulk)), numeric: true },
          ]}
        />
      </Card>

      <div className="cols-2">
        {coefs.length > 0 && (
          <ChartCard title="Effects with 95% credible intervals" sub="Dot: posterior median." table={{ columns: ["term", "median", "lower", "upper"], rows: coefs.map((p) => [p.name, p.median, p.ci[0], p.ci[1]]) }}>
            <XYChart
              height={Math.max(150, 56 + coefs.length * 26)}
              x={{ type: "linear", label: `effect${ratio ? ` (${link} scale)` : ""}`, grid: true }}
              y={{ type: "band", domain: coefs.map((p) => p.name), padding: 0.5 }}
              marks={[
                { type: "rule", x: 0, color: "var(--text-2)" },
                { type: "interval", horizontal: true, data: coefs.map((p) => ({ x: p.name, lo: p.ci[0], hi: p.ci[1] })), width: 2, cap: true },
                { type: "dot", r: 5, data: coefs.map((p) => ({ x: p.median, y: p.name, tip: { title: p.name, rows: [["median", fmt(p.median)], ["95% credible interval", `${fmt(p.ci[0])} – ${fmt(p.ci[1])}`], ["BF₁₀", p.logBf10 === undefined ? "–" : fmtBf(p.logBf10)]] } })) },
              ]}
              ariaLabel="Posterior medians and credible intervals of the effects"
            />
          </ChartCard>
        )}
        <ChartCard title="Does the model reproduce the data?" sub="Thick line: observed outcome. Thin lines: data sets simulated from the fitted model.">
          <XYChart
            height={240}
            x={{ type: "linear", label: model.spec.outcome, nice: false }}
            y={{ type: "linear", zero: true, label: ppc.discrete ? "share" : "density" }}
            legend={[{ label: "observed", color: "var(--text)", kind: "line" }, { label: "simulated", color: "var(--series-1)", kind: "line" }]}
            marks={ppc.marks}
            ariaLabel="Posterior predictive check: observed and simulated distributions of the outcome"
          />
        </ChartCard>
      </div>

      {others.length > 0 && (
        <div className="cols-2">
          <Card title="Variation" sub="Standard deviations between groups and of the residuals." flush>
            <DataTable<ParamSummary>
              rows={others.filter((p) => p.kind !== "intercept")}
              maxHeight={240}
              columns={[
                { key: "name", header: "Parameter", value: (p) => p.name },
                { key: "median", header: "Median", value: (p) => p.median, numeric: true },
                { key: "ci", header: "95% CrI", value: (p) => p.ci[0], render: (p) => `${fmt(p.ci[0])} – ${fmt(p.ci[1])}`, numeric: true },
                { key: "rhat", header: "R̂", value: (p) => p.rhat, numeric: true, digits: 3 },
                { key: "ess", header: "ESS", value: (p) => p.essBulk, render: (p) => String(Math.round(p.essBulk)), numeric: true },
              ]}
            />
          </Card>
          {effects.length > 0 && (
            <ChartCard title={`Groups: ${effects[0]!.term}`} sub="Deviation of each group from the overall level, with 95% credible interval." table={{ columns: [effects[0]!.term, "mean", "lower", "upper"], rows: effects.map((e) => [e.level, e.mean, e.ci[0], e.ci[1]]) }}>
              <XYChart
                height={Math.max(160, 50 + effects.length * 17)}
                x={{ type: "linear", label: "deviation", grid: true }}
                y={{ type: "band", domain: effects.map((e) => e.level), padding: 0.5 }}
                marks={[
                  { type: "rule", x: 0, color: "var(--text-2)" },
                  { type: "interval", horizontal: true, data: effects.map((e) => ({ x: e.level, lo: e.ci[0], hi: e.ci[1] })) },
                  { type: "dot", data: effects.map((e) => ({ x: e.mean, y: e.level, tip: { title: e.level, rows: [["deviation", fmt(e.mean)]] } })) },
                ]}
                ariaLabel="Estimated deviation of each group"
              />
            </ChartCard>
          )}
        </div>
      )}

      {models.length > 1 && (
        <Card title="Model comparison" sub={`Bayes factors are relative to ${reference.name}; Δ elpd is relative to the model with the best predictive accuracy.`} flush>
          {!sameRows && <div style={{ padding: "0 14px 8px" }}><Callout kind="warning">These models were fitted to different rows or outcomes, so they cannot be compared. This usually happens when a predictor has missing values.</Callout></div>}
          <DataTable<StoredModel>
            rows={models}
            maxHeight={260}
            onRowClick={(m) => onSelect(m.id)}
            selected={(m) => m.id === model.id}
            columns={[
              { key: "name", header: "Model", value: (m) => m.name },
              { key: "formula", header: "Formula", value: (m) => m.formula },
              { key: "lml", header: "ln marginal likelihood", value: (m) => m.fit.bridge?.logMarginal ?? NaN, numeric: true, digits: 5 },
              { key: "bf", header: `BF vs. ${reference.name}`, value: (m) => (m.fit.bridge && reference.fit.bridge ? m.fit.bridge.logMarginal - reference.fit.bridge.logMarginal : NaN), render: (m) => (m.fit.bridge && reference.fit.bridge && sameRows ? fmtBf(m.fit.bridge.logMarginal - reference.fit.bridge.logMarginal) : "–"), numeric: true },
              { key: "cv", header: "± error", value: (m) => m.fit.bridge?.cv ?? NaN, render: (m) => (m.fit.bridge ? pct(m.fit.bridge.cv, 0) : "–"), numeric: true, title: "Approximate relative error of the marginal likelihood estimate" },
              { key: "waic", header: "WAIC", value: (m) => m.fit.waic.waic, numeric: true, digits: 5 },
              { key: "delta", header: "Δ elpd (± SE)", value: (m) => m.fit.waic.elpd - best.fit.waic.elpd, render: (m) => { if (m === best || !sameRows) return m === best ? "best" : "–"; const c = compareWaic(m.fit.waic, best.fit.waic); return `${fmt(c.elpdDiff, 3)} (± ${fmt(c.se, 2)})`; }, numeric: true },
            ]}
          />
        </Card>
      )}
    </>
  );
}

/** Observed and simulated distributions of the outcome, as lines. */
function ppcMarks(fit: GlmmFit): { marks: Mark[]; discrete: boolean } {
  const obs = fit.ppc.observed;
  const discrete = fit.family === "poisson" || fit.family === "negbinomial" || fit.family === "bernoulli" || fit.family === "binomial";
  const marks: Mark[] = [];
  const reps = fit.ppc.replicated.slice(0, 25);
  if (discrete) {
    const max = Math.min(Math.ceil(quantile(obs, 0.995)) + 2, 60);
    const share = (xs: Float64Array): [number, number][] => {
      const counts = new Array<number>(max + 1).fill(0);
      for (const v of xs) if (v >= 0 && v <= max) counts[Math.round(v)]!++;
      return counts.map((c, k) => [k, c / xs.length]);
    };
    for (const r of reps) marks.push({ type: "line", color: "var(--series-1)", width: 1, points: share(r) });
    marks.push({ type: "line", color: "var(--text)", width: 2.5, points: share(obs) });
  } else {
    const lo = quantile(obs, 0.005);
    const hi = quantile(obs, 0.995);
    const pad = (hi - lo) * 0.1 || 1;
    const o = kde(obs, { lo: lo - pad, hi: hi + pad, points: 120 });
    for (const r of reps) {
      const k = kde(r, { lo: lo - pad, hi: hi + pad, points: 120, bandwidth: o.bandwidth });
      marks.push({ type: "line", color: "var(--series-1)", width: 1, points: Array.from(k.x, (x, i) => [x, k.y[i]!] as [number, number]) });
    }
    marks.push({ type: "line", color: "var(--text)", width: 2.5, points: Array.from(o.x, (x, i) => [x, o.y[i]!] as [number, number]) });
  }
  return { marks, discrete };
}
