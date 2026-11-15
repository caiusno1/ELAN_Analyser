import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateDemoCorpus } from "../src/core/demo/demoCorpus.ts";
import { METHODS, NEW_QUESTIONS, STATISTICS, USE_CASES, VIEW_NAME } from "../src/reference/content.ts";
import { methodsMarkdown } from "../src/reference/markdown.ts";
import { REFERENCES, reference, shortCitation } from "../src/reference/references.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("reference material", () => {
  it("cites only works that are in the bibliography, and uses every entry", () => {
    const cited = new Set<string>();
    for (const list of [USE_CASES, NEW_QUESTIONS, METHODS, STATISTICS]) for (const item of list) for (const id of item.refs ?? []) cited.add(id);
    for (const id of cited) expect(() => reference(id)).not.toThrow();
    const unused = REFERENCES.filter((r) => !cited.has(r.id)).map((r) => r.id);
    expect(unused).toEqual([]);
  });

  it("has a well-formed bibliography in alphabetical order, without duplicates", () => {
    const ids = REFERENCES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(REFERENCES.map((r) => r.text)).size).toBe(ids.length);
    for (const r of REFERENCES) expect(r.text, r.id).toMatch(/\(\d{4}\)\. .+\.$/);
    // Same first author: ordered by the next author (Gronau, Ly … before Gronau, Sarafoglou …).
    const first = REFERENCES.map((r) => r.text.slice(0, 12));
    expect(first.indexOf("Abney, D. H.")).toBe(0);
    expect(ids.indexOf("gronau2020")).toBeLessThan(ids.indexOf("gronau2017"));
    expect(ids.indexOf("oben2016")).toBeLessThan(ids.indexOf("pickering2004"));
    expect(ids.indexOf("strelioff2007")).toBeLessThan(ids.indexOf("terbekke2024"));
    expect(ids.indexOf("terbekke2024")).toBeLessThan(ids.indexOf("vandoorn2021"));
  });

  it("derives short citations", () => {
    expect(shortCitation("pickering2004")).toBe("Pickering & Garrod (2004)");
    expect(shortCitation("stivers2009")).toBe("Stivers et al. (2009)");
    expect(shortCitation("terbekke2024")).toBe("ter Bekke et al. (2024)");
    expect(shortCitation("dubuisson2017")).toBe("Dubuisson Duplessis et al. (2017)");
    expect(shortCitation("kok2017")).toBe("Kok (2017)");
    expect(shortCitation("vandoorn2021")).toBe("van Doorn et al. (2021)");
  });

  it("describes every analysis view exactly once", () => {
    const described = METHODS.map((m) => m.view);
    expect(new Set(described).size).toBe(described.length);
    const views = Object.keys(VIEW_NAME).filter((v) => v !== "statistics" && v !== "methods");
    expect([...described].sort()).toEqual(views.sort());
  });

  it("matches the generated documentation (run `npm run docs` after changing the text)", () => {
    expect(read("../docs/METHODS.md")).toBe(methodsMarkdown());
  });
});

describe("example corpus on disk", () => {
  it("is what the generator produces (run `npm run demo:write` after changing it)", () => {
    const generated = generateDemoCorpus();
    const onDisk = readdirSync(new URL("../examples/demo-corpus/", import.meta.url)).filter((f) => f.endsWith(".eaf")).sort();
    expect(onDisk).toEqual(generated.map((f) => f.fileName).sort());
    for (const f of generated) expect(read(`../examples/demo-corpus/${f.fileName}`) === f.xml, f.fileName).toBe(true);
  });
});
