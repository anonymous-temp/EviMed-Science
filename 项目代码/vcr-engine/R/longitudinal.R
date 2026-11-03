# ---------------------------------------------------------------------------
# longitudinal.R — virtual patients with a continuous trajectory (plan 5.2).
#
#   y_ij = (b0 + u0_i) + (b1 + u1_i) t_j + delta z_i t_j + beta' x_i + e_ij
#
# a linear mixed model: a baseline, a slope, a random intercept and a random
# slope with a declared covariance, a residual, a treatment effect that changes
# the slope, and visits on a stated schedule that a person may leave.
#
# Hidden knowledge:
#
# - **A person is one stream of uniforms, drawn person by person.** Everything
#   that is random about person i -- the two random effects, a residual at each
#   visit, a dropout draw at each visit -- is a fixed position in that person's
#   own row of one uniform matrix drawn by row (`byrow = TRUE`), whatever the
#   scenario says. So (a) the same seed under two scenarios is the same person
#   twice: changing delta moves nobody's random effects or residuals, changing
#   the dropout rate changes who leaves and nothing else, (b) the treated arm
#   and the control arm are the same population (the arm is never an input to a
#   draw), and (c) adding people at the end changes nobody before them. This is
#   the plan's "same virtual patient under two scenarios" (5.2), and the cases
#   hold it bit for bit. It is also why the example individuals can be shown
#   under both arms honestly: the other arm's trajectory is this person's own
#   numbers with the treatment term swapped, nothing re-drawn.
# - **The treatment changes the slope, not the intercept.** delta z t_j is zero
#   at t = 0: arms are randomised, so they start alike, and "the effect" is the
#   difference in rate of change. The mean difference at a later visit is
#   delta t_j. A scenario that wants a level shift at the first visit is a
#   different model and is refused by the schema (no such key), not read as this
#   one.
# - **Dropout is missing completely at random, per visit, and monotone.** A
#   person still in the study leaves before visit j (j >= 2) with the stated
#   probability and every later visit is missing; the first visit is never
#   missing (there is nobody to drop before the baseline). The values a person
#   would have had after leaving are generated and withheld from the table (the
#   example individuals draw them as an unobserved stretch), so a dropout is a
#   mask on the same numbers and never a change to them.
# - **The covariance is stated as two SDs and a correlation**, not a matrix: a
#   matrix the model writes is routinely not positive definite, and a correlation
#   in (-1, 1) always is. The random slope is built as
#   u1 = sd1 (rho z1 + sqrt(1 - rho^2) z2), z1, z2 standard normals from the
#   person's first two uniforms, so Cov(u0, u1) = rho sd0 sd1 exactly.
# - **The model-implied moments travel with the sample.** The mean at visit t
#   is b0 + (b1 + delta z) t and the variance sd0^2 + 2 rho sd0 sd1 t + sd1^2 t^2
#   + sigma^2; the result carries them beside the sample means and spreads so
#   that "the generator did what the scenario said" is a number on the result
#   (the case compares the two within Monte-Carlo error) and the page can draw
#   the stated trajectory under the generated one.
# - Every key is read with `[["key"]]`: a prefix of a caller's key is never a key.
# - **1.2.0 (algorithm round T11, 2026-11-03): a dropout that depends on the outcome, a rescue medication, and a curved mean.** None of
#   them changes a draw: the person's row of uniforms is the same, and a scenario that states none of them is the 1.1.0 generator to the bit
#   (the case holds a recorded output hash). `dropoutModel` makes the probability of leaving before a visit depend on the standardized outcome
#   (against the control arm's own mean and spread at that visit): the PREVIOUS observed value for "mar" (missing at random: what is missing is
#   explained by what was seen), the value AT the visit for "mnar" (missing not at random: the value that would be missing is the cause). `rescue`
#   is an intercurrent event: before each visit a person not yet on rescue starts it with a probability that may rise with the previous value, and
#   from that visit on the outcome is shifted by `effect`; the rescue draws are J more uniforms in the person's own row, so nobody's draws depend on
#   how many people come after them (and a scenario that states rescue is not the same set of people as one that does not: the "no rescue" world of
#   each person is in the result, `y_nr`, which is the comparison that matters). Each person is run through the whole visit schedule under BOTH arms with their own draws, so the
#   table keeps `y0` and `y1` (what the person would show under each arm, rescue included) and the generator knows two estimands exactly: the
#   treatment-policy effect (the outcome as it comes, whatever was taken) and the hypothetical one (the outcome had there been no rescue,
#   which is the model's own effect times the shape of time). A naive analysis answers neither unless dropout and rescue are
#   at random given what it sees: the case holds that bias against these truths. `trajectory` bends the mean: time enters through g(t) in
#   place of t (a plateau g = tau (1 - exp(-t / tau)) with tau = halfTime / ln 2, a quadratic g = t + curvature t^2), g(0) = 0 so the arms start alike.
# ---------------------------------------------------------------------------

#' The mean's time scale: the visit times themselves, or the shape the scenario states (g(0) = 0 in every shape, so the arms start alike).
.vcr_longitudinal_shape <- function(visits, shape = NULL) {
  kind <- as.character(shape[["kind"]] %||% "linear")
  if (identical(kind, "linear")) return(visits)
  if (identical(kind, "plateau")) {
    tau <- vcr_scalar(shape[["halfTime"]], NULL)
    if (is.null(tau) || !(tau > 0)) vcr_abort("scenario_field_missing", "scenario.trajectory.halfTime", "A plateau trajectory states the time at which it is half way to its plateau.")
    tau <- tau / log(2)
    return(tau * (1 - exp(-visits / tau)))
  }
  if (identical(kind, "quadratic")) {
    curvature <- vcr_scalar(shape[["curvature"]], NULL)
    if (is.null(curvature)) vcr_abort("scenario_field_missing", "scenario.trajectory.curvature", "A quadratic trajectory states its curvature.")
    return(visits + curvature * visits^2)
  }
  vcr_abort("scenario_value_invalid", "scenario.trajectory.kind", "The trajectory is linear, a plateau or a quadratic.")
}

#' The model's two-arm, K-visit draw. `z` fixes the arm vector (a stored
#' population has its own members), `lp` is an extra per-person additive term
#' (covariate effects read from that population); neither changes a draw.
#'
#' Returns the person-level draws (random effects, arm) and the full J-visit
#' matrices of the values, the other arm's values and the observed mask.
#'
#' `shape`, `dropout_model` and `rescue` (1.2.0) are the scenario's `trajectory`, `dropoutModel` and `rescue`; with none of them the generator is
#' the 1.1.0 one. With `dropout_model` or `rescue` every person is run through the visits under both arms (`$full`).
vcr_sim_longitudinal <- function(n_treat, n_control, visits, intercept, slope, effect, sd_resid,
                                 sd_intercept = 0, sd_slope = 0, correlation = 0, dropout = 0,
                                 z = NULL, lp = NULL, shape = NULL, dropout_model = NULL, rescue = NULL) {
  if (is.null(z)) z <- c(rep(1L, n_treat), rep(0L, n_control))
  n <- length(z); J <- length(visits)
  K <- 2L + 2L * J
  # one row of K uniforms per person: columns 1-2 the random effects, 3..J+2 the residuals, J+3..2J+2 the dropout draws; a scenario that states
  # a rescue medication (1.2.0) has J more in the same row, so that nobody's draws depend on how many people come after them
  K_row <- if (is.null(rescue)) K else K + J
  U <- matrix(stats::runif(n * K_row), nrow = n, ncol = K_row, byrow = TRUE)
  z1 <- stats::qnorm(U[, 1L]); z2 <- stats::qnorm(U[, 2L])
  u0 <- sd_intercept * z1
  u1 <- sd_slope * (correlation * z1 + sqrt(1 - correlation^2) * z2)
  e <- sd_resid * stats::qnorm(U[, 2L + seq_len(J), drop = FALSE])
  g <- if (is.null(shape)) visits else .vcr_longitudinal_shape(visits, shape)
  t_mat <- matrix(g, nrow = n, ncol = J, byrow = TRUE)
  base <- (intercept + u0) + (slope + u1) * t_mat + (lp %||% 0) + e
  y <- base + effect * z * t_mat
  y_other <- base + effect * (1L - z) * t_mat
  if (is.null(dropout_model) && is.null(rescue)) {
    # monotone MCAR dropout: leaves before the first follow-up visit whose draw is below the rate
    left <- if (dropout > 0) U[, 2L + J + seq_len(J), drop = FALSE] < dropout else matrix(FALSE, n, J)
    left[, 1L] <- FALSE
    first_left <- ifelse(rowSums(left) > 0, max.col(left, ties.method = "first"), J + 1L)
    gone <- col(left) >= first_left     # a visit from the first one left onwards
    return(list(arm = z, u0 = u0, u1 = u1, y = y, y_other = y_other, observed = !gone, visits = visits))
  }
  # 1.2.0: the outcome decides who leaves and who starts rescue
  Dm <- U[, 2L + J + seq_len(J), drop = FALSE]
  Rm <- if (is.null(rescue)) NULL else U[, K + seq_len(J), drop = FALSE]
  ref_mean <- intercept + slope * g                                                     # the control arm, no rescue: what a standardized value is read against
  ref_sd <- sqrt(sd_intercept^2 + 2 * correlation * sd_intercept * sd_slope * g + sd_slope^2 * g^2 + sd_resid^2)
  path <- function(arm) {
    y_nr <- base + effect * arm * t_mat
    yy <- y_nr; on_rescue <- rep(FALSE, n); gone <- rep(FALSE, n)
    rescued <- matrix(FALSE, n, J); left <- matrix(FALSE, n, J)
    for (j in seq_len(J)) {
      if (j >= 2L && !is.null(rescue)) {
        prev <- (yy[, j - 1L] - ref_mean[j - 1L]) / ref_sd[j - 1L]
        on_rescue <- on_rescue | (Rm[, j] < stats::plogis(stats::qlogis(rescue$perVisit) + rescue$slope * prev))
      }
      if (!is.null(rescue)) yy[, j] <- y_nr[, j] + rescue$effect * on_rescue
      rescued[, j] <- on_rescue
      if (j >= 2L) {
        p_leave <- if (is.null(dropout_model)) dropout else {
          driver <- if (identical(dropout_model$kind, "mar")) (yy[, j - 1L] - ref_mean[j - 1L]) / ref_sd[j - 1L] else (yy[, j] - ref_mean[j]) / ref_sd[j]
          stats::plogis(stats::qlogis(dropout) + dropout_model$slope * driver)
        }
        gone <- gone | (Dm[, j] < p_leave)
      }
      left[, j] <- gone
    }
    list(y = yy, y_nr = y_nr, rescued = rescued, gone = left)
  }
  p1 <- path(1L); p0 <- path(0L)
  as_given <- matrix(z == 1L, n, J)
  pick <- function(a, b) ifelse(as_given, a, b)
  list(arm = z, u0 = u0, u1 = u1, y = pick(p1$y, p0$y), y_other = pick(p0$y, p1$y), observed = !pick(p1$gone, p0$gone), visits = visits, g = g,
       y_nr = pick(p1$y_nr, p0$y_nr), rescue = pick(p1$rescued, p0$rescued) * 1L,
       full = list(y1 = p1$y, y0 = p0$y, y1_nr = p1$y_nr, y0_nr = p0$y_nr, rescue1 = p1$rescued, rescue0 = p0$rescued))
}

#' The model's own mean and standard deviation of the outcome at each visit, for
#' one arm (`z` 0 or 1): what a generator that does what the scenario says must
#' reproduce in the limit.
vcr_longitudinal_implied <- function(visits, intercept, slope, effect, sd_resid, sd_intercept, sd_slope, correlation, z) {
  # (`visits` is the mean's time scale: the visit times, or their shape g(t) for a curved trajectory)
  list(mean = intercept + (slope + effect * z) * visits,
       sd = sqrt(sd_intercept^2 + 2 * correlation * sd_intercept * sd_slope * visits + sd_slope^2 * visits^2 + sd_resid^2))
}

#' The sample size of a two-sample comparison of the last visit's values, one-sided 2.5%, for a power: n per arm = 2 (z_a + z_b)^2 sd^2 / delta^2.
.vcr_longitudinal_n <- function(delta, sd, power) {
  if (!is.finite(delta) || abs(delta) < 1e-12 || !is.finite(sd) || !(sd > 0)) return(NULL)
  ceiling(2 * (stats::qnorm(0.975) + stats::qnorm(power))^2 * sd^2 / delta^2)
}

#' What the generated people say of the estimands (1.2.0, T11), from the complete trajectories every person has under both arms: the
#' treatment-policy effect at the last visit (the outcome as it comes, rescue included), the hypothetical one (the outcome had there been no rescue),
#' the share on rescue at the last visit in each arm, the plain comparison of those still in the study, and the size per arm each estimand
#' would need (80% and 90% power, one-sided 2.5%, a two-sample comparison of the last visit, the spread of that estimand's own values).
.vcr_longitudinal_estimands <- function(sim) {
  f <- sim$full; J <- ncol(f$y1)
  one <- function(key, a, b) {
    d <- mean(a) - mean(b); sdv <- sqrt((stats::var(a) + stats::var(b)) / 2)
    list(key = key, effect = d, sd = sdv, perArm80 = .vcr_longitudinal_n(d, sdv, 0.8), perArm90 = .vcr_longitudinal_n(d, sdv, 0.9))
  }
  seen <- sim$observed[, J]
  naive_n <- c(sum(seen & sim$arm == 1L), sum(seen & sim$arm == 0L))
  naive <- if (all(naive_n > 0L)) mean(sim$y[seen & sim$arm == 1L, J]) - mean(sim$y[seen & sim$arm == 0L, J]) else NA_real_
  list(treatmentPolicy = one("treatment_policy", f$y1[, J], f$y0[, J]), hypothetical = one("hypothetical", f$y1_nr[, J], f$y0_nr[, J]),
       rescueShare = list(treated = mean(f$rescue1[, J]), control = mean(f$rescue0[, J])),
       observedOnly = list(effect = naive, treated = naive_n[1], control = naive_n[2]))
}

#' Per-arm, per-visit summary of the observed values: how many are still in, their
#' mean, spread and the 2.5% / 97.5% quantiles (the band that holds 95% of the
#' generated patients).
.vcr_longitudinal_arm_summary <- function(sim, arm) {
  keep <- sim$arm == arm
  lapply(seq_along(sim$visits), function(j) {
    v <- sim$y[keep & sim$observed[, j], j]
    q <- if (length(v) >= 2L) stats::quantile(v, c(0.025, 0.975), names = FALSE) else c(NA_real_, NA_real_)
    list(time = sim$visits[j], n = length(v), mean = if (length(v)) mean(v) else NA_real_,
         sd = if (length(v) >= 2L) stats::sd(v) else NA_real_, low = q[1], high = q[2])
  })
}

.vcr_fmt <- function(x) format(signif(x, 3L), trim = TRUE, scientific = FALSE)

#' Which patients are shown as examples: those at the 10th, 50th and 90th
#' percentile of the true individual slope among the patients seen at least twice.
.vcr_longitudinal_examples <- function(sim, slope, effect) {
  seen <- which(rowSums(sim$observed) >= 2L)
  if (!length(seen)) return(integer(0))
  true_slope <- slope + sim$u1 + effect * sim$arm
  ord <- seen[order(true_slope[seen], seen)]
  unique(ord[pmax(1L, ceiling(c(0.1, 0.5, 0.9) * length(ord)))])
}

#' One example individual in the shape the patients page reads, with the same
#' person under the other arm beside the arm they were given.
.vcr_longitudinal_example <- function(sim, i, id, label, effect) {
  t <- sim$visits; J <- length(t)
  last <- max(which(sim$observed[i, ]))
  in_trial <- sim$arm[i] == 1L
  arm_name <- function(z) if (z == 1L) "试验组" else "对照组"
  unobserved <- if (last < J) list(list(from = t[last + 1L], to = t[J])) else list()
  mk <- function(key, name, values, ours) {
    s <- vcr_series(key, name, t, values, "synthetic", ours = ours)
    if (length(unobserved)) s$unobserved <- unobserved
    s
  }
  # the same person under the two arms differs by exactly effect x t: say it as treated against control, whichever arm they were given
  gap <- (if (in_trial) sim$y[i, J] - sim$y_other[i, J] else sim$y_other[i, J] - sim$y[i, J])
  list(id = id, source = "synthetic", origin = label,
       baseline = list(
         list(label = "所在组", value = arm_name(sim$arm[i]), source = "synthetic"),
         list(label = "第一次随访的值", value = .vcr_fmt(sim$y[i, 1L]), source = "synthetic"),
         list(label = "随访", value = if (last == J) sprintf("完成全部 %d 次随访", J) else sprintf("第 %d 次随访后退出", last), source = "synthetic")),
       inScope = list(ok = TRUE, text = "情景模型：只在所述参数下推演，不是对这个人的预测"),
       scenarios = list(
         note = "同一个人，随机数相同，只有分组不同",
         series = list(mk("as_given", paste0("实际分到的组（", arm_name(sim$arm[i]), "）"), sim$y[i, ], in_trial),
                       mk("other_arm", paste0("如果分到另一组（", arm_name(1L - sim$arm[i]), "）"), sim$y_other[i, ], !in_trial)),
         difference = if (abs(gap) < 1e-12) "到最后一个时间点，两种分组没有差别"
                      else sprintf("到最后一个时间点，同一个人在试验组比在对照组%s %s", if (gap < 0) "低" else "高", .vcr_fmt(abs(gap)))),
       note = "患者是模型按所述参数生成的，不对应任何真实的人")
}

#' The summaries a page draws from a generated longitudinal set: the two arms'
#' mean trajectories with the band that holds 95% of the patients, a handful of
#' individual lines, the stated trajectory beside the generated one, three example
#' individuals, and a panel of the numbers that matter.
vcr_longitudinal_summary <- function(sim, ids, model, max_lines = 12L) {
  t <- sim$visits; J <- length(t)
  arms <- list(list(key = "treated", label = "试验组", z = 1L), list(key = "control", label = "对照组", z = 0L))
  series <- list(); implied <- list(); rows <- list(); stats_by_arm <- list()
  for (a in arms) {
    if (!any(sim$arm == a$z)) next
    summ <- .vcr_longitudinal_arm_summary(sim, a$z)
    stats_by_arm[[a$key]] <- summ
    s <- vcr_series(a$key, a$label, t, vapply(summ, function(r) r$mean, numeric(1)), "synthetic", ours = a$z == 1L,
                    low = vapply(summ, function(r) r$low, numeric(1)), high = vapply(summ, function(r) r$high, numeric(1)),
                    band_kind = "prediction", band_level = 0.95)
    members <- which(sim$arm == a$z & rowSums(sim$observed) >= 2L)
    members <- utils::head(members, max_lines)
    s$individuals <- lapply(members, function(i) {
      v <- which(sim$observed[i, ])
      lapply(v, function(j) list(x = unname(t[j]), y = unname(sim$y[i, j])))
    })
    series[[length(series) + 1L]] <- s
    im <- vcr_longitudinal_implied(model[["g"]] %||% t, model$intercept, model$slope, model$effect, model$sd, model$sdIntercept, model$sdSlope, model[["correlation"]], a$z)
    implied[[a$key]] <- list(mean = unname(im$mean), sd = unname(im$sd))
    last <- summ[[J]]
    rows[[length(rows) + 1L]] <- list(label = paste0(a$label, "末次随访均值"), value = list(value = .vcr_sig(last$mean)))
    rows[[length(rows) + 1L]] <- list(label = paste0(a$label, "完成全部随访的比例"),
                                      value = list(value = round(100 * mean(sim$observed[sim$arm == a$z, J]), 1), unit = "%"))
  }
  diff_last <- if (all(c("treated", "control") %in% names(stats_by_arm))) stats_by_arm$treated[[J]]$mean - stats_by_arm$control[[J]]$mean else NA_real_
  if (is.finite(diff_last)) rows[[length(rows) + 1L]] <- list(label = "末次随访两组均值之差", value = list(value = .vcr_sig(diff_last)))
  pick <- .vcr_longitudinal_examples(sim, model$slope, model$effect)
  names_ <- c("斜率偏低的虚拟患者", "斜率居中的虚拟患者", "斜率偏高的虚拟患者")
  at <- if (length(pick) == 3L) 1:3 else seq_along(pick)
  examples <- lapply(seq_along(pick), function(k) .vcr_longitudinal_example(sim, pick[k], ids[pick[k]], names_[at[k]], model$effect))
  panels <- list(list(key = "arms", title = "两组的生成结果", kind = "binary", note = "情景仿真生成，非观察", rows = rows, series = list()))
  est <- model[["estimands"]]
  if (!is.null(est)) panels[[2L]] <- list(key = "estimands", title = "按不同的估计目标，末次随访的效应", kind = "binary",
    note = "每个虚拟患者在两个组下的完整轨迹都已生成，所以两种估计目标的真值是已知的", rows = .vcr_longitudinal_estimand_rows(est), series = list())
  list(
    headline = if (is.finite(diff_last)) sprintf("到最后一个时间点，试验组与对照组的平均值相差 %s", .vcr_fmt(diff_last)) else NULL,
    trajectories = list(xLabel = "随访时间", yLabel = "结局指标", ticks = as.list(.vcr_fmt(t)), series = series),
    expected = c(list(visits = unname(t)), implied),
    observed = lapply(stats_by_arm, function(summ) lapply(summ, function(r) list(
      time = unname(r$time), n = r$n, mean = r$mean, sd = r$sd))),
    example = if (length(examples)) examples[[min(2L, length(examples))]] else NULL,
    examples = examples,
    panels = panels)
}

#' The rows of the estimand panel: each number said in words a person can read, in outcome units, with the people each needs.
.vcr_longitudinal_estimand_rows <- function(est) {
  row <- function(label, value, unit = NULL) list(label = label, value = if (is.null(unit)) list(value = .vcr_sig(value)) else list(value = value, unit = unit))
  rows <- list()
  share <- est$rescueShare
  if (share$treated > 0 || share$control > 0) {
    rows[[length(rows) + 1L]] <- row("末次随访时在用救援药的比例（试验组）", round(100 * share$treated, 1), "%")
    rows[[length(rows) + 1L]] <- row("末次随访时在用救援药的比例（对照组）", round(100 * share$control, 1), "%")
  }
  for (e in list(list(est$treatmentPolicy, "治疗策略（用了救援药的结果照算）"), list(est$hypothetical, "假想策略（假如没有救援药）"))) {
    x <- e[[1L]]
    rows[[length(rows) + 1L]] <- row(paste0(e[[2L]], "：末次随访两组均值之差"), x$effect)
    if (!is.null(x$perArm90)) rows[[length(rows) + 1L]] <- row(paste0(e[[2L]], "：每组需要的人数（90% 把握，单侧 2.5%）"), x$perArm90, "人")
  }
  if (is.finite(est$observedOnly$effect)) rows[[length(rows) + 1L]] <- row("直接比较末次随访仍在研究内的人（不处理脱落）", est$observedOnly$effect)
  rows
}

#' The job of `patients.longitudinal`: draw the two arms (or the members of a
#' stored population) under the model above and write the observed visits as a
#' long table, one row per patient per visit still in the study.
vcr_job_generate_patients_longitudinal <- function(job, output_dir = NULL, ...) {
  sc <- job[["scenario"]]
  endpoint <- as.character(sc[["endpoint"]][["type"]] %||% "")
  if (!identical(endpoint, "continuous")) {
    vcr_abort("endpoint_not_supported", "scenario.endpoint.type", "patients.longitudinal generates continuous trajectories.")
  }
  tr <- sc[["truth"]]; design <- sc[["design"]]
  visits <- vcr_num(sc[["visits"]])
  if (length(visits) < 2L || anyNA(visits) || any(visits < 0) || any(diff(visits) <= 0)) {
    vcr_abort("scenario_value_invalid", "scenario.visits", "The visits are at least two times, from 0, strictly increasing.")
  }
  effect <- .vcr_need(tr[["effect"]], "scenario.truth.effect", "A longitudinal scenario states the treatment effect on the slope (0 for the null).")
  intercept <- vcr_scalar(tr[["intercept"]], 0); slope <- vcr_scalar(tr[["slope"]], 0); sd_resid <- vcr_scalar(tr[["sd"]], 1)
  re <- tr[["randomEffects"]] %||% list()
  sd0 <- vcr_scalar(re[["sdIntercept"]], 0); sd1 <- vcr_scalar(re[["sdSlope"]], 0); rho <- vcr_scalar(re[["correlation"]], 0)
  drop <- vcr_scalar(sc[["dropoutPerVisit"]], 0)
  # 1.2.0 (T11): the outcome decides who leaves and who starts rescue, and the mean may be curved
  shape <- sc[["trajectory"]]
  dm <- sc[["dropoutModel"]]
  dropout_model <- if (is.null(dm)) NULL else list(kind = as.character(dm[["mechanism"]]), slope = vcr_scalar(dm[["logOddsPerSd"]], NULL))
  rs <- sc[["rescue"]]
  rescue <- if (is.null(rs)) NULL else list(perVisit = vcr_scalar(rs[["perVisit"]], NULL), effect = vcr_scalar(rs[["effect"]], NULL), slope = vcr_scalar(rs[["logOddsPerSd"]], 0))
  if (!is.null(dropout_model) && !(drop > 0)) vcr_abort("scenario_value_invalid", "scenario.dropoutPerVisit", "A dropout that depends on the outcome starts from the probability of leaving at an average outcome: state dropoutPerVisit above 0.")
  n1 <- vcr_scalar(design[["nTreat"]], NULL); n0 <- vcr_scalar(design[["nControl"]], 0)
  if (is.null(n1)) vcr_abort("scenario_field_missing", "scenario.design.nTreat", "A virtual-patient scenario states its arm sizes.")
  tabs <- vcr_job_tables(job)
  pop <- if (length(tabs$files)) tabs$files[[1]] else tabs$subject
  cohort <- vcr_apply_downstream_cohort(pop, sc[["cohortRules"]])
  pop <- cohort$data
  n <- if (is.null(pop)) n1 + n0 else nrow(pop)
  if (as.numeric(n) * length(visits) > .vcr_max_records()) {
    vcr_abort("scenario_value_invalid", "scenario.design", "The patients times the visits is more records than this engine can hold.")
  }
  z <- NULL; lp <- NULL
  randomization <- vcr_patient_randomization(job)
  eff <- tr[["covariateEffects"]]
  if (!is.null(pop)) {
    if (n1 + n0 != n) vcr_abort("scenario_value_invalid", "scenario.design", "For a stored population the arm sizes add up to the number of members.")
    # the generated table has columns of its own; a population variable of the same name would be read as one of them
    reserved <- c("patientId", "arm", "visit", "time", "y", "source", "modelTier")
    if (!identical(job[["methodVersion"]], "1.0.0")) reserved <- c(reserved, "y0", "y1")
    if (!is.null(rescue)) reserved <- c(reserved, "rescue")
    if (any(names(pop) %in% reserved)) {
      vcr_abort("scenario_value_invalid", "inputs", "A population column is named like a column of the generated table (patientId, arm, visit, time, y, source, modelTier); rename it in the population.")
    }
    z <- as.integer(rank(stats::runif(n), ties.method = "first") <= n1)
    if (!is.null(eff) && length(eff)) {
      cols <- names(eff)
      if (!all(cols %in% names(pop))) vcr_abort("scenario_value_invalid", "scenario.truth.covariateEffects", "A covariate effect names a column of the population.")
      B <- vapply(cols, function(k) vcr_scalar(eff[[k]], NA_real_), numeric(1))
      if (anyNA(B)) vcr_abort("scenario_value_invalid", "scenario.truth.covariateEffects", "A covariate effect is a number.")
      Xp <- as.matrix(pop[, cols, drop = FALSE])
      if (!is.numeric(Xp) || anyNA(Xp)) vcr_abort("missing_covariate", "scenario.truth.covariateEffects", "A covariate with an effect is numeric and complete in the population.")
      # centred at the population mean, as the other virtual-patient generators: the intercept stated is the average member's
      lp <- as.vector(sweep(Xp, 2L, colMeans(Xp), "-") %*% B)
    }
  } else if (!is.null(eff) && length(eff)) {
    vcr_abort("scenario_value_invalid", "scenario.truth.covariateEffects", "A covariate effect needs a stored population to take the covariate from.")
  }
  sim <- vcr_sim_longitudinal(n1, n0, visits, intercept, slope, effect, sd_resid, sd0, sd1, rho, drop, z = z, lp = lp,
                              shape = shape, dropout_model = dropout_model, rescue = rescue)
  ids <- vcr_patient_ids(job, pop, n)
  J <- length(visits)
  # one row per patient per visit still in the study
  who <- rep(seq_len(n), times = J)
  vis <- rep(seq_len(J), each = n)
  mask <- as.vector(sim$observed)
  long <- data.frame(patientId = ids[who], arm = sim$arm[who], visit = vis, time = visits[vis], y = as.vector(sim$y), stringsAsFactors = FALSE)
  if (!identical(job[["methodVersion"]], "1.0.0")) {
    # Materialize the two already drawn outcomes only at retained visits; no new randomness.
    long$y0 <- as.vector(ifelse(matrix(sim$arm == 0L, nrow = n, ncol = J), sim$y, sim$y_other))
    long$y1 <- as.vector(ifelse(matrix(sim$arm == 1L, nrow = n, ncol = J), sim$y, sim$y_other))
    if (!is.null(rescue)) long$rescue <- as.vector(sim$rescue)           # 1 from the visit rescue was started
  }
  if (!is.null(pop)) long <- cbind(long[, 1:2, drop = FALSE], pop[who, , drop = FALSE], long[, setdiff(names(long), c("patientId", "arm")), drop = FALSE])
  long <- long[mask, , drop = FALSE]
  long <- long[order(match(long$patientId, ids), long$visit), , drop = FALSE]
  rownames(long) <- NULL
  long$source <- "synthetic"
  long$modelTier <- "scenario"
  model <- list(intercept = intercept, slope = slope, effect = effect, sd = sd_resid, sdIntercept = sd0, sdSlope = sd1, correlation = rho)
  new_features <- !is.null(shape) || !is.null(dropout_model) || !is.null(rescue)
  if (new_features) {
    model$g <- sim$g %||% .vcr_longitudinal_shape(visits, shape)
    model$trajectory <- if (is.null(shape)) list(kind = "linear") else shape
    model$dropoutModel <- dropout_model; model$rescue <- rescue
    if (!is.null(sim$full)) model$estimands <- .vcr_longitudinal_estimands(sim)
  }
  generated_count <- if (identical(job[["methodVersion"]], "1.0.0")) nrow(long) else n
  list(status = "succeeded",
       measures = list(vcr_measure("generated_records", generated_count, source = "synthetic")),
       counts = vcr_counts(realPatients = 0, generatedRecords = generated_count),
       diagnostics = c(list(endpoint = "continuous", valueSource = "synthetic", modelTier = "scenario",
                            mode = if (is.null(pop)) "scenario" else "population", persons = n, observations = nrow(long), randomization = randomization, cohort = cohort$info, visits = unname(visits), dropoutPerVisit = drop,
                            model = model[setdiff(names(model), "g")],
                            note = "Scenario simulation from stated parameters; no baseline-conditioned or digital-twin claim is made."),
                       if (!is.null(model$estimands)) list(estimands = model$estimands),
                       vcr_longitudinal_summary(sim, ids, model)),
       tables = .vcr_tables_of(list(vcr_write_table(long, "virtual-patients", output_dir))))
}

`%||%` <- function(a, b) if (is.null(a)) b else a
