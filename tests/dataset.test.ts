import { describe, expect, it } from "vitest";
import {
  aggregateDataset,
  datasetFromDelimited,
  datasetFromRows,
  datasetToCsv,
  decodeTextBytes,
  detectDelimiter,
  filterDataset,
  freeColumnName,
  numberColumn,
  parseDelimited,
  stringColumn,
  withColumn,
} from "../src/core/data/dataset.ts";

const rows = [
  { file: "f1", speaker: "A", condition: "f2f", minutes: 3, dur: 1.0, n: 2 },
  { file: "f1", speaker: "A", condition: "f2f", minutes: 3, dur: 3.0, n: 4 },
  { file: "f1", speaker: "B", condition: "f2f", minutes: 3, dur: 2.0, n: 1 },
  { file: "f2", speaker: "A", condition: "screen", minutes: 5, dur: 4.0, n: 3 },
  { file: "f2", speaker: "A", condition: "screen", minutes: 5, dur: NaN, n: 5 },
];
const ds = datasetFromRows("annotations", "one annotation", "", rows, [
  { name: "file", type: "string" },
  { name: "speaker", type: "string" },
  { name: "condition", type: "string" },
  { name: "minutes" },
  { name: "dur", primary: true },
  { name: "n" },
]);

describe("datasets", () => {
  it("remembers the main measure", () => {
    expect(ds.primary).toBe("dur");
    expect(filterDataset(ds, (i) => i > 0).primary).toBe("dur");
  });

  it("aggregates by groups and ignores missing values", () => {
    const agg = aggregateDataset(ds, ["file", "speaker"], [{ column: "dur", fn: "mean" }, { column: "n", fn: "sum" }, { column: "dur", fn: "count", as: "rows" }], "per speaker", "one speaker");
    expect(agg.rowCount).toBe(3);
    expect(stringColumn(agg, "file")).toEqual(["f1", "f1", "f2"]);
    expect(Array.from(numberColumn(agg, "mean_dur"))).toEqual([2, 2, 4]);
    expect(Array.from(numberColumn(agg, "sum_n"))).toEqual([6, 1, 8]);
    expect(Array.from(numberColumn(agg, "rows"))).toEqual([2, 1, 2]);
    expect(agg.columns.map((c) => c.name)).toEqual(["file", "speaker", "mean_dur", "sum_n", "rows"]);
    expect(agg.primary).toBe("mean_dur");
  });

  it("carries over variables that are constant within every group", () => {
    const agg = aggregateDataset(ds, ["file", "speaker"], [{ column: "dur", fn: "median" }], "per speaker", "one speaker", { keepConstant: true });
    // condition and minutes do not change within a speaker; n does, and dur is being summarised.
    expect(agg.columns.map((c) => c.name)).toEqual(["file", "speaker", "condition", "minutes", "median_dur"]);
    expect(stringColumn(agg, "condition")).toEqual(["f2f", "f2f", "screen"]);
    expect(Array.from(numberColumn(agg, "minutes"))).toEqual([3, 3, 5]);
    // Grouped by speaker only, the condition differs within speaker A and is dropped.
    const bySpeaker = aggregateDataset(ds, ["speaker"], [{ column: "dur", fn: "max" }], "s", "one speaker", { keepConstant: true });
    expect(bySpeaker.columns.map((c) => c.name)).toEqual(["speaker", "max_dur"]);
  });

  it("adds and replaces variables without changing the identity of the table", () => {
    const more = withColumn(ds, { name: "log_dur", type: "number", values: Float64Array.from(numberColumn(ds, "dur"), Math.log) });
    expect(more.id).toBe(ds.id);
    expect(more.columns.length).toBe(ds.columns.length + 1);
    expect(ds.columns.length).toBe(6);
    const replaced = withColumn(more, { name: "log_dur", type: "string", values: ["a", "b", "c", "d", "e"] });
    expect(replaced.columns.length).toBe(more.columns.length);
    expect(stringColumn(replaced, "log_dur")[4]).toBe("e");
    expect(() => withColumn(ds, { name: "x", type: "string", values: ["too", "short"] })).toThrow();
    expect(freeColumnName(ds, "dur")).toBe("dur_2");
    expect(freeColumnName(ds, "new")).toBe("new");
  });
});

describe("delimited text", () => {
  it("detects the separator and respects quotes", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(detectDelimiter("﻿a,b\n1,2")).toBe(",");
    expect(parseDelimited('name,text\r\nx,"hello, ""world"""\r\ny,"two\nlines"\r\n')).toEqual([["name", "text"], ["x", 'hello, "world"'], ["y", "two\nlines"]]);
  });

  it("infers numeric and text variables", () => {
    const t = datasetFromDelimited("id,group,score,note\n1,a,2.5,x\n2,b,,y\n3,a,-1e2,\n4,b,NA,z\n", "t");
    expect(t.rowCount).toBe(4);
    expect(t.imported).toBe(true);
    expect(t.columns.map((c) => `${c.name}:${c.type}`)).toEqual(["id:number", "group:string", "score:number", "note:string"]);
    const score = numberColumn(t, "score");
    expect(score[0]).toBe(2.5);
    expect(Number.isNaN(score[1]!)).toBe(true);
    expect(score[2]).toBe(-100);
    expect(Number.isNaN(score[3]!)).toBe(true);
    expect(stringColumn(t, "note")).toEqual(["x", "y", "", "z"]);
  });

  it("understands decimal commas in files that are not comma-separated", () => {
    const t = datasetFromDelimited("Sprecher;Dauer;Anzahl\nA;1,5;3\nB;2,25;4\n", "t");
    expect(t.columns.map((c) => c.type)).toEqual(["string", "number", "number"]);
    expect(Array.from(numberColumn(t, "Dauer"))).toEqual([1.5, 2.25]);
    // In a comma-separated file a quoted "1,5" stays text: it could just as well be a list.
    const c = datasetFromDelimited('speaker,value\nA,"1,5"\nB,"2,25"\n', "t");
    expect(c.columns[1]!.type).toBe("string");
  });

  it("names missing and repeated headers, and treats a mixed column as text", () => {
    const t = datasetFromDelimited("a,,a\n1,x,2\n2,3,y\n", "t");
    expect(t.columns.map((c) => c.name)).toEqual(["a", "V2", "a_2"]);
    expect(t.columns.map((c) => c.type)).toEqual(["number", "string", "string"]);
    expect(() => datasetFromDelimited("only a header\n", "t")).toThrow();
  });

  it("round-trips through CSV", () => {
    const back = datasetFromDelimited(datasetToCsv(ds), "back");
    expect(back.columns.map((c) => `${c.name}:${c.type}`)).toEqual(ds.columns.map((c) => `${c.name}:${c.type}`));
    expect(Array.from(numberColumn(back, "dur")).map((v) => (Number.isNaN(v) ? "NaN" : v))).toEqual([1, 3, 2, 4, "NaN"]);
    expect(stringColumn(back, "condition")).toEqual(stringColumn(ds, "condition"));
  });

  it("decodes UTF-8, UTF-16 and Windows-1252 bytes", () => {
    const text = "Äußerung;Länge\nüber;1,5\n";
    expect(decodeTextBytes(new TextEncoder().encode(text))).toBe(text);
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16[0] = 0xff;
    utf16[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      utf16[2 + 2 * i] = text.charCodeAt(i) & 0xff;
      utf16[3 + 2 * i] = text.charCodeAt(i) >> 8;
    }
    expect(decodeTextBytes(utf16).replace(/^﻿/, "")).toBe(text);
    // "Äußerung" in Windows-1252: not valid UTF-8, so the fallback applies.
    const latin = Uint8Array.from([0xc4, 0x75, 0xdf, 0x65, 0x72, 0x75, 0x6e, 0x67]);
    expect(decodeTextBytes(latin)).toBe("Äußerung");
  });
});
