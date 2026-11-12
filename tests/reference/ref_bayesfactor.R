# Reference Bayes factors from the R package BayesFactor (Morey & Rouder).
# Run: Rscript ref_bayesfactor.R  -> ../fixtures/ref_bayesfactor.json
suppressMessages(library(BayesFactor))
suppressMessages(library(jsonlite))
set.seed(20261112)
bf <- function(obj) as.numeric(obj@bayesFactor$bf)   # natural log of BF10
out <- list()

# ---- t-tests -----------------------------------------------------------------------
tt <- list()
mk <- function(n, m, s) round(rnorm(n, m, s), 3)
cases <- list(
  list(n = 8,   m = 0.9, s = 1), list(n = 15, m = 0.2, s = 1), list(n = 40, m = -0.35, s = 2),
  list(n = 120, m = 0.0, s = 1), list(n = 3,  m = 1.5, s = 1), list(n = 60, m = 0.8, s = 1.5),
  list(n = 500, m = 0.12, s = 1), list(n = 25, m = -1.4, s = 1))
for (cs in cases) {
  x <- mk(cs$n, cs$m, cs$s)
  for (r in c(sqrt(2) / 2, 1, 0.3)) {
    tt[[length(tt) + 1]] <- list(kind = "one", x = x, r = r,
      logbf10 = bf(ttestBF(x, rscale = r)),
      logbf_plus = bf(ttestBF(x, rscale = r, nullInterval = c(0, Inf))[1]),
      logbf_minus = bf(ttestBF(x, rscale = r, nullInterval = c(-Inf, 0))[1]))
  }
}
two <- list(
  list(n1 = 10, n2 = 12, d = 0.8), list(n1 = 30, n2 = 30, d = 0.1), list(n1 = 6, n2 = 45, d = -1.1),
  list(n1 = 80, n2 = 75, d = 0.45), list(n1 = 200, n2 = 220, d = 0.0), list(n1 = 4, n2 = 5, d = 2))
for (cs in two) {
  x <- mk(cs$n1, cs$d, 1); y <- mk(cs$n2, 0, 1)
  for (r in c(sqrt(2) / 2, 1.2)) {
    tt[[length(tt) + 1]] <- list(kind = "two", x = x, y = y, r = r,
      logbf10 = bf(ttestBF(x, y, rscale = r)),
      logbf_plus = bf(ttestBF(x, y, rscale = r, nullInterval = c(0, Inf))[1]),
      logbf_minus = bf(ttestBF(x, y, rscale = r, nullInterval = c(-Inf, 0))[1]))
  }
}
for (cs in list(list(n = 12, d = 0.5), list(n = 35, d = -0.2), list(n = 9, d = 1.3))) {
  x <- mk(cs$n, 5, 2); y <- round(x - cs$d + rnorm(cs$n, 0, 1), 3)
  tt[[length(tt) + 1]] <- list(kind = "paired", x = x, y = y, r = sqrt(2) / 2,
    logbf10 = bf(ttestBF(x, y, paired = TRUE)),
    logbf_plus = bf(ttestBF(x, y, paired = TRUE, nullInterval = c(0, Inf))[1]),
    logbf_minus = bf(ttestBF(x, y, paired = TRUE, nullInterval = c(-Inf, 0))[1]))
}
out$ttest <- tt

# posterior of delta (MCMC), for a loose check of the analytic posterior
post <- list()
for (cs in list(list(n = 20, m = 0.6), list(n = 60, m = -0.3), list(n = 8, m = 1.2))) {
  x <- mk(cs$n, cs$m, 1)
  ch <- posterior(ttestBF(x), iterations = 400000, progress = FALSE)
  d <- as.numeric(ch[, "delta"])
  post[[length(post) + 1]] <- list(x = x, q = as.numeric(quantile(d, c(0.025, 0.5, 0.975))), p_pos = mean(d > 0))
}
out$ttest_posterior <- post

# ---- one-way ANOVA -----------------------------------------------------------------
an <- list()
designs <- list(
  list(n = c(10, 10, 10), mu = c(0, 0.5, 1)), list(n = c(8, 8, 8, 8), mu = c(0, 0, 0, 0)),
  list(n = c(5, 12, 30), mu = c(0, 0.8, 0.2)), list(n = c(20, 25), mu = c(0, 0.6)),
  list(n = c(6, 9, 4, 15, 11), mu = c(0, 1, -0.5, 0.3, 2)), list(n = c(40, 35, 50), mu = c(0, 0.1, -0.1)),
  list(n = c(3, 3, 3), mu = c(0, 3, 6)))
for (ds in designs) {
  g <- factor(rep(seq_along(ds$n), ds$n))
  y <- round(rnorm(sum(ds$n), ds$mu[as.integer(g)], 1), 3)
  dat <- data.frame(y = y, g = g)
  for (r in c(0.5, 1)) {
    an[[length(an) + 1]] <- list(y = y, g = as.integer(g), r = r,
      logbf10 = bf(anovaBF(y ~ g, data = dat, rscaleFixed = r, progress = FALSE)))
  }
}
out$anova <- an

# ---- correlation -------------------------------------------------------------------
co <- list()
for (cs in list(list(n = 10, rho = 0.7), list(n = 30, rho = 0.3), list(n = 100, rho = -0.25),
                list(n = 250, rho = 0.05), list(n = 6, rho = -0.9), list(n = 50, rho = 0.0))) {
  x <- rnorm(cs$n); y <- cs$rho * x + sqrt(1 - cs$rho^2) * rnorm(cs$n)
  x <- round(x, 3); y <- round(y, 3)
  for (k in c(1, 1 / 3, 1 / sqrt(3))) {
    co[[length(co) + 1]] <- list(x = x, y = y, kappa = k, r = cor(x, y),
      logbf10 = bf(correlationBF(y, x, rscale = k)),
      logbf_plus = bf(correlationBF(y, x, rscale = k, nullInterval = c(0, 1))[1]),
      logbf_minus = bf(correlationBF(y, x, rscale = k, nullInterval = c(-1, 0))[1]))
  }
}
out$correlation <- co

# ---- contingency tables ------------------------------------------------------------
ct <- list()
tables <- list(
  matrix(c(12, 5, 7, 14), 2, byrow = TRUE), matrix(c(30, 28, 25, 31), 2, byrow = TRUE),
  matrix(c(3, 0, 1, 9), 2, byrow = TRUE), matrix(c(20, 15, 5, 10, 12, 22), 2, byrow = TRUE),
  matrix(c(8, 3, 2, 4, 9, 3, 1, 5, 12), 3, byrow = TRUE), matrix(c(50, 40, 45, 55, 30, 70, 60, 41), 4, byrow = TRUE),
  matrix(c(120, 80, 95, 105), 2, byrow = TRUE))
for (m in tables) {
  for (a in c(1, 2.5, 4)) {
    ct[[length(ct) + 1]] <- list(table = m, a = a,
      poisson = bf(contingencyTableBF(m, sampleType = "poisson", priorConcentration = a)),
      jointMulti = bf(contingencyTableBF(m, sampleType = "jointMulti", priorConcentration = a)),
      indepMultiRows = bf(contingencyTableBF(m, sampleType = "indepMulti", fixedMargin = "rows", priorConcentration = a)),
      indepMultiCols = bf(contingencyTableBF(m, sampleType = "indepMulti", fixedMargin = "cols", priorConcentration = a)))
  }
}
out$contingency <- ct

write(toJSON(out, digits = NA, auto_unbox = TRUE), "../fixtures/ref_bayesfactor.json")
cat("t-tests:", length(tt), " anova:", length(an), " correlation:", length(co), " contingency:", length(ct), "\n")
