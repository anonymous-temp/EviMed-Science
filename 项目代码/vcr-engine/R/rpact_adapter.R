# ---------------------------------------------------------------------------
# rpact_adapter.R — the one file that calls rpact (algorithm round G5, 2026-11-03).
#
# Hidden knowledge:
#
# - **Nothing else in R/ names rpact.** The confirmatory designs (`design_confirmatory.R`) ask this file for a design, a sample size, an
#   analytic power or a batch of simulated trials and read plain lists and data frames back; rpact's classes, its argument spellings and
#   its error text stop at this door (case N65 greps R/ for `rpact::` outside this file). rpact is a runtime package and so cannot check
#   itself: the checks of what it returns are gsDesign, a closed form and a simulation in plain R (tests/numeric/N66..N69).
# - **rpact sets its own random state.** A simulation call with a `seed` gives the same trials whatever generator the caller was using, and
#   it leaves the generator on Mersenne-Twister with a state of its own. The engine's streams are L'Ecuyer substreams per replicate
#   (rng.R), so every call here saves the generator's kind and `.Random.seed` and puts both back, found or absent, before it returns
#   (`.vcr_rpact_guard`): a job that draws numbers after a call is not a function of whether the call happened.
# - **A simulation is a loop of small calls, never one big one.** One rpact call runs to the end: it cannot be cancelled and it does not
#   hand back what it has when the CPU budget is spent. `vcr_rpact_batches` runs the iterations in batches of `batch` (1,000) with a seed
#   derived from the job seed, the batch and the scenario, checks the cancel file and the CPU budget between batches, merges the
#   per-iteration rows of the batches that finished and says why it stopped. The same job seed gives the same batches, so the answer is
#   bit-identical whatever the core count (the adapter is single-process; `cores` changes nothing here), and a stopped run keeps its
#   batches: a partial result is reported as limited, with its iterations, never as the whole.
# - **The Monte-Carlo errors are ours.** rpact reports a probability and no error. Probabilities get the binomial error from the iterations
#   that ran, expectations the standard error of the per-iteration values (`$.data` keeps one row per iteration and stage).
# - **A rule of ours is a function we hand to rpact.** The promising zone (a lower and an upper conditional-power bound) is not an argument of
#   any rpact call; rpact asks for the size of the second stage as a function (`calcSubjectsFunction` for means and rates,
#   `calcEventsFunction` for event time) and the zone is written here, in the engine's own formulas. With the zone spanning 0 to 1 the three
#   functions reproduce rpact's own conditional-power rule row for row (tests N67e), which is how the arithmetic around the zone is held
#   to something outside it. Two conventions of rpact's are easy to get wrong: the event-time function returns the CUMULATED number of
#   events (the events so far plus the new stage), and its `estimatedTheta` is the hazard ratio turned so that a value above 1 favours the
#   treatment whatever the direction of the test.
# - **Event-time selection and enrichment are simulated on the log-rank statistics, not on patients.** `getSimulationMultiArmSurvival` and
#   `getSimulationEnrichmentSurvival` draw normal log-rank statistics from the planned events (Deng et al. 2019 for the correlation of the
#   arms sharing a control), assume proportional hazards and the same control hazard everywhere, and know nothing of accrual, follow-up or
#   dropout; the events a stage collects are split between the arms in proportion to their hazards. The sizes are events, and the result
#   says so (N68e and N68g hold the selection probability to a patient-level simulation in plain R and to the closed form).
# - **rpact's text never reaches a person.** A call that fails is `design_not_computable` with a fixed sentence (the message only with
#   `VCR_ENGINE_DEBUG`, as for any handler error); rpact's start-up notice about installation qualification is swallowed.
# ---------------------------------------------------------------------------

#' Run `fn` with rpact quiet and the caller's random state untouched.
.vcr_rpact_guard <- function(fn) {
  if (!requireNamespace("rpact", quietly = TRUE)) {
    vcr_abort("design_not_computable", "design", "The design library is not available in this engine.")
  }
  had_seed <- exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
  seed_state <- if (had_seed) get(".Random.seed", envir = .GlobalEnv, inherits = FALSE) else NULL
  kind <- RNGkind()
  on.exit({
    RNGkind(kind[1L], kind[2L], kind[3L])
    if (had_seed) assign(".Random.seed", seed_state, envir = .GlobalEnv)
    else if (exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)) rm(".Random.seed", envir = .GlobalEnv)
  }, add = TRUE)
  tryCatch(suppressWarnings(suppressMessages(fn())),
           vcr_refusal = function(e) stop(e),
           error = function(e) {
             detail <- "The design could not be computed with these settings."
             if (nzchar(Sys.getenv("VCR_ENGINE_DEBUG", ""))) detail <- paste(detail, substr(conditionMessage(e), 1, 300))
             vcr_abort("design_not_computable", "design", detail)
           })
}

#' The seed of one batch of one scenario, derived from the job seed alone: a pure function, so a rerun, a resumed run and a run on more
#' cores draw the same trials. Positive, below 2^31 - 1, computed in double arithmetic (the integer product overflows).
vcr_rpact_batch_seed <- function(seed, batch, scenario = 1L) {
  as.integer(1 + ((as.numeric(seed) * 1009 + batch * 7919 + scenario * 104729) %% 2147483646))
}

# --- the spending functions, in rpact's words ----------------------------------------------------

.VCR_RPACT_ALPHA_TYPE <- c(obrien_fleming = "asOF", pocock = "asP", hwang_shih_decani = "asHSD", kim_demets = "asKD")
.VCR_RPACT_BETA_TYPE <- c(obrien_fleming = "bsOF", pocock = "bsP", hwang_shih_decani = "bsHSD", kim_demets = "bsKD")

# --- designs ----------------------------------------------------------------------------------------

#' A group-sequential design with an efficacy boundary and, when `futility` is a list(spending, gamma, binding), a futility boundary from
#' beta spending. `kind` is "group_sequential" or "inverse_normal" (the combination test the adaptive designs need; for a fixed
#' sample-size plan the two are the same). The result is the design object and the plain numbers of it.
vcr_rpact_design <- function(rates, alpha, power, spending = "obrien_fleming", gamma = NULL, futility = NULL, kind = "group_sequential") {
  .vcr_rpact_guard(function() {
    # beta is always the design's: a sample size read from the design is the size for that power (rpact's default would be 0.2)
    args <- list(kMax = length(rates), alpha = alpha, beta = 1 - power, sided = 1L, informationRates = rates,
                 typeOfDesign = unname(.VCR_RPACT_ALPHA_TYPE[[spending]]))
    if (!is.null(gamma)) args$gammaA <- gamma
    if (!is.null(futility)) {
      args$typeBetaSpending <- unname(.VCR_RPACT_BETA_TYPE[[futility[["spending"]]]])
      if (!is.null(futility$gamma)) args$gammaB <- futility$gamma
      args$bindingFutility <- isTRUE(futility$binding)
    }
    # a one-look design is a fixed design: rpact's designs need two looks at least, and the fixed one has no object to speak of
    fn <- if (identical(kind, "inverse_normal")) rpact::getDesignInverseNormal else rpact::getDesignGroupSequential
    design <- do.call(fn, args)
    list(object = design, rates = rates, alpha = alpha,
         efficacyBounds = as.numeric(design$criticalValues),
         futilityBounds = if (is.null(futility)) NULL else c(as.numeric(design$futilityBounds), NA_real_),
         alphaSpent = as.numeric(design$alphaSpent),
         betaSpent = if (is.null(futility)) NULL else as.numeric(design$betaSpent))
  })
}

#' How a design with a futility boundary behaves, as fractions of its maximum information: the inflation over a fixed design and, under the
#' alternative it was sized for and under the null, the probability of stopping for efficacy and for futility at each look and the expected
#' information (as a fraction of the maximum). The null is read with the futility boundary obeyed.
vcr_rpact_operating <- function(design) {
  .vcr_rpact_guard(function() {
    obj <- design$object
    dc <- rpact::getDesignCharacteristics(obj)
    h0 <- rpact::getPowerAndAverageSampleNumber(obj, theta = 0, nMax = 1)
    k <- length(design$rates)
    pad <- function(x) { x <- as.numeric(x); c(x, rep(0, k - length(x))) }
    list(inflation = as.numeric(dc$inflationFactor), shift = as.numeric(dc$shift),
         h1 = list(reject = pad(dc$rejectionProbabilities), futility = pad(dc$futilityProbabilities), expected = as.numeric(dc$averageSampleNumber1)),
         h0 = list(reject = pad(h0$rejectPerStage[, 1L]), futility = pad(h0$futilityPerStage[, 1L]), expected = as.numeric(h0$averageSampleNumber[1L])))
  })
}

# --- the direction of an effect, and the subject cap rpact asks for ---------------------------------------

#' A problem stated in the person's direction, put as rpact reads it (a positive effect is the benefit, treated arm first). `direction` is
#' `hypothesis.direction`; a hazard ratio needs none (below 1 is the benefit). For a mean the effect changes sign. For a risk the treated arm
#' and the control swap labels: a treated rate of 0.20 against a control of 0.30 (lower is better) is the same problem as a treated 0.30
#' against a control of 0.20 (higher is better) with the allocation reversed, a test of the difference of two rates not caring which arm
#' carries which label. One effect at a time; a design that shares one control among several arms (selection, enrichment) cannot swap and
#' uses rpact's own `directionUpper` for rates.
.vcr_rpact_orient <- function(endpoint, effect, control_rate, allocation, direction) {
  if (!identical(direction, "lower_better")) return(list(effect = effect, control_rate = control_rate, allocation = allocation))
  switch(endpoint,
    continuous = list(effect = -effect, control_rate = control_rate, allocation = allocation),
    binary = list(effect = -effect, control_rate = control_rate + effect, allocation = 1 - allocation),
    list(effect = effect, control_rate = control_rate, allocation = allocation))
}

#' The number of subjects rpact is allowed to enrol when a time-to-event design is sized by the Schoenfeld formula. The events a design needs
#' do not depend on it (the sample size returned for 10 times the events and for 1,000 times are the same to the last digit); rpact only
#' refuses a design whose events exceed it, which a fixed 1,000 did from a hazard ratio of about 0.81 up (HR 0.85 needs 1,600 events) with a
#' message the person has no setting to answer. So it is derived: ten times the events the fixed design needs, which the longest
#' group-sequential design (a few percent more) never reaches.
.vcr_rpact_subject_cap <- function(events_fixed) as.numeric(max(1000, ceiling(10 * events_fixed)))

# --- sample size and power of a design, one function for the three endpoints ---------------------------

#' The sample size (patients, or events for a time-to-event endpoint) of a design at a planned effect, with the probabilities of stopping
#' per look and the expected size under the alternative and the null. `design` is a `vcr_rpact_design` (NULL: the fixed design).
#' `endpoint`: "continuous" (effect = difference of means, `sd`), "binary" (`effect` = risk difference, `control_rate`), "time_to_event"
#' (`effect` = hazard ratio, `control_median`).
vcr_rpact_sample_size <- function(endpoint, design, effect, alpha, power, allocation = 0.5, sd = 1, control_rate = NULL, control_median = NULL,
                                  direction = "higher_better") {
  .vcr_rpact_guard(function() {
    o <- .vcr_rpact_orient(endpoint, effect, control_rate, allocation, direction)
    effect <- o$effect; control_rate <- o$control_rate; allocation <- o$allocation
    cap <- if (identical(endpoint, "time_to_event")) .vcr_rpact_subject_cap(vcr_events_schoenfeld(effect, alpha, power, allocation)) else NULL
    r <- allocation / (1 - allocation)
    d <- if (is.null(design)) rpact::getDesignGroupSequential(kMax = 1L, alpha = alpha, beta = 1 - power, sided = 1L) else design$object
    if (is.null(design)) d <- NULL
    res <- switch(endpoint,
      continuous = if (is.null(d)) rpact::getSampleSizeMeans(alpha = alpha, beta = 1 - power, sided = 1L, alternative = effect, stDev = sd, allocationRatioPlanned = r, normalApproximation = TRUE)
                 else rpact::getSampleSizeMeans(d, alternative = effect, stDev = sd, allocationRatioPlanned = r, normalApproximation = TRUE),
      binary = if (is.null(d)) rpact::getSampleSizeRates(alpha = alpha, beta = 1 - power, sided = 1L, pi1 = control_rate + effect, pi2 = control_rate, allocationRatioPlanned = r)
               else rpact::getSampleSizeRates(d, pi1 = control_rate + effect, pi2 = control_rate, allocationRatioPlanned = r),
      time_to_event = if (is.null(d)) rpact::getSampleSizeSurvival(alpha = alpha, beta = 1 - power, sided = 1L, hazardRatio = effect, lambda2 = log(2) / control_median,
                                                                    allocationRatioPlanned = r, accrualTime = c(0, 12), maxNumberOfSubjects = cap, typeOfComputation = "Schoenfeld")
                      else rpact::getSampleSizeSurvival(d, hazardRatio = effect, lambda2 = log(2) / control_median, allocationRatioPlanned = r,
                                                         accrualTime = c(0, 12), maxNumberOfSubjects = cap, typeOfComputation = "Schoenfeld"),
      stop("endpoint"))
    if (identical(endpoint, "time_to_event")) {
      list(max = as.numeric(res$maxNumberOfEvents), expected_h1 = as.numeric(res$expectedEventsH1 %||% res$maxNumberOfEvents),
           expected_h0 = as.numeric(res$expectedEventsH0 %||% res$maxNumberOfEvents),
           reject = as.numeric(res$rejectPerStage), futility = as.numeric(res$futilityPerStage))
    } else {
      list(max = as.numeric(res$maxNumberOfSubjects), expected_h1 = as.numeric(res$expectedNumberOfSubjectsH1 %||% res$maxNumberOfSubjects),
           expected_h0 = as.numeric(res$expectedNumberOfSubjectsH0 %||% res$maxNumberOfSubjects),
           reject = as.numeric(res$rejectPerStage), futility = as.numeric(res$futilityPerStage))
    }
  })
}

#' The analytic power, the probability of stopping early and the expected size of a design of a stated maximum size at each of several
#' true effects (the baselines an adaptive design is shown beside). `size` is the maximum number of patients (events for time to event).
vcr_rpact_power <- function(endpoint, design, size, effects, alpha, allocation = 0.5, sd = 1, control_rate = NULL, control_median = NULL,
                            direction = "higher_better") {
  .vcr_rpact_guard(function() {
    d <- if (is.null(design)) rpact::getDesignGroupSequential(kMax = 1L, alpha = alpha, sided = 1L) else design$object
    pick <- function(x, field) { v <- x[[field]]; if (is.null(v)) NA_real_ else as.numeric(v) }
    one <- function(e) {
      o <- .vcr_rpact_orient(endpoint, e, control_rate, allocation, direction)
      r <- o$allocation / (1 - o$allocation)
      p <- switch(endpoint,
        continuous = rpact::getPowerMeans(d, alternative = o$effect, stDev = sd, maxNumberOfSubjects = size, allocationRatioPlanned = r, normalApproximation = TRUE),
        binary = rpact::getPowerRates(d, pi1 = o$control_rate + o$effect, pi2 = o$control_rate, maxNumberOfSubjects = size, allocationRatioPlanned = r),
        time_to_event = rpact::getPowerSurvival(d, hazardRatio = e, lambda2 = log(2) / control_median, maxNumberOfEvents = size, allocationRatioPlanned = r,
                                                directionUpper = FALSE, accrualTime = c(0, 12), maxNumberOfSubjects = .vcr_rpact_subject_cap(size), typeOfComputation = "Schoenfeld"))
      list(power = pick(p, "overallReject"), early_stop = sum(pick(p, "earlyStop"), na.rm = TRUE),
           expected = if (identical(endpoint, "time_to_event")) pick(p, "expectedNumberOfEvents") else pick(p, "expectedNumberOfSubjects"))
    }
    lapply(effects, one)
  })
}

#' A sample size for a count endpoint (negative binomial rate ratio), fixed or, with `design`, group sequential.
vcr_rpact_counts <- function(design, rate_ratio, control_rate, overdispersion, exposure, alpha, power, allocation = 0.5) {
  .vcr_rpact_guard(function() {
    r <- allocation / (1 - allocation)
    args <- list(lambda1 = control_rate * rate_ratio, lambda2 = control_rate, overdispersion = overdispersion, fixedExposureTime = exposure,
                 allocationRatioPlanned = r)
    res <- if (is.null(design)) do.call(rpact::getSampleSizeCounts, c(list(alpha = alpha, beta = 1 - power, sided = 1L), args))
           else do.call(rpact::getSampleSizeCounts, c(list(design$object), args))
    list(max = as.numeric(res$maxNumberOfSubjects), max_treatment = as.numeric(res$maxNumberOfSubjects1), max_control = as.numeric(res$maxNumberOfSubjects2),
         reject = as.numeric(res$rejectPerStage), futility = as.numeric(res$futilityPerStage),
         expected_h1 = as.numeric(res$expectedNumberOfSubjectsH1 %||% NA_real_))
  })
}

# --- batched simulation --------------------------------------------------------------------------------

#' Run `iterations` simulated trials of one scenario in batches and merge them.
#'
#' `simulate(take, seed, scenario)` is a function of the caller that makes one rpact call and returns its per-iteration rows as a data frame
#' with an `iterationNumber` column (the call runs under the guard here, so the caller writes no tryCatch). `scenarios` runs that many
#' scenarios batch by batch, in step, each for its own number of `iterations` (a null scenario is held to a larger floor than an
#' alternative). Returns the rows of each scenario (iteration numbers continued across batches), the iterations each finished, and why the
#' loop ended early (`canceled`, `cpu_budget` or NULL for a run that finished). `progress(done, planned)` is the job's progress callback.
vcr_rpact_batches <- function(simulate, iterations, seed, scenarios = 1L, batch = 1000L, progress = NULL) {
  want <- rep_len(as.integer(iterations), scenarios)
  parts <- replicate(scenarios, list(), simplify = FALSE)
  done <- rep(0L, scenarios); b <- 0L; stopped <- NULL
  while (any(done < want)) {
    reason <- vcr_interrupt()
    if (!is.null(reason)) { stopped <- reason; break }
    b <- b + 1L
    for (s in which(done < want)) {
      take <- as.integer(min(batch, want[s] - done[s]))
      rows <- .vcr_rpact_guard(function() simulate(take, vcr_rpact_batch_seed(seed, b, s), s))
      rows$iterationNumber <- rows$iterationNumber + done[s]
      parts[[s]][[length(parts[[s]]) + 1L]] <- rows
      done[s] <- done[s] + take
    }
    if (!is.null(progress)) progress(sum(done), sum(want))
  }
  list(rows = lapply(parts, function(p) if (length(p)) do.call(rbind, p) else NULL), done = done, planned = want, stopped = stopped, batches = b)
}

#' The rpact words for a selection rule: `rule` is "best", "rbest" (the `r` best), "epsilon" (all within `epsilon` of the best) or "all".
.vcr_rpact_selection <- function(selection) {
  rule <- selection$rule %||% "best"
  c(list(typeOfSelection = switch(rule, best = "best", rbest = "rBest", epsilon = "epsilon", all = "all")),
    if (identical(rule, "rbest")) list(rValue = selection$r),
    if (identical(rule, "epsilon")) list(epsilonValue = selection$epsilon))
}
.vcr_rpact_intersection <- function(test) c(simes = "Simes", bonferroni = "Bonferroni", dunnett = "Dunnett")[[test %||% "simes"]]

#' An allocation ratio as the whole numbers of patients per cycle an event-time simulation takes (1:1, 2:1, 3:2 ...): the first ratio of up to
#' ten control patients that reproduces it exactly, else the nearest one out of ten.
.vcr_rpact_cycle <- function(ratio) {
  for (b in 1:10) if (abs(ratio * b - round(ratio * b)) < 1e-9 && round(ratio * b) >= 1) return(c(as.integer(round(ratio * b)), as.integer(b)))
  c(max(1L, as.integer(round(ratio * 10))), 10L)
}

#' The promising-zone rule as the stage-size function rpact asks for (`vcr_rpact_zone_function`). At the interim the conditional power of the
#' PLANNED second stage is read at the interim estimate of the effect (the same estimate the plain conditional-power rule uses): inside the
#' zone `lower <= CP <= upper` the second stage is sized to reach the target conditional power, within [planned second stage, cap]; outside
#' it, or when the estimate gives no conditional power to read, the planned second stage is kept. The conditional power of a stage of n
#' patients (events) under the standardized drift `theta` per unit of root-n is Phi(theta * sqrt(n) - cc), `cc` being the conditional
#' critical value of the inverse-normal combination, and the size that reaches a target is (cc + z_target)^2 / theta^2: the rule of rpact's
#' default function with one more condition in front of it.
.vcr_rpact_zone_stage <- function(zone, theta, planned, cc, target, lowest, highest) {
  cp <- stats::pnorm(theta * sqrt(planned) - cc)
  if (!(is.finite(cp) && cp >= zone$lower && cp <= zone$upper)) return(planned)
  need <- max(0, cc + stats::qnorm(target))^2 / max(1e-12, theta)^2
  min(max(lowest, need), highest)
}
.vcr_rpact_at <- function(x, i) x[min(i, length(x))]

#' The zone function of an endpoint; `zone` is list(lower, upper). The formal arguments are the ones rpact passes by name (it checks them
#' against its own default function and requires the three dots).
vcr_rpact_zone_function <- function(endpoint, zone) {
  switch(endpoint,
    continuous = function(..., stage, plannedSubjects, allocationRatioPlanned, minNumberOfSubjectsPerStage, maxNumberOfSubjectsPerStage,
                          thetaH1, stDevH1, conditionalPower, conditionalCriticalValue) {
      r <- .vcr_rpact_at(allocationRatioPlanned, stage)
      variance <- stDevH1[1L]^2 * (1 + r) / r + stDevH1[length(stDevH1)]^2 * (1 + r)
      .vcr_rpact_zone_stage(zone, thetaH1 / sqrt(variance), plannedSubjects[stage] - plannedSubjects[stage - 1L], conditionalCriticalValue,
                            conditionalPower, minNumberOfSubjectsPerStage[stage], maxNumberOfSubjectsPerStage[stage])
    },
    binary = function(..., stage, plannedSubjects, allocationRatioPlanned, minNumberOfSubjectsPerStage, maxNumberOfSubjectsPerStage,
                      conditionalPower, conditionalCriticalValue, overallRate, farringtonManningValue1, farringtonManningValue2) {
      r <- .vcr_rpact_at(allocationRatioPlanned, stage); k <- 1 + 1 / r
      planned <- plannedSubjects[stage] - plannedSubjects[stage - 1L]
      effect <- overallRate[1L] - overallRate[2L]
      # the null variance of the stage statistic (Farrington-Manning, the restricted rates) and the variance at the observed rates
      v0 <- farringtonManningValue1 * (1 - farringtonManningValue1) + farringtonManningValue2 * (1 - farringtonManningValue2) * r
      v1 <- overallRate[1L] * (1 - overallRate[1L]) + overallRate[2L] * (1 - overallRate[2L]) * r
      cp <- stats::pnorm((effect * sqrt(planned / k) - conditionalCriticalValue * sqrt(v0)) / sqrt(v1))
      if (!(is.finite(cp) && cp >= zone$lower && cp <= zone$upper)) return(planned)
      need <- k * max(0, conditionalCriticalValue * sqrt(v0) + stats::qnorm(conditionalPower) * sqrt(v1))^2 / max(1e-12, effect)^2
      ceiling(min(max(minNumberOfSubjectsPerStage[stage], need), maxNumberOfSubjectsPerStage[stage]))
    },
    time_to_event = function(..., stage, conditionalPower, thetaH0, estimatedTheta, plannedEvents, eventsOverStages, minNumberOfEventsPerStage,
                             maxNumberOfEventsPerStage, allocationRatioPlanned, conditionalCriticalValue) {
      r <- .vcr_rpact_at(allocationRatioPlanned, stage)
      theta <- log(estimatedTheta / thetaH0) * sqrt(r) / (1 + r)
      done <- eventsOverStages[stage - 1L]
      # rpact reads the CUMULATED number of events back: what has happened plus the new stage
      done + .vcr_rpact_zone_stage(zone, theta, plannedEvents[stage] - plannedEvents[stage - 1L], conditionalCriticalValue, conditionalPower,
                                   minNumberOfEventsPerStage[stage], maxNumberOfEventsPerStage[stage])
    },
    stop("endpoint"))
}

#' One batch of a sample-size re-estimation for one true `effect` (two stages, the second sized from the conditional power at the interim
#' estimate, within [planned second stage, cap]): the per-iteration rows. `planned` is the cumulative size at each stage (patients, or events
#' for a time-to-event endpoint), `cap` the largest total, `accrual` list(duration, dropoutAnnual, perYear, maxSubjects) for the event-time case.
#' With `zone` (list(lower, upper)) the second stage is enlarged only when the conditional power of the planned one lies in the zone.
vcr_rpact_sim_reestimation <- function(endpoint, design, effect, planned, cap, conditional_power, allocation, take, seed,
                                       sd = 1, control_rate = NULL, control_median = NULL, accrual = NULL, zone = NULL, direction = "higher_better") {
  o <- .vcr_rpact_orient(endpoint, effect, control_rate, allocation, direction)
  effect <- o$effect; control_rate <- o$control_rate; allocation <- o$allocation
  r <- allocation / (1 - allocation)
  second <- c(NA_real_, planned[2L] - planned[1L]); most <- c(NA_real_, cap - planned[1L])
  rule <- if (is.null(zone)) NULL else vcr_rpact_zone_function(endpoint, zone)
  sim <- switch(endpoint,
    continuous = rpact::getSimulationMeans(design$object, groups = 2L, alternative = effect, stDev = sd, plannedSubjects = planned, directionUpper = TRUE,
      normalApproximation = TRUE, allocationRatioPlanned = r, conditionalPower = conditional_power,
      minNumberOfSubjectsPerStage = second, maxNumberOfSubjectsPerStage = most, maxNumberOfIterations = take, seed = seed, calcSubjectsFunction = rule),
    binary = rpact::getSimulationRates(design$object, groups = 2L, pi1 = control_rate + effect, pi2 = control_rate, plannedSubjects = planned, directionUpper = TRUE,
      allocationRatioPlanned = r, conditionalPower = conditional_power,
      minNumberOfSubjectsPerStage = second, maxNumberOfSubjectsPerStage = most, maxNumberOfIterations = take, seed = seed, calcSubjectsFunction = rule),
    time_to_event = rpact::getSimulationSurvival(design$object, hazardRatio = effect, lambda2 = log(2) / control_median, plannedEvents = planned, directionUpper = FALSE,
      allocation1 = .vcr_rpact_cycle(r)[[1L]], allocation2 = .vcr_rpact_cycle(r)[[2L]], accrualTime = c(0, accrual$duration), maxNumberOfSubjects = accrual$maxSubjects,
      dropoutRate1 = accrual$dropoutAnnual, dropoutRate2 = accrual$dropoutAnnual, dropoutTime = accrual$perYear,
      conditionalPower = conditional_power, minNumberOfEventsPerStage = second, maxNumberOfEventsPerStage = most,
      maxNumberOfIterations = take, seed = seed, calcEventsFunction = rule))
  as.data.frame(sim$.data)
}

#' One batch of a multi-arm selection design for one effect scenario (`effects`: the true effect of each active arm; for an event-time endpoint
#' the hazard ratio of each arm against the control). `planned` is the cumulative number of patients per arm (the control too) at each stage,
#' or, for an event-time endpoint, the cumulative number of events of the arms still in the trial and the control. Returns the per-iteration
#' rows: an arm has a row at the second stage when it was selected, and a row says whether its hypothesis was rejected there.
vcr_rpact_sim_multiarm <- function(endpoint, design, effects, planned, selection, intersection, take, seed, sd = 1, control_rate = NULL, direction = "higher_better") {
  lower <- identical(direction, "lower_better")
  if (lower && identical(endpoint, "continuous")) effects <- -effects     # (the means simulation has no direction of its own; the rates one has)
  common <- c(list(design$object, activeArms = length(effects), typeOfShape = "userDefined",
                   effectMatrix = matrix(if (identical(endpoint, "binary")) control_rate + effects else effects, nrow = 1L),
                   intersectionTest = .vcr_rpact_intersection(intersection), maxNumberOfIterations = take, seed = seed),
              .vcr_rpact_selection(selection))
  sim <- switch(endpoint,
    binary = do.call(rpact::getSimulationMultiArmRates, c(common, list(plannedSubjects = planned, piControl = control_rate, directionUpper = !lower))),
    time_to_event = do.call(rpact::getSimulationMultiArmSurvival, c(common, list(plannedEvents = planned, directionUpper = FALSE))),
    do.call(rpact::getSimulationMultiArmMeans, c(common, list(plannedSubjects = planned, stDev = sd))))
  as.data.frame(sim$.data)
}

#' One batch of an enrichment design for one scenario: the effect in the biomarker-positive subset and outside it (a hazard ratio for an
#' event-time endpoint), the subset's prevalence, and the selection between the subset and the full population at the interim. `planned` is
#' the cumulative number of patients (events, for an event-time endpoint) of both arms at each stage.
vcr_rpact_sim_enrichment <- function(endpoint, design, subset_effect, rest_effect, prevalence, planned, selection, intersection, take, seed, sd = 1, control_rate = NULL,
                                     direction = "higher_better") {
  lower <- identical(direction, "lower_better")
  if (lower && identical(endpoint, "continuous")) { subset_effect <- -subset_effect; rest_effect <- -rest_effect }
  groups <- c("S", "R")
  effects <- matrix(c(subset_effect, rest_effect), nrow = 1L, dimnames = list(NULL, groups))
  effect_list <- switch(endpoint,
    binary = list(subGroups = groups, prevalences = c(prevalence, 1 - prevalence),
                  piTreatments = matrix(control_rate + c(subset_effect, rest_effect), nrow = 1L, dimnames = list(NULL, groups)), piControls = rep(control_rate, 2L)),
    time_to_event = list(subGroups = groups, prevalences = c(prevalence, 1 - prevalence), hazardRatios = effects),
    list(subGroups = groups, prevalences = c(prevalence, 1 - prevalence), stDevs = sd, effects = effects))
  common <- c(list(design$object, effectList = effect_list, intersectionTest = .vcr_rpact_intersection(intersection),
                   maxNumberOfIterations = take, seed = seed), .vcr_rpact_selection(selection))
  sim <- switch(endpoint,
    binary = do.call(rpact::getSimulationEnrichmentRates, c(common, list(plannedSubjects = planned, directionUpper = !lower))),
    time_to_event = do.call(rpact::getSimulationEnrichmentSurvival, c(common, list(plannedEvents = planned, directionUpper = FALSE))),
    do.call(rpact::getSimulationEnrichmentMeans, c(common, list(plannedSubjects = planned))))
  as.data.frame(sim$.data)
}

#' The inverse-normal design an adaptive simulation combines its stages with (alpha spending only; the same spending as the group-sequential baseline).
vcr_rpact_inverse_normal <- function(rates, alpha, spending = "obrien_fleming", gamma = NULL) {
  vcr_rpact_design(rates, alpha, power = 0.9, spending = spending, gamma = gamma, futility = NULL, kind = "inverse_normal")
}
