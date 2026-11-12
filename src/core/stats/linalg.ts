/** Small dense linear-algebra helpers (matrices as arrays of rows). */

export type Matrix = number[][];

export function zeros(r: number, c: number): Matrix {
  return Array.from({ length: r }, () => new Array<number>(c).fill(0));
}

export function transpose(a: Matrix): Matrix {
  const r = a.length;
  const c = r ? a[0]!.length : 0;
  const out = zeros(c, r);
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) out[j]![i] = a[i]![j]!;
  return out;
}

export function matMul(a: Matrix, b: Matrix): Matrix {
  const r = a.length;
  const k = b.length;
  const c = k ? b[0]!.length : 0;
  const out = zeros(r, c);
  for (let i = 0; i < r; i++) {
    const ai = a[i]!;
    const oi = out[i]!;
    for (let p = 0; p < k; p++) {
      const v = ai[p]!;
      if (v === 0) continue;
      const bp = b[p]!;
      for (let j = 0; j < c; j++) oi[j] = oi[j]! + v * bp[j]!;
    }
  }
  return out;
}

export function matVec(a: Matrix, x: ArrayLike<number>): number[] {
  return a.map((row) => {
    let s = 0;
    for (let j = 0; j < row.length; j++) s += row[j]! * x[j]!;
    return s;
  });
}

/**
 * Eigen-decomposition of a real symmetric matrix by cyclic Jacobi rotations.
 * Returns eigenvalues and the matrix whose columns are the eigenvectors.
 */
export function symEig(input: Matrix): { values: number[]; vectors: Matrix } {
  const n = input.length;
  const a = input.map((row) => [...row]);
  const v = zeros(n, n);
  for (let i = 0; i < n; i++) v[i]![i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p]![q]! * a[p]![q]!;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]!), vectors: v };
}

/** Cholesky factor L (lower triangular) of a symmetric positive-definite matrix. */
export function cholesky(a: Matrix): Matrix | undefined {
  const n = a.length;
  const l = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i]![j]!;
      for (let k = 0; k < j; k++) s -= l[i]![k]! * l[j]![k]!;
      if (i === j) {
        if (!(s > 0)) return undefined;
        l[i]![i] = Math.sqrt(s);
      } else {
        l[i]![j] = s / l[j]![j]!;
      }
    }
  }
  return l;
}

/** Solve L y = b for lower-triangular L. */
export function forwardSolve(l: Matrix, b: ArrayLike<number>): number[] {
  const n = l.length;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= l[i]![k]! * y[k]!;
    y[i] = s / l[i]![i]!;
  }
  return y;
}

/** Solve Lᵀ x = y for lower-triangular L. */
export function backSolveT(l: Matrix, y: ArrayLike<number>): number[] {
  const n = l.length;
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let k = i + 1; k < n; k++) s -= l[k]![i]! * x[k]!;
    x[i] = s / l[i]![i]!;
  }
  return x;
}

/** Orthonormal basis (columns) of the sum-to-zero subspace of Rᵃ: normalized Helmert contrasts. */
export function helmertBasis(a: number): Matrix {
  const q = zeros(a, a - 1);
  for (let k = 1; k < a; k++) {
    const norm = Math.sqrt(k * (k + 1));
    for (let i = 0; i < k; i++) q[i]![k - 1] = 1 / norm;
    q[k]![k - 1] = -k / norm;
  }
  return q;
}
