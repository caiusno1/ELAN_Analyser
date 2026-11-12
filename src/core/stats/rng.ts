/**
 * Seeded pseudo-random number generator (xoshiro128**) with the variate generators the
 * analyser needs. Everything stochastic in the app takes an explicit seed so that results
 * are reproducible.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  private spare: number | undefined;

  constructor(seed = 1) {
    // SplitMix32 to expand the seed into the 128-bit state.
    let z = (seed | 0) ^ 0x9e3779b9;
    const next = () => {
      z = (z + 0x9e3779b9) | 0;
      let t = z ^ (z >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t ^= t >>> 15;
      t = Math.imul(t, 0x735a2d97);
      t ^= t >>> 15;
      return t | 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Next raw 32-bit unsigned integer. */
  nextU32(): number {
    const r = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9);
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return r >>> 0;
  }

  /** Uniform on [0, 1) with 53 bits of precision. */
  uniform(): number {
    const hi = this.nextU32() >>> 5; // 27 bits
    const lo = this.nextU32() >>> 6; // 26 bits
    return (hi * 67108864 + lo) / 9007199254740992;
  }

  /** Uniform on (0, 1): never returns 0. */
  uniformOpen(): number {
    let u = this.uniform();
    while (u === 0) u = this.uniform();
    return u;
  }

  /** Integer uniform on [0, n). */
  int(n: number): number {
    return Math.floor(this.uniform() * n);
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.uniform();
  }

  /** Standard normal (polar Box–Muller). */
  normal(mean = 0, sd = 1): number {
    if (this.spare !== undefined) {
      const v = this.spare;
      this.spare = undefined;
      return mean + sd * v;
    }
    let u: number;
    let v: number;
    let s: number;
    do {
      u = 2 * this.uniform() - 1;
      v = 2 * this.uniform() - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * f;
    return mean + sd * u * f;
  }

  exponential(rate = 1): number {
    return -Math.log(this.uniformOpen()) / rate;
  }

  /** Gamma(shape, rate) by Marsaglia & Tsang (2000). */
  gamma(shape: number, rate = 1): number {
    if (shape < 1) {
      // Boost: Gamma(a) = Gamma(a+1) * U^(1/a)
      const u = this.uniformOpen();
      return this.gamma(shape + 1, rate) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.uniformOpen();
      if (u < 1 - 0.0331 * x * x * x * x) return (d * v) / rate;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return (d * v) / rate;
    }
  }

  beta(a: number, b: number): number {
    const x = this.gamma(a);
    const y = this.gamma(b);
    return x / (x + y);
  }

  /** Dirichlet(alpha) into `out` (allocated if omitted). */
  dirichlet(alpha: ArrayLike<number>, out?: Float64Array): Float64Array {
    const k = alpha.length;
    const res = out ?? new Float64Array(k);
    let sum = 0;
    for (let i = 0; i < k; i++) {
      const g = this.gamma(alpha[i]!);
      res[i] = g;
      sum += g;
    }
    if (sum <= 0) {
      for (let i = 0; i < k; i++) res[i] = 1 / k;
    } else {
      for (let i = 0; i < k; i++) res[i] = res[i]! / sum;
    }
    return res;
  }

  /** Poisson(lambda): inversion for small means, transformed rejection (PTRS) otherwise. */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda < 30) {
      const l = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= this.uniform();
      } while (p > l);
      return k - 1;
    }
    // Hörmann (1993) PTRS.
    const slam = Math.sqrt(lambda);
    const loglam = Math.log(lambda);
    const b = 0.931 + 2.53 * slam;
    const a = -0.059 + 0.02483 * b;
    const invalpha = 1.1239 + 1.1328 / (b - 3.4);
    const vr = 0.9277 - 3.6224 / (b - 2);
    for (;;) {
      const u = this.uniform() - 0.5;
      const v = this.uniformOpen();
      const us = 0.5 - Math.abs(u);
      const k = Math.floor(((2 * a) / us + b) * u + lambda + 0.43);
      if (us >= 0.07 && v <= vr) return k;
      if (k < 0 || (us < 0.013 && v > us)) continue;
      if (Math.log(v) + Math.log(invalpha) - Math.log(a / (us * us) + b) <= -lambda + k * loglam - lgammaInt(k + 1)) {
        return k;
      }
    }
  }

  bernoulli(p: number): boolean {
    return this.uniform() < p;
  }

  /** Binomial(n, p): inversion for small expected counts, normal approximation otherwise. */
  binomial(n: number, p: number): number {
    if (n <= 0 || p <= 0) return 0;
    if (p >= 1) return n;
    if (p > 0.5) return n - this.binomial(n, 1 - p);
    if (n * p < 30) {
      // BINV: sequential search from zero.
      const q = 1 - p;
      const s = p / q;
      let f = Math.pow(q, n);
      if (f > 0) {
        let u = this.uniform();
        let k = 0;
        while (u > f && k < n) {
          u -= f;
          k++;
          f *= ((n - k + 1) / k) * s;
        }
        return k;
      }
    }
    const k = Math.round(n * p + Math.sqrt(n * p * (1 - p)) * this.normal());
    return Math.min(n, Math.max(0, k));
  }

  /** Student t with `df` degrees of freedom. */
  studentT(df: number): number {
    return this.normal() / Math.sqrt(this.gamma(df / 2, df / 2));
  }

  /** Negative binomial with mean `mu` and shape `phi` (variance mu + mu²/phi). */
  negBinomial(mu: number, phi: number): number {
    return this.poisson(this.gamma(phi, phi / mu));
  }

  /** Pick an index with probability proportional to `weights`. */
  categorical(weights: ArrayLike<number>): number {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i]!;
    let u = this.uniform() * total;
    for (let i = 0; i < weights.length; i++) {
      u -= weights[i]!;
      if (u < 0) return i;
    }
    return weights.length - 1;
  }

  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }

  /** In-place Fisher–Yates shuffle. */
  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = xs[i]!;
      xs[i] = xs[j]!;
      xs[j] = t;
    }
    return xs;
  }

  /** Log-normal with the given median and sigma of the underlying normal. */
  logNormal(median: number, sigma: number): number {
    return median * Math.exp(this.normal(0, sigma));
  }
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/** ln Γ(n) for positive integers and general positive reals (Stirling series). */
function lgammaInt(x: number): number {
  if (x < 12) {
    let p = 1;
    let y = x;
    while (y < 12) {
      p *= y;
      y += 1;
    }
    return stirling(y) - Math.log(p);
  }
  return stirling(x);
}

function stirling(x: number): number {
  const x2 = x * x;
  return (
    (x - 0.5) * Math.log(x) -
    x +
    0.9189385332046727 +
    1 / (12 * x) -
    1 / (360 * x * x2) +
    1 / (1260 * x2 * x2 * x)
  );
}
