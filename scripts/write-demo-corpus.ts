// Writes the example corpus as .eaf files, so that it can be opened in ELAN or loaded
// into the analyser like any other set of recordings.
//
//   npm run demo:write                 → examples/demo-corpus/
//   npm run demo:write -- some/folder  → some/folder/
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateDemoCorpus } from "../src/core/demo/demoCorpus.ts";

const target = resolve(process.argv[2] ?? "examples/demo-corpus");
mkdirSync(target, { recursive: true });
const files = generateDemoCorpus();
let bytes = 0;
for (const f of files) {
  writeFileSync(join(target, f.fileName), f.xml);
  bytes += Buffer.byteLength(f.xml);
}
// File variables as a table that the Corpus page can import.
const variables = [...new Set(files.flatMap((f) => Object.keys(f.meta)))];
const table = [["file", ...variables].join(","), ...files.map((f) => [f.fileName, ...variables.map((v) => f.meta[v] ?? "")].join(","))].join("\n") + "\n";
writeFileSync(join(target, "file_variables.csv"), table);
console.log(`${files.length} files (${(bytes / 1024).toFixed(0)} kB) and file_variables.csv written to ${target}`);
