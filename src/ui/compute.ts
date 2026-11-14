import { sampleChain, summarizeFit, type FitOptions, type GlmmFit } from "../core/stats/mcmc/fit.ts";
import type { GlmmInput } from "../core/stats/mcmc/glmm.ts";
import type { ChainResult } from "../core/stats/mcmc/nuts.ts";
import ChainWorker from "../workers/chain.worker.ts?worker&inline";

export interface FitHandle {
  promise: Promise<GlmmFit>;
  cancel: () => void;
}

/**
 * Fit a multilevel model with one Web Worker per chain. If workers are not available
 * (some embedded or restricted contexts), the chains run one after another on the main
 * thread instead — slower and with a frozen page, but with the same result.
 */
export function fitModel(input: GlmmInput, options: FitOptions, onProgress: (fraction: number, phase: string) => void): FitHandle {
  const nChains = options.chains ?? 4;
  const start = Date.now();
  const workers: Worker[] = [];
  let cancelled = false;
  // A terminated worker never answers, so cancelling has to settle the promise itself.
  let rejectOnCancel: (e: Error) => void = () => {};
  const untilCancelled = new Promise<never>((_, reject) => {
    rejectOnCancel = reject;
  });
  const cancel = () => {
    cancelled = true;
    for (const w of workers) w.terminate();
    rejectOnCancel(new Error("cancelled"));
  };
  const progress = new Array<number>(nChains).fill(0);
  const report = () => onProgress(progress.reduce((a, b) => a + b, 0) / nChains, "Sampling");

  const viaWorkers = (): Promise<ChainResult[]> =>
    Promise.all(
      Array.from({ length: nChains }, (_, chain) =>
        new Promise<ChainResult>((resolve, reject) => {
          const w = new ChainWorker();
          workers.push(w);
          w.onmessage = (e: MessageEvent<{ type: string; fraction?: number; result?: ChainResult; message?: string }>) => {
            if (e.data.type === "progress") {
              progress[chain] = e.data.fraction ?? 0;
              report();
            } else if (e.data.type === "done") {
              progress[chain] = 1;
              report();
              w.terminate();
              resolve(e.data.result!);
            } else {
              w.terminate();
              reject(new Error(e.data.message ?? "The sampler failed."));
            }
          };
          w.onerror = (e) => {
            w.terminate();
            reject(new Error(e.message || "The sampler could not be started."));
          };
          w.postMessage({ id: chain, input, chain, options: { ...options, onProgress: undefined, shouldStop: undefined } });
        }),
      ),
    );

  const onMainThread = async (): Promise<ChainResult[]> => {
    const out: ChainResult[] = [];
    for (let chain = 0; chain < nChains; chain++) {
      if (cancelled) throw new Error("cancelled");
      onProgress(chain / nChains, `Sampling chain ${chain + 1} of ${nChains}`);
      await new Promise((r) => setTimeout(r, 20));
      out.push(sampleChain(input, chain, options));
    }
    return out;
  };

  const work = (async () => {
    let chains: ChainResult[];
    let useWorkers = true;
    try {
      // Constructing a worker throws where they are not allowed.
      new ChainWorker().terminate();
    } catch {
      useWorkers = false;
    }
    try {
      chains = useWorkers ? await viaWorkers() : await onMainThread();
    } catch (e) {
      if (cancelled) throw new Error("cancelled");
      if (!useWorkers) throw e;
      // A worker failed to start or crashed: one more attempt without workers.
      for (const w of workers) w.terminate();
      const message = e instanceof Error ? e.message : String(e);
      if (!/could not be started|Failed to construct|SecurityError/i.test(message)) throw e;
      chains = await onMainThread();
    }
    if (cancelled) throw new Error("cancelled");
    onProgress(1, "Summarising");
    await new Promise((r) => setTimeout(r, 20));
    return summarizeFit(input, chains, options, (Date.now() - start) / 1000);
  })();
  return { promise: Promise.race([work, untilCancelled]), cancel };
}
