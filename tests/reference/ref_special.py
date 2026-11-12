# Reference values for special functions and distributions (SciPy + mpmath).
import json, itertools
import numpy as np
from scipy import special as sp, stats as st
import mpmath as mp
mp.mp.dps = 40
out = {}
out["lgamma"] = [[x, float(mp.re(mp.loggamma(x)) if x > 0 else mp.log(abs(mp.gamma(x))))] for x in [1e-8, 0.001, 0.1, 0.5, 1, 1.5, 2, 3.7, 10, 50.5, 171, 1000.25, 1e5, 1e8, -0.5, -1.5, -10.3]]
out["digamma"] = [[x, float(mp.digamma(x))] for x in [0.01, 0.5, 1, 2.5, 6, 30, 1e4, -0.5, -2.3]]
out["gammaP"] = [[a, x, float(mp.gammainc(a, 0, x, regularized=True))] for a in [0.5, 1, 2.5, 10, 100, 1000] for x in [0.01, 0.5, 1, 3, 9, 50, 120, 900, 1100]]
out["gammaQ"] = [[a, x, float(mp.gammainc(a, x, mp.inf, regularized=True))] for a in [0.5, 1, 2.5, 10, 100] for x in [0.01, 0.5, 1, 3, 9, 50, 120, 300]]
out["erfc"] = [[x, float(mp.erfc(x))] for x in [-3, -1, -0.1, 0, 1e-5, 0.3, 1, 2, 4, 6, 10, 20]]
out["betaI"] = [[a, b, x, float(mp.betainc(a, b, 0, x, regularized=True))] for a in [0.5, 1, 2, 7.5, 40, 500] for b in [0.5, 1, 3, 25, 300] for x in [0.001, 0.05, 0.3, 0.5, 0.8, 0.99]]
mp.mp.dps = 400
out["betaIc"] = [[a, b, x, float(mp.betainc(a, b, x, 1, regularized=True))] for a in [0.5, 2, 40] for b in [0.5, 3, 300] for x in [0.05, 0.5, 0.9, 0.999]]
mp.mp.dps = 40
out["logHyp1f1"] = [[a, b, z, float(mp.log(mp.hyp1f1(a, b, z)))] for a in [0.5, 1.5, 3, 26, 500.5] for b in [0.5, 1.5] for z in [0, 0.01, 1, 10, 100, 2000, 30000]]
out["hyp2f1"] = [[a, b, c, z, float(mp.hyp2f1(a, b, c, z))] for (a, b, c) in [(1.5, 1.5, 4, ), (1.5, 1.5, 12), (1.5, 1.5, 52), (3.5, 3.5, 7), (0.5, 0.5, 10.5), (0.5, 0.5, 99.5)] for z in [0, 0.01, 0.3, 0.7, 0.95, 0.999]]
out["normalCdf"] = [[x, float(mp.ncdf(x))] for x in [-38, -10, -5, -2, -0.5, 0, 0.7, 3, 8]]
out["normalInv"] = [[p, float(st.norm.ppf(p))] for p in [1e-300, 1e-20, 1e-6, 0.001, 0.02425, 0.025, 0.2, 0.5, 0.8, 0.975, 0.999, 1 - 1e-12]]
out["tCdf"] = [[x, df, float(st.t.cdf(x, df))] for df in [1, 2.5, 10, 100, 5000] for x in [-40, -5, -1, -0.1, 0, 0.5, 2, 8, 60]]
out["tInv"] = [[p, df, float(st.t.ppf(p, df))] for df in [1, 2.5, 10, 100, 5000] for p in [1e-8, 0.001, 0.025, 0.3, 0.5, 0.9, 0.975, 0.9999]]
out["tLogPdf"] = [[x, df, float(st.t.logpdf(x, df))] for df in [1, 3, 30, 1e4] for x in [-20, -1, 0, 0.4, 7]]
out["gammaInv"] = [[p, a, r, float(st.gamma.ppf(p, a, scale=1 / r))] for a in [0.3, 1, 4.5, 60, 2000] for r in [0.2, 3] for p in [1e-6, 0.025, 0.5, 0.975, 0.99999]]
out["betaInv"] = [[p, a, b, float(st.beta.ppf(p, a, b))] for a in [0.5, 1, 3, 30, 400] for b in [0.5, 2, 45] for p in [1e-7, 0.025, 0.5, 0.975, 0.999999]]
out["betaPrimeInv"] = [[p, a, b, float(st.betaprime.ppf(p, a, b))] for a in [1, 12.5] for b in [2, 30] for p in [0.025, 0.5, 0.975]]
# noncentral t density from its integral representation
#   T = (Z + mu)/S, S = sqrt(V/v):  f(t) = C * Int_0^inf s^v exp(-v s^2/2 - (t s - mu)^2/2) ds
# integrated at 60 digits with break points centred on the mode of the integrand
# (a coarse fixed grid loses accuracy in the far tails, where the peak is narrow).
def nct_logpdf(t, v, mu):
    mp.mp.dps = 60
    t, v, mu = mp.mpf(t), mp.mpf(v), mp.mpf(mu)
    a = v + t * t
    sstar = (mu * t + mp.sqrt(mu * mu * t * t + 4 * v * a)) / (2 * a)
    sig = 1 / mp.sqrt(v / sstar ** 2 + a)
    h = lambda s: v * mp.log(s) - v * s * s / 2 - (t * s - mu) ** 2 / 2
    hs = h(sstar)
    pts = [max(mp.mpf(0), sstar + k * sig) for k in range(-40, 0, 2)] + [sstar + k / mp.sqrt(a) for k in range(0, 42, 2)]
    I = mp.quad(lambda s: mp.exp(h(s) - hs) if s > 0 else mp.mpf(0), sorted(set(pts)))
    logC = mp.log(2) + (v / 2) * mp.log(v / 2) - mp.loggamma(v / 2) - mp.log(2 * mp.pi) / 2
    r = logC + hs + mp.log(I)
    mp.mp.dps = 40
    return r
nct = []; nctlog = []; cmp = []
for v in [1, 3, 9, 30, 199]:
    for mu in [-12, -3, -0.5, 0.3, 2, 6, 25]:
        for t in [-8, -2, -0.3, 0, 0.5, 1.7, 4, 11, 30]:
            lref = nct_logpdf(t, v, mu); ref = float(mp.exp(lref)); sc = float(st.nct.pdf(t, v, mu))
            nct.append([t, v, mu, ref]); nctlog.append([t, v, mu, float(lref)]); cmp.append((t, v, mu, ref, sc))
out["nctLogPdf"] = nctlog
out["nctPdf"] = nct
json.dump(out, open("../fixtures/ref_special.json", "w"), allow_nan=False)
print({k: len(v) for k, v in out.items()})
nan = [r for r in cmp if r[4] != r[4]]
bad = [r for r in cmp if r[4] == r[4] and abs(r[3] - r[4]) > 1e-9 * max(1e-3, abs(r[3]))]
print("scipy nct NaN:", len(nan), "| mpmath vs scipy nct disagreements:", len(bad), bad[:5])
