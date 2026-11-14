import { useMemo } from "react";
import { levelsOf, type Dataset } from "../../core/data/dataset.ts";
import { contingencyLogBf10, cramersV, cramersVPosterior, oddsRatioPosterior, SCHEME_LABEL, type SamplingScheme } from "../../core/stats/bayes/contingency.ts";
import { ChartCard } from "../charts/ChartCard.tsx";
import { Heatmap } from "../charts/Heatmap.tsx";
import { useViewState } from "../hooks.ts";
import { Callout, Card, Empty, Field, fmt, MethodNote, NumberField, pct, Select } from "../kit.tsx";
import { BfHeadline, defaultGrouping, DroppedNote, groupingOptions, numberOf, textOf, variableOptions } from "./common.tsx";

export function ContingencyPanel({ ds }: { ds: Dataset }) {
  const cats = groupingOptions(ds);
  const [rowVar, setRowVar] = useViewState(`stats.ct.row.${ds.id}`, defaultGrouping(ds));
  const [colVar, setColVar] = useViewState(`stats.ct.col.${ds.id}`, cats.find((c) => c.value !== defaultGrouping(ds) && c.value === defaultGrouping(ds, "several"))?.value ?? cats.find((c) => c.value !== defaultGrouping(ds))?.value ?? "");
  const [countVar, setCountVar] = useViewState(`stats.ct.count.${ds.id}`, "");
  const [scheme, setScheme] = useViewState<SamplingScheme>(`stats.ct.scheme.${ds.id}`, "independentRows");
  const [a, setA] = useViewState(`stats.ct.a.${ds.id}`, 1);

  const res = useMemo(() => {
    if (!rowVar || !colVar || rowVar === colVar) return undefined;
    const cells = new Map<string, number>();
    const rs: string[] = [];
    const cs: string[] = [];
    let dropped = 0;
    for (let i = 0; i < ds.rowCount; i++) {
      const r = textOf(ds, rowVar, i);
      const c = textOf(ds, colVar, i);
      const w = countVar ? numberOf(ds, countVar, i) : 1;
      if (r === "" || c === "" || !Number.isFinite(w) || w < 0) {
        dropped++;
        continue;
      }
      rs.push(r);
      cs.push(c);
      cells.set(`${r}\u0001${c}`, (cells.get(`${r}\u0001${c}`) ?? 0) + w);
    }
    const rows = levelsOf(rs);
    const cols = levelsOf(cs);
    if (rows.length < 2 || cols.length < 2) return { error: "Both variables need at least two categories." };
    if (rows.length * cols.length > 600) return { error: "The table would have more than 600 cells. Choose variables with fewer categories." };
    const table = rows.map((r) => cols.map((c) => Math.round(cells.get(`${r}\u0001${c}`) ?? 0)));
    const n = table.flat().reduce((s, v) => s + v, 0);
    if (n === 0) return { error: "The table is empty." };
    return {
      rows, cols, table, n, dropped,
      logBf: contingencyLogBf10(table, scheme, a),
      v: cramersV(table),
      vPost: cramersVPosterior(table, a),
      or: rows.length === 2 && cols.length === 2 ? oddsRatioPosterior(table, a) : undefined,
    };
  }, [ds, rowVar, colVar, countVar, scheme, a]);

  return (
    <div className="view-grid">
      <div className="stack">
        <Card title="Bayesian contingency table">
          <Field label="Rows" htmlFor="ct-row"><Select id="ct-row" value={rowVar} onChange={setRowVar} options={cats} /></Field>
          <Field label="Columns" htmlFor="ct-col"><Select id="ct-col" value={colVar} onChange={setColVar} options={cats} /></Field>
          <Field label="Counts" htmlFor="ct-count" hint="If each row of the table already stands for several cases, choose the variable holding their number.">
            <Select id="ct-count" value={countVar} onChange={setCountVar} options={variableOptions(ds, "number", "one case per row")} />
          </Field>
          <Field label="How the data were collected" htmlFor="ct-scheme" hint="What was fixed before the data came in. This changes the Bayes factor slightly.">
            <Select id="ct-scheme" value={scheme} onChange={setScheme} options={(Object.keys(SCHEME_LABEL) as SamplingScheme[]).map((k) => ({ value: k, label: SCHEME_LABEL[k] }))} />
          </Field>
          <Field label="Prior concentration" htmlFor="ct-a" hint="1 = all cell probabilities equally likely beforehand.">
            <NumberField id="ct-a" value={a} min={1} max={100} step={0.5} onChange={setA} />
          </Field>
        </Card>
        <MethodNote refs={["Gunel & Dickey (1974) Biometrika 61", "Jamil, Ly, Morey, Love, Marsman & Wagenmakers (2017) Behav Res Methods 49"]}>
          <p>
            The Bayes factor compares “rows and columns are independent” with “they are associated”, using Dirichlet priors on the cell probabilities. Choose the sampling plan that describes the study: in most corpus work nothing was
            fixed in advance, or only the row totals (for example, the number of annotations per condition).
          </p>
          <p>Cramér's V measures the strength of the association from 0 to 1; for 2 × 2 tables the odds ratio is given as well. Every case must be an independent observation.</p>
        </MethodNote>
      </div>
      <div className="stack">
        {!res ? <Empty title="Choose two categorical variables" /> : "error" in res ? <Callout kind="warning">{res.error}</Callout> : (
          <>
            <Card title={`${rowVar} × ${colVar}`} sub={`${res.n.toLocaleString("en-US")} cases in ${res.rows.length} × ${res.cols.length} cells`}>
              <BfHeadline logBf={res.logBf} h1={`for an association between ${rowVar} and ${colVar}`} h0="for independence" />
              <p className="muted" style={{ marginTop: 8 }}>
                Cramér's V = {fmt(res.v, 3)}; posterior median {fmt(res.vPost.median, 3)}, 95% credible interval {fmt(res.vPost.ci[0], 3)} to {fmt(res.vPost.ci[1], 3)}.
                {res.or && (
                  <>
                    {" "}Odds ratio: posterior median {fmt(res.or.oddsRatio.median, 3)}, 95% credible interval {fmt(res.or.oddsRatio.ci[0], 3)} to {fmt(res.or.oddsRatio.ci[1], 3)}; probability that it exceeds 1: {fmt(res.or.pGreater1, 3)}.
                  </>
                )}
              </p>
              <DroppedNote dropped={res.dropped} />
            </Card>
            <ChartCard title="Share of each row" sub="Cell colour: share of the row total. Numbers: counts." table={{ columns: [rowVar, ...res.cols], rows: res.rows.map((r, i) => [r, ...res.table[i]!]) }}>
              <Heatmap
                rows={res.rows}
                cols={res.cols}
                values={res.table.map((row) => {
                  const t = row.reduce((s, v) => s + v, 0);
                  return row.map((v) => (t ? v / t : NaN));
                })}
                mode="sequential"
                max={1}
                rowLabel={rowVar}
                colLabel={colVar}
                legendLabel="share of row"
                cellText={(r, c) => String(res.table[r]![c]!)}
                tip={(r, c) => {
                  const t = res.table[r]!.reduce((s, v) => s + v, 0);
                  return { title: `${res.rows[r]} / ${res.cols[c]}`, rows: [["cases", String(res.table[r]![c]!)], ["of the row", t ? pct(res.table[r]![c]! / t) : "–"]] };
                }}
                ariaLabel={`Contingency table of ${rowVar} by ${colVar}`}
              />
            </ChartCard>
          </>
        )}
      </div>
    </div>
  );
}
