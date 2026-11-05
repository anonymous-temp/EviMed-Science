# ---------------------------------------------------------------------------
# bias_analysis.R — quantitative bias analysis of an estimate (comparator.bias_analysis; algorithm round C1, C2, 2026-11-03).
#
# The person's question is "how much would an unmeasured confounder have to shift this estimate before the conclusion turns?", and
# the second one, "given what I believe about the bias, what is the adjusted effect and its interval?". The E-value answers only how
# strong a confounder would have to be; this is the next two levels of bias analysis up (NICE RWE framework; FDA external-control
# draft; EU HTA guideline's "shifted null hypothesis"), kept apart from `comparator.tipping_point`, which is about missing outcomes.
#
# Hidden knowledge:
#
# - **One direction for every bias in this file: the bias that exaggerates the observed effect.** A hazard ratio of 0.70 is made to
#   look better by a bias factor of 1.25 when the true ratio is 0.70 x 1.25 = 0.875, and an observed 1.40 by 1.25 when the truth is
#   1.12. So a bias is stated as a ratio of at least 1 (an amount of at least 0 on the difference scale) that moves the estimate toward
#   the null when removed, whichever side of the null the estimate is on. A bias that goes the other way is a ratio below 1 in a
#   probabilistic draw and works out as it should.
# - **The analysis scale is the log for a ratio and the estimate itself for a difference.** An interval given as limits of a ratio
#   is read as symmetric on the log scale (the standard error is (log upper - log lower) / (2 z), z of the stated level, 0.95 by
#   default); a standard error given is the log ratio's. Nothing here refits a model: the estimate and its error are the inputs, taken
#   from a saved comparison by the platform or stated by the person.
# - **Four parts, each with its own meaning.** (1) The shifted null (EU HTA guideline): for each stated bias B the test of H0 "the
#   effect is no more than the bias", z = (|theta| - log B) / s, one-sided. (2) The tipping bias: the B at which the interval's limit nearer
#   the null reaches the null (and the one at which the estimate itself does): exp(|theta| - z s) and exp(|theta|); 1 when the interval
#   already contains the null. (3) The tipping confounder (tipr-style closed forms): for a binary confounder with prevalence p1 among the
#   exposed, p0 among the unexposed and outcome association gamma, the bias factor is (gamma p1 + 1 - p1) / (gamma p0 + 1 - p0); setting
#   it equal to the estimate gives the prevalence p1 (so the prevalence difference) that tips it, per association and for a stated p0 (at
#   p0 = 0 the smallest difference that can tip); for a normal confounder with unit variance the bias factor is gamma^delta, so delta =
#   log(estimate) / log(gamma). On the difference scale the bias is gamma (p1 - p0) and gamma delta. The arm that carries more of the
#   confounder is the treated arm when the estimate and the confounder's effect on the outcome lie on the same side of the null, and the
#   control arm otherwise (a protective estimate is exaggerated by a confounder that is more common among the controls); so the code
#   solves for the prevalence in the carrier arm given the prevalence in the other, and names the carrier. (4) The probabilistic analysis (Fox,
#   MacLehose & Lash): the bias parameters have stated distributions, each draw removes its bias from the estimate (the systematic error),
#   and a second pass adds the sampling error s * N(0, 1) to each adjusted draw (the combined uncertainty). The median and the 2.5 and
#   97.5 percentiles are simulated numbers and carry their Monte-Carlo error, and so does the share of draws whose adjusted effect is
#   still on the observed side of the null.
# - **The parameters are the person's, the arithmetic is the engine's.** The model reads the literature for a plausible range; every draw,
#   quantile and tipping point here is code. Defaults (the association grid) are listed in `diagnostics.biasAnalysis.assumed`, so
#   the page can name them as defaults.
# - **Draws are batched with a stream of their own per batch**, as the other simulations are: the same seed gives the same numbers on
#   any number of cores (the work is single-threaded; the streams make a cut-short run's finished batches those of the full run), and
#   the loop checks the cancel file and the CPU budget between batches and keeps the finished batches.
# ---------------------------------------------------------------------------

VCR_BIAS_RATIO_SCALES <- c("hazard_ratio", "risk_ratio", "odds_ratio")
VCR_BIAS_DEFAULT_ASSOCIATIONS <- c(1.5, 2, 3, 5)
VCR_BIAS_BATCH <- 20000L
VCR_BIAS_DEFAULT_DRAWS <- 100000L

#' The estimate and its error on the analysis scale. Aborts by name on an estimate the scale cannot hold or an interval that is not
#' one.
.vcr_bias_input <- function(sc) {
  scale <- as.character(sc$scale %||% "")
  if (!(scale %in% c(VCR_BIAS_RATIO_SCALES, "difference"))) vcr_abort("scenario_value_invalid", "scenario.scale", "The scale is hazard_ratio, risk_ratio, odds_ratio or difference.")
  ratio <- scale %in% VCR_BIAS_RATIO_SCALES
  est <- vcr_scalar(sc$estimate, NULL)
  if (is.null(est) || !is.finite(est)) vcr_abort("scenario_field_missing", "scenario.estimate", "State the estimate the bias analysis is about.")
  if (ratio && !(est > 0)) vcr_abort("scenario_value_invalid", "scenario.estimate", "A ratio is above 0.")
  level <- vcr_scalar(sc$confidenceLevel, 0.95)
  if (!(level > 0.5 && level < 1)) vcr_abort("scenario_value_invalid", "scenario.confidenceLevel", "The confidence level is between 0.5 and 1.")
  toscale <- if (ratio) log else identity
  theta <- toscale(est)
  se <- vcr_scalar(sc$se, NULL)
  lo <- vcr_scalar(sc$lower, NULL); hi <- vcr_scalar(sc$upper, NULL)
  if (is.null(se)) {
    if (is.null(lo) || is.null(hi)) vcr_abort("scenario_field_missing", "scenario.lower", "State the interval of the estimate (lower and upper), or its standard error on the log scale.")
    if (ratio && !(lo > 0 && hi > 0)) vcr_abort("scenario_value_invalid", "scenario.lower", "The limits of a ratio are above 0.")
    if (!(lo < hi)) vcr_abort("scenario_value_invalid", "scenario.lower", "The lower limit is below the upper one.")
    if (!(lo <= est && est <= hi)) vcr_abort("scenario_value_invalid", "scenario.estimate", "The estimate lies between its limits.")
    se <- (toscale(hi) - toscale(lo)) / (2 * stats::qnorm(1 - (1 - level) / 2))
  } else if (!(se > 0)) vcr_abort("scenario_value_invalid", "scenario.se", "The standard error is above 0.")
  sigma <- if (theta < 0) -1 else 1
  z <- stats::qnorm(0.975)
  list(scale = scale, ratio = ratio, estimate = est, theta = theta, se = se, sigma = sigma, magnitude = abs(theta),
       limitMagnitude = sigma * theta - z * se, z = z, level = level, statedLower = lo, statedUpper = hi,
       back = if (ratio) exp else identity)
}

#' The bias at which the interval's nearer limit (and, separately, the estimate) reaches the null: a ratio of at least 1, or an amount of
#' at least 0. The interval that already holds the null needs no bias (1, or 0), and says so.
vcr_bias_tipping <- function(inp) {
  none <- if (inp$ratio) 1 else 0
  list(estimate = inp$back(inp$magnitude), limit = if (inp$limitMagnitude > 0) inp$back(inp$limitMagnitude) else none,
       alreadyIncludesNull = !(inp$limitMagnitude > 0), none = none)
}

#' The shifted null hypothesis for each stated bias: H0 "the effect is no more than the bias", one-sided, with the estimate and the interval
#' taken back by the bias. `p` is the probability of a result at least as far from the shifted null by chance alone.
vcr_bias_shifted_null <- function(inp, biases) {
  lapply(biases, function(b) {
    beta <- if (inp$ratio) log(b) else b
    zs <- (inp$magnitude - beta) / inp$se
    adj <- inp$theta - inp$sigma * beta
    lo <- adj - inp$z * inp$se; hi <- adj + inp$z * inp$se
    list(bias = b, adjustedEstimate = inp$back(adj), lower = inp$back(lo), upper = inp$back(hi), z = zs, p = 1 - stats::pnorm(zs),
         excludesNull = lo > 0 || hi < 0)
  })
}

#' The prevalence, among the people who carry more of a binary confounder, that makes its bias factor `target` (a ratio of at least 1),
#' given the association `gamma` and the prevalence `r` among the people who carry less; NA when no prevalence in [0, 1] does.
#'
#' Hidden knowledge: the outcome's risk factor of an arm is f(p) = 1 + (gamma - 1) p. A confounder that RAISES the outcome (gamma above 1) must
#' be carried by the arm whose outcome looks better to be exaggerated by it, so f(carrier) / f(other) = target. One that LOWERS it (gamma below
#' 1) makes its carrier look better, so f(carrier) / f(other) = 1 / target: the arms trade places but the equation is NOT the same one with
#' the association turned over (the first version solved the gamma = 1 / gamma problem, which is a different confounder: a protective
#' association of 0.5 with no confounder among the controls tips an estimate of 0.7 at a treated prevalence of 0.6, not 0.4286, 2026-11-04).
#' A gamma of 1 carries no bias at all: NA.
.vcr_bias_tip_carrier <- function(target, gamma, r) {
  if (!is.finite(gamma) || abs(gamma - 1) < 1e-12) return(NA_real_)
  f_other <- 1 + (gamma - 1) * r
  want <- if (gamma > 1) target * f_other else f_other / target
  carrier <- (want - 1) / (gamma - 1)
  if (is.finite(carrier) && carrier >= r && carrier <= 1) carrier else NA_real_
}

#' The confounder that tips an estimate, for one stated association: `magnitude` is the bias to tip on the analysis scale (`inp$magnitude` for
#' the estimate, `inp$limitMagnitude` for the interval's nearer limit). The confounder that exaggerates the effect is more common in one arm
#' than in the other - which arm depends on the side of the null the estimate is on and on whether the confounder raises or lowers the outcome -
#' so the row names the arm that carries more of it (`carrier`: "treated" or "control"), the prevalence there, the prevalence difference, and
#' (a normal confounder of unit variance) the standardised mean difference between the arms.
.vcr_bias_tip_row <- function(inp, gamma, reference, magnitude) {
  if (!(magnitude > 0)) return(NULL)
  raises <- if (inp$ratio) gamma > 1 else gamma > 0
  carrier <- if ((inp$sigma > 0) == raises) "treated" else "control"
  strength <- if (inp$ratio) (if (gamma < 1) 1 / gamma else gamma) else abs(gamma)
  if (inp$ratio) {
    c1 <- .vcr_bias_tip_carrier(exp(magnitude), gamma, reference)
    list(carrier = carrier, carrierPrevalence = c1, prevalenceDifference = if (is.na(c1)) NA_real_ else c1 - reference, feasible = !is.na(c1),
         standardizedDifference = magnitude / log(strength))
  } else {
    c1 <- reference + magnitude / strength
    ok <- c1 <= 1
    list(carrier = carrier, carrierPrevalence = if (ok) c1 else NA_real_, prevalenceDifference = if (ok) magnitude / strength else NA_real_, feasible = ok,
         standardizedDifference = magnitude / strength)
  }
}

vcr_bias_confounder_tipping <- function(inp, gammas, reference) {
  lapply(gammas, function(g) list(association = g,
                                  estimate = .vcr_bias_tip_row(inp, g, reference, inp$magnitude),
                                  limit = .vcr_bias_tip_row(inp, g, reference, inp$limitMagnitude)))
}

# --- distributions of the bias parameters --------------------------------------------------------------------------------------------

#' Draws from a stated distribution (`constant`, `uniform`, `triangular`, `normal`, `lognormal`), n of them, from the current stream.
.vcr_bias_draw <- function(dist, n) {
  fam <- as.character(dist$family %||% "")
  num <- function(key) vcr_scalar(dist[[key]], NULL)
  switch(fam,
    constant = rep(num("value"), n),
    uniform = stats::runif(n, num("min"), num("max")),
    triangular = {
      a <- num("min"); b <- num("max"); m <- num("mode"); u <- stats::runif(n); fc <- (m - a) / (b - a)
      ifelse(u < fc, a + sqrt(u * (b - a) * (m - a)), b - sqrt((1 - u) * (b - a) * (b - m)))
    },
    normal = stats::rnorm(n, num("mean"), num("sd")),
    lognormal = exp(stats::rnorm(n, log(num("median")), num("sdlog"))),
    vcr_abort("scenario_value_invalid", "scenario.probabilistic", sprintf("The distribution '%s' is not one of constant, uniform, triangular, normal, lognormal.", fam)))
}

#' A distribution's support is checked before any draw: `kind` is "probability" (inside [0, 1]), "ratio" (above 0) or "any".
.vcr_bias_check_dist <- function(dist, kind, field, allowed) {
  fam <- as.character(dist$family %||% "")
  if (!(fam %in% allowed)) vcr_abort("scenario_value_invalid", field, sprintf("%s is described by %s.", field, paste(allowed, collapse = ", ")))
  num <- function(key) vcr_scalar(dist[[key]], NULL)
  lo <- switch(fam, constant = num("value"), uniform = , triangular = num("min"), normal = -Inf, lognormal = 0)
  hi <- switch(fam, constant = num("value"), uniform = , triangular = num("max"), normal = Inf, lognormal = Inf)
  if (fam %in% c("uniform", "triangular") && !(lo < hi)) vcr_abort("scenario_value_invalid", field, "The minimum is below the maximum.")
  if (identical(fam, "triangular") && !(num("mode") >= lo && num("mode") <= hi)) vcr_abort("scenario_value_invalid", field, "The mode lies between the minimum and the maximum.")
  if (identical(kind, "probability") && !(lo >= 0 && hi <= 1)) vcr_abort("scenario_value_invalid", field, "A prevalence lies between 0 and 1.")
  # a lognormal is a positive ratio by construction, and a normal bias on a ratio scale is a normal log-ratio (it needs no sign)
  if (identical(kind, "ratio") && !(fam %in% c("lognormal", "normal")) && !(lo > 0)) vcr_abort("scenario_value_invalid", field, "A ratio is above 0.")
  invisible(TRUE)
}

#' The probabilistic analysis. `spec` is `list(bias = <dist>)` (the bias that exaggerates the effect, a ratio or an amount) or
#' `list(confounder = list(exposedPrevalence, unexposedPrevalence, association))`; `n` draws in batches; returns the systematic-only and
#' the combined (plus sampling error) distributions, on the reporting scale, and the share of the combined draws still on the observed side
#' of the null. A run cut short by the CPU budget keeps its finished batches and says so.
vcr_bias_probabilistic <- function(inp, spec, n, seed, batch = VCR_BIAS_BATCH) {
  model <- if (!is.null(spec$bias)) "bias" else "confounder"
  if (identical(model, "bias")) {
    .vcr_bias_check_dist(spec$bias, if (inp$ratio) "ratio" else "any", "scenario.probabilistic.bias", if (inp$ratio) c("constant", "uniform", "triangular", "normal", "lognormal") else c("constant", "uniform", "triangular", "normal"))
  } else {
    cf <- spec$confounder
    for (k in c("exposedPrevalence", "unexposedPrevalence")) .vcr_bias_check_dist(cf[[k]], "probability", paste0("scenario.probabilistic.confounder.", k), c("constant", "uniform", "triangular"))
    .vcr_bias_check_dist(cf$association, if (inp$ratio) "ratio" else "any", "scenario.probabilistic.confounder.association",
                         if (inp$ratio) c("constant", "uniform", "triangular", "lognormal") else c("constant", "uniform", "triangular", "normal"))
  }
  batches <- ceiling(n / batch)
  streams <- vcr_stream_bank(seed)$take(batches)
  sys_draws <- numeric(0); comb_draws <- numeric(0); done <- 0L; interrupted <- NULL
  for (b in seq_len(batches)) {
    reason <- vcr_interrupt()
    if (!is.null(reason)) { interrupted <- reason; break }
    m <- min(batch, n - length(sys_draws))
    out <- vcr_with_stream(streams[[b]], function(.) {
      adj <- if (identical(model, "bias")) {
        draw <- .vcr_bias_draw(spec$bias, m)
        inp$theta - inp$sigma * (if (inp$ratio) log(draw) else draw)
      } else {
        p1 <- .vcr_bias_draw(cf$exposedPrevalence, m); p0 <- .vcr_bias_draw(cf$unexposedPrevalence, m); g <- .vcr_bias_draw(cf$association, m)
        inp$theta - (if (inp$ratio) log((g * p1 + 1 - p1) / (g * p0 + 1 - p0)) else g * (p1 - p0))
      }
      list(sys = adj, comb = adj + inp$se * stats::rnorm(m))
    }, b)
    sys_draws <- c(sys_draws, out$sys); comb_draws <- c(comb_draws, out$comb); done <- done + 1L
  }
  if (!length(sys_draws)) return(list(draws = 0L, interrupted = interrupted))
  q <- function(x, p) as.numeric(stats::quantile(x, p, names = FALSE, type = 7))
  desc <- function(x) {
    ps <- c(0.025, 0.5, 0.975)
    list(median = inp$back(q(x, 0.5)), low = inp$back(q(x, 0.025)), high = inp$back(q(x, 0.975)),
         medianMcse = abs(inp$back(q(x, 0.5) + vcr_quantile_mcse(x, 0.5)) - inp$back(q(x, 0.5) - vcr_quantile_mcse(x, 0.5))) / 2,
         lowMcse = abs(inp$back(q(x, 0.025) + vcr_quantile_mcse(x, 0.025)) - inp$back(q(x, 0.025) - vcr_quantile_mcse(x, 0.025))) / 2,
         highMcse = abs(inp$back(q(x, 0.975) + vcr_quantile_mcse(x, 0.975)) - inp$back(q(x, 0.975) - vcr_quantile_mcse(x, 0.975))) / 2)
  }
  persists <- mean(inp$sigma * comb_draws > 0); persists_sys <- mean(inp$sigma * sys_draws > 0); N <- length(comb_draws)
  list(model = model, draws = N, requested = n, batches = done, interrupted = interrupted,
       systematic = desc(sys_draws), combined = desc(comb_draws),
       persists = persists, persistsMcse = sqrt(persists * (1 - persists) / N),
       persistsSystematic = persists_sys, persistsSystematicMcse = sqrt(persists_sys * (1 - persists_sys) / N))
}

# --- the job -------------------------------------------------------------------------------------------------------------------------

vcr_job_bias_analysis <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  inp <- .vcr_bias_input(sc)
  unit_word <- if (inp$ratio) "ratio" else "amount"
  assumed <- list()
  note_default <- function(key, value, basis) assumed[[length(assumed) + 1L]] <<- list(key = key, value = value, basis = basis)
  if (is.null(sc$lower) && is.null(sc$se)) vcr_abort("scenario_field_missing", "scenario.lower", "State the interval of the estimate, or its standard error.")
  if (is.null(sc$confidenceLevel) && !is.null(sc$lower)) note_default("confidenceLevel", 0.95, "the usual level of a published interval")

  tip <- vcr_bias_tipping(inp)

  shifted <- NULL
  if (!is.null(sc$shiftedNull)) {
    biases <- vcr_num(sc$shiftedNull$biases)
    if (!length(biases) || anyNA(biases)) vcr_abort("scenario_value_invalid", "scenario.shiftedNull.biases", "State the biases the effect is tested against.")
    if (any(biases < (if (inp$ratio) 1 else 0))) vcr_abort("scenario_value_invalid", "scenario.shiftedNull.biases",
      if (inp$ratio) "A bias is a ratio of at least 1 (1.25: the observed effect is exaggerated by a quarter)." else "A bias is an amount of at least 0.")
    shifted <- vcr_bias_shifted_null(inp, biases)
  }

  conf <- NULL
  ct <- sc$confounderTipping
  gammas <- vcr_num(ct$associations)
  if (!length(gammas)) {
    if (inp$ratio) { gammas <- VCR_BIAS_DEFAULT_ASSOCIATIONS; note_default("confounderTipping.associations", as.list(gammas), "a grid of confounder-outcome associations (ratios), not anything about this study") }
  } else if (anyNA(gammas) || (inp$ratio && any(gammas <= 0)) || any(gammas == (if (inp$ratio) 1 else 0))) {
    vcr_abort("scenario_value_invalid", "scenario.confounderTipping.associations",
              if (inp$ratio) "An association is a ratio above 0 and not 1 (a confounder with no association cannot tip anything)." else "An association is an amount other than 0.")
  }
  p0 <- vcr_scalar(ct$baselinePrevalence, NULL)
  if (is.null(p0)) { p0 <- 0; if (length(gammas)) note_default("confounderTipping.baselinePrevalence", 0, "none in the arm that has less of the confounder: the smallest prevalence difference that can tip the estimate") }
  if (!(p0 >= 0 && p0 < 1)) vcr_abort("scenario_value_invalid", "scenario.confounderTipping.baselinePrevalence", "A prevalence lies between 0 and 1.")
  if (length(gammas)) conf <- vcr_bias_confounder_tipping(inp, gammas, p0)

  prob <- NULL; interrupted <- NULL
  if (!is.null(sc$probabilistic)) {
    asked <- vcr_scalar(job$replicates, NULL)
    floor_ <- as.integer(vcr_limit("replicatesNullMin", 20000L))
    n <- as.integer(max(floor_, asked %||% VCR_BIAS_DEFAULT_DRAWS))
    prob <- vcr_bias_probabilistic(inp, sc$probabilistic, n, job$seed)
    if (is.null(asked)) note_default("draws", n, "the default number of simulations of the probabilistic analysis")
    interrupted <- prob$interrupted
    if (identical(interrupted, "canceled")) return(list(status = "canceled", measures = list(), counts = vcr_counts(), diagnostics = list(draws = prob$draws)))
    if (prob$draws == 0L) {
      return(list(status = "failed", measures = list(), counts = vcr_counts(),
                  issues = list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", "The CPU budget ran out before the first batch of simulations; no probabilistic result is reported.")),
                  diagnostics = list(draws = 0L)))
    }
  }

  measures <- list(
    vcr_measure("bias_tipping_limit", tip$limit, source = "calculated"),
    vcr_measure("bias_tipping_estimate", tip$estimate, source = "calculated"))
  if (!is.null(prob)) {
    cb <- prob$combined
    measures <- c(measures, list(
      vcr_measure("bias_adjusted_estimate", cb$median, simulated = TRUE, mcse = cb$medianMcse, interval = vcr_interval("monte_carlo", cb$low, cb$high), source = "calculated"),
      vcr_measure("bias_adjusted_effect_persists", prob$persists, simulated = TRUE, mcse = prob$persistsMcse, source = "calculated")))
  }

  diag <- list(
    scale = inp$scale, reading = "the bias that exaggerates the observed effect, toward the null when removed",
    given = list(estimate = inp$estimate, lower = inp$statedLower, upper = inp$statedUpper, se = if (!is.null(sc$se)) vcr_scalar(sc$se) else NULL,
                 confidenceLevel = if (!is.null(sc$lower)) inp$level else NULL, standardError = inp$se, standardErrorScale = if (inp$ratio) "log" else "difference",
                 interval = c(inp$back(inp$theta - inp$z * inp$se), inp$back(inp$theta + inp$z * inp$se)), direction = if (inp$sigma < 0) "below_the_null" else "above_the_null"),
    tipping = list(estimate = tip$estimate, limit = tip$limit, alreadyIncludesNull = tip$alreadyIncludesNull, none = tip$none, unit = unit_word),
    shiftedNull = if (!is.null(shifted)) list(rows = shifted, test = "H0: the effect is no more than the bias; one-sided; z = (|estimate| - bias) / standard error on the analysis scale") else NULL,
    confounderTipping = if (!is.null(conf)) list(rows = conf, baselinePrevalence = p0,
      basis = if (inp$ratio) "binary confounder: bias factor (gamma p1 + 1 - p1) / (gamma p0 + 1 - p0) set equal to the estimate; a normal confounder of unit variance: gamma^delta"
              else "binary confounder: bias gamma (p1 - p0); a standardised confounder: gamma delta") else NULL,
    probabilistic = if (!is.null(prob)) list(
      model = prob$model, draws = prob$draws, requested = prob$requested, batches = prob$batches, interrupted = prob$interrupted,
      stated = sc$probabilistic,
      systematic = list(median = prob$systematic$median, low = prob$systematic$low, high = prob$systematic$high,
                        medianMcse = prob$systematic$medianMcse, lowMcse = prob$systematic$lowMcse, highMcse = prob$systematic$highMcse),
      combined = list(median = prob$combined$median, low = prob$combined$low, high = prob$combined$high,
                      medianMcse = prob$combined$medianMcse, lowMcse = prob$combined$lowMcse, highMcse = prob$combined$highMcse),
      persists = prob$persists, persistsMcse = prob$persistsMcse, persistsSystematic = prob$persistsSystematic, persistsSystematicMcse = prob$persistsSystematicMcse,
      basis = "each draw takes its bias from the estimate (systematic error); a second pass adds the standard error times a standard normal draw (combined uncertainty)") else NULL,
    assumed = assumed)
  c(list(status = "succeeded", measures = measures, counts = vcr_counts(),
         diagnostics = c(list(biasAnalysis = diag), if (!is.null(interrupted)) list(limitedBy = list("cpu_budget_exhausted")))),
    if (!is.null(interrupted)) list(conclusion = "limited"))
}
