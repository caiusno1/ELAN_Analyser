import { inferScheme, stripExtension, type CorpusFile, type TierScheme } from "../src/core/corpus/corpus.ts";
import { generateDemoCorpus } from "../src/core/demo/demoCorpus.ts";
import { parseEaf } from "../src/core/eaf/parser.ts";
import { writeEaf } from "../src/core/eaf/writer.ts";

export type Ann = [start: number, end: number, value: string];

/** Build a corpus file through the real writer and parser. */
export function makeFile(name: string, tiers: Record<string, Ann[]>, meta: Record<string, string> = {}): CorpusFile {
  const xml = writeEaf({
    linguisticTypes: [{ id: "default-lt" }],
    tiers: Object.entries(tiers).map(([id, anns]) => ({
      id,
      linguisticType: "default-lt",
      annotations: anns.map(([start, end, value]) => ({ start, end, value })),
    })),
  });
  return { id: name, name, doc: parseEaf(xml, `${name}.eaf`), meta };
}

export function corpus(files: CorpusFile[]): { files: CorpusFile[]; scheme: TierScheme } {
  return { files, scheme: inferScheme(files) };
}

let demoCache: { files: CorpusFile[]; scheme: TierScheme } | undefined;

export function demoCorpus(): { files: CorpusFile[]; scheme: TierScheme } {
  if (!demoCache) {
    const files = generateDemoCorpus().map((d, i) => ({ id: `f${i}`, name: stripExtension(d.fileName), doc: parseEaf(d.xml, d.fileName), meta: d.meta }));
    demoCache = corpus(files);
  }
  return demoCache;
}
