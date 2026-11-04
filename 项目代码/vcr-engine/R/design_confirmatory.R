# ---------------------------------------------------------------------------
# design_confirmatory.R — the confirmatory designs (algorithm round T2-T6, 2026-11-03): `design.confirmatory`.
#
# One method, five `design.kind`s, each answering a question a person asks before a trial:
#
#   futility_group_sequential  "中期发现没戏就停，能省多少"  efficacy and futility boundaries, the size, the expected size under the null and the
#                              alternative, the probability of stopping at each look
#   sample_size_reestimation   "效应没把握，中期加样，功效和平均要多少人"  conditional-power re-estimation at one interim, shown per assumed effect
#                              beside the fixed and the group-sequential design that go with it; with a promising zone the size is
#                              enlarged only when the conditional power at the interim lies between two stated bounds
#   multi_arm_selection        "几个剂量加对照，中期选一个，比几个试验省多少，选错概率多少"  continuous, binary and event time
#   enrichment                 "标志物阳性占一部分，中期收窄入组，功效如何"  continuous, binary and event time
#   count_endpoint             "每年发作次数这类终点要多少人"  negative-binomial rate ratio, fixed or group sequential
#
# Hidden knowledge:
#
# - **rpact does the arithmetic and `rpact_adapter.R` is the only file that touches it.** This file builds the questions in the engine's own
#   words and reads plain numbers back. The checks of the numbers are not rpact (it cannot check itself): gsDesign for the boundaries and
#   the inflation, the engine's own recursion for a design without a futility boundary, mvtnorm for the probability of selecting an arm, a
#   negative-binomial closed form for the counts, and a simulation of the rule in plain R (cases N66-N69).
# - **An adaptive design is never shown alone.** A sample-size re-estimation, a selection and an enrichment are read against the fixed
#   design and the group-sequential design that match them (same alpha, same power at the planned effect, same looks), because "it adapts"
#   is not a result: what it saves, and what it costs in the cases where it does not help, is. The baselines are analytic.
# - **The null is always a row.** A confirmatory design must show its type I error, so the null effect is added to the effects the person
#   states when they did not list it (a hazard ratio of 1, a difference of 0, every arm at 0), and the result says it was added.
# - **Every simulated number goes through `vcr_measure(simulated = TRUE)` with its Monte-Carlo error**, probabilities with the binomial
#   error of the iterations that ran, expectations with the standard error of the per-iteration values. The per-effect table is
#   `diagnostics.confirmatory.effects[].cells`, one measure-shaped cell per number; the headline numbers are the flat `measures`.
# - **A default the person did not state is an assumption of the result**, listed with its value in `diagnostics.confirmatory.assumed`
#   (the spending function, the conditional power, the cap on the size, the selection rule, a planned size taken from the matching
#   group-sequential design). The page turns each into a line of the premises; none of them is a refusal.
# - **An event-time selection or enrichment is simulated on the log-rank statistics** (rpact draws them from the planned events; the
#   adapter's header says what that assumes) and is sized in events: `plannedSize` is the cumulative events of the arms still in the trial and
#   the control, there is no accrual and no control median, and the result lists "simulated on the log-rank statistics, proportional
#   hazards" among its assumptions. Its baseline is in the same unit: the best arm in a two-arm trial of its own with the events its own
#   comparison has in the design.
# - **The people of an event-time design (1.2.0) are the people enrolled when the trial ends, never the events over a chance of an event.** A
#   person asks "how many people on average", and the events saved by stopping early are mostly follow-up saved, not people: the interim
#   of a 18-month accrual falls at month 17, when 95% have already entered. Group sequential: the expected number enrolled at each look
#   (even enrolment, the look is the day the expected events reach its share, nobody enters after a stop) weighted by the probability of
#   stopping there. Re-estimation: the plan's people (its events over the chance of an event at the planned effect), the people enrolled at the
#   interim for a trial that stops there, the final events over that chance for one that goes on. The simulation's own `numberOfSubjects` is not
#   used: it enrols the cap's people on the cap's schedule in every trial (1,466 on average beside a plan of 830). Selection and enrichment are
#   sized in events and simulated on the log-rank statistics, so for them the people are only the events over the chance of an event of a
#   control and a treated person (`*_patients_from_events`: the final comparison, the arms dropped at the interim not counted), and only when the
#   scenario states the accrual and the control median; otherwise `people` says they are not computed and which keys give them.
# - **A run that is stopped keeps what it has.** The batches that finished are merged, every scenario reports the iterations it ran, and
#   the result is `limited` with the named reason (a spent CPU budget or a cancel), never a whole-looking answer from part of the work.
# ---------------------------------------------------------------------------

VCR_CONFIRMATORY_NULL_RATE_RATIO <- 1

# --- reading the scenario ------------------------------------------------------------------------------

.vcr_conf_common <- function(sc) {
  d <- sc$design; an <- sc$analysis %||% list(); tr <- sc$truth %||% list()
  spending <- as.character(d[["spending"]] %||% "obrien_fleming")
  endpoint <- as.character(sc$endpoint$type %||% "")
  # which way a mean or a risk difference is better (hypothesis.direction): the one sign convention of the five kinds. A hazard ratio and a
  # rate ratio have theirs (below 1); the key is not read for them.
  direction <- if (endpoint %in% c("continuous", "binary")) as.character(sc[["hypothesis"]][["direction"]] %||% "") else "higher_better"
  if (!(direction %in% c("higher_better", "lower_better"))) {
    vcr_abort("scenario_field_missing", "scenario.hypothesis.direction", "A confirmatory design on a mean or a risk states which direction is better (higher_better or lower_better): the same sign is a benefit one way and a harm the other.")
  }
  list(kind = as.character(d$kind), endpoint = endpoint, direction = direction,
       alpha = vcr_scalar(an$alpha, 0.025), power = vcr_scalar(an$power, 0.9), allocation = vcr_scalar(d$allocation, 0.5),
       rates = vcr_num(d$informationRates), spending = spending, gamma = vcr_scalar(d$spendingGamma, NULL),
       sd = vcr_scalar(tr$sd, 1), control_rate = vcr_scalar(tr[["controlRate"]], NULL), control_median = vcr_scalar(tr$controlMedian, NULL),
       assumed = list())
}

#' Remember a value the scenario did not state and the engine took.
.vcr_conf_assume <- function(p, key, value, basis = "default") {
  p$assumed[[length(p$assumed) + 1L]] <- list(key = key, value = value, basis = basis)
  p
}
#' What a design's sizes count, as the closed code the control plane words ("events" for a time-to-event design, "patients" for the rest;
#' it is not a unit a number carries, so it is not the "例" of a measure). One definition, because five designs write it.
.vcr_conf_count_kind <- function(events) if (isTRUE(events)) "events" else "patients"
.vcr_conf_note_defaults <- function(p, sc) {
  d <- sc$design; an <- sc$analysis %||% list(); tr <- sc$truth %||% list()
  if (is.null(an$alpha)) p <- .vcr_conf_assume(p, "analysis.alpha", p$alpha)
  if (is.null(an$power) && !identical(p$kind, "multi_arm_selection") && !identical(p$kind, "enrichment")) p <- .vcr_conf_assume(p, "analysis.power", p$power)
  if (is.null(d[["spending"]])) p <- .vcr_conf_assume(p, "design.spending", p[["spending"]])
  if (is.null(d$allocation) && p$kind %in% c("futility_group_sequential", "sample_size_reestimation", "count_endpoint")) p <- .vcr_conf_assume(p, "design.allocation", p$allocation)
  if (identical(p$endpoint, "continuous") && is.null(tr$sd)) p <- .vcr_conf_assume(p, "truth.sd", p$sd)
  p
}

#' The null effect of an endpoint, on the scale the effects are stated in.
.vcr_conf_null_value <- function(endpoint) if (identical(endpoint, "time_to_event")) 1 else 0

#' The effect a size is planned for is a benefit: a hazard ratio or rate ratio below 1, a difference on the side `hypothesis.direction` names.
#' The validator refuses a scenario whose planned effect is a harm before a handler runs; this is the same rule where a handler is called
#' with a scenario that was not validated, so that a size is never planned for power against a harm.
.vcr_conf_require_benefit <- function(p, effect, field) {
  against <- if (p$endpoint %in% c("continuous", "binary")) (if (identical(p$direction, "lower_better")) effect > 0 else effect < 0) else effect > 1
  if (isTRUE(against)) {
    vcr_abort("effect_against_direction", field, if (p$endpoint %in% c("continuous", "binary"))
      sprintf("A size is planned for a benefit, and this effect is on the wrong side of hypothesis.direction (%s): a design cannot be sized to reach power for it.", p$direction)
      else "A size is planned for a benefit, and a ratio above 1 is a harm (more events): a design cannot be sized to reach power for it.")
  }
  invisible(effect)
}

#' The event-time conversion of the control median and the dropout the way the other design methods read them.
.vcr_conf_tte_context <- function(sc, p) {
  acc <- sc$accrual
  if (is.null(acc)) vcr_abort("scenario_field_missing", "scenario.accrual", "A time-to-event design states its accrual: the duration and the follow-up after it.")
  perYear <- vcr_time_unit(sc)$perYear
  list(dist = vcr_dist_exponential_from_median(p$control_median), duration = vcr_scalar(acc$duration, 0), followup = vcr_scalar(acc$followup),
       dropout = vcr_scalar(acc$dropoutAnnual, 0), perYear = perYear, eta = vcr_dropout_hazard(vcr_scalar(acc$dropoutAnnual, 0), perYear))
}

#' Patients an event-time design needs to see `events` events at a hazard ratio, under the stated accrual, follow-up and dropout.
.vcr_conf_patients_for_events <- function(events, hr, ctx, allocation) {
  p0 <- vcr_event_probability(ctx$dist$rate, ctx$duration, ctx$followup, ctx$eta)
  p1 <- vcr_event_probability(ctx$dist$rate * hr, ctx$duration, ctx$followup, ctx$eta)
  p_ev <- (1 - allocation) * p0 + allocation * p1
  list(patients = ceiling(events / p_ev), eventProbability = p_ev)
}

#' Is the job labelled with `from` or a later release? (A job with no label, a handler called directly, replays the oldest release: only a
#' labelled job is counted as having a later one.) design.confirmatory 1.2.0 added the people of an event-time design.
.vcr_conf_labelled_at_least <- function(job, from) {
  mv <- job[["methodVersion"]]
  is.character(mv) && length(mv) == 1L && nzchar(mv) && utils::compareVersion(mv, from) >= 0L
}

#' What turns the events of an event-time design into people: the accrual, the follow-up, the dropout and the control median the scenario
#' stated. `NULL` when it did not (a selection or an enrichment design states none of them unless asked about people).
.vcr_conf_people_context <- function(sc, p) {
  if (is.null(sc$accrual) || is.null(p$control_median)) return(NULL)
  .vcr_conf_tte_context(sc, p)
}

#' The answer of a design that cannot say how many people: the reason and the keys that would give it, in the words the model reads.
.vcr_conf_people_missing <- function() list(computed = FALSE, reason = "accrual_not_stated",
  needs = list("accrual.duration", "accrual.followup", "truth.controlMedian"),
  note = paste("People are not computed: the scenario states no accrual, so the events cannot be turned into patients.",
               "Give accrual.duration, accrual.followup (and accrual.dropoutAnnual if some are lost) and truth.controlMedian, and the result reports expected and maximum patients as well."))

#' The people of a design that is sized in events and simulated on the log-rank statistics: its maximum events over the chance of an event of one
#' person (`per_head`), or the reason there is no answer.
.vcr_conf_people_block <- function(ctx, per_head, max_events, basis) {
  if (is.null(ctx) || is.null(per_head)) return(.vcr_conf_people_missing())
  list(computed = TRUE, basis = basis, maxPatients = ceiling(max_events / per_head - 1e-9), accrualDuration = ctx$duration, followup = ctx$followup)
}

#' The probability that a person of a group with `hr` (against the control) has an event under the stated accrual, follow-up and dropout.
.vcr_conf_event_prob <- function(hr, ctx) vcr_event_probability(ctx$dist$rate * hr, ctx$duration, ctx$followup, ctx$eta)

#' The expected events at calendar time `t` of `n` people who enter evenly over the accrual: the people enrolled by `t`, each with the
#' probability of an event by `t` (the Lachin-Foulkes probability for an accrual that has run `t` and no follow-up yet, or the whole accrual and
#' `t - accrual` of follow-up), averaged over the groups (`shares`, with the hazard ratios `hrs` against the control).
.vcr_conf_events_by_time <- function(t, n, shares, hrs, ctx) {
  during <- min(t, ctx$duration)
  enrolled <- if (ctx$duration > 0) n * min(1, t / ctx$duration) else n
  enrolled * sum(shares * vapply(hrs, function(h) vcr_event_probability(ctx$dist$rate * h, during, max(0, t - ctx$duration), ctx$eta), numeric(1)))
}

#' When `events` are expected to have happened among `n` people, and how many of them were enrolled by then (the analysis of a look
#' happens that day; enrolment stops with a trial that stops).
.vcr_conf_enrolled_at <- function(events, n, shares, hrs, ctx) {
  horizon <- ctx$duration + ctx$followup
  at <- function(t) .vcr_conf_events_by_time(t, n, shares, hrs, ctx)
  t <- if (!(events > 0)) 0 else if (at(horizon) <= events) horizon else stats::uniroot(function(u) at(u) - events, c(0, horizon), tol = 1e-10)$root
  list(time = t, enrolled = if (ctx$duration > 0) n * min(1, t / ctx$duration) else n)
}

#' The analytic power of the one-sided log-rank test at `events` events and a hazard ratio, 1:1, signed (a hazard ratio above 1 has a power
#' below alpha): Schoenfeld's formula, the engine's own, solved for power.
.vcr_conf_events_power <- function(events, hazard_ratio, alpha) stats::pnorm(sqrt(events / 4) * (-log(hazard_ratio)) - stats::qnorm(1 - alpha))

#' The analytic power of a fixed two-arm comparison with `n_treat` and `n_control` patients at a true effect, the engine's own closed form.
.vcr_conf_fixed_power <- function(p, effect, n_treat, n_control, alpha) {
  lower <- identical(p$direction, "lower_better")
  switch(p$endpoint,
    continuous = vcr_power_means(if (lower) -effect else effect, p$sd, n_treat, n_control, alpha, 1),
    # a lower rate is better: the arms swap labels (the test of two rates does not care which carries which)
    binary = if (lower) vcr_power_proportions(p$control_rate + effect, p$control_rate, n_control, n_treat, alpha, 1)
             else vcr_power_proportions(p$control_rate, p$control_rate + effect, n_treat, n_control, alpha, 1))
}

#' What the scenario stated that the answer turns on, echoed with the result so that a page can word the premises without the job: the
#' effect the size is planned for, the control level, the dropout, how many scenarios were stated.
.vcr_conf_given <- function(sc) {
  tr <- sc$truth %||% list(); d <- sc$design %||% list()
  zone <- d$promisingZone
  hy <- sc[["hypothesis"]][["direction"]]
  keep <- list(direction = if (is.character(hy)) hy, plannedEffect = vcr_scalar(tr$plannedEffect, NULL), controlRate = vcr_scalar(tr[["controlRate"]], NULL), controlMedian = vcr_scalar(tr$controlMedian, NULL),
               controlEventRate = vcr_scalar(tr$controlEventRate, NULL), rateRatio = vcr_scalar(tr$rateRatio, NULL), overdispersion = vcr_scalar(tr$overdispersion, NULL),
               subsetPrevalence = vcr_scalar(d$subsetPrevalence, NULL), dropoutAnnual = vcr_scalar(sc$accrual$dropoutAnnual, NULL),
               accrualDuration = vcr_scalar(sc$accrual$duration, NULL), followup = vcr_scalar(sc$accrual$followup, NULL),
               timeUnit = if (!is.null(sc$accrual)) vcr_time_unit(sc)$unit,
               effectScenarios = if (!is.null(tr$effectScenarios)) length(tr$effectScenarios), subsetScenarios = if (!is.null(tr$subsetEffects)) length(tr$subsetEffects),
               promisingZone = if (!is.null(zone)) list(lower = vcr_scalar(zone$lower), upper = vcr_scalar(zone$upper)))
  Filter(Negate(is.null), keep)
}

# --- cells and rows ---------------------------------------------------------------------------------------

.vcr_conf_calc <- function(name, value) vcr_measure(name, value, source = "calculated")
.vcr_conf_prob <- function(name, successes, n) {
  p <- successes / n
  vcr_measure(name, p, simulated = TRUE, mcse = vcr_mcse_proportion(p, n), source = "synthetic")
}
.vcr_conf_mean <- function(name, x) {
  x <- x[is.finite(x)]
  vcr_measure(name, mean(x), simulated = TRUE, mcse = if (length(x) > 1L && stats::sd(x) > 0) vcr_mcse_mean(x) else 0, source = "synthetic")
}
#' A named list of cells, one per index, each built by `make(index)` (its name is the measure's own).
.vcr_conf_indexed <- function(n, make) .vcr_conf_cells(cells = lapply(seq_len(n), make))
.vcr_conf_cells <- function(..., cells = NULL) {
  cells <- c(list(...), cells)
  cells <- Filter(Negate(is.null), cells)
  names(cells) <- vapply(cells, function(m) m$name, character(1))
  cells
}
.vcr_conf_ceiling <- function(x) if (is.finite(x)) ceiling(x - 1e-9) else x

# --- futility group sequential (T2) -----------------------------------------------------------------------

.vcr_conf_futility <- function(job) {
  sc <- job$scenario; p <- .vcr_conf_note_defaults(.vcr_conf_common(sc), sc)
  d <- sc$design; tr <- sc$truth
  fut <- d$futility %||% list()
  if (is.null(d$futility)) p <- .vcr_conf_assume(p, "design.futility", "beta spending, O'Brien-Fleming type, not binding")
  else {
    if (is.null(fut[["spending"]])) p <- .vcr_conf_assume(p, "design.futility.spending", "obrien_fleming")
    if (is.null(fut$binding)) p <- .vcr_conf_assume(p, "design.futility.binding", FALSE)
  }
  futility <- list(spending = as.character(fut[["spending"]] %||% "obrien_fleming"), gamma = vcr_scalar(fut$gamma, NULL), binding = isTRUE(fut$binding))
  effect <- .vcr_conf_require_benefit(p, vcr_scalar(tr$plannedEffect), "scenario.truth.plannedEffect")
  k <- length(p$rates)
  gs <- vcr_rpact_design(p$rates, p$alpha, p$power, p[["spending"]], p$gamma, futility)
  op <- vcr_rpact_operating(gs)
  size <- vcr_rpact_sample_size(p$endpoint, gs, effect, p$alpha, p$power, p$allocation, p$sd, p$control_rate, p$control_median, direction = p$direction)
  # the fixed design it is read against: the engine's own closed form, not rpact's
  fixed <- switch(p$endpoint,
    continuous = vcr_n_means(effect, p$sd, p$alpha, p$power, p$allocation, 1)$total,
    binary = vcr_n_proportions(p$control_rate, p$control_rate + effect, p$alpha, p$power, p$allocation, 1)$total,
    time_to_event = vcr_events_schoenfeld(effect, p$alpha, p$power, p$allocation, 1))
  events <- identical(p$endpoint, "time_to_event")
  unit <- .vcr_conf_count_kind(events)
  max_size <- size$max
  at_look <- max_size * p$rates
  patients <- NULL
  people <- v12 <- NULL
  if (events) {
    ctx <- .vcr_conf_tte_context(sc, p)
    patients <- .vcr_conf_patients_for_events(max_size, effect, ctx, p$allocation)$patients
    v12 <- .vcr_conf_labelled_at_least(job, "1.2.0")
  }
  efficacy <- gs$efficacyBounds; futility_bounds <- gs$futilityBounds %||% rep(NA_real_, k)
  looks <- lapply(seq_len(k), function(i) list(look = i, informationRate = p$rates[i], size = at_look[i], efficacyBound = efficacy[i],
    futilityBound = if (is.finite(futility_bounds[i])) futility_bounds[i] else NULL, alphaSpent = gs$alphaSpent[i], betaSpent = if (is.null(gs$betaSpent)) NULL else gs$betaSpent[i]))
  # The people of an event-time design (1.2.0): the number enrolled when the trial stops. Enrolment is even over the accrual, a look is the day
  # the expected events reach its share of the planned events, and a trial that stops enrols no one after it, so a look after the accrual has
  # ended stops nothing in people (the events saved are the follow-up saved). The events per head are the stated accrual's (Lachin-Foulkes).
  at_looks <- function(hr, probs) {
    shares <- c(1 - p$allocation, p$allocation); hrs <- c(1, hr)
    where <- lapply(seq_len(k), function(i) .vcr_conf_enrolled_at(p$rates[i] * max_size, patients, shares, hrs, ctx))
    stopped <- probs$reject + probs$futility
    weight <- c(stopped[-k], 1 - sum(stopped[-k]))
    list(expected = sum(weight * vapply(where, function(w) w$enrolled, numeric(1))), looks = where)
  }
  row <- function(role, probs, expected, effect_value, enrolled = NULL) list(role = role, effect = effect_value, cells = c(
    .vcr_conf_cells(.vcr_conf_calc(if (identical(role, "null")) "type_one_error" else "power", sum(probs$reject)),
                    .vcr_conf_calc("futility_stop_probability", sum(probs$futility)),
                    .vcr_conf_calc(if (events) "expected_events" else "expected_sample_size", expected),
                    if (!is.null(enrolled)) .vcr_conf_calc("expected_patients", enrolled$expected)),
    .vcr_conf_indexed(k, function(i) .vcr_conf_calc(sprintf("stop_efficacy_%d", i), probs$reject[i])),
    .vcr_conf_indexed(k, function(i) .vcr_conf_calc(sprintf("stop_futility_%d", i), probs$futility[i]))))
  # (the expected sizes are rpact's own absolute ones from the sample-size call; the characteristics' average sample number is relative to
  # the fixed design, not to the maximum, and is not used here)
  enrolled <- if (isTRUE(v12)) list(h0 = at_looks(1, op$h0), h1 = at_looks(effect, op$h1))
  effects <- list(row("null", op$h0, size$expected_h0, .vcr_conf_null_value(p$endpoint), enrolled[["h0"]]),
                  row("planned", op$h1, size$expected_h1, effect, enrolled[["h1"]]))
  if (!is.null(enrolled)) people <- list(computed = TRUE, basis = "enrolment_at_looks", maxPatients = patients, accrualDuration = ctx$duration, followup = ctx$followup,
    atLooks = lapply(seq_len(k), function(i) list(look = i, timePlanned = enrolled[["h1"]]$looks[[i]]$time, enrolledPlanned = enrolled[["h1"]]$looks[[i]]$enrolled,
                                                  timeNull = enrolled[["h0"]]$looks[[i]]$time, enrolledNull = enrolled[["h0"]]$looks[[i]]$enrolled)))
  size_name <- if (events) "expected_events" else "expected_sample_size"
  renamed <- function(m, name) { m$name <- name; m }
  measures <- Filter(Negate(is.null), list(
    .vcr_conf_calc(if (events) "required_events" else "required_total", .vcr_conf_ceiling(fixed)),
    .vcr_conf_calc(if (events) "max_events" else "max_patients", .vcr_conf_ceiling(max_size)),
    if (!is.null(patients)) .vcr_conf_calc("max_patients", patients),
    effects[[2]]$cells$power, effects[[1]]$cells$type_one_error,
    effects[[2]]$cells[[size_name]], renamed(effects[[1]]$cells[[size_name]], paste0(size_name, "_h0")),
    if (!is.null(enrolled)) effects[[2]]$cells$expected_patients, if (!is.null(enrolled)) renamed(effects[[1]]$cells$expected_patients, "expected_patients_h0"),
    effects[[2]]$cells$futility_stop_probability, renamed(effects[[1]]$cells$futility_stop_probability, "futility_stop_probability_h0")))
  list(status = "succeeded", measures = measures, counts = vcr_counts(), conclusion = "estimable",
       diagnostics = list(confirmatory = c(list(kind = p$kind, endpoint = p$endpoint, unit = unit, looks = looks, effects = effects,
         baselines = list(fixed = list(size = .vcr_conf_ceiling(fixed), unit = unit)), inflation = op$inflation,
         binding = futility$binding, assumed = p$assumed, given = .vcr_conf_given(sc)), if (!is.null(people)) list(people = people))))
}

# --- the simulated designs: shared reductions ---------------------------------------------------------------

#' What a simulated scenario's rows say per iteration: whether anything was rejected, the size at the stop, and the stage it stopped at.
#' `stopped_stage1` is the trial that ended at the first look. It is NOT "a hypothesis was rejected at the first look": a selection or
#' enrichment trial goes on until every hypothesis it still tests is rejected, so most trials with a rejection at look 1 continue (0.77
#' against 0.0002 in a 3-arm trial with one effective arm, 2026-11-04); rpact's own `earlyStop` counts the stage a trial ended at.
.vcr_conf_iterations <- function(rows, size_col = "numberOfCumulatedSubjects") {
  it <- rows$iterationNumber
  ord <- order(it, rows$stageNumber)
  rows <- rows[ord, , drop = FALSE]; it <- it[ord]
  last <- !duplicated(it, fromLast = TRUE)
  rejected <- rows$rejectPerStage %in% c(TRUE, 1)
  any_reject <- tapply(rejected, it, any)
  list(n = length(any_reject), reject = as.logical(any_reject), size = as.numeric(rows[[size_col]][last]), stage = as.integer(rows$stageNumber[last]),
       stopped_stage1 = as.integer(rows$stageNumber[last]) == 1L, rows = rows, iteration = it)
}

#' A run that stopped before its iterations: the issues that say so, the status and what is left of the iterations.
.vcr_conf_stop <- function(batches) {
  if (is.null(batches$stopped)) return(NULL)
  list(status = if (identical(batches$stopped, "canceled")) "canceled" else "failed",
       issues = if (identical(batches$stopped, "cpu_budget")) list(vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit",
         "The CPU budget ran out before every iteration ran; the numbers below use the iterations that finished, and each effect says how many.")) else list())
}

.vcr_conf_iterations_planned <- function(job, n_null, n_alt, is_null) {
  req <- vcr_scalar(job$replicates, 0)
  limits <- vcr_domain()$limits
  vapply(is_null, function(z) as.integer(max(req, if (z) limits$replicatesNullMin else limits$replicatesAltMin)), integer(1))
}

# --- sample size re-estimation (T3) -----------------------------------------------------------------------

#' The people a re-estimation trial has enrolled when it ends (design.confirmatory 1.2.0), one number per simulated trial. The plan enrols
#' `plan_people$patients` to reach its planned events; a trial that stops at the interim has enrolled those who entered by the day the
#' expected interim events were reached at the true effect (even enrolment, none after the stop), and one that goes on has enrolled the people its
#' final events need at the planned event rate per head, never fewer than the plan. (The simulation's own `numberOfSubjects` is not this: it
#' enrols the people of the cap on the cap's schedule in every trial, 1,466 on average beside a plan of 830.)
.vcr_conf_reestimation_people <- function(it, events, effect, plan, plan_people, ctx, allocation) {
  at_interim <- .vcr_conf_enrolled_at(plan[1L], plan_people$patients, c(1 - allocation, allocation), c(1, effect), ctx)$enrolled
  ifelse(it$stage == 1L, at_interim, pmax(plan_people$patients, events / plan_people$eventProbability))
}

.vcr_conf_reestimation <- function(job, progress = NULL) {
  sc <- job$scenario; p <- .vcr_conf_note_defaults(.vcr_conf_common(sc), sc)
  d <- sc$design; tr <- sc$truth
  events <- identical(p$endpoint, "time_to_event"); unit <- .vcr_conf_count_kind(events)
  cp <- vcr_scalar(d$conditionalPower, 0.8); factor <- vcr_scalar(d$maxSampleSizeFactor, 2)
  zone <- if (is.null(d$promisingZone)) NULL else list(lower = vcr_scalar(d$promisingZone$lower), upper = vcr_scalar(d$promisingZone$upper))
  if (is.null(d$conditionalPower)) p <- .vcr_conf_assume(p, "design.conditionalPower", cp)
  if (is.null(d$maxSampleSizeFactor)) p <- .vcr_conf_assume(p, "design.maxSampleSizeFactor", factor)
  planned_effect <- .vcr_conf_require_benefit(p, vcr_scalar(tr$plannedEffect), "scenario.truth.plannedEffect")
  null_value <- .vcr_conf_null_value(p$endpoint)
  stated <- vcr_num(tr$effects)
  asked <- unique(c(stated, planned_effect))
  has_null <- any(abs(asked - null_value) < 1e-12)
  effects <- c(if (!has_null) null_value, asked)
  if (!has_null) p <- .vcr_conf_assume(p, "truth.effects", null_value, basis = "added: the null, to show the type I error")
  # the group-sequential design the same looks make (efficacy only), and the fixed one; both sized for the planned effect
  gs <- vcr_rpact_design(p$rates, p$alpha, p$power, p[["spending"]], p$gamma, NULL)
  gs_size <- vcr_rpact_sample_size(p$endpoint, gs, planned_effect, p$alpha, p$power, p$allocation, p$sd, p$control_rate, p$control_median, direction = p$direction)
  fx_size <- vcr_rpact_sample_size(p$endpoint, NULL, planned_effect, p$alpha, p$power, p$allocation, p$sd, p$control_rate, p$control_median, direction = p$direction)
  plan_total <- if (!is.null(d$plannedSize)) vcr_scalar(d$plannedSize) else .vcr_conf_ceiling(gs_size$max)
  if (is.null(d$plannedSize)) p <- .vcr_conf_assume(p, "design.plannedSize", plan_total, basis = "derived: the size of the group-sequential design with these looks, for the planned effect")
  plan <- c(ceiling(p$rates[1L] * plan_total), plan_total)
  cap <- ceiling(factor * plan_total)
  if (cap <= plan_total) cap <- plan_total + 1
  ctx <- if (events) .vcr_conf_tte_context(sc, p) else NULL
  v12 <- events && .vcr_conf_labelled_at_least(job, "1.2.0")
  max_subjects <- if (events) {
    worst <- max(vapply(effects, function(e) .vcr_conf_patients_for_events(cap, e, ctx, p$allocation)$patients, numeric(1)))
    as.integer(worst)
  }
  # (1.2.0) the people the plan enrols, and the chance of an event per person that turns every other number of events into people
  plan_people <- if (v12) .vcr_conf_patients_for_events(plan_total, planned_effect, ctx, p$allocation)
  accrual <- if (events) list(duration = ctx$duration, dropoutAnnual = vcr_scalar(sc$accrual$dropoutAnnual, 0), perYear = ctx$perYear, maxSubjects = max_subjects)
  inv <- vcr_rpact_inverse_normal(p$rates, p$alpha, p[["spending"]], p$gamma)
  is_null <- abs(effects - null_value) < 1e-12
  iters <- .vcr_conf_iterations_planned(job, NULL, NULL, is_null)
  batches <- vcr_rpact_batches(function(take, seed, s) vcr_rpact_sim_reestimation(p$endpoint, inv, effects[s], plan, cap, cp, p$allocation, take, seed,
                                 sd = p$sd, control_rate = p$control_rate, control_median = p$control_median, accrual = accrual, zone = zone, direction = p$direction),
                               iters, vcr_scalar(job$seed, 1), scenarios = length(effects), progress = progress)
  size_col <- if (events) "numberOfSubjects" else "numberOfCumulatedSubjects"
  fixed_pw <- vcr_rpact_power(p$endpoint, NULL, .vcr_conf_ceiling(fx_size$max), effects, p$alpha, p$allocation, p$sd, p$control_rate, p$control_median, direction = p$direction)
  gs_pw <- vcr_rpact_power(p$endpoint, gs, .vcr_conf_ceiling(gs_size$max), effects, p$alpha, p$allocation, p$sd, p$control_rate, p$control_median, direction = p$direction)
  rows_out <- list(); issues <- list()
  for (s in seq_along(effects)) {
    r <- batches$rows[[s]]
    if (is.null(r)) next
    it <- .vcr_conf_iterations(r, size_col)
    ev <- if (events) {
      last <- r[order(r$iterationNumber, r$stageNumber), ]; last <- last[!duplicated(last$iterationNumber, fromLast = TRUE), ]
      as.numeric(last$overallEvents1 + last$overallEvents2)
    } else NULL
    total <- if (events) ev else it$size
    increased <- sum(total > plan_total + 1e-9)
    cells <- .vcr_conf_cells(
      .vcr_conf_prob(if (is_null[s]) "type_one_error" else "power", sum(it$reject), it$n),
      .vcr_conf_mean(if (events) "expected_events" else "expected_sample_size", total),
      .vcr_conf_prob("early_stop_probability", sum(it$stopped_stage1), it$n),
      .vcr_conf_prob("increase_probability", increased, it$n),
      if (events) .vcr_conf_mean("expected_patients", if (v12) .vcr_conf_reestimation_people(it, ev, effects[s], plan, plan_people, ctx, p$allocation) else it$size))
    rows_out[[length(rows_out) + 1L]] <- list(role = if (is_null[s]) "null" else if (abs(effects[s] - planned_effect) < 1e-12) "planned" else "assumed", effect = effects[s],
      iterations = it$n, cells = cells,
      fixed = list(power = fixed_pw[[s]]$power, size = .vcr_conf_ceiling(fx_size$max)),
      groupSequential = list(power = gs_pw[[s]]$power, expectedSize = gs_pw[[s]]$expected, maxSize = .vcr_conf_ceiling(gs_size$max), earlyStop = gs_pw[[s]]$early_stop))
  }
  stop_state <- .vcr_conf_stop(batches)
  head_row <- Filter(function(r) identical(r$role, "planned"), rows_out)
  null_row <- Filter(function(r) identical(r$role, "null"), rows_out)
  # (1.2.0) the people beside the events: the trial is simulated patient by patient, so the expected number is the simulation's own and the most
  # a trial can enrol is the people that the capped number of events needs in the worst of the effects
  measures <- c(list(.vcr_conf_calc(if (events) "required_events" else "required_total", .vcr_conf_ceiling(fx_size$max)),
                     .vcr_conf_calc(if (events) "planned_events" else "planned_total", plan_total),
                     .vcr_conf_calc(if (events) "max_events" else "max_patients", cap)),
                if (v12) list(.vcr_conf_calc("max_patients", .vcr_conf_ceiling(cap / plan_people$eventProbability))),
                if (length(head_row)) unname(head_row[[1]]$cells[c("power", if (events) "expected_events" else "expected_sample_size", if (v12) "expected_patients", "increase_probability")]),
                if (length(null_row)) list(null_row[[1]]$cells$type_one_error))
  people <- if (v12) {
    list(computed = TRUE, basis = "planned_enrolment", maxPatients = .vcr_conf_ceiling(cap / plan_people$eventProbability), plannedPatients = plan_people$patients, accrualDuration = ctx$duration, followup = ctx$followup,
         fixedPatients = .vcr_conf_patients_for_events(fx_size$max, planned_effect, ctx, p$allocation)$patients,
         groupSequentialPatients = .vcr_conf_patients_for_events(gs_size$max, planned_effect, ctx, p$allocation)$patients)
  }
  list(status = stop_state$status %||% "succeeded", measures = measures, issues = stop_state$issues %||% list(), counts = vcr_counts(generatedRecords = sum(batches$done)),
       conclusion = if (is.null(stop_state)) "estimable" else "limited",
       diagnostics = list(replicatesCompleted = min(batches$done), confirmatory = c(list(kind = p$kind, endpoint = p$endpoint, unit = unit, effects = rows_out,
         plan = list(first = plan[1L], total = plan[2L], cap = cap, conditionalPower = cp, promisingZone = zone), iterations = as.list(batches$done),
         baselines = list(fixed = list(size = .vcr_conf_ceiling(fx_size$max), unit = unit),
                          groupSequential = list(maxSize = .vcr_conf_ceiling(gs_size$max), unit = unit, looks = length(p$rates))),
         assumed = p$assumed, given = .vcr_conf_given(sc)), if (!is.null(people)) list(people = people))))
}

# --- multi-arm selection (T4) -------------------------------------------------------------------------------

#' What an event-time design takes that the others do not state: it is simulated on the log-rank statistics (no accrual, follow-up or dropout)
#' and sized in events. Listed with the result as an assumption of the method.
.vcr_conf_event_driven <- function(p) {
  .vcr_conf_assume(p, "design.eventDriven", "simulated on the log-rank statistics from the planned events, proportional hazards, the same control hazard in every group",
                   basis = "method: no accrual, follow-up or dropout is simulated")
}

.vcr_conf_multiarm <- function(job, progress = NULL) {
  sc <- job$scenario; p <- .vcr_conf_note_defaults(.vcr_conf_common(sc), sc)
  d <- sc$design; tr <- sc$truth
  events <- identical(p$endpoint, "time_to_event"); unit <- .vcr_conf_count_kind(events)
  arms <- as.integer(d$activeArms)
  selection <- list(rule = as.character(d$selection$rule %||% "best"), r = vcr_scalar(d$selection$r, NULL), epsilon = vcr_scalar(d$selection$epsilon, NULL))
  if (is.null(d$selection)) p <- .vcr_conf_assume(p, "design.selection.rule", "best", basis = "default: the arm with the best interim estimate continues")
  intersection <- as.character(d$intersectionTest %||% "simes")
  if (is.null(d$intersectionTest)) p <- .vcr_conf_assume(p, "design.intersectionTest", intersection)
  if (events) p <- .vcr_conf_event_driven(p)
  # (1.2.0) an event-time design says how many people its events are when the scenario states the accrual and the control median
  v12 <- events && .vcr_conf_labelled_at_least(job, "1.2.0")
  ctx <- if (v12) .vcr_conf_people_context(sc, p)
  per_arm <- vcr_scalar(d$plannedSize, NULL)
  if (is.null(per_arm)) vcr_abort("scenario_field_missing", "scenario.design.plannedSize",
    if (events) "A multi-arm event-time design states the planned number of events at the final analysis (the arms still in the trial and the control)."
    else "A multi-arm design states the planned number of patients per arm (the control included).")
  planned <- c(ceiling(p$rates[1L] * per_arm), per_arm)
  scenarios <- lapply(tr$effectScenarios, vcr_num)
  null_value <- if (events) 1 else 0
  has_null <- any(vapply(scenarios, function(e) all(abs(e - null_value) < 1e-12), logical(1)))
  if (!has_null) { scenarios <- c(list(rep(null_value, arms)), scenarios); p <- .vcr_conf_assume(p, "truth.effectScenarios", if (events) "all arms at a hazard ratio of 1" else "all arms at no effect", basis = "added: the global null, to show the type I error") }
  is_null <- vapply(scenarios, function(e) all(abs(e - null_value) < 1e-12), logical(1))
  inv <- vcr_rpact_inverse_normal(p$rates, p$alpha, p[["spending"]], p$gamma)
  iters <- .vcr_conf_iterations_planned(job, NULL, NULL, is_null)
  batches <- vcr_rpact_batches(function(take, seed, s) vcr_rpact_sim_multiarm(p$endpoint, inv, scenarios[[s]], planned, selection, intersection, take, seed,
                                 sd = p$sd, control_rate = p$control_rate, direction = p$direction),
                               iters, vcr_scalar(job$seed, 1), scenarios = length(scenarios), progress = progress)
  size_name <- if (events) "expected_events" else "expected_sample_size"
  rows_out <- list()
  # (the benefit of an arm: the hazard ratio below 1, the difference on the side the direction names)
  benefit <- function(e) if (events) -e else if (identical(p$direction, "lower_better")) -e else e
  for (s in seq_along(scenarios)) {
    r <- batches$rows[[s]]; if (is.null(r)) next
    it <- .vcr_conf_iterations(r)
    # the best arm is the one with the better effect: the larger benefit
    best <- which(benefit(scenarios[[s]]) == max(benefit(scenarios[[s]])))
    # an event-time trial costs the events planned for the stage it stopped at
    if (events) it$size <- ifelse(it$stage == 2L, planned[2L], planned[1L])
    # the people those events are: the events over the chance of an event of a person of the control and of the arm that is best in this scenario
    # (1:1; the people of the arms dropped at the interim are not counted, nor is the enrolment simulated)
    per_head <- if (!is.null(ctx)) 0.5 * .vcr_conf_event_prob(1, ctx) + 0.5 * .vcr_conf_event_prob(min(scenarios[[s]]), ctx)
    # an arm is selected when it has a row at the second stage; one that stopped at the first stage for success has none
    stage2 <- r[r$stageNumber == 2L, , drop = FALSE]
    n_it <- it$n
    selected <- vapply(seq_len(arms), function(j) length(unique(stage2$iterationNumber[stage2$armNumber == j])), numeric(1))
    rejected_arm <- vapply(seq_len(arms), function(j) length(unique(r$iterationNumber[r$armNumber == j & r$rejectPerStage %in% c(TRUE, 1)])), numeric(1))
    best_selected <- length(unique(stage2$iterationNumber[stage2$armNumber %in% best]))
    cells <- c(.vcr_conf_cells(.vcr_conf_prob(if (is_null[s]) "type_one_error" else "power", sum(it$reject), n_it),
                               .vcr_conf_mean(size_name, it$size),
                               if (!is.null(ctx)) .vcr_conf_mean("expected_patients_from_events", it$size / per_head),
                               .vcr_conf_prob("early_stop_probability", sum(it$stopped_stage1), n_it),
                               # with equal effects there is no best arm to select, and the cell is left out
                               if (!is_null[s] && length(best) == 1L) .vcr_conf_prob("correct_selection_probability", best_selected, n_it)),
               .vcr_conf_indexed(arms, function(j) .vcr_conf_prob(sprintf("selected_arm_%d", j), selected[j], n_it)),
               .vcr_conf_indexed(arms, function(j) .vcr_conf_prob(sprintf("reject_arm_%d", j), rejected_arm[j], n_it)))
    # the baseline beside it: the best arm in a trial of its own against the same control, at a level split between the arms (Bonferroni);
    # with events, a two-arm trial with as many events as the best arm's own comparison has in this design: its share of the first stage
    # (the events of the arms are split in proportion to their hazards, 1:1) and all of the second
    split_power <- if (is_null[s]) p$alpha / arms
                   else if (events) {
                     best_hr <- min(scenarios[[s]])
                     own_events <- planned[1L] * (1 + best_hr) / (1 + sum(scenarios[[s]])) + (planned[2L] - planned[1L])
                     .vcr_conf_events_power(own_events, best_hr, p$alpha / arms)
                   } else .vcr_conf_fixed_power(p, scenarios[[s]][best[1L]], per_arm, per_arm, p$alpha / arms)
    rows_out[[length(rows_out) + 1L]] <- c(list(role = if (is_null[s]) "null" else "assumed", effect = scenarios[[s]], iterations = n_it, cells = cells,
      fixed = list(power = split_power, alpha = p$alpha / arms)), if (!is.null(per_head)) list(perHead = per_head))
  }
  fixed_all <- (arms + 1L) * per_arm; separate <- 2L * arms * per_arm
  stop_state <- .vcr_conf_stop(batches)
  first_alt <- Filter(function(r) identical(r$role, "assumed"), rows_out)
  null_row <- Filter(function(r) identical(r$role, "null"), rows_out)
  people <- if (v12) .vcr_conf_people_block(ctx, if (length(first_alt)) first_alt[[1]]$perHead, per_arm, "events_over_event_probability")
  measures <- c(if (events) list(.vcr_conf_calc("max_events", per_arm))
                else list(.vcr_conf_calc("max_patients", fixed_all), .vcr_conf_calc("separate_trials_size", separate)),
                if (isTRUE(people$computed)) list(.vcr_conf_calc("max_patients_from_events", people$maxPatients)),
                if (length(first_alt)) unname(first_alt[[1]]$cells[c("power", size_name, if (isTRUE(people$computed)) "expected_patients_from_events", "correct_selection_probability")]),
                if (length(null_row)) list(null_row[[1]]$cells$type_one_error))
  list(status = stop_state$status %||% "succeeded", measures = Filter(Negate(is.null), measures), issues = stop_state$issues %||% list(),
       counts = vcr_counts(generatedRecords = sum(batches$done)), conclusion = if (is.null(stop_state)) "estimable" else "limited",
       diagnostics = list(replicatesCompleted = min(batches$done), confirmatory = c(list(kind = p$kind, endpoint = p$endpoint, unit = unit, effects = rows_out,
         plan = list(first = planned[1L], total = per_arm, arms = arms, perArm = !events), iterations = as.list(batches$done),
         baselines = if (events) list() else list(fixedMultiArm = list(size = fixed_all), separateTrials = list(size = separate)), assumed = p$assumed, given = .vcr_conf_given(sc)),
         if (!is.null(people)) list(people = people))))
}

# --- enrichment (T5) --------------------------------------------------------------------------------------------

.vcr_conf_enrichment <- function(job, progress = NULL) {
  sc <- job$scenario; p <- .vcr_conf_note_defaults(.vcr_conf_common(sc), sc)
  d <- sc$design; tr <- sc$truth
  events <- identical(p$endpoint, "time_to_event"); unit <- .vcr_conf_count_kind(events)
  prevalence <- vcr_scalar(d$subsetPrevalence)
  selection <- list(rule = as.character(d$selection$rule %||% "best"), r = vcr_scalar(d$selection$r, NULL), epsilon = vcr_scalar(d$selection$epsilon, NULL))
  if (is.null(d$selection)) p <- .vcr_conf_assume(p, "design.selection.rule", "best", basis = "default: the population with the better interim estimate continues")
  intersection <- as.character(d$intersectionTest %||% "simes")
  if (is.null(d$intersectionTest)) p <- .vcr_conf_assume(p, "design.intersectionTest", intersection)
  if (events) p <- .vcr_conf_event_driven(p)
  v12 <- events && .vcr_conf_labelled_at_least(job, "1.2.0")
  ctx <- if (v12) .vcr_conf_people_context(sc, p)
  total <- vcr_scalar(d$plannedSize, NULL)
  if (is.null(total)) vcr_abort("scenario_field_missing", "scenario.design.plannedSize",
    if (events) "An event-time enrichment design states the planned number of events at the final analysis (the full population, both arms)."
    else "An enrichment design states the planned number of patients in the full population (both arms).")
  planned <- c(ceiling(p$rates[1L] * total), total)
  scenarios <- lapply(tr$subsetEffects, function(e) c(subset = vcr_scalar(e$subset), rest = vcr_scalar(e$rest)))
  null_value <- if (events) 1 else 0
  has_null <- any(vapply(scenarios, function(e) all(abs(e - null_value) < 1e-12), logical(1)))
  if (!has_null) { scenarios <- c(list(c(subset = null_value, rest = null_value)), scenarios); p <- .vcr_conf_assume(p, "truth.subsetEffects", if (events) "a hazard ratio of 1 in either group" else "no effect in either group", basis = "added: the null, to show the type I error") }
  is_null <- vapply(scenarios, function(e) all(abs(e - null_value) < 1e-12), logical(1))
  inv <- vcr_rpact_inverse_normal(p$rates, p$alpha, p[["spending"]], p$gamma)
  iters <- .vcr_conf_iterations_planned(job, NULL, NULL, is_null)
  batches <- vcr_rpact_batches(function(take, seed, s) vcr_rpact_sim_enrichment(p$endpoint, inv, scenarios[[s]][["subset"]], scenarios[[s]][["rest"]], prevalence, planned,
                                 selection, intersection, take, seed, sd = p$sd, control_rate = p$control_rate, direction = p$direction),
                               iters, vcr_scalar(job$seed, 1), scenarios = length(scenarios), progress = progress)
  size_name <- if (events) "expected_events" else "expected_sample_size"
  rows_out <- list()
  for (s in seq_along(scenarios)) {
    r <- batches$rows[[s]]; if (is.null(r)) next
    it <- .vcr_conf_iterations(r, "stageNumber")
    # the full population is enrolled for the first stage; the second stage is enrolled from the population that was kept, in the planned number
    it$size <- ifelse(it$stage == 2L, planned[2L], planned[1L])
    n_it <- it$n
    # the people those events are: the events over the chance of an event of a person of the control and of one given the treatment, who is in the
    # biomarker-positive subset with the stated prevalence (1:1; the enrolment is not simulated)
    per_head <- if (!is.null(ctx)) 0.5 * .vcr_conf_event_prob(1, ctx) + 0.5 * (prevalence * .vcr_conf_event_prob(scenarios[[s]][["subset"]], ctx) + (1 - prevalence) * .vcr_conf_event_prob(scenarios[[s]][["rest"]], ctx))
    pop <- r$populationNumber
    # population 1 is the biomarker-positive subset, the last the full population
    stage2 <- r[r$stageNumber == 2L, , drop = FALSE]
    cont <- function(k) length(unique(stage2$iterationNumber[stage2$populationNumber == k]))
    rej <- function(k) length(unique(r$iterationNumber[pop == k & r$rejectPerStage %in% c(TRUE, 1)]))
    cells <- .vcr_conf_cells(.vcr_conf_prob(if (is_null[s]) "type_one_error" else "power", sum(it$reject), n_it),
                             .vcr_conf_mean(size_name, it$size),
                             if (!is.null(ctx)) .vcr_conf_mean("expected_patients_from_events", it$size / per_head),
                             .vcr_conf_prob("early_stop_probability", sum(it$stopped_stage1), n_it),
                             .vcr_conf_prob("selected_subset", cont(1L), n_it), .vcr_conf_prob("selected_full", cont(2L), n_it),
                             .vcr_conf_prob("reject_subset", rej(1L), n_it), .vcr_conf_prob("reject_full", rej(2L), n_it))
    # the baseline beside it: the full population, fixed, at the same total size, with the effect the two groups average to; with events the
    # log hazard ratios average with the share of the events each group contributes (prevalence x (1 + hazard ratio), 1:1)
    pooled <- if (events) {
      share <- c(prevalence, 1 - prevalence) * (1 + scenarios[[s]])
      exp(sum(share * log(scenarios[[s]])) / sum(share))
    } else prevalence * scenarios[[s]][["subset"]] + (1 - prevalence) * scenarios[[s]][["rest"]]
    fixed_power <- if (is_null[s]) p$alpha else if (events) .vcr_conf_events_power(total, pooled, p$alpha) else .vcr_conf_fixed_power(p, pooled, total / 2, total / 2, p$alpha)
    rows_out[[length(rows_out) + 1L]] <- c(list(role = if (is_null[s]) "null" else "assumed", effect = list(subset = scenarios[[s]][["subset"]], rest = scenarios[[s]][["rest"]]),
      iterations = n_it, cells = cells,
      fixed = list(power = fixed_power, pooledEffect = pooled)), if (!is.null(per_head)) list(perHead = per_head))
  }
  stop_state <- .vcr_conf_stop(batches)
  first_alt <- Filter(function(r) identical(r$role, "assumed"), rows_out)
  null_row <- Filter(function(r) identical(r$role, "null"), rows_out)
  people <- if (v12) .vcr_conf_people_block(ctx, if (length(first_alt)) first_alt[[1]]$perHead, total, "events_over_event_probability")
  measures <- c(list(.vcr_conf_calc(if (events) "max_events" else "max_patients", total)),
                if (isTRUE(people$computed)) list(.vcr_conf_calc("max_patients_from_events", people$maxPatients)),
                if (length(first_alt)) unname(first_alt[[1]]$cells[c("power", size_name, if (isTRUE(people$computed)) "expected_patients_from_events", "selected_subset")]),
                if (length(null_row)) list(null_row[[1]]$cells$type_one_error))
  list(status = stop_state$status %||% "succeeded", measures = measures, issues = stop_state$issues %||% list(),
       counts = vcr_counts(generatedRecords = sum(batches$done)), conclusion = if (is.null(stop_state)) "estimable" else "limited",
       diagnostics = list(replicatesCompleted = min(batches$done), confirmatory = c(list(kind = p$kind, endpoint = p$endpoint, unit = unit, effects = rows_out,
         plan = list(first = planned[1L], total = total, prevalence = prevalence), iterations = as.list(batches$done),
         baselines = list(fixedFullPopulation = list(size = total)), assumed = p$assumed, given = .vcr_conf_given(sc)),
         if (!is.null(people)) list(people = people))))
}

# --- count endpoint (T6) ---------------------------------------------------------------------------------------------

.vcr_conf_count <- function(job) {
  sc <- job$scenario; p <- .vcr_conf_note_defaults(.vcr_conf_common(sc), sc)
  d <- sc$design; tr <- sc$truth
  .vcr_conf_require_benefit(p, vcr_scalar(tr$rateRatio), "scenario.truth.rateRatio")
  exposure <- vcr_scalar(tr$exposureTime, 1)
  if (is.null(tr$exposureTime)) p <- .vcr_conf_assume(p, "truth.exposureTime", exposure)
  gs <- if (length(p$rates)) vcr_rpact_design(p$rates, p$alpha, p$power, p[["spending"]], p$gamma, NULL) else NULL
  args <- list(rate_ratio = vcr_scalar(tr$rateRatio), control_rate = vcr_scalar(tr$controlEventRate), overdispersion = vcr_scalar(tr$overdispersion),
               exposure = exposure, alpha = p$alpha, power = p$power, allocation = p$allocation)
  fixed <- do.call(vcr_rpact_counts, c(list(NULL), args))
  seq_ <- if (!is.null(gs)) do.call(vcr_rpact_counts, c(list(gs), args))
  base <- fixed
  per_arm <- function(x) c(treatment = ceiling(x$max_treatment), control = ceiling(x$max_control))
  measures <- list(.vcr_conf_calc("required_total", sum(per_arm(fixed))), .vcr_conf_calc("required_treatment", per_arm(fixed)[["treatment"]]),
                   .vcr_conf_calc("required_control", per_arm(fixed)[["control"]]))
  looks <- NULL
  if (!is.null(seq_)) {
    measures <- c(measures, list(.vcr_conf_calc("max_patients", sum(per_arm(seq_)))))
    if (is.finite(seq_$expected_h1)) measures <- c(measures, list(.vcr_conf_calc("expected_sample_size", seq_$expected_h1)))
    looks <- lapply(seq_along(p$rates), function(i) list(look = i, informationRate = p$rates[i], size = seq_$max * p$rates[i], efficacyBound = gs$efficacyBounds[i], alphaSpent = gs$alphaSpent[i]))
  }
  list(status = "succeeded", measures = measures, counts = vcr_counts(), conclusion = "estimable",
       diagnostics = list(confirmatory = list(kind = p$kind, endpoint = "count", unit = .vcr_conf_count_kind(FALSE), looks = looks,
         baselines = list(fixed = list(size = sum(per_arm(fixed)), perArm = as.list(per_arm(fixed)))), model = "negative_binomial", assumed = p$assumed, given = .vcr_conf_given(sc))))
}

# --- the handler ------------------------------------------------------------------------------------------------------------

vcr_job_design_confirmatory <- function(job, output_dir = NULL, cancel_file = NULL, progress = NULL) {
  kind <- as.character(job$scenario$design$kind %||% "")
  switch(kind,
    futility_group_sequential = .vcr_conf_futility(job),
    sample_size_reestimation = .vcr_conf_reestimation(job, progress),
    multi_arm_selection = .vcr_conf_multiarm(job, progress),
    enrichment = .vcr_conf_enrichment(job, progress),
    count_endpoint = .vcr_conf_count(job),
    vcr_abort("design_not_supported", "scenario.design.kind", sprintf("'%s' is not a confirmatory design this build computes.", kind)))
}
