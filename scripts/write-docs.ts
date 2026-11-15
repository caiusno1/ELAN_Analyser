// Generates docs/METHODS.md from the same text that the Methods page of the app shows
// (src/reference), so that the documentation cannot drift away from the program.
//
//   npm run docs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { methodsMarkdown } from "../src/reference/markdown.ts";

const target = resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs", "METHODS.md");
mkdirSync(dirname(target), { recursive: true });
const text = methodsMarkdown();
writeFileSync(target, text);
console.log(`docs/METHODS.md written (${text.split("\n").length} lines)`);
