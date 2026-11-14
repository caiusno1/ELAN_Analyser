import { sampleChain, type FitOptions } from "../core/stats/mcmc/fit.ts";
import type { GlmmInput } from "../core/stats/mcmc/glmm.ts";

/** Runs one MCMC chain off the main thread. */
interface Request {
  id: number;
  input: GlmmInput;
  chain: number;
  options: FitOptions;
}

const ctx = self as unknown as { onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage: (message: unknown, transfer?: Transferable[]) => void };

ctx.onmessage = (e) => {
  const { id, input, chain, options } = e.data;
  try {
    const result = sampleChain(input, chain, { ...options, onProgress: (fraction) => ctx.postMessage({ id, type: "progress", fraction }) });
    ctx.postMessage({ id, type: "done", result }, [result.draws.buffer as ArrayBuffer, result.logDensity.buffer as ArrayBuffer]);
  } catch (err) {
    ctx.postMessage({ id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
