import { describe, expect, it } from "vitest";
import { linkLayer, NO_ANNOTATION } from "../src/core/analysis/link.ts";
import { analyseTurnTaking, DEFAULT_TURN_TAKING } from "../src/core/analysis/turntaking.ts";
import { datasetFromRows } from "../src/core/data/dataset.ts";
import { corpus, demoCorpus, makeFile } from "./helpers.ts";

describe("linkLayer", () => {
  const { files, scheme } = corpus([
    makeFile("rec1", {
      A_gesture: [[1000, 2000, "iconic"], [2500, 2700, "beat"], [6000, 9000, "deictic"]],
      B_gesture: [[1500, 1800, "beat"]],
    }),
    makeFile("rec2", { A_gesture: [[0, 500, "beat"]], B_gesture: [] }),
  ]);
  const ds = datasetFromRows("events", "one event", "", [
    { file: "rec1", who: "A", time_s: 1.5 },
    { file: "rec1", who: "B", time_s: 1.5 },
    { file: "rec1", who: "A", time_s: 2.2 },
    { file: "rec1", who: "A", time_s: 3.0 },
    { file: "rec2", who: "A", time_s: 0.5 },
    { file: "elsewhere", who: "A", time_s: 1 },
    { file: "rec1", who: "A", time_s: NaN },
  ], [{ name: "file", type: "string" }, { name: "who", type: "string" }, { name: "time_s", type: "number" }]);
  const base = { layer: "gesture", fileColumn: "file", timeColumn: "time_s", participantColumn: "who" } as const;

  it("finds the annotation at an instant, for the same or the other participant", () => {
    const same = linkLayer(ds, files, scheme, { ...base, participant: "same", before: 0, after: 0, output: "value" }, "g");
    // 0.5 s in rec2 is the end of the annotation, which is exclusive.
    expect(same.column.values).toEqual(["iconic", "beat", NO_ANNOTATION, NO_ANNOTATION, NO_ANNOTATION, "", ""]);
    expect(same.matched).toBe(2);
    expect(same.unlinked).toBe(2);
    const other = linkLayer(ds, files, scheme, { ...base, participant: "other", before: 0, after: 0, output: "value" }, "g");
    expect(other.column.values.slice(0, 2)).toEqual(["beat", "iconic"]);
    const any = linkLayer(ds, files, scheme, { ...base, participant: "any", before: 0, after: 0, output: "present" }, "g");
    expect(any.column.values).toEqual(["yes", "yes", "no", "no", "no", "", ""]);
  });

  it("takes the annotation that fills most of a window", () => {
    // 1.2–2.2 s holds 800 ms of "iconic"; 2.0–3.0 s holds 200 ms of "beat" only. B's gesture
    // starts exactly where the window before 1.5 s ends, so it is not in it.
    const win = linkLayer(ds, files, scheme, { ...base, participant: "same", before: 1000, after: 0, output: "value" }, "g");
    expect(win.column.values.slice(0, 5)).toEqual(["iconic", NO_ANNOTATION, "iconic", "beat", "beat"]);
    // Long annotations that started well before the window are found too.
    const late = datasetFromRows("e", "event", "", [{ file: "rec1", who: "A", time_s: 8.9 }], [{ name: "file", type: "string" }, { name: "who", type: "string" }, { name: "time_s", type: "number" }]);
    expect(linkLayer(late, files, scheme, { ...base, participant: "same", before: 100, after: 0, output: "value" }, "g").column.values).toEqual(["deictic"]);
  });

  it("respects a value filter", () => {
    const beats = linkLayer(ds, files, scheme, { ...base, participant: "any", before: 1000, after: 0, output: "present", filter: { mode: "values", values: ["beat"] } }, "g");
    expect(beats.column.values.slice(0, 5)).toEqual(["no", "no", "yes", "yes", "yes"]);
    expect(beats.column.label).toContain("gesture");
  });

  it("links the changes of speaker of the example corpus to gaze", () => {
    const demo = demoCorpus();
    const transfers = analyseTurnTaking(demo.files, demo.scheme, { layer: "speech", ...DEFAULT_TURN_TAKING }).dataset;
    const gazeOf = (who: string) => linkLayer(transfers, demo.files, demo.scheme, { layer: "gaze", fileColumn: "file", timeColumn: "time_s", participant: "same", participantColumn: who, before: 0, after: 0, output: "value" }, `gaze_of_${who}`);
    const previous = gazeOf("from");
    const next = gazeOf("to");
    expect(previous.unlinked).toBe(0);
    expect(previous.matched).toBeGreaterThan(transfers.rowCount * 0.9);
    // The example corpus follows Kendon (1967): the speaker who hands over the turn looks at the
    // partner more often at that moment than the speaker who takes it.
    const share = (r: typeof previous) => r.column.values.filter((v) => v === "partner").length / transfers.rowCount;
    expect(share(previous)).toBeGreaterThan(share(next) + 0.08);
  });
});
