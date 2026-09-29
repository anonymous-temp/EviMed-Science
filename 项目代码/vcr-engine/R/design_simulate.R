# ---------------------------------------------------------------------------
# design_simulate.R — the ADEMP runner: aims, data-generating mechanism,
# estimand, methods, performance measures (Morris et al. 2019; plan 5.4).
#
# Hidden knowledge:
#
# - **Replicates are stored, not accumulated.** Every replicate's raw
#   quantities are kept by index and reduced once at the end, in index order.
#   That is what makes a resumed run and a one-shot run produce the same bits,
#   and a 1-core and an 8-core run produce the same bits (AC-31). Running
#   totals are smaller and are the reason most simulation frameworks cannot
#   promise this.
# - **Failed replicates are counted and reported, never dropped.** ADEMP is
#   explicit about it and it is also the honest thing: a design whose analysis
#   fails to converge 4% of the time has an operating characteristic that
#   includes the 4%.
# - **The checkpoint carries the scenario hash.** Resuming into a checkpoint
#   written for a different scenario would silently blend two experiments, so
#   the hash is checked and a mismatch starts over rather than continuing.
# - **Cancellation is checked between batches and the batch size is chosen
#   for latency, not throughput.** 500 replicates of a 300-patient survival
#   trial is well under a second, so "cancel takes effect immediately" is true
#   to within a batch, and whatever batches finished are kept (AC-38).
# - **The replicate count is derived, not typed.** `vcr_plan_replicates()`
#   turns a target Monte-Carlo standard error into a count via
#   p(1-p)/target^2, then applies the floors (20,000 under the null, 5,000
#   under an alternative). A scenario that asks for a type-I error to +-0.001
#   gets 24,375 whether or not anyone remembered (AC-28, N05).
# - **The analytic value travels with the simulated one.** Where a closed form
#   exists it is computed and attached, and the difference is reported in
#   MCSE units so AC-29 ("within 3 MCSE") is a number on the result rather
#   than a thing someone checks by hand.
# ---------------------------------------------------------------------------

#' How many replicates this scenario needs.
#' Hidden knowledge: "is this the null scenario?" is answered from the
#' *estimand*, not from a field name. A binary scenario written as
#' `controlRate = 0.3, treatmentRate = 0.3` has no `effect` field and no
#' `hazardRatio` field, so a name-based test calls it an alternative, gives it
#' the 5,000-replicate floor instead of 20,000, and labels its measure `power`
#' instead of `type_one_error`. Both errors are silent and both survive review.
vcr_plan_replicates <- function(scenario, requested = NULL, estimand = NULL) {
  perf <- scenario$performance %||% c("power")
  is_null_case <- isTRUE(scenario$truth$null) ||
    (!is.null(estimand) && is.finite(estimand) && abs(estimand) < 1e-12) ||
    (is.null(estimand) && (identical(scenario$truth$effect %||% NA, 0) ||
                           identical(scenario$truth$hazardRatio %||% NA, 1)))
  target <- scenario$targetMcse
  p <- if (is_null_case) (scenario$analysis$alpha %||% 0.025) else 0.5
  floor_ <- vcr_replicate_floor(is_null_case, target, p)
  n <- as.integer(max(floor_, requested %||% 0))
  list(replicates = n, isNull = is_null_case, targetMcse = target,
       floor = floor_, basisProportion = p)
}

#' Monte-Carlo standard errors for the ADEMP performance measures.
vcr_mcse_proportion <- function(p, n) sqrt(p * (1 - p) / n)
vcr_mcse_mean <- function(x) stats::sd(x) / sqrt(length(x))
vcr_mcse_empse <- function(x) stats::sd(x) / sqrt(2 * (length(x) - 1))

#' Build the generate/analyse pair for a scenario.
#'
#' A scenario is
#'   design:   list(kind, nTreat, nControl, allocation, informationRates, spending, ...)
#'   endpoint: list(type, ...)
#'   truth:    the data-generating parameters
#'   analysis: list(method, alpha, sided, tau, covariates)
#'   accrual:  list(kind, duration, followup, dropoutAnnual)
vcr_scenario_runner <- function(scenario) {
  endpoint <- scenario$endpoint$type
  design <- scenario$design
  truth <- scenario$truth
  analysis <- scenario$analysis %||% list()
  alpha <- analysis$alpha %||% 0.025
  sided <- analysis$sided %||% 1

  if (identical(endpoint, "continuous")) {
    n1 <- design$nTreat; n0 <- design$nControl %||% design$nTreat
    method <- analysis$method %||% "ttest"
    estimand <- truth$effect %||% 0
    return(list(estimand = estimand, run = function(i) {
      d <- vcr_sim_continuous(n1, n0, truth$effect %||% 0, truth$sd %||% 1,
                              truth$baselineCorrelation %||% 0)
      r <- if (identical(method, "ancova")) vcr_analyse_ancova(d, alpha, sided)
           else vcr_analyse_ttest(d, alpha, sided)
      c(r, sampleSize = n1 + n0)
    }))
  }

  if (identical(endpoint, "binary")) {
    n1 <- design$nTreat; n0 <- design$nControl %||% design$nTreat
    method <- analysis$method %||% "risk_difference"
    p0 <- truth$controlRate
    p1 <- truth$treatmentRate %||% (p0 + (truth$riskDifference %||% 0))
    estimand <- if (identical(method, "logistic")) log((p1 / (1 - p1)) / (p0 / (1 - p0))) else p1 - p0
    return(list(estimand = estimand, run = function(i) {
      d <- vcr_sim_binary(n1, n0, p0, p_treat = p1, covariate_logit = truth$covariateLogit %||% 0)
      r <- if (identical(method, "logistic")) vcr_analyse_logistic(d, alpha, sided)
           else vcr_analyse_risk_difference(d, alpha, sided)
      c(r, sampleSize = n1 + n0)
    }))
  }

  if (identical(endpoint, "time_to_event")) {
    n1 <- design$nTreat; n0 <- design$nControl %||% design$nTreat
    dist <- truth$controlDistribution %||% vcr_dist_exponential_from_median(truth$controlMedian)
    hr <- truth$hazardRatio %||% 1
    accrual <- scenario$accrual %||% list(kind = "uniform", duration = 0)
    followup <- scenario$accrual$followup %||% Inf
    dropout <- scenario$accrual$dropoutAnnual %||% 0
    tau <- analysis$tau
    method <- analysis$method %||% "logrank"
    estimand <- if (identical(method, "rmst")) {
      vcr_rmst_analytic(.vcr_scale_hazard(dist, hr), tau) - vcr_rmst_analytic(dist, tau)
    } else log(hr)
    gs <- identical(design$kind, "group_sequential")
    gs_design <- if (gs) vcr_group_sequential(design$informationRates,
                                              alpha, design$spending %||% "obrien_fleming") else NULL
    return(list(estimand = estimand, groupSequential = gs_design, run = function(i) {
      d <- vcr_sim_tte(n1, n0, dist, hr, accrual, followup, dropout,
                       max_followup = scenario$accrual$maxFollowup %||% Inf)
      if (identical(method, "rmst")) {
        rule <- vcr_tau_rule(d$time, d$status, d$arm, tau)
        if (!is.null(rule)) return(c(estimate = NA_real_, se = NA_real_, statistic = NA_real_,
                                     p = NA_real_, reject = NA_real_, ci_low = NA_real_,
                                     ci_high = NA_real_, events = sum(d$status), sampleSize = n1 + n0))
        r <- vcr_rmst_difference(d$time, d$status, d$arm, tau)
        z <- r$estimate / r$se
        return(c(estimate = r$estimate, se = r$se, statistic = z,
                 p = stats::pnorm(z, lower.tail = FALSE),
                 reject = as.numeric(z > stats::qnorm(1 - alpha)),
                 ci_low = r$interval[1], ci_high = r$interval[2],
                 events = sum(d$status), sampleSize = n1 + n0))
      }
      if (gs) return(.vcr_run_group_sequential(d, gs_design, alpha))
      r <- vcr_analyse_logrank(d, alpha, sided)
      c(r, sampleSize = n1 + n0)
    }))
  }

  stop("vcr_scenario_runner: unsupported endpoint ", endpoint)
}

.vcr_scale_hazard <- function(dist, hr) {
  kind <- dist$kind %||% "exponential"
  if (identical(kind, "exponential")) return(list(kind = "exponential", rate = dist$rate * hr))
  if (identical(kind, "weibull")) return(list(kind = "weibull", shape = dist$shape,
                                              scale = dist$scale * hr^(-1 / dist$shape)))
  if (identical(kind, "piecewise")) return(list(kind = "piecewise", breaks = dist$breaks,
                                                rates = dist$rates * hr))
  stop(".vcr_scale_hazard: unknown distribution kind ", kind)
}

#' One group-sequential replicate: analyse at each information fraction,
#' measured in events, and stop at the first boundary crossing.
.vcr_run_group_sequential <- function(d, gs, alpha) {
  total_events <- sum(d$status)
  targets <- ceiling(gs$informationRates * total_events)
  event_times <- sort(d$time[d$status == 1L])
  rejected <- 0; look <- NA_integer_; est <- NA_real_; se <- NA_real_
  n_used <- nrow(d)
  for (k in seq_along(targets)) {
    if (targets[k] < 2) next
    cutoff <- event_times[min(targets[k], length(event_times))]
    dk <- d
    dk$status <- as.integer(dk$status == 1L & dk$time <= cutoff)
    dk$time <- pmin(dk$time, cutoff)
    r <- vcr_analyse_logrank(dk, alpha, 1)
    z <- -as.numeric(r["statistic"])        # upper-tail convention: benefit is positive
    if (is.finite(z) && z > gs$criticalValues[k]) {
      rejected <- 1; look <- k; est <- as.numeric(r["estimate"]); se <- as.numeric(r["se"])
      break
    }
    est <- as.numeric(r["estimate"]); se <- as.numeric(r["se"])
  }
  c(estimate = est, se = se, statistic = NA_real_, p = NA_real_,
    reject = rejected, ci_low = est - stats::qnorm(1 - alpha) * se,
    ci_high = est + stats::qnorm(1 - alpha) * se,
    events = total_events, look = if (is.na(look)) length(targets) else look,
    sampleSize = n_used)
}

#' Run a scenario. Returns the result's `measures`, `diagnostics` and the raw
#' per-replicate matrix (which the caller may write out as a table).
vcr_run_simulation <- function(scenario, seed, replicates = NULL, cores = 1L,
                               checkpoint = NULL, cancel_file = NULL,
                               batch_size = 500L, progress = NULL,
                               cpu_seconds_limit = Inf) {
  runner <- vcr_scenario_runner(scenario)
  plan <- vcr_plan_replicates(scenario, replicates, runner$estimand)
  n_rep <- plan$replicates
  hash <- vcr_scenario_hash(scenario)
  started <- proc.time()[["elapsed"]]
  cpu0 <- sum(proc.time()[c("user.self", "sys.self", "user.child", "sys.child")], na.rm = TRUE)

  done <- 0L
  values <- NULL
  bank <- vcr_stream_bank(seed)
  if (!is.null(checkpoint) && file.exists(checkpoint)) {
    cp <- tryCatch(readRDS(checkpoint), error = function(e) NULL)
    if (!is.null(cp) && identical(cp$scenarioHash, hash) && identical(as.integer(cp$seed), as.integer(seed)) &&
        identical(as.integer(cp$batchSize), as.integer(batch_size))) {
      done <- cp$done; values <- cp$values
      bank <- vcr_stream_bank(seed, state = cp$streamState)
    }
  }

  canceled <- FALSE
  over_budget <- FALSE
  while (done < n_rep) {
    if (!is.null(cancel_file) && file.exists(cancel_file)) { canceled <- TRUE; break }
    cpu_now <- sum(proc.time()[c("user.self", "sys.self", "user.child", "sys.child")], na.rm = TRUE) - cpu0
    if (is.finite(cpu_seconds_limit) && cpu_now > cpu_seconds_limit) { over_budget <- TRUE; break }
    take <- min(batch_size, n_rep - done)
    streams <- bank$take(take)
    idx <- done + seq_len(take)
    out <- vcr_map_streams(streams, function(i) {
      tryCatch(runner$run(i), error = function(e) stats::setNames(rep(NA_real_, 1), "estimate"))
    }, cores = cores, indices = idx)
    nms <- unique(unlist(lapply(out, names)))
    mat <- matrix(NA_real_, nrow = take, ncol = length(nms), dimnames = list(NULL, nms))
    for (j in seq_len(take)) { v <- out[[j]]; mat[j, names(v)] <- as.numeric(v) }
    values <- if (is.null(values)) mat else rbind(values[, colnames(mat), drop = FALSE], mat)
    done <- done + take
    if (!is.null(checkpoint)) {
      tmp <- paste0(checkpoint, ".tmp")
      saveRDS(list(scenarioHash = hash, seed = seed, done = done, values = values,
                   streamState = bank$state(), batchSize = batch_size), tmp)
      file.rename(tmp, checkpoint)
    }
    if (!is.null(progress)) progress(done, n_rep)
  }

  summary <- vcr_summarize_replicates(values, runner$estimand, scenario, done)
  cpu <- sum(proc.time()[c("user.self", "sys.self", "user.child", "sys.child")], na.rm = TRUE) - cpu0
  list(
    measures = summary$measures,
    diagnostics = c(summary$diagnostics, list(
      replicatesPlanned = n_rep, replicatesCompleted = done,
      replicateFloor = plan$floor, isNullScenario = plan$isNull,
      targetMcse = plan$targetMcse, batchSize = batch_size, cores = cores,
      canceled = canceled, overCpuBudget = over_budget,
      elapsedSeconds = proc.time()[["elapsed"]] - started, cpuSeconds = cpu)),
    values = values, scenarioHash = hash,
    status = if (canceled) "canceled" else if (over_budget) "failed" else "succeeded"
  )
}

#' Reduce the per-replicate matrix to ADEMP performance measures with MCSEs.
vcr_summarize_replicates <- function(values, estimand, scenario, done) {
  if (is.null(values) || !nrow(values)) {
    return(list(measures = list(), diagnostics = list(replicatesUsable = 0, replicatesFailed = done)))
  }
  wanted <- scenario$performance %||% c("power", "bias", "coverage")
  alpha <- scenario$analysis$alpha %||% 0.025
  est <- values[, "estimate"]
  usable <- is.finite(est)
  n <- sum(usable)
  measures <- list()
  add <- function(m) measures[[length(measures) + 1L]] <<- m

  rej <- values[, "reject"]
  if (any(c("power", "type_one_error") %in% wanted) && any(is.finite(rej))) {
    p <- mean(rej[is.finite(rej)])
    nn <- sum(is.finite(rej))
    mcse <- vcr_mcse_proportion(p, nn)
    name <- if (isTRUE(scenario$truth$null) ||
                (is.finite(estimand) && abs(estimand) < 1e-12)) "type_one_error" else "power"
    add(vcr_measure(name, p, simulated = TRUE, mcse = mcse,
                    interval = vcr_interval("monte_carlo", p - 1.96 * mcse, p + 1.96 * mcse)))
  }
  if ("bias" %in% wanted && n > 1) {
    b <- mean(est[usable]) - estimand
    add(vcr_measure("bias", b, simulated = TRUE, mcse = vcr_mcse_mean(est[usable])))
    add(vcr_measure("empirical_se", stats::sd(est[usable]), simulated = TRUE,
                    mcse = vcr_mcse_empse(est[usable])))
    mse <- mean((est[usable] - estimand)^2)
    add(vcr_measure("mse", mse, simulated = TRUE,
                    mcse = stats::sd((est[usable] - estimand)^2) / sqrt(n)))
  }
  if ("coverage" %in% wanted && all(c("ci_low", "ci_high") %in% colnames(values))) {
    cov_ok <- is.finite(values[, "ci_low"]) & is.finite(values[, "ci_high"])
    if (any(cov_ok)) {
      cov <- mean(values[cov_ok, "ci_low"] <= estimand & values[cov_ok, "ci_high"] >= estimand)
      add(vcr_measure("coverage", cov, simulated = TRUE,
                      mcse = vcr_mcse_proportion(cov, sum(cov_ok))))
    }
  }
  if ("expected_sample_size" %in% wanted && "sampleSize" %in% colnames(values)) {
    s <- values[, "sampleSize"]; s <- s[is.finite(s)]
    add(vcr_measure("expected_sample_size", mean(s), simulated = TRUE, mcse = vcr_mcse_mean(s)))
  }
  if ("events" %in% colnames(values)) {
    e <- values[, "events"]; e <- e[is.finite(e)]
    if (length(e)) add(vcr_measure("expected_events", mean(e), simulated = TRUE, mcse = vcr_mcse_mean(e)))
  }
  if ("look" %in% colnames(values)) {
    l <- values[, "look"]; l <- l[is.finite(l)]
    if (length(l)) add(vcr_measure("expected_analyses", mean(l), simulated = TRUE, mcse = vcr_mcse_mean(l)))
  }
  list(measures = measures,
       diagnostics = list(replicatesUsable = n, replicatesFailed = done - n,
                          estimand = estimand, alpha = alpha))
}

#' Analytic counterpart of a simulated scenario, where one exists, plus the
#' difference in MCSE units (AC-29).
vcr_analytic_check <- function(scenario, measures) {
  endpoint <- scenario$endpoint$type
  design <- scenario$design
  truth <- scenario$truth
  alpha <- scenario$analysis$alpha %||% 0.025
  sided <- scenario$analysis$sided %||% 1
  analytic <- NULL
  if (identical(endpoint, "continuous") && identical(design$kind, "two_arm_fixed")) {
    analytic <- list(name = if (identical(truth$effect %||% 0, 0)) "type_one_error" else "power",
                     value = if (identical(truth$effect %||% 0, 0)) alpha
                             else vcr_power_means(truth$effect, truth$sd %||% 1,
                                                  design$nTreat, design$nControl %||% design$nTreat,
                                                  alpha, sided))
  }
  if (identical(endpoint, "binary") && identical(design$kind, "two_arm_fixed")) {
    p0 <- truth$controlRate; p1 <- truth$treatmentRate %||% (p0 + (truth$riskDifference %||% 0))
    analytic <- list(name = if (isTRUE(all.equal(p1, p0))) "type_one_error" else "power",
                     value = if (isTRUE(all.equal(p1, p0))) alpha
                             else vcr_power_proportions(p0, p1, design$nTreat,
                                                        design$nControl %||% design$nTreat, alpha, sided))
  }
  if (identical(endpoint, "time_to_event") && identical(design$kind, "two_arm_fixed") &&
      !identical(scenario$analysis$method %||% "logrank", "rmst")) {
    hr <- truth$hazardRatio %||% 1
    dist <- truth$controlDistribution %||% vcr_dist_exponential_from_median(truth$controlMedian)
    accrual <- scenario$accrual %||% list()
    if (identical(hr, 1)) {
      analytic <- list(name = "type_one_error", value = alpha, basis = "nominal_alpha")
    } else {
      # The exact asymptotic reference, not Schoenfeld's local approximation:
      # see `vcr_logrank_power`. Schoenfeld's value is kept beside it so the
      # size of the approximation is visible rather than argued about.
      exact <- vcr_logrank_power(hr, dist, design$nTreat, design$nControl %||% design$nTreat,
                                 accrual$duration %||% 0,
                                 accrual$followup %||% Inf,
                                 accrual$dropoutAnnual %||% 0,
                                 alpha, accrual$maxFollowup %||% Inf)
      analytic <- list(name = "power", value = exact$power,
                       basis = "exact_asymptotic_logrank",
                       schoenfeld = exact$schoenfeldPower,
                       expectedEvents = exact$expectedEvents)
    }
  }
  if (is.null(analytic)) return(NULL)
  sim <- Filter(function(m) identical(m$name, analytic$name), measures)
  if (!length(sim)) return(analytic)
  d <- sim[[1]]$value - analytic$value
  c(analytic, list(simulated = sim[[1]]$value, difference = d,
                   differenceInMcse = if (sim[[1]]$mcse > 0) d / sim[[1]]$mcse else NA_real_,
                   withinThreeMcse = abs(d) <= 3 * sim[[1]]$mcse))
}

#' A design grid: designs x truth scenarios, every cell one immutable run.
vcr_design_grid <- function(base_scenario, designs, truths, seed, replicates = NULL,
                            cores = 1L, cancel_file = NULL, checkpoint_dir = NULL,
                            progress = NULL) {
  cells <- list(); k <- 0L
  total <- length(designs) * length(truths)
  for (di in seq_along(designs)) for (ti in seq_along(truths)) {
    k <- k + 1L
    sc <- utils::modifyList(base_scenario, list(design = utils::modifyList(base_scenario$design %||% list(), designs[[di]]),
                                                truth = utils::modifyList(base_scenario$truth %||% list(), truths[[ti]])))
    # Each cell gets its own seed derived from the job seed and the cell index,
    # so adding a cell never changes another cell's numbers.
    cell_seed <- (as.integer(seed) + k * 7919L) %% 2147483647L
    cp <- if (is.null(checkpoint_dir)) NULL else file.path(checkpoint_dir, sprintf("cell-%03d.rds", k))
    res <- vcr_run_simulation(sc, cell_seed, replicates, cores, cp, cancel_file,
                              progress = NULL)
    cells[[k]] <- list(designIndex = di, truthIndex = ti, design = designs[[di]],
                       truth = truths[[ti]], seed = cell_seed,
                       scenarioHash = res$scenarioHash, measures = res$measures,
                       diagnostics = res$diagnostics, status = res$status)
    if (!is.null(progress)) progress(k, total)
    if (identical(res$status, "canceled")) break
  }
  cells
}

#' Deterministic Pareto dominance over a set of design cells: a design is
#' dominated when another is at least as good on every declared metric and
#' strictly better on one. The platform greys out dominated designs; it never
#' ranks the rest (plan 5.4).
vcr_dominated_designs <- function(rows, maximize = character(), minimize = character()) {
  n <- nrow(rows)
  dominated <- logical(n)
  for (i in seq_len(n)) for (j in seq_len(n)) {
    if (i == j) next
    ge <- all(vapply(maximize, function(m) rows[[m]][j] >= rows[[m]][i], logical(1))) &&
          all(vapply(minimize, function(m) rows[[m]][j] <= rows[[m]][i], logical(1)))
    gt <- any(vapply(maximize, function(m) rows[[m]][j] > rows[[m]][i], logical(1))) ||
          any(vapply(minimize, function(m) rows[[m]][j] < rows[[m]][i], logical(1)))
    if (ge && gt) { dominated[i] <- TRUE; break }
  }
  dominated
}

`%||%` <- function(a, b) if (is.null(a)) b else a
