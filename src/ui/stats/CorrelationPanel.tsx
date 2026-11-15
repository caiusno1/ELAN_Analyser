import { useMemo } from "react";
import type { Dataset } from "../../core/data/dataset.ts";
import { correlationBayesFactors, correlationPosterior, correlationPriorLogPdf } from "../../core/stats/bayes/correlation.ts";
import type { Alternative } from "../../core/stats/bayes/ttest.ts";
import { mean, pearson } from "../../core/stats/describe.ts";
import { ChartCard } from "../charts/ChartCard.tsx";
import { XYChart } from "../charts/XYChart.tsx";
import { useViewState } from "../hooks.ts";
import { Callout, Card, Empty, Field, fmt, fmtBf, MethodNote, NumberField, Segmented, Select } from "../kit.tsx";
import { BfHeadline, defaultOutcome, DroppedNote, NestingNote, numberOf, PosteriorChart, textOf, variableOptions } from "./common.tsx";

export function CorrelationPanel({ ds }: { ds: Dataset }) {
  const numeric = variableOptions(ds, "number");
  const [x, setX] = useViewState(`stats.cor.x.${ds.id}`, defaultOutcome(ds, defaultOutcome(ds)));
  const [y, setY] = useViewState(`stats.cor.y.${ds.id}`, defaultOutcome(ds));
  const [kappa, setKappa] = useViewState(`stats.cor.kappa.${ds.id}`, 1);
  const [alternative, setAlternative] = useViewState<Alternative>(`stats.cor.alt.${ds.id}`, "two-sided");
  const labelCol = ds.columns.find((c) => c.type === "string")?.name;

  const res = useMemo(() => {
    if (!x || !y || x === y) return undefined;
    const xs: number[] = [];
    const ys: number[] = [];
    const names: string[] = [];
    let dropped = 0;
    for (let i = 0; i < ds.rowCount; i++) {
      const a = numberOf(ds, x, i);
      const b = numberOf(ds, y, i);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        xs.push(a);
        ys.push(b);
        names.push(labelCol ? textOf(ds, labelCol, i) : `row ${i + 1}`);
      } else dropped++;
    }
    const n = xs.length;
    if (n < 3) return { error: "The test needs at least three complete pairs of values." };
    const r = pearson(xs, ys);
    if (!Number.isFinite(r)) return { error: "One of the variables does not vary." };
    const bf = correlationBayesFactors(r, n, kappa);
    const post = correlationPosterior(r, n, kappa, alternative);
    // Least-squares line, for orientation only.
    const mx = mean(xs);
    const my = mean(ys);
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i]! - mx) * (ys[i]! - my);
      sxx += (xs[i]! - mx) ** 2;
    }
    const slope = sxy / sxx;
    return { xs, ys, names, n, r, bf, post, dropped, slope, intercept: my - slope * mx, xmin: Math.min(...xs), xmax: Math.max(...xs) };
  }, [ds, x, y, kappa, alternative, labelCol]);

  const label = alternative === "two-sided" ? "BF₁₀" : alternative === "greater" ? "BF₊₀" : "BF₋₀";
  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Bayesian correlation">
          <Field label="Variable X" htmlFor="co-x2"><Select id="co-x2" value={x} onChange={setX} options={numeric} /></Field>
          <Field label="Variable Y" htmlFor="co-y2"><Select id="co-y2" value={y} onChange={setY} options={numeric} /></Field>
          <Field label="Alternative hypothesis">
            <Segmented value={alternative} onChange={setAlternative} options={[{ value: "two-sided", label: "ρ ≠ 0" }, { value: "greater", label: "ρ > 0" }, { value: "less", label: "ρ < 0" }]} />
          </Field>
          <Field label="Prior width κ" htmlFor="co-kappa" hint="1 = every correlation between −1 and 1 equally likely; smaller values favour weak correlations.">
            <NumberField id="co-kappa" value={kappa} min={0.05} max={2} step={0.1} onChange={setKappa} />
          </Field>
        </Card>
        <MethodNote refs={["Jeffreys (1961) Theory of Probability", "Ly, Marsman & Wagenmakers (2018) Stat Neerl 72", "Wetzels & Wagenmakers (2012) Psychon Bull Rev 19"]}>
          <p>
            Pearson's correlation with H₀: ρ = 0 against H₁: ρ follows a stretched beta distribution of width κ on (−1, 1). The posterior of ρ is exact given n and the sample correlation.
          </p>
          <p>Pearson's r describes linear relations and is sensitive to outliers — look at the scatter plot. The pairs of values must be independent of each other.</p>
        </MethodNote>
      </div>
      <div className="stack">
        <NestingNote ds={ds} />
        {!res ? <Empty title="Choose two different numeric variables" /> : "error" in res ? <Callout kind="warning">{res.error}</Callout> : (
          <>
            <Card title={`${x} and ${y}`} sub={`r = ${fmt(res.r, 3)}, n = ${res.n}`}>
              <BfHeadline
                logBf={alternative === "two-sided" ? res.bf.logBf10 : alternative === "greater" ? res.bf.logBfPlus0 : res.bf.logBfMinus0}
                label={label}
                h1={alternative === "two-sided" ? "for a correlation" : alternative === "greater" ? "for a positive correlation" : "for a negative correlation"}
                h0="for no correlation"
              />
              <p className="muted" style={{ marginTop: 8 }}>
                Correlation ρ: posterior median {fmt(res.post.median, 3)}, 95% credible interval {fmt(res.post.ci[0], 3)} to {fmt(res.post.ci[1], 3)}.
                {alternative !== "two-sided" && ` Two-sided BF₁₀ = ${fmtBf(res.bf.logBf10)}.`}
              </p>
              <DroppedNote dropped={res.dropped} />
            </Card>
            <div className="cols-2">
              <ChartCard title="Scatter plot" sub="Line: least-squares fit." table={{ columns: ["case", x, y], rows: res.xs.slice(0, 500).map((v, i) => [res.names[i]!, v, res.ys[i]!]) }}>
                <XYChart
                  height={260}
                  x={{ type: "linear", label: x }}
                  y={{ type: "linear", label: y }}
                  marks={[
                    { type: "line", color: "var(--text-2)", width: 1.5, points: [[res.xmin, res.intercept + res.slope * res.xmin], [res.xmax, res.intercept + res.slope * res.xmax]] },
                    { type: "dot", r: 3.5, opacity: 0.8, data: res.xs.slice(0, 3000).map((v, i) => ({ x: v, y: res.ys[i]!, tip: { title: res.names[i]!, rows: [[x, fmt(v)], [y, fmt(res.ys[i]!)]] } })) },
                  ]}
                  ariaLabel={`Scatter plot of ${y} against ${x}`}
                />
              </ChartCard>
              <ChartCard title="Correlation: prior and posterior">
                <PosteriorChart
                  x={res.post.x}
                  posterior={res.post.density}
                  prior={(rho) => (alternative === "greater" && rho < 0) || (alternative === "less" && rho > 0) ? 0 : Math.exp(correlationPriorLogPdf(rho, kappa)) * (alternative === "two-sided" ? 1 : 2)}
                  ci={res.post.ci}
                  xLabel="correlation ρ"
                  height={260}
                />
              </ChartCard>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
