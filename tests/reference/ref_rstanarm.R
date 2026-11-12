# Reference posteriors for the multilevel-model engine, from rstanarm (Stan).
# Priors are set explicitly (autoscale = FALSE) so that both programs fit the same model.
# Run: Rscript ref_rstanarm.R  -> ../fixtures/ref_rstanarm.json
suppressMessages(library(rstanarm))
suppressMessages(library(jsonlite))
options(mc.cores = 4)
set.seed(4711)
summ <- function(fit, pars) {
  m <- as.matrix(fit)
  lapply(pars, function(p) {
    d <- m[, p]
    list(name = p, mean = mean(d), sd = sd(d), q025 = unname(quantile(d, 0.025)), q50 = unname(quantile(d, 0.5)), q975 = unname(quantile(d, 0.975)))
  })
}
out <- list()

# A: Gaussian regression -------------------------------------------------------------
n <- 80
x1 <- round(rnorm(n, 3, 2), 3); x2 <- rep(c(0, 1), n / 2)
y <- round(1.5 + 0.7 * x1 - 1.2 * x2 + rnorm(n, 0, 1.3), 3)
dA <- data.frame(y, x1, x2)
fitA <- stan_glm(y ~ x1 + x2, data = dA, family = gaussian(),
  prior = normal(0, c(2, 5), autoscale = FALSE), prior_intercept = normal(3, 10, autoscale = FALSE),
  prior_aux = exponential(0.5, autoscale = FALSE), chains = 4, iter = 6000, warmup = 1000, seed = 1, refresh = 0)
out$gaussian <- list(data = dA, priors = list(coefSd = c(2, 5), interceptMean = 3, interceptSd = 10, sigmaRate = 0.5),
  post = summ(fitA, c("(Intercept)", "x1", "x2", "sigma")))

# B: Poisson multilevel model with exposure -------------------------------------------
n <- 150; G <- 10
g <- rep(1:G, length.out = n); x <- round(rnorm(n), 3); expo <- round(runif(n, 0.5, 4), 3)
u <- rnorm(G, 0, 0.6)
yB <- rpois(n, expo * exp(0.2 + 0.5 * x + u[g]))
dB <- data.frame(y = yB, x, g = factor(g), expo)
fitB <- stan_glmer(y ~ x + (1 | g), data = dB, family = poisson(), offset = log(expo),
  prior = normal(0, 2.5, autoscale = FALSE), prior_intercept = normal(0, 5, autoscale = FALSE),
  prior_covariance = decov(1, 1, 1, 1), chains = 4, iter = 6000, warmup = 1000, seed = 2, refresh = 0, adapt_delta = 0.95)
out$poisson <- list(data = dB, priors = list(coefSd = 2.5, interceptMean = 0, interceptSd = 5, tauRate = 1),
  post = summ(fitB, c("(Intercept)", "x")),
  sd_g = { d <- sqrt(as.matrix(fitB)[, "Sigma[g:(Intercept),(Intercept)]"]); list(mean = mean(d), sd = sd(d), q025 = unname(quantile(d, 0.025)), q50 = unname(quantile(d, 0.5)), q975 = unname(quantile(d, 0.975))) },
  b1 = { d <- as.matrix(fitB)[, "b[(Intercept) g:1]"]; list(mean = mean(d), sd = sd(d)) })

# C: Bernoulli multilevel model ---------------------------------------------------------
n <- 300; G <- 15
g <- rep(1:G, length.out = n); x <- round(rnorm(n), 3); cond <- rep(c(0, 1), each = n / 2)
u <- rnorm(G, 0, 0.9)
yC <- rbinom(n, 1, plogis(-0.4 + 0.8 * x + 0.9 * cond + u[g]))
dC <- data.frame(y = yC, x, cond, g = factor(g))
fitC <- stan_glmer(y ~ x + cond + (1 | g), data = dC, family = binomial(),
  prior = normal(0, 2.5, autoscale = FALSE), prior_intercept = normal(0, 2.5, autoscale = FALSE),
  prior_covariance = decov(1, 1, 1, 1), chains = 4, iter = 6000, warmup = 1000, seed = 3, refresh = 0, adapt_delta = 0.95)
out$bernoulli <- list(data = dC, priors = list(coefSd = 2.5, interceptMean = 0, interceptSd = 2.5, tauRate = 1),
  post = summ(fitC, c("(Intercept)", "x", "cond")),
  sd_g = { d <- sqrt(as.matrix(fitC)[, "Sigma[g:(Intercept),(Intercept)]"]); list(mean = mean(d), sd = sd(d), q025 = unname(quantile(d, 0.025)), q50 = unname(quantile(d, 0.5)), q975 = unname(quantile(d, 0.975))) })

write(toJSON(out, digits = NA, auto_unbox = TRUE, dataframe = "columns"), "../fixtures/ref_rstanarm.json")
for (k in names(out)) { cat(k, ":\n"); for (p in out[[k]]$post) cat(sprintf("  %-14s %8.4f (sd %.4f)\n", p$name, p$mean, p$sd)); if (!is.null(out[[k]]$sd_g)) cat(sprintf("  %-14s %8.4f (sd %.4f)\n", "sd(g)", out[[k]]$sd_g$mean, out[[k]]$sd_g$sd)) }
