import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Relative base so the build works from any sub-path (GitHub Pages) and from file://.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    target: "es2022",
    // Everything is bundled into one JS + one CSS file; scripts/build-single.mjs then
    // inlines both into a single self-contained HTML file that also runs offline.
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4000,
  },
  worker: {
    format: "es",
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
