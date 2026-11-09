# ---------------------------------------------------------------------------
# decision_voi.R — which uncertainty is worth resolving before the decision is taken (decision.value_of_information; in-silico round 2, R35,
# 2026-11-09).
#
# The person has a decision (which design to run, or whether to run one at all) and a utility for each option, and some inputs they do not know.
# The question is "which of those unknowns, if learned, would change the decision, and by how much is the decision worth it": the expected value of
# perfect information (EVPI), the expected value of perfect *partial* information on each input (EVPPI) and the expected value of the
# sample information a named study would give (EVSI).
#
# Hidden knowledge:
#
# - **One sample, three numbers, no nested loop.** The engine draws the uncertain inputs once (S draws, one uniform stream per input in a fixed
#   order, so the same seed gives the same numbers on any core count), evaluates every option's utility on every draw, and then
#     EVPI  = mean_s max_d U_d(s)  -  max_d mean_s U_d(s)
#     EVPPI = mean_s max_d g_d(phi_s) -  max_d mean_s U_d(s), g_d = a GAM fit of U_d on the input(s) phi (Strong, Oakley & Brennan 2014)
#     EVSI  = the same with phi replaced by a summary of the data a study would produce, simulated from each draw (Strong et al. 2015).
#   A GAM fit has residuals that sum to zero, so mean_s g_d = mean_s U_d and an EVPPI is never below zero; it can exceed the EVPI by estimation
#   error, and the table says the share it is, not a clipped one.
# - **The Monte-Carlo error of an estimate is the error of the average over the draws** (per draw: the best fitted utility minus the chosen
#   option's fitted utility; over 40 repeated samples of a known problem its mean was 0.0058 against a true spread of 0.0067). It does not include the smoothing error of the regression, which is why the basis is fixed and stated
#   (a cubic regression spline of ten knots for one input, a tensor product of five per margin for two or three, four for four) and a case holds it
#   to the `voi` package and to closed forms. A very small discrete input (ten values or fewer) is conditioned on exactly (group means), with no
#   smoothing at all.
# - **An input with no proper distribution has no EVPPI.** A triple of optimistic, base and pessimistic values is not a prior, so a `range` input
#   is held at its base value in every draw and gets a threshold instead: the value at which the best option changes, found on the same draws
#   (bisection on the best option of the expected utilities), with a bootstrap standard error of the threshold. Nothing about its probability is said.
# - **The built-in model is an analytic power, and says so.** `two_arm_continuous` evaluates, for each draw, the power of a two-arm trial with a
#   continuous endpoint: n(1 - dropout) analysed per arm, standard error sd sqrt(2 / n_analysed), one-sided alpha. Dropout is only a loss of analysed
#   people (completely at random); the effect is either an absolute difference or a share (`proportional_slowing`) of the control arm's worsening.
#   Success is the significant result's expected probability given the drawn truth (the inner expectation, not a 0/1 draw). Utility is that
#   probability, or `successValue` times it minus `costPerPatient` times the people enrolled. An option with no patients is not running a trial
#   and has utility 0. A decision whose utilities come from anywhere else (an engine campaign, a model of the person's own) enters as a `table`.
# - **The table form is the `voi` package's own interface**: one numeric column per option's utility and one per input, same length. The engine
#   does not know where the numbers came from and says so in the premises.
# - **A study is a summary statistic with its noise.** `phase2_effect` (m per arm) observes the true effect plus N(0, 2 sd^2 / m);
#   `natural_history_control` (n people) observes the control worsening plus N(0, sd^2 / n); `normal_known` observes a named input plus
#   N(0, sd^2 / size). The EVSI is the EVPPI of that summary, so it cannot exceed the EVPPI of the input it observes (the table shows that ceiling).
# - **The engine ranks and does not recommend.** `next` names the input with the largest EVPPI and the study with the largest EVSI; whether the
#   value covers what the step costs is the person's decision (no cost of a study is assumed).
# ---------------------------------------------------------------------------

VCR_VOI_ROLES <- c("effect", "sd", "dropoutShare", "controlProgression")
VCR_VOI_MIN_DRAWS <- 30L
VCR_VOI_DEFAULT_DRAWS <- 10000L
VCR_VOI_EXACT_LEVELS <- 10L

# --- the three estimators on a utility matrix -----------------------------------------------------------------------

#' EVPI of a draws-by-options utility matrix, with the chosen option (the best expected utility) and the share of draws where another option was better.
vcr_voi_evpi <- function(U) {
  U <- as.matrix(U); S <- nrow(U)
  means <- colMeans(U)
  best <- which.max(means)
  mx <- apply(U, 1L, max)
  d <- mx - U[, best]
  list(evpi = mean(d), mcse = stats::sd(d) / sqrt(S), best = best, means = means, wrong = mean(U[, best] < mx),
       bestMcse = stats::sd(U[, best]) / sqrt(S))
}

#' The regression basis of an EVPPI on `k` inputs with `u` distinct values (see the header).
.vcr_voi_formula <- function(names_, u) {
  if (length(names_) == 1L) sprintf("s(%s, bs = 'cr', k = %d)", names_, as.integer(min(10L, max(3L, u - 1L))))
  else sprintf("te(%s, bs = 'cr', k = %d)", paste(names_, collapse = ", "), if (length(names_) >= 4L) 4L else 5L)
}

#' The fitted conditional expectation of each option's utility given the columns `cols` of `Phi`.
.vcr_voi_fit <- function(U, Phi, cols) {
  P <- as.matrix(Phi[, cols, drop = FALSE]); S <- nrow(P)
  key <- if (ncol(P) == 1L) P[, 1L] else do.call(paste, c(as.data.frame(P), sep = "\r"))
  levels_ <- length(unique(key))
  if (levels_ <= 1L) return(matrix(rep(colMeans(U), each = S), S))
  if (levels_ <= VCR_VOI_EXACT_LEVELS) {
    g <- match(key, unique(key))
    return(apply(U, 2L, function(y) stats::ave(y, g)))
  }
  df <- as.data.frame(P); names(df) <- paste0("x", seq_len(ncol(P)))
  form <- .vcr_voi_formula(names(df), levels_)
  # the fit of one option; a failure of the smoother is reported by the caller, never a zero
  vapply(seq_len(ncol(U)), function(d) {
    df$y <- U[, d]
    as.numeric(mgcv::gam(stats::as.formula(paste("y ~", form)), data = df)$fitted.values)
  }, numeric(S))
}

#' EVPPI of the inputs `cols` (a column or a group of columns of `Phi`) given the utilities `U` and the chosen option of `base`.
vcr_voi_evppi <- function(U, Phi, cols, base = vcr_voi_evpi(U)) {
  U <- as.matrix(U); S <- nrow(U)
  fit <- .vcr_voi_fit(U, Phi, cols)
  # a fit's mean is the option's mean, so the estimate is the average of (best fitted utility - the chosen option's fitted utility); the error of that
  # average is the spread of the same quantity (an input that moves nothing has fitted lines that are constants: no spread, no error)
  d <- apply(fit, 1L, max) - fit[, base$best]
  list(evppi = mean(d), mcse = stats::sd(d) / sqrt(S))
}

# --- reading the scenario ------------------------------------------------------------------------------------------

.vcr_voi_assume <- function(p, key, value, basis = "default") {
  p$assumed[[length(p$assumed) + 1L]] <- list(key = key, value = value, basis = basis)
  p
}

.vcr_voi_spec_family <- function(spec) as.character(spec[["family"]] %||% "")

#' The quantile function of an uncertain input's distribution, or NULL for a fixed value or a range.
.vcr_voi_quantile <- function(spec, role) {
  fam <- .vcr_voi_spec_family(spec)
  num <- function(k) vcr_scalar(spec[[k]], NULL)
  switch(fam,
    normal = { m <- num("mean"); s <- num("sd"); function(u) stats::qnorm(u, m, s) },
    lognormal = { m <- num("meanlog"); s <- num("sdlog"); function(u) stats::qlnorm(u, m, s) },
    beta = { a <- num("alpha"); b <- num("beta"); function(u) stats::qbeta(u, a, b) },
    uniform = { lo <- num("min"); hi <- num("max")
      if (!(lo < hi)) vcr_abort("scenario_value_invalid", sprintf("scenario.inputs.%s", role), "A uniform input has a minimum below its maximum.")
      function(u) lo + u * (hi - lo) },
    NULL)
}

#' The value an input has at its base: the fixed value, the base of a range, or the median of its distribution.
.vcr_voi_base_value <- function(spec, role) {
  fam <- .vcr_voi_spec_family(spec)
  if (identical(fam, "fixed")) return(vcr_scalar(spec[["value"]], NULL))
  if (identical(fam, "range")) return(vcr_scalar(spec[["base"]], NULL))
  .vcr_voi_quantile(spec, role)(0.5)
}

.vcr_voi_check_role_values <- function(role, v) {
  bad <- function(why) vcr_abort("scenario_value_invalid", sprintf("scenario.inputs.%s", role), why)
  if (any(!is.finite(v))) bad("An input of the decision has to be a finite number in every draw.")
  if (identical(role, "sd") && any(v <= 0)) bad("The standard deviation is positive in every draw; use a lognormal distribution for it.")
  if (identical(role, "dropoutShare") && any(v < 0 | v >= 1)) bad("The dropout share is in [0, 1) in every draw; use a beta or a uniform distribution for it.")
  if (identical(role, "controlProgression") && any(v < 0)) bad("The control arm's worsening is not negative in any draw; use a lognormal or a beta-scaled distribution for it.")
  invisible(TRUE)
}

#' The power-based utility of every option on a set of draws (vectors recycled to the longest).
vcr_voi_two_arm_utilities <- function(n_per_arm, delta, sd, dropout, alpha, utility, success_value, cost_per_patient) {
  len <- max(length(delta), length(sd), length(dropout))
  delta <- rep_len(delta, len); sd <- rep_len(sd, len); dropout <- rep_len(dropout, len)
  zc <- stats::qnorm(1 - alpha)
  U <- vapply(n_per_arm, function(n) {
    if (n <= 0) return(numeric(len))
    neff <- n * (1 - dropout)
    p <- stats::pnorm(delta / (sd * sqrt(2 / neff)) - zc)
    if (identical(utility, "success_probability")) p else success_value * p - cost_per_patient * 2 * n
  }, numeric(len))
  matrix(U, nrow = len)
}

#' Everything the two-arm model reads, validated: a list the draws and the threshold analysis share.
.vcr_voi_read_two_arm <- function(sc) {
  p <- list(assumed = list(), notApplied = list())
  opts <- sc[["options"]]
  if (!is.list(opts) || length(opts) < 2L) vcr_abort("scenario_field_missing", "scenario.options", "A decision has at least two options.")
  p$labels <- vapply(opts, function(o) as.character(o[["label"]] %||% ""), character(1))
  p$n <- vapply(opts, function(o) vcr_scalar(o[["nPerArm"]], NA_real_), numeric(1))
  if (any(is.na(p$n)) || any(!nzchar(p$labels))) vcr_abort("scenario_value_invalid", "scenario.options", "Each option has a label and a number of people per arm (0 for no trial).")
  if (anyDuplicated(p$labels)) vcr_abort("scenario_value_invalid", "scenario.options", "The option labels differ from each other.")
  p$utility <- as.character(sc[["utility"]] %||% "")
  p$value <- vcr_scalar(sc[["successValue"]], NULL); p$cost <- vcr_scalar(sc[["costPerPatient"]], 0)
  if (identical(p$utility, "net_benefit") && is.null(p$value)) vcr_abort("scenario_field_missing", "scenario.successValue", "A net benefit states the value of a successful trial.")
  if (identical(p$utility, "success_probability") && (!is.null(sc[["successValue"]]) || !is.null(sc[["costPerPatient"]]))) {
    p$notApplied <- c(p$notApplied, list(vcr_not_applied("successValue", "the utility is the probability of success; a value and a cost belong to a net benefit")))
  }
  p$alpha <- vcr_scalar(sc[["alpha"]], 0.025)
  if (is.null(sc[["alpha"]])) p <- .vcr_voi_assume(p, "alpha", 0.025, "default")
  p$scale <- as.character(sc[["effectScale"]] %||% "absolute")
  inputs <- sc[["inputs"]]
  p$specs <- list()
  for (role in VCR_VOI_ROLES) {
    if (!is.null(inputs[[role]])) p$specs[[role]] <- inputs[[role]]
  }
  if (is.null(p$specs$effect) || is.null(p$specs$sd)) vcr_abort("scenario_field_missing", "scenario.inputs", "The effect and the standard deviation are stated (fixed, uncertain or a range).")
  if (identical(p$scale, "proportional_slowing") && is.null(p$specs$controlProgression)) {
    vcr_abort("scenario_field_missing", "scenario.inputs.controlProgression", "An effect stated as a share of the control arm's worsening needs that worsening.")
  }
  if (identical(p$scale, "absolute") && !is.null(p$specs$controlProgression)) {
    p$notApplied <- c(p$notApplied, list(vcr_not_applied("inputs.controlProgression", "an absolute effect does not depend on the control arm's worsening; the input is used only by a study of it")))
  }
  if (is.null(p$specs$dropoutShare)) {
    p$specs$dropoutShare <- list(family = "fixed", value = 0)
    p <- .vcr_voi_assume(p, "inputs.dropoutShare", 0, "default")
  }
  p
}

#' The utility matrix of the two-arm model for given role values (each a vector or a scalar).
.vcr_voi_two_arm_matrix <- function(p, vals) {
  delta <- if (identical(p$scale, "proportional_slowing")) vals$effect * vals$controlProgression else vals$effect
  vcr_voi_two_arm_utilities(p$n, delta, vals$sd, vals$dropoutShare, p$alpha, p$utility, p$value, p$cost)
}

# --- thresholds of a range input ------------------------------------------------------------------------------------

#' The values of `x` between the two ends of a range at which the best option changes, on the given draws.
.vcr_voi_flips <- function(best_at, lo, hi, grid = 41L) {
  xs <- seq(lo, hi, length.out = grid)
  b <- vapply(xs, best_at, integer(1))
  out <- list()
  for (i in seq_len(grid - 1L)) {
    if (b[i] == b[i + 1L]) next
    a <- xs[i]; z <- xs[i + 1L]; left <- b[i]
    for (it in seq_len(45L)) {
      mid <- (a + z) / 2
      if (best_at(mid) == left) a <- mid else z <- mid
    }
    out[[length(out) + 1L]] <- list(value = (a + z) / 2, from = b[i], to = b[i + 1L])
  }
  out
}

#' Run `fn` on a stream of its own (`seed`) and leave the stream in use exactly where it was: a step that draws only sometimes (a bootstrap that runs when a
#' range input flips, a shuffled baseline) must not move the numbers drawn after it (review S18: the threshold bootstrap reseeded the global stream, so the
#' EVSI noise drawn afterwards depended on whether and where an input flipped).
.vcr_voi_own_stream <- function(seed, fn) {
  old <- if (exists(".Random.seed", envir = globalenv(), inherits = FALSE)) get(".Random.seed", envir = globalenv()) else NULL
  on.exit(if (is.null(old)) { if (exists(".Random.seed", envir = globalenv(), inherits = FALSE)) rm(".Random.seed", envir = globalenv()) } else assign(".Random.seed", old, envir = globalenv()), add = TRUE)
  set.seed(seed, kind = VCR_RNG_KIND)
  fn()
}

.vcr_voi_threshold <- function(role, spec, p, draws, S, unit, stopped_fn) {
  vals_stated <- c(optimistic = vcr_scalar(spec[["optimistic"]], NA), base = vcr_scalar(spec[["base"]], NA), pessimistic = vcr_scalar(spec[["pessimistic"]], NA))
  if (any(is.na(vals_stated))) vcr_abort("scenario_field_missing", sprintf("scenario.inputs.%s", role), "A range states its optimistic, base and pessimistic values.")
  lo <- min(vals_stated); hi <- max(vals_stated)
  fixed_vals <- lapply(draws, identity)
  best_with <- function(draw_set) function(x) {
    v <- draw_set; v[[role]] <- x
    m <- colMeans(.vcr_voi_two_arm_matrix(p, v))
    which.max(m)
  }
  best_at <- best_with(fixed_vals)
  at <- vapply(vals_stated, best_at, integer(1))
  flips <- if (hi > lo) .vcr_voi_flips(best_at, lo, hi) else list()
  rows <- list()
  for (f in flips) {
    # the bootstrap standard error of the threshold: the same search on resampled draws
    found <- numeric(0)
    if (is.null(stopped_fn())) found <- .vcr_voi_own_stream(1000L + as.integer(round(f$value * 1e6)) %% 100000L, function() {
      out <- numeric(0)
      for (b in seq_len(30L)) {
        idx <- sample.int(S, S, replace = TRUE)
        dr <- lapply(draws, function(v) if (length(v) == S) v[idx] else v)
        fl <- .vcr_voi_flips(best_with(dr), lo, hi, grid = 21L)
        hit <- Filter(function(g) g$from == f$from && g$to == f$to, fl)
        if (length(hit)) out <- c(out, hit[[1L]]$value)
      }
      out
    })
    mcse <- if (length(found) >= 10L) stats::sd(found) else (hi - lo) / 2
    rows[[length(rows) + 1L]] <- list(value = f$value, from = p$labels[f$from], to = p$labels[f$to], mcse = mcse,
                                      reproduced = length(found), resamples = 30L)
  }
  list(input = role, optimistic = unname(vals_stated["optimistic"]), base = unname(vals_stated["base"]), pessimistic = unname(vals_stated["pessimistic"]),
       decisionAt = list(optimistic = p$labels[at["optimistic"]], base = p$labels[at["base"]], pessimistic = p$labels[at["pessimistic"]]),
       flips = rows)
}

# --- the studies ---------------------------------------------------------------------------------------------------

.vcr_voi_study_summary <- function(study, role_draws, Phi, S, model) {
  kind <- as.character(study[["kind"]] %||% "")
  m <- vcr_scalar(study[["size"]], NULL)
  if (is.null(m) || m < 2) vcr_abort("scenario_value_invalid", "scenario.studies", "A study has a size of at least two.")
  noise <- stats::rnorm(S)
  if (identical(model, "two_arm_continuous")) {
    if (!(kind %in% c("phase2_effect", "natural_history_control"))) vcr_abort("scenario_value_invalid", "scenario.studies", sprintf("A study of kind %s is for the table form; the two-arm decision takes phase2_effect or natural_history_control.", kind))
    if (identical(kind, "phase2_effect")) list(T = role_draws$delta + noise * role_draws$sd * sqrt(2 / m), observes = "effect")
    else {
      if (is.null(role_draws$controlProgression)) vcr_abort("scenario_value_invalid", "scenario.studies", "A natural-history study needs the control arm's worsening as an input.")
      list(T = role_draws$controlProgression + noise * role_draws$sd / sqrt(m), observes = "controlProgression")
    }
  } else {
    if (!identical(kind, "normal_known")) vcr_abort("scenario_value_invalid", "scenario.studies", "A study of a table decision is normal_known: a named input observed with a known standard deviation.")
    nm <- as.character(study[["input"]] %||% ""); sd_ <- vcr_scalar(study[["sd"]], NULL)
    if (!(nm %in% colnames(Phi)) || is.null(sd_) || !(sd_ > 0)) vcr_abort("scenario_value_invalid", "scenario.studies", "A normal_known study names an input of the table and a positive standard deviation.")
    list(T = Phi[, nm] + noise * sd_ / sqrt(m), observes = nm)
  }
}

# --- the handler ---------------------------------------------------------------------------------------------------

.vcr_voi_table <- function(sc, S_req) {
  read <- function(key) {
    m <- sc[[key]]
    if (!is.list(m) || !length(m)) vcr_abort("scenario_field_missing", sprintf("scenario.%s", key), sprintf("The table form states %s: one list of numbers per name.", key))
    out <- lapply(m, vcr_num)
    n <- unique(vapply(out, length, integer(1)))
    if (length(n) != 1L) vcr_abort("scenario_value_invalid", sprintf("scenario.%s", key), "Every list of the table has the same length.")
    if (any(!is.finite(unlist(out)))) vcr_abort("scenario_value_invalid", sprintf("scenario.%s", key), "Every number of the table is finite.")
    do.call(cbind, out)
  }
  U <- read("utilities"); Phi <- read("draws")
  if (nrow(U) != nrow(Phi)) vcr_abort("scenario_value_invalid", "scenario.draws", "The utilities and the inputs have the same number of draws.")
  if (nrow(U) < VCR_VOI_MIN_DRAWS) vcr_abort("scenario_value_invalid", "scenario.draws", sprintf("A regression needs at least %d draws.", VCR_VOI_MIN_DRAWS))
  if (ncol(U) < 2L) vcr_abort("scenario_value_invalid", "scenario.utilities", "A decision has at least two options.")
  list(U = U, Phi = Phi)
}

vcr_job_decision_voi <- function(job, ...) {
  sc <- job$scenario
  source <- as.character(sc[["source"]] %||% "two_arm_continuous")
  S <- as.integer(vcr_scalar(job[["replicates"]], VCR_VOI_DEFAULT_DRAWS))
  assumed <- list(); not_applied <- list()
  set.seed(as.integer(as.numeric(vcr_scalar(job[["seed"]], 1)) %% 2147483647), kind = VCR_RNG_KIND)
  p <- NULL; draws <- list(); thresholds <- list(); unit <- as.character(sc[["unit"]] %||% "")

  if (identical(source, "two_arm_continuous")) {
    if (S < VCR_VOI_MIN_DRAWS) vcr_abort("replicates_invalid", "replicates", sprintf("A regression needs at least %d draws.", VCR_VOI_MIN_DRAWS))
    p <- .vcr_voi_read_two_arm(sc)
    assumed <- p$assumed; not_applied <- p$notApplied
    # draws: one uniform stream per uncertain input, in the order of VCR_VOI_ROLES; the others are a single value
    vals <- list(); uncertain <- character(0); ranges <- character(0)
    for (role in VCR_VOI_ROLES) {
      spec <- p$specs[[role]]
      if (is.null(spec)) next
      q <- .vcr_voi_quantile(spec, role)
      fam <- .vcr_voi_spec_family(spec)
      if (!is.null(q)) { v <- q(stats::runif(S)); uncertain <- c(uncertain, role) }
      else {
        v <- .vcr_voi_base_value(spec, role)
        if (is.null(v)) vcr_abort("scenario_field_missing", sprintf("scenario.inputs.%s", role), "A fixed input states its value.")
        if (identical(fam, "range")) ranges <- c(ranges, role)
      }
      .vcr_voi_check_role_values(role, v)
      vals[[role]] <- v
    }
    if (!length(uncertain)) vcr_abort("scenario_value_invalid", "scenario.inputs", "At least one input has a distribution; with none there is nothing to be uncertain about.")
    draws <- vals
    delta <- if (identical(p$scale, "proportional_slowing")) vals$effect * vals$controlProgression else vals$effect
    role_draws <- list(delta = rep_len(delta, S), sd = rep_len(vals$sd, S), controlProgression = if (!is.null(vals$controlProgression)) rep_len(vals$controlProgression, S))
    U <- .vcr_voi_two_arm_matrix(p, vals)
    labels <- p$labels
    Phi <- do.call(cbind, lapply(uncertain, function(r) rep_len(vals[[r]], S))); colnames(Phi) <- uncertain
    if (identical(p$utility, "success_probability") && unit == "") unit <- "概率"
    # Live R39 (2026-11-09): a go/no-go question stated on the success-probability scale answered EVPI 0 (a trial always beats the zero of "no trial"), and the
    # agent then worked out a value of information of its own. The result says why, in the one place the agent reads it.
    if (identical(p$utility, "success_probability") && any(p$n == 0)) {
      assumed <- c(assumed, list(list(key = "utility.noTrial", value = "not running the trial is worth 0 on a success-probability scale, so any trial beats it and no input can change that; for a go/no-go decision state successValue and costPerPatient (utility net_benefit)", basis = "default")))
    }
    assumed <- c(assumed, list(
      list(key = "inputs.independent", value = "independent", basis = "default"),
      list(key = "model.dropoutShare", value = "analysed people only", basis = "default"),
      list(key = "model.success", value = "expected probability of a significant one-sided result given the drawn truth", basis = "default")))
  } else {
    tb <- .vcr_voi_table(sc, S)
    U <- tb$U; Phi <- tb$Phi; S <- nrow(U); labels <- colnames(U); uncertain <- colnames(Phi); ranges <- character(0)
    role_draws <- NULL
    assumed <- list(list(key = "utilities", value = "stated by the caller, not computed here", basis = "given"),
                    list(key = "inputs.draws", value = "stated by the caller, not computed here", basis = "given"))
  }

  # a precision, not an execution problem: the run goes on and the premises say how little it has to go on
  if (S < 1000L) assumed <- c(assumed, list(list(key = "draws.few", value = sprintf("only %d draws: the regression estimates are rough", S), basis = "default")))
  stopped <- NULL
  stop_fn <- function() { if (is.null(stopped)) stopped <<- vcr_interrupt(); stopped }

  base <- vcr_voi_evpi(U)
  # a single input, or a stated group (two to four inputs)
  groups <- lapply(sc[["groups"]] %||% list(), vcr_chr)
  for (g in groups) if (length(g) < 2L || length(g) > 4L || any(!(g %in% colnames(Phi)))) {
    vcr_abort("scenario_value_invalid", "scenario.groups", "A group names two to four of the uncertain inputs of the decision.")
  }
  sets <- c(lapply(uncertain, function(nm) nm), groups)
  rows <- list(); failures <- list()
  for (cols in sets) {
    if (!is.null(stop_fn())) break
    r <- tryCatch(vcr_voi_evppi(U, Phi, cols, base), error = function(e) e)
    if (inherits(r, "error")) { failures[[length(failures) + 1L]] <- list(input = paste(cols, collapse = " + "), reason = "the smoother did not converge on these draws"); next }
    rows[[length(rows) + 1L]] <- list(members = cols, evppi = r$evppi, mcse = r$mcse)
  }
  if (length(rows)) {
    ord <- order(-vapply(rows, function(r) r$evppi, numeric(1)), seq_along(rows))
    rows <- rows[ord]
  }
  tiny <- !(base$evpi > 1e-12)
  rows <- lapply(seq_along(rows), function(i) {
    r <- rows[[i]]
    list(input = paste(r$members, collapse = " + "), members = as.list(r$members), group = length(r$members) > 1L, rank = i,
         evppi = vcr_measure("evppi", r$evppi, simulated = TRUE, mcse = r$mcse, unit = unit, source = "synthetic",
                             interval = vcr_interval("monte_carlo", r$evppi - 1.96 * r$mcse, r$evppi + 1.96 * r$mcse)),
         shareOfEvpi = if (tiny) NULL else r$evppi / base$evpi)
  })

  # what the interval leaves out: the regression's own upward bias. An input that tells nothing (its draws shuffled on a stream of its own, so the true EVPPI is
  # zero) reads this much here, which is the least a real input's EVPPI can be told from zero at this number of draws.
  noise_floor <- NULL
  if (length(uncertain) && !tiny && is.null(stop_fn())) {
    nm <- uncertain[1L]
    shuffled <- .vcr_voi_own_stream(7919L, function() Phi[sample.int(S), nm, drop = FALSE])
    nf <- tryCatch(vcr_voi_evppi(U, shuffled, nm, base), error = function(e) NULL)
    if (!is.null(nf)) noise_floor <- list(input = nm, evppi = nf$evppi, shareOfEvpi = nf$evppi / base$evpi)
  }

  if (length(ranges) && is.null(stop_fn())) {
    thresholds <- lapply(ranges, function(role) .vcr_voi_threshold(role, p$specs[[role]], p, draws, S, unit, stop_fn))
  }

  studies <- list()
  for (st in sc[["studies"]] %||% list()) {
    if (!is.null(stop_fn())) break
    sm <- .vcr_voi_study_summary(st, role_draws, Phi, S, source)
    r <- tryCatch(vcr_voi_evppi(U, matrix(sm$T, ncol = 1L, dimnames = list(NULL, "T")), "T", base), error = function(e) NULL)
    if (is.null(r)) { failures[[length(failures) + 1L]] <- list(input = as.character(st[["label"]] %||% st[["kind"]]), reason = "the smoother did not converge on these draws"); next }
    ceiling_row <- Filter(function(x) identical(x$input, sm$observes), rows)
    studies[[length(studies) + 1L]] <- list(
      label = as.character(st[["label"]] %||% ""), kind = as.character(st[["kind"]]), size = vcr_scalar(st[["size"]], NULL), observes = sm$observes,
      evsi = vcr_measure("evsi", r$evppi, simulated = TRUE, mcse = r$mcse, unit = unit, source = "synthetic",
                         interval = vcr_interval("monte_carlo", r$evppi - 1.96 * r$mcse, r$evppi + 1.96 * r$mcse)),
      shareOfEvpi = if (tiny) NULL else r$evppi / base$evpi,
      ceiling = if (length(ceiling_row)) ceiling_row[[1L]]$evppi$value else NULL)
  }

  # the next step the numbers point at; the person decides
  nxt <- list(kind = "none")
  if (!tiny) {
    # a stated group is at least as valuable as each of its members, so the step named is the best single input; a group only when there is none
    singles <- Filter(function(r) !isTRUE(r$group), rows)
    topi <- if (length(singles)) singles[[1L]] else if (length(rows)) rows[[1L]] else NULL
    tops <- if (length(studies)) studies[[which.max(vapply(studies, function(s) s$evsi$value, numeric(1)))]] else NULL
    nxt <- list(kind = if (!is.null(topi)) "input" else "none", input = if (!is.null(topi)) topi$input else NULL,
                study = if (!is.null(tops)) tops$label else NULL, studyEvsi = if (!is.null(tops)) tops$evsi$value else NULL)
  }

  opt_rows <- lapply(seq_along(labels), function(i) list(
    label = labels[i], nPerArm = if (!is.null(p)) p$n[i] else NULL, chosen = i == base$best,
    expectedUtility = vcr_measure("expected_utility", base$means[i], simulated = TRUE, mcse = stats::sd(U[, i]) / sqrt(S), unit = unit, source = "synthetic")))

  measures <- list(
    vcr_measure("voi_evpi", base$evpi, simulated = TRUE, mcse = base$mcse, unit = unit, source = "synthetic",
                interval = vcr_interval("monte_carlo", base$evpi - 1.96 * base$mcse, base$evpi + 1.96 * base$mcse)),
    vcr_measure("voi_probability_wrong_decision", base$wrong, simulated = TRUE, mcse = sqrt(max(base$wrong * (1 - base$wrong), 0) / S), source = "synthetic"),
    vcr_measure("voi_best_expected_utility", base$means[base$best], simulated = TRUE, mcse = base$bestMcse, unit = unit, source = "synthetic"))
  if (length(rows)) measures <- c(measures, list(
    vcr_measure("voi_top_evppi", rows[[1L]]$evppi$value, simulated = TRUE, mcse = rows[[1L]]$evppi$mcse, unit = unit, source = "synthetic")))

  result <- list(status = "succeeded", measures = measures, counts = vcr_counts(realPatients = NULL, generatedRecords = 0),
    diagnostics = list(replicatesCompleted = S, voi = list(
      given = list(label = as.character(sc[["label"]] %||% ""), source = source, utility = as.character(sc[["utility"]] %||% "table"),
                   effectScale = if (!is.null(p)) p$scale else NULL, unit = unit, draws = S, alpha = if (!is.null(p)) p$alpha else NULL,
                   successValue = if (!is.null(p)) p$value else NULL, costPerPatient = if (!is.null(p) && identical(p$utility, "net_benefit")) p$cost else NULL,
                   inputs = if (!is.null(p)) lapply(names(p$specs), function(r) c(list(role = r), p$specs[[r]])) else lapply(uncertain, function(nm) list(role = nm, family = "draws"))),
      chosen = labels[base$best], options = opt_rows, inputs = rows, thresholds = thresholds, studies = studies, `next` = nxt,
      regression = list(noiseFloor = noise_floor, intervalOmits = "the interval of an EVPPI or an EVSI is the Monte Carlo error of the average over the draws; it leaves out the regression's own upward bias, which noiseFloor measures on a shuffled input (its true EVPPI is zero)",
                        method = "gam", basis = "s(x, bs = 'cr', k = 10); te(..., bs = 'cr', k = 5) for two or three inputs, k = 4 for four; group means for ten values or fewer"),
      failures = failures, assumed = assumed, notApplied = if (length(not_applied)) not_applied else NULL)))
  if (identical(stopped, "canceled")) { result$status <- "canceled"; result$diagnostics$interrupted <- "canceled before every input was evaluated" }
  else if (identical(stopped, "cpu_budget")) {
    result$conclusion <- "limited"
    result$issues <- list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit", sprintf("The CPU budget ran out after %d of the %d inputs; the table holds the finished ones.", length(rows), length(sets))))
  }
  result
}
