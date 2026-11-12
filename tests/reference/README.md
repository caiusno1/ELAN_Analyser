# Reference values for the statistics tests

The Bayesian tests in `src/core/stats` are checked against independent implementations.
The fixtures in `tests/fixtures` are produced by the scripts in this folder:

| Fixture | Script | Reference software |
| --- | --- | --- |
| `ref_special.json` | `ref_special.py` | SciPy and mpmath (40–400 digits) |
| `ref_bayesfactor.json` | `ref_bayesfactor.R` | R package **BayesFactor** 0.9.12-4.7 (Morey & Rouder) |
| `ref_rstanarm.json` | `ref_rstanarm.R` | R package **rstanarm** 2.32.1 (Stan) |

To regenerate (not needed to run the tests):

```bash
python3 -m venv .venv && .venv/bin/pip install numpy scipy mpmath
.venv/bin/python ref_special.py
```

```bash
Rscript ref_bayesfactor.R   # needs the R packages BayesFactor and jsonlite
```

```bash
Rscript ref_rstanarm.R      # needs the R packages rstanarm and jsonlite
```
