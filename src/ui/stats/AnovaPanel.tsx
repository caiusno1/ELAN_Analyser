import { useMemo } from "react";
import type { Dataset } from "../../core/data/dataset.ts";
import { anovaLogBf10, oneWayStats, postHoc } from "../../core/stats/bayes/anova.ts";
import { ChartCard } from "../charts/ChartCard.tsx";
import { GroupChart } from "../charts/GroupChart.tsx";
import { useViewState } from "../hooks.ts";
import { Callout, Card, DataTable, Empty, Field, fmt, fmtBf, MethodNote, Select } from "../kit.tsx";
import { BfHeadline, defaultGrouping, defaultOutcome, DroppedNote, groupingOptions, NestingNote, splitByGroup, variableOptions } from "./common.tsx";

const SCALES = [
  { value: "0.5", label: "medium (0.5)" },
  { value: "0.707", label: "wide (0.707)" },
  { value: "1", label: "ultrawide (1)" },
];

export function AnovaPanel({ ds }: { ds: Dataset }) {
  const numeric = variableOptions(ds, "number");
  const groupings = groupingOptions(ds);
  const [variable, setVariable] = useViewState(`stats.anova.var.${ds.id}`, defaultOutcome(ds));
  const [group, setGroup] = useViewState(`stats.anova.group.${ds.id}`, defaultGrouping(ds, "several"));
  const [scale, setScale] = useViewState(`stats.anova.scale.${ds.id}`, "0.5");

  const res = useMemo(() => {
    if (!variable || !group) return undefined;
    const split = splitByGroup(ds, variable, group);
    const usable = split.groups.filter((g) => g.values.length >= 1);
    if (usable.length < 2) return { error: "The grouping variable needs at least two groups with values." };
    const n = usable.reduce((s, g) => s + g.values.length, 0);
    if (n <= usable.length) return { error: "There must be more observations than groups." };
    const stats = oneWayStats(usable.map((g) => g.values), usable.map((g) => g.label));
    if (!(stats.ssTotal > 0)) return { error: "The values do not vary." };
    return { stats, logBf: anovaLogBf10(stats, Number(scale)), post: usable.length > 2 ? postHoc(usable.map((g) => g.values), usable.map((g) => g.label)) : [], groups: usable, dropped: split.dropped };
  }, [ds, variable, group, scale]);

  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Bayesian ANOVA">
          <Field label="Variable" htmlFor="an-var"><Select id="an-var" value={variable} onChange={setVariable} options={numeric} /></Field>
          <Field label="Groups defined by" htmlFor="an-group"><Select id="an-group" value={group} onChange={setGroup} options={groupings} /></Field>
          <Field label="Prior on the effects" htmlFor="an-scale" hint="Scale of the Cauchy prior on standardised group effects.">
            <Select id="an-scale" value={scale} onChange={setScale} options={SCALES} />
          </Field>
        </Card>
        <MethodNote refs={["Rouder, Morey, Speckman & Province (2012) J Math Psychol 56", "Westfall, Johnson & Utts (1997) Biometrika 84"]}>
          <p>
            The Bayes factor compares a model in which the group means differ with one in which they are all equal. Standardised group effects get a multivariate Cauchy prior (the JZS prior); the result is exact also for groups of
            unequal size.
          </p>
          <p>
            The pairwise comparisons are default t-tests. Their posterior odds are corrected for multiplicity by fixing the prior probability that <em>no</em> groups differ at ½.
          </p>
          <p>Observations must be independent: use one value per speaker or file, or the multilevel model for nested data.</p>
        </MethodNote>
      </div>
      <div className="stack">
        <NestingNote ds={ds} />
        {!res ? <Empty title="Choose a variable and a grouping variable" /> : "error" in res ? <Callout kind="warning">{res.error}</Callout> : (
          <>
            <Card title={`${variable} by ${group}`} sub={`F(${res.stats.dfBetween}, ${res.stats.dfWithin}) = ${fmt(res.stats.f, 3)}, η² = ${fmt(res.stats.r2, 3)}`}>
              <BfHeadline logBf={res.logBf} h1={`that ${variable} differs between the groups`} h0="that the group means are equal" />
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table className="data">
                  <thead><tr><th>{group}</th><th className="n">n</th><th className="n">Mean</th><th className="n">SD</th><th className="n">95% CrI of the mean</th></tr></thead>
                  <tbody>
                    {res.stats.groups.map((g) => <tr key={g.label}><td>{g.label}</td><td className="n">{g.n}</td><td className="n">{fmt(g.mean)}</td><td className="n">{fmt(g.sd)}</td><td className="n">{fmt(g.ci[0])} – {fmt(g.ci[1])}</td></tr>)}
                  </tbody>
                </table>
              </div>
              <DroppedNote dropped={res.dropped} />
            </Card>
            <ChartCard title="The data" sub="Black: group mean with 95% credible interval.">
              <GroupChart groups={res.groups.map((g) => ({ label: g.label, values: g.values }))} yLabel={variable} xLabel={group} />
            </ChartCard>
            {res.post.length > 0 && (
              <Card title="Pairwise comparisons" sub="Default Cauchy t-tests; posterior odds corrected for multiple comparisons." flush>
                <DataTable
                  rows={res.post}
                  csvName="pairwise_comparisons"
                  columns={[
                    { key: "a", header: "Group", value: (r) => r.a },
                    { key: "b", header: "vs.", value: (r) => r.b },
                    { key: "diff", header: "Mean difference", value: (r) => r.meanDiff, numeric: true },
                    { key: "d", header: "Cohen's d", value: (r) => r.d, numeric: true, digits: 2 },
                    { key: "bf", header: "BF₁₀", value: (r) => r.logBf10, render: (r) => fmtBf(r.logBf10), numeric: true },
                    { key: "odds", header: "Posterior odds", value: (r) => r.logPosteriorOdds, render: (r) => fmtBf(r.logPosteriorOdds), numeric: true, title: `Prior odds ${fmt(res.post[0]!.priorOdds, 3)} × BF₁₀` },
                  ]}
                />
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
