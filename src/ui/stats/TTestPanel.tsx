import { useMemo } from "react";
import type { Dataset } from "../../core/data/dataset.ts";
import { summarize } from "../../core/stats/describe.ts";
import { tInv } from "../../core/stats/distributions.ts";
import {
  effectPosterior, effectPriorPdf, oneSampleStats, pairedStats, tTestBayesFactors, tTestRobustness, tTestSequential, twoSampleStats,
  type Alternative, type EffectPrior, type TStatistic,
} from "../../core/stats/bayes/ttest.ts";
import { ChartCard } from "../charts/ChartCard.tsx";
import { GroupChart } from "../charts/GroupChart.tsx";
import { XYChart } from "../charts/XYChart.tsx";
import { useViewState } from "../hooks.ts";
import { Callout, Card, Empty, Field, fmt, fmtBf, MethodNote, NumberField, Segmented, Select } from "../kit.tsx";
import { bfAxis, BfHeadline, defaultGrouping, defaultOutcome, DroppedNote, groupingOptions, numberOf, numericValues, PosteriorChart, splitByGroup, variableOptions } from "./common.tsx";

type Design = "one" | "independent" | "paired";

interface Settings {
  design: Design;
  variable: string;
  group: string;
  levelA: string;
  levelB: string;
  variable2: string;
  testValue: number;
  scale: number;
  alternative: Alternative;
}

export function TTestPanel({ ds }: { ds: Dataset }) {
  const numeric = variableOptions(ds, "number");
  const groupings = groupingOptions(ds);
  const [s, setS] = useViewState<Settings>(`stats.ttest.${ds.id}`, {
    design: groupings.length ? "independent" : "one",
    variable: defaultOutcome(ds),
    group: defaultGrouping(ds),
    levelA: "",
    levelB: "",
    variable2: defaultOutcome(ds, defaultOutcome(ds)),
    testValue: 0,
    scale: 0.707,
    alternative: "two-sided",
  });
  const patch = (p: Partial<Settings>) => setS((prev) => ({ ...prev, ...p }));
  const prior: EffectPrior = useMemo(() => ({ family: "cauchy", location: 0, scale: s.scale }), [s.scale]);

  const data = useMemo(() => {
    if (!s.variable) return undefined;
    if (s.design === "one") {
      const { values, dropped } = numericValues(ds, s.variable);
      if (values.length < 2) return { error: "The test needs at least two values." };
      const stat = oneSampleStats(values, s.testValue);
      return { stat: stat as TStatistic, d: stat.d, dropped, groups: [{ label: s.variable, values }], sequential: { values, mu0: s.testValue }, labels: [s.variable, `the value ${s.testValue}`] };
    }
    if (s.design === "paired") {
      if (!s.variable2 || s.variable2 === s.variable) return { error: "Choose two different variables." };
      const a: number[] = [];
      const b: number[] = [];
      let dropped = 0;
      for (let i = 0; i < ds.rowCount; i++) {
        const x = numberOf(ds, s.variable, i);
        const y = numberOf(ds, s.variable2, i);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          a.push(x);
          b.push(y);
        } else dropped++;
      }
      if (a.length < 2) return { error: "The test needs at least two complete pairs." };
      const stat = pairedStats(a, b);
      return { stat: stat as TStatistic, d: stat.d, dropped, groups: [{ label: s.variable, values: a }, { label: s.variable2, values: b }], sequential: { values: a.map((v, i) => v - b[i]!), mu0: 0 }, labels: [s.variable, s.variable2] };
    }
    if (!s.group) return { error: "Choose a grouping variable." };
    const split = splitByGroup(ds, s.variable, s.group);
    if (split.groups.length < 2) return { error: "The grouping variable needs at least two groups with values." };
    const ga = split.groups.find((g) => g.label === s.levelA) ?? split.groups[0]!;
    const gb = split.groups.find((g) => g.label === s.levelB && g.label !== ga.label) ?? split.groups.find((g) => g.label !== ga.label)!;
    if (ga.values.length < 2 || gb.values.length < 2) return { error: "Each group needs at least two values." };
    const stat = twoSampleStats(ga.values, gb.values);
    // Sequential analysis follows the order of the rows in the table.
    const order = [...ga.rows.map((r, i) => ({ r, v: ga.values[i]!, g: 0 })), ...gb.rows.map((r, i) => ({ r, v: gb.values[i]!, g: 1 }))].sort((p, q) => p.r - q.r);
    return {
      stat: stat as TStatistic, d: stat.d, dropped: split.dropped, groups: [ga, gb], levels: split.groups.map((g) => g.label),
      sequential: { values: order.map((o) => o.v), groups: order.map((o) => o.g) }, labels: [ga.label, gb.label],
    };
  }, [ds, s.design, s.variable, s.variable2, s.group, s.levelA, s.levelB, s.testValue]);

  const result = useMemo(() => {
    if (!data || "error" in data || !Number.isFinite(data.stat.t)) return undefined;
    const bf = tTestBayesFactors(data.stat, prior);
    const post = effectPosterior(data.stat, prior, s.alternative);
    const scales = Array.from({ length: 40 }, (_, i) => 0.05 + (i * 1.95) / 39);
    const robust = tTestRobustness(data.stat, prior, s.alternative, scales);
    const seq = tTestSequential(data.sequential.values, prior, s.alternative, "groups" in data.sequential && data.sequential.groups ? { groups: data.sequential.groups } : { mu0: data.sequential.mu0 ?? 0 });
    const logBf = s.alternative === "two-sided" ? bf.logBf10 : s.alternative === "greater" ? bf.logBfPlus0 : bf.logBfMinus0;
    return { bf, post, scales, robust, seq, logBf };
  }, [data, prior, s.alternative]);

  const label = s.alternative === "two-sided" ? "BF₁₀" : s.alternative === "greater" ? "BF₊₀" : "BF₋₀";
  const [la, lb] = data && !("error" in data) ? data.labels : ["", ""];
  const direction = s.alternative === "greater" ? `that ${la} is larger than ${lb}` : s.alternative === "less" ? `that ${la} is smaller than ${lb}` : `for a difference between ${la} and ${lb}`;

  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Bayesian t-test">
          <Field label="Design">
            <Segmented value={s.design} onChange={(design) => patch({ design })} options={[{ value: "independent", label: "Two groups" }, { value: "paired", label: "Paired" }, { value: "one", label: "One sample" }]} />
          </Field>
          <Field label={s.design === "paired" ? "First variable" : "Variable"} htmlFor="tt-var"><Select id="tt-var" value={s.variable} onChange={(variable) => patch({ variable })} options={numeric} /></Field>
          {s.design === "paired" && <Field label="Second variable" htmlFor="tt-var2"><Select id="tt-var2" value={s.variable2} onChange={(variable2) => patch({ variable2 })} options={numeric} /></Field>}
          {s.design === "one" && <Field label="Test value" htmlFor="tt-mu"><NumberField id="tt-mu" value={s.testValue} onChange={(testValue) => patch({ testValue })} /></Field>}
          {s.design === "independent" && (
            <>
              <Field label="Groups defined by" htmlFor="tt-group"><Select id="tt-group" value={s.group} onChange={(group) => patch({ group, levelA: "", levelB: "" })} options={groupings} /></Field>
              {data && !("error" in data) && data.levels && data.levels.length > 2 && (
                <div className="field-row" style={{ marginTop: 9 }}>
                  <Field label="Group 1" htmlFor="tt-a"><Select id="tt-a" value={la} onChange={(levelA) => patch({ levelA })} options={data.levels.map((l) => ({ value: l, label: l }))} /></Field>
                  <Field label="Group 2" htmlFor="tt-b"><Select id="tt-b" value={lb} onChange={(levelB) => patch({ levelB })} options={data.levels.filter((l) => l !== la).map((l) => ({ value: l, label: l }))} /></Field>
                </div>
              )}
            </>
          )}
          <Field label="Alternative hypothesis">
            <Segmented value={s.alternative} onChange={(alternative) => patch({ alternative })} options={[{ value: "two-sided", label: "≠" }, { value: "greater", label: ">" }, { value: "less", label: "<" }]} />
          </Field>
          <Field label="Prior width (Cauchy scale)" htmlFor="tt-r" hint="0.707 is the usual default; smaller values expect smaller effects.">
            <NumberField id="tt-r" value={s.scale} min={0.01} max={5} step={0.1} onChange={(scale) => patch({ scale })} />
          </Field>
        </Card>
        <MethodNote refs={["Jeffreys (1961) Theory of Probability", "Rouder, Speckman, Sun, Morey & Iverson (2009) Psychon Bull Rev 16", "Morey & Rouder (2011) Psychol Methods 16", "Wagenmakers et al. (2018) Psychon Bull Rev 25"]}>
          <p>
            The test compares H₀: the standardised effect δ is zero, with H₁: δ follows a Cauchy distribution centred on zero with the chosen scale. The Bayes factor says how much better one hypothesis predicted the data than the
            other; it can also express evidence <em>for</em> the null hypothesis.
          </p>
          <p>The posterior of δ is shown with its median and 95% credible interval. The robustness plot repeats the test for other prior widths; the sequential plot shows how the evidence developed as rows were added.</p>
          <p>The test assumes independent observations. For annotations nested in speakers or files, aggregate to one value per speaker first, or use the multilevel model.</p>
        </MethodNote>
      </div>
      <div className="stack">
        {!data ? (
          <Empty title="Choose a variable" />
        ) : "error" in data ? (
          <Callout kind="warning">{data.error}</Callout>
        ) : !result ? (
          <Callout kind="warning">The values do not vary, so no test can be computed.</Callout>
        ) : (
          <>
            <Card title={s.design === "one" ? `${la} against ${s.testValue}` : `${la} against ${lb}`} sub={`t(${fmt(data.stat.df, 3)}) = ${fmt(data.stat.t, 3)}, Cohen's d = ${fmt(data.d, 3)}`}>
              <BfHeadline logBf={result.logBf} label={label} h1={direction} h0={s.design === "one" ? `that ${la} does not differ from ${s.testValue}` : `that ${la} and ${lb} do not differ`} />
              <p className="muted" style={{ marginTop: 8 }}>
                Standardised effect δ: posterior median {fmt(result.post.median, 3)}, 95% credible interval {fmt(result.post.ci[0], 3)} to {fmt(result.post.ci[1], 3)}
                {s.alternative === "two-sided" ? `; probability that δ > 0: ${fmt(result.post.pPositive, 3)}` : ""}.
                {s.alternative !== "two-sided" && ` Two-sided BF₁₀ = ${fmtBf(result.bf.logBf10)}.`}
              </p>
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table className="data">
                  <thead><tr><th>Group</th><th className="n">n</th><th className="n">Mean</th><th className="n">SD</th><th className="n">SE</th><th className="n">95% CrI of the mean</th></tr></thead>
                  <tbody>
                    {data.groups.map((g) => {
                      const sm = summarize(g.values);
                      const half = sm.n > 1 ? tInv(0.975, sm.n - 1) * sm.se : NaN;
                      return <tr key={g.label}><td>{g.label}</td><td className="n">{sm.n}</td><td className="n">{fmt(sm.mean)}</td><td className="n">{fmt(sm.sd)}</td><td className="n">{fmt(sm.se)}</td><td className="n">{fmt(sm.mean - half)} – {fmt(sm.mean + half)}</td></tr>;
                    })}
                  </tbody>
                </table>
              </div>
              <DroppedNote dropped={data.dropped} />
            </Card>
            <div className="cols-2">
              <ChartCard title="The data" sub="Black: mean with 95% credible interval.">
                <GroupChart groups={data.groups.map((g) => ({ label: g.label, values: g.values }))} yLabel={s.variable} />
              </ChartCard>
              <ChartCard title="Effect size: prior and posterior" sub="Dots mark the densities at δ = 0; their ratio is the Bayes factor.">
                <PosteriorChart x={result.post.x} posterior={result.post.density} prior={(d) => effectPriorPdf(prior, d, s.alternative)} ci={result.post.ci} xLabel="standardised effect δ" />
              </ChartCard>
              <ChartCard title="Robustness to the prior" sub="The Bayes factor for other prior widths." table={{ columns: ["prior width", label], rows: result.scales.map((r, i) => [r, Math.exp(result.robust[i]!)]) }}>
                <XYChart
                  height={220}
                  crosshair
                  x={{ type: "linear", label: "prior width (Cauchy scale)" }}
                  y={bfAxis(result.robust, label)}
                  marks={[
                    { type: "rule", y: 0, color: "var(--text-3)" },
                    { type: "line", color: "var(--series-1)", label, points: result.scales.map((r, i) => [r, result.robust[i]!] as [number, number]) },
                    { type: "dot", data: [{ x: s.scale, y: result.logBf, tip: { title: "Your prior", rows: [["width", fmt(s.scale)], [label, fmtBf(result.logBf)]] } }] },
                  ]}
                  ariaLabel="Bayes factor as a function of the prior width"
                />
              </ChartCard>
              <ChartCard title="Sequential analysis" sub="The Bayes factor after each additional row, in table order." table={{ columns: ["rows", label], rows: result.seq.map((p) => [p.n, Math.exp(p.logBf)]) }}>
                {result.seq.length >= 2 ? (
                  <XYChart
                    height={220}
                    crosshair
                    crosshairFormat={(v) => `after ${Math.round(v)} rows`}
                    x={{ type: "linear", label: "number of rows" }}
                    y={bfAxis(result.seq.map((p) => p.logBf), label)}
                    marks={[
                      { type: "rule", y: 0, color: "var(--text-3)" },
                      { type: "line", color: "var(--series-1)", label, points: result.seq.map((p) => [p.n, p.logBf] as [number, number]) },
                    ]}
                    ariaLabel="Bayes factor as rows are added"
                  />
                ) : <Empty title="Too few rows" />}
              </ChartCard>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
