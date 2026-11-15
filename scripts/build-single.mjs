// Turns the Vite build (dist/index.html + one script + one stylesheet) into a single
// self-contained file, dist/elan-analyser.html, that can be opened straight from disk,
// e-mailed or put on a memory stick: no server, no installation, no network access.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
let html = readFileSync(join(dist, "index.html"), "utf8");

/** Text may not contain the sequences that would end (or comment out) the element it is put in. */
const safeScript = (code) => code.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
const safeStyle = (css) => css.replace(/<\/style/gi, "<\\/style");

let scripts = 0;
let styles = 0;
html = html.replace(/<script\b([^>]*?)\bsrc="([^"]+)"([^>]*)><\/script>/g, (_tag, before, src, after) => {
  const code = readFileSync(join(dist, src), "utf8");
  const attrs = `${before}${after}`.replace(/\bcrossorigin(="[^"]*")?/g, "").replace(/\s+/g, " ").trim();
  scripts++;
  // A replacer function keeps "$" sequences in the code from being read as replacement patterns.
  return `<script ${attrs}>${safeScript(code)}</script>`;
});
html = html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*>/g, (tag) => {
  const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
  if (!href) return tag;
  styles++;
  return `<style>${safeStyle(readFileSync(join(dist, href), "utf8"))}</style>`;
});
// Preload hints point at files that no longer need to be fetched.
html = html.replace(/<link\b[^>]*\brel="modulepreload"[^>]*>\s*/g, "");

if (scripts !== 1 || styles !== 1) {
  throw new Error(`Expected one script and one stylesheet in dist/index.html, found ${scripts} and ${styles}.`);
}
if (/\b(src|href)="\.\/assets\//.test(html)) throw new Error("dist/index.html still refers to files in assets/.");

const out = join(dist, "elan-analyser.html");
writeFileSync(out, html);
console.log(`dist/elan-analyser.html  ${(Buffer.byteLength(html) / 1024).toFixed(0)} kB  (self-contained)`);
