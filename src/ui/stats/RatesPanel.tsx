import { useMemo } from "react";
import { levelsOf, type Dataset } from "../../core/data/dataset.ts";
import { binomialTest, compareRates, multinomialTest, rateSummary } from "../../core/stats/bayes/proportions.ts";
import { betaLogPdf, normalPdf } from "../../core/stats/distributions.ts";
import { linspace } from "../../core/stats/describe.ts";
import { ChartCard } from "../charts/ChartCard.tsx";
import { XYChart } from "../charts/XYChart.tsx";
import { useViewState } from "../hooks.ts";
import { Callout, Card, Empty, Field, fmt, fmtBf, MethodNote, NumberField, pct, Segmented, Select } from "../kit.tsx";
import { BfHeadline, groupingOptions, numberOf, PosteriorChart, textOf, variableOptions } from "./common.tsx";

type Mode = "rates" | "proportion" | "distribution";

export function RatesPanel({ ds }: { ds: Dataset }) {
  const [mode, setMode] = useViewState<Mode>(`stats.rates.mode.${ds.id}`, "rates");
  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Counts, proportions and rates">
          <Field label="Question">
            <Segmented value={mode} onChange={setMode} options={[{ value: "rates", label: "Compare rates" }, { value: "proportion", label: "One proportion" }, { value: "distribution", label: "Distribution" }]} />
          </Field>
          {mode === "rates" && <RatesSettings ds={ds} />}
          {mode === "proportion" && <ProportionSettings ds={ds} />}
          {mode === "distribution" && <DistributionSettings ds={ds} />}
        </Card>
        <MethodNote refs={["Jeffreys (1961) Theory of Probability", "Kass & Vaidyanathan (1992) J R Stat Soc B 54", "Wagenmakers et al. (2018) Psychon Bull Rev 25"]}>
          <p>
            <strong>Compare rates</strong>: events per unit of exposure (for example gestures per minute) in two groups. Given the total number of events, the split between the groups is binomial; the test puts a normal prior on the
            log of the rate ratio. With more than two groups, the counts are tested against the shares expected from the exposures.
          </p>
          <p>
            <strong>One proportion</strong>: H₀: the proportion equals the test value, H₁: it follows a Beta prior. <strong>Distribution</strong>: are the categories of a variable equally frequent, or as frequent as expected?
          </p>
          <p>These tests pool the counts and treat events as independent. If events cluster within speakers, compare one rate per speaker with a t-test, or fit a Poisson multilevel model.</p>
        </MethodNote>
      </div>
      <div className="stack">
        {mode === "rates" && <RatesResult ds={ds} />}
        {mode === "proportion" && <ProportionResult ds={ds} />}
        {mode === "distribution" && <DistributionResult ds={ds} />}
      </div>
    </div>
  );
}

// ---- rates ------------------------------------------------------------------------------------

function useRatesSettings(ds: Dataset) {
  const numeric = variableOptions(ds, "number");
  const count = useViewState(`stats.rates.count.${ds.id}`, numeric.find((o) => /^(n|count|events|instances)$/i.test(o.value))?.value ?? numeric[0]?.value ?? "");
  const exposure = useViewState(`stats.rates.exp.${ds.id}`, numeric.find((o) => /min|dur|exposure|observed|tokens/i.test(o.value))?.value ?? "");
  const group = useViewState(`stats.rates.group.${ds.id}`, groupingOptions(ds)[0]?.value ?? "");
  const sd = useViewState(`stats.rates.sd.${ds.id}`, 1);
  return { count, exposure, group, sd };
}

function RatesSettings({ ds }: { ds: Dataset }) {
  const { count, exposure, group, sd } = useRatesSettings(ds);
  return (
    <>
      <Field label="Number of events" htmlFor="ra-count"><Select id="ra-count" value={count[0]} onChange={count[1]} options={variableOptions(ds, "number")} /></Field>
      <Field label="Exposure" htmlFor="ra-exp" hint="Observation time, number of words … whatever the events are counted per."><Select id="ra-exp" value={exposure[0]} onChange={exposure[1]} options={variableOptions(ds, "number", "choose …")} /></Field>
      <Field label="Groups defined by" htmlFor="ra-group"><Select id="ra-group" value={group[0]} onChange={group[1]} options={groupingOptions(ds)} /></Field>
      <Field label="Prior SD of the log rate ratio" htmlFor="ra-sd" hint="1 means: ratios between about 1/7 and 7 are plausible."><NumberField id="ra-sd" value={sd[0]} min={0.05} max={10} step={0.25} onChange={sd[1]} /></Field>
    </>
  );
}

function RatesResult({ ds }: { ds: Dataset }) {
  const { count, exposure, group, sd } = useRatesSettings(ds);
  const res = useMemo(() => {
    if (!count[0] || !exposure[0] || !group[0]) return undefined;
    const acc = new Map<string, { k: number; t: number; rows: number }>();
    for (let i = 0; i < ds.rowCount; i++) {
      const g = textOf(ds, group[0], i);
      const k = numberOf(ds, count[0], i);
      const t = numberOf(ds, exposure[0], i);
      if (g === "" || !Number.isFinite(k) || !(t > 0) || k < 0) continue;
      const e = acc.get(g) ?? { k: 0, t: 0, rows: 0 };
      e.k += k;
      e.t += t;
      e.rows++;
      acc.set(g, e);
    }
    const levels = levelsOf([...acc.keys()]);
    if (levels.length < 2) return { error: "The grouping variable needs at least two groups with a positive exposure." };
    const groups = levels.map((l) => ({ label: l, ...acc.get(l)!, summary: rateSummary(Math.round(acc.get(l)!.k), acc.get(l)!.t) }));
    if (levels.length === 2) return { groups, two: compareRates(Math.round(groups[0]!.k), groups[0]!.t, Math.round(groups[1]!.k), groups[1]!.t, sd[0]) };
    return { groups, multi: multinomialTest(groups.map((g) => Math.round(g.k)), groups.map((g) => g.t)) };
  }, [ds, count[0], exposure[0], group[0], sd[0]]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!res) return <Empty title="Choose the count, the exposure and the grouping variable" />;
  if ("error" in res) return <Callout kind="warning">{res.error}</Callout>;
  const [a, b] = res.groups;
  return (
    <>
      <Card title={`${count[0]} per ${exposure[0]}, by ${group[0]}`}>
        {res.two && a && b ? (
          <>
            <BfHeadline logBf={res.two.logBf10} h1={`that the rates of ${a.label} and ${b.label} differ`} h0="that the rates are equal" />
            <p className="muted" style={{ marginTop: 8 }}>
              Rate ratio {a.label} / {b.label}: posterior median {fmt(res.two.ratio.median, 3)}, 95% credible interval {fmt(res.two.ratio.ci[0], 3)} to {fmt(res.two.ratio.ci[1], 3)}; probability that {a.label} has the higher rate:{" "}
              {fmt(res.two.pGreater, 3)}. One-sided: BF₊₀ = {fmtBf(res.two.logBfPlus0)} ({a.label} higher), BF₋₀ = {fmtBf(res.two.logBfMinus0)} ({a.label} lower).
            </p>
          </>
        ) : res.multi ? (
          <BfHeadline logBf={res.multi.logBf10} h1="that the rates differ between the groups" h0="that all groups have the same rate" />
        ) : null}
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="data">
            <thead><tr><th>{group[0]}</th><th className="n">Rows</th><th className="n">Events</th><th className="n">Exposure</th><th className="n">Rate</th><th className="n">95% CrI</th></tr></thead>
            <tbody>
              {res.groups.map((g) => <tr key={g.label}><td>{g.label}</td><td className="n">{g.rows}</td><td className="n">{fmt(g.k)}</td><td className="n">{fmt(g.t)}</td><td className="n">{fmt(g.summary.rate)}</td><td className="n">{fmt(g.summary.ci[0])} – {fmt(g.summary.ci[1])}</td></tr>)}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="cols-2">
        <ChartCard title="Rates" sub="Posterior median with 95% credible interval (Jeffreys prior)." table={{ columns: [group[0], "rate", "lower", "upper"], rows: res.groups.map((g) => [g.label, g.summary.rate, g.summary.ci[0], g.summary.ci[1]]) }}>
          <XYChart
            height={220}
            x={{ type: "band", domain: res.groups.map((g) => g.label), label: group[0], padding: 0.5 }}
            y={{ type: "linear", zero: true, label: `${count[0]} per ${exposure[0]}` }}
            marks={[
              { type: "interval", data: res.groups.map((g) => ({ x: g.label, lo: g.summary.ci[0], hi: g.summary.ci[1] })), cap: true, width: 2 },
              { type: "dot", r: 5, data: res.groups.map((g) => ({ x: g.label, y: g.summary.median, tip: { title: g.label, rows: [["rate", fmt(g.summary.rate)], ["events", fmt(g.k)], ["exposure", fmt(g.t)]] } })) },
            ]}
            ariaLabel="Event rates by group with credible intervals"
          />
        </ChartCard>
        {res.two && a && b && (
          <ChartCard title="Log rate ratio: prior and posterior" sub={`ln(${a.label} / ${b.label}); 0 means equal rates.`}>
            <PosteriorChart x={res.two.logRatio.x} posterior={res.two.logRatio.density} prior={(v) => normalPdf(v, 0, sd[0])} ci={[Math.log(res.two.ratio.ci[0]), Math.log(res.two.ratio.ci[1])]} xLabel="log rate ratio" height={220} />
          </ChartCard>
        )}
      </div>
    </>
  );
}

// ---- one proportion ---------------------------------------------------------------------------

function useProportionSettings(ds: Dataset) {
  const cats = groupingOptions(ds);
  const variable = useViewState(`stats.prop.var.${ds.id}`, cats[0]?.value ?? "");
  const level = useViewState(`stats.prop.level.${ds.id}`, "");
  const theta0 = useViewState(`stats.prop.theta.${ds.id}`, 0.5);
  return { variable, level, theta0 };
}

function levelCounts(ds: Dataset, variable: string): { levels: string[]; counts: number[]; n: number } {
  const acc = new Map<string, number>();
  for (let i = 0; i < ds.rowCount; i++) {
    const v = textOf(ds, variable, i);
    if (v !== "") acc.set(v, (acc.get(v) ?? 0) + 1);
  }
  const levels = levelsOf([...acc.keys()]);
  const counts = levels.map((l) => acc.get(l)!);
  return { levels, counts, n: counts.reduce((a, b) => a + b, 0) };
}

function ProportionSettings({ ds }: { ds: Dataset }) {
  const { variable, level, theta0 } = useProportionSettings(ds);
  const { levels } = useMemo(() => levelCounts(ds, variable[0]), [ds, variable[0]]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Field label="Variable" htmlFor="pr-var"><Select id="pr-var" value={variable[0]} onChange={variable[1]} options={groupingOptions(ds)} /></Field>
      <Field label="Category of interest" htmlFor="pr-level"><Select id="pr-level" value={levels.includes(level[0]) ? level[0] : levels[0] ?? ""} onChange={level[1]} options={levels.map((l) => ({ value: l, label: l }))} /></Field>
      <Field label="Test value" htmlFor="pr-theta" hint="The proportion under the null hypothesis."><NumberField id="pr-theta" value={theta0[0]} min={0.001} max={0.999} step={0.05} onChange={theta0[1]} /></Field>
    </>
  );
}

function ProportionResult({ ds }: { ds: Dataset }) {
  const { variable, level, theta0 } = useProportionSettings(ds);
  const res = useMemo(() => {
    if (!variable[0]) return undefined;
    const lc = levelCounts(ds, variable[0]);
    if (lc.n === 0) return undefined;
    const lv = lc.levels.includes(level[0]) ? level[0] : lc.levels[0]!;
    const k = lc.counts[lc.levels.indexOf(lv)]!;
    const test = binomialTest(k, lc.n, theta0[0]);
    const x = linspace(0.0005, 0.9995, 800);
    const density = x.map((v) => Math.exp(betaLogPdf(v, test.posterior.a, test.posterior.b)));
    return { lv, k, n: lc.n, test, x, density };
  }, [ds, variable[0], level[0], theta0[0]]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!res) return <Empty title="Choose a categorical variable" />;
  return (
    <>
      <Card title={`Proportion of “${res.lv}” in ${variable[0]}`} sub={`${res.k} of ${res.n} (${pct(res.k / res.n)})`}>
        <BfHeadline logBf={res.test.logBf10} h1={`that the proportion differs from ${theta0[0]}`} h0={`that the proportion is ${theta0[0]}`} />
        <p className="muted" style={{ marginTop: 8 }}>
          Posterior median {fmt(res.test.posterior.median, 3)}, 95% credible interval {fmt(res.test.posterior.ci[0], 3)} to {fmt(res.test.posterior.ci[1], 3)} (uniform prior). One-sided: BF₊₀ = {fmtBf(res.test.logBfPlus0)} (larger), BF₋₀ ={" "}
          {fmtBf(res.test.logBfMinus0)} (smaller).
        </p>
      </Card>
      <ChartCard title="Proportion: prior and posterior">
        <PosteriorChart x={res.x} posterior={res.density} prior={() => 1} ci={res.test.posterior.ci} xLabel="proportion" testValue={theta0[0]} />
      </ChartCard>
    </>
  );
}

// ---- distribution over categories ---------------------------------------------------------------

function DistributionSettings({ ds }: { ds: Dataset }) {
  const variable = useViewState(`stats.dist.var.${ds.id}`, groupingOptions(ds)[0]?.value ?? "");
  return <Field label="Variable" htmlFor="di-var" hint="Tests whether all categories are equally frequent."><Select id="di-var" value={variable[0]} onChange={variable[1]} options={groupingOptions(ds)} /></Field>;
}

function DistributionResult({ ds }: { ds: Dataset }) {
  const [variable] = useViewState(`stats.dist.var.${ds.id}`, groupingOptions(ds)[0]?.value ?? "");
  const res = useMemo(() => {
    if (!variable) return undefined;
    const lc = levelCounts(ds, variable);
    if (lc.levels.length < 2) return undefined;
    return { ...lc, test: multinomialTest(lc.counts) };
  }, [ds, variable]);
  if (!res) return <Empty title="Choose a variable with at least two categories" />;
  return (
    <>
      <Card title={`Categories of ${variable}`} sub={`${res.n} cases in ${res.levels.length} categories`}>
        <BfHeadline logBf={res.test.logBf10} h1="that the categories are not equally frequent" h0="that all categories are equally frequent" />
      </Card>
      <ChartCard title="Share of each category" sub="Posterior median with 95% credible interval; line: equal shares." table={{ columns: [variable, "count", "share", "lower", "upper"], rows: res.levels.map((l, i) => [l, res.counts[i]!, res.counts[i]! / res.n, res.test.posteriors[i]!.ci[0], res.test.posteriors[i]!.ci[1]]) }}>
        <XYChart
          height={Math.max(180, 50 + res.levels.length * 24)}
          x={{ type: "linear", zero: true, label: "share", format: (v) => `${Math.round(v * 100)}%`, grid: true }}
          y={{ type: "band", domain: res.levels, padding: 0.5 }}
          marks={[
            { type: "rule", x: 1 / res.levels.length, color: "var(--text-2)", dash: "5 4" },
            { type: "interval", horizontal: true, data: res.levels.map((l, i) => ({ x: l, lo: res.test.posteriors[i]!.ci[0], hi: res.test.posteriors[i]!.ci[1] })), width: 2 },
            { type: "dot", r: 5, data: res.levels.map((l, i) => ({ x: res.test.posteriors[i]!.median, y: l, tip: { title: l, rows: [["cases", String(res.counts[i]!)], ["share", pct(res.counts[i]! / res.n)]] } })) },
          ]}
          ariaLabel="Share of each category with credible intervals"
        />
      </ChartCard>
    </>
  );
}
