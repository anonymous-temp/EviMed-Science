# ---------------------------------------------------------------------------
# evidence_network.R — frequentist network meta-analysis (evidence.network; algorithm round C5, 2026-11-03).
#
# The person's question is "how do all these drugs compare with each other, how consistent is the evidence, and which ranks first?". A
# pairwise pool answers one comparison at a time; a network pools every comparison that the trials connect, directly or through a common
# treatment (Rücker 2012; Lu & Ades 2004), and says how well the direct and the indirect evidence agree.
#
# Hidden knowledge:
#
# - **One model, three equivalent writings.** Rücker's graph-theoretical network meta-analysis, the weighted least squares on the contrasts and the
#   multivariate meta-regression on the study-specific contrasts are the same estimator. This file writes the last: each study contributes its
#   contrasts against its first treatment (treatments sorted by name), the basic parameters are the effects of every treatment against the reference
#   treatment, and the pooled estimate is generalized least squares with the study's own covariance. `netmeta` (graph-theoretical) is the independent
#   implementation the numeric case holds it to.
# - **The within-study covariance of a multi-arm study is what keeps the network honest.** The contrasts of a study that shares one arm are
#   correlated through that arm's variance. From arm data the arm variances are known (a log odds ratio: 1/events + 1/non-events; a mean
#   difference: sd^2/n). From a study that states its contrasts, they are reconstructed from the variances of ALL its pairs (the variance of the
#   difference of two arms is the sum of their variances; three arms give three equations for three unknowns, more arms are solved by least squares),
#   which is why a multi-arm study stated as contrasts must state every pair. A pair set that implies a non-positive arm variance is refused by its
#   study, never repaired.
# - **Random effects add tau-squared to each contrast and half of it between two contrasts of one study** (the covariance of the arm effects drawn from
#   one normal distribution). tau-squared is the generalized DerSimonian-Laird estimate: (Q - df) / tr(W (I - H) P), with W the inverse
#   covariance, H the hat matrix of the common-effect fit and P the structure above; with two-arm studies only it is the usual denominator. df is
#   the number of contrasts less the number of basic parameters.
# - **Q is split by design, not by guess.** Within a design (the same set of treatments) the studies are pooled by themselves; the sum of their Q is the
#   heterogeneity, and what is left of the total Q (common-effect fit) is the inconsistency between designs (Krahn et al. 2013; Higgins et al. 2012), with
#   the degrees of freedom that remain. The split is of the common-effect fit, and the page words it as such.
# - **P-scores are the mean of the probabilities that one treatment is better than each other** (Rücker & Schwarzer 2015), from the normal
#   approximation to each pairwise difference. Which direction is better is the person's statement (`direction`); the engine has no default for it. A
#   P-score is a ranking of point estimates weighted by their precision, not a probability of being best.
# - **Zero cells are corrected per study and the study is listed.** A binary study with an arm that has no event, or only events, gets 0.5 added to the
#   events and to the non-events of every arm of that study (the same increment `netmeta::pairwise` adds to a study with a zero cell), and the study
#   is named in the result's assumptions. A different correction is a different estimate; the person can change it (`continuityCorrection`).
#   **A study in which NO arm has an event (or every arm has only events) compares nothing and is left out, as `netmeta::pairwise` leaves it out**
#   (it is named in the assumptions, and `k` counts the studies that stayed). The first version corrected it and kept it: a log odds ratio of
#   -0.608 against netmeta's -0.620 on the same four studies, one of them with no event in either arm. (A multi-arm study with SOME arms at zero is
#   kept and corrected: netmeta refuses it and advises the same.)
# - **A multi-arm study stated as contrasts must agree with itself.** The effects against the first treatment are read from the comparisons that involve it,
#   and the other comparisons only give the variances, so a study that states C-B = +5 beside B-A = -0.3 and C-A = -0.5 would run with no complaint.
#   Each stated comparison is held to the difference of the other two to within what rounding explains (0.02, or a quarter of its standard error), and a
#   study that disagrees is refused by its path, never repaired.
# - **A network that is not connected is refused by name, with its parts.** Treatments in separate components cannot be compared; the result lists
#   the components so the person sees what is missing.
# - **Nothing here is simulated.** Every number is closed form or a matrix solve, so there is no Monte-Carlo error and a rerun is identical.
# ---------------------------------------------------------------------------

VCR_NET_RATIO_MEASURES <- c("odds_ratio", "risk_ratio", "log_ratio")

#' Sorted unique strings in C order, so the reference and the baselines do not depend on the locale.
.vcr_net_sort <- function(x) sort(unique(as.character(x)), method = "radix")

#' One study as the contrasts of its sorted treatments against the first, with their covariance.
.vcr_net_study <- function(id, trt, theta, v) {
  ord <- order(trt, method = "radix")
  trt <- trt[ord]; theta <- theta[ord]; v <- v[ord]
  a <- length(trt)
  y <- theta[-1L] - theta[1L]
  S <- matrix(v[1L], a - 1L, a - 1L) + diag(v[-1L], a - 1L)
  list(id = id, trt = trt, y = y, S = S, design = paste(trt, collapse = " | "), arms = a)
}

#' The arm variances behind a set of pairwise variances: v_i + v_j = V_ij, solved by least squares.
.vcr_net_arm_variances <- function(trts, pair_var, field) {
  a <- length(trts)
  if (a == 2L) return(c(0.5, 0.5) * pair_var[[1L]]$v)
  A <- matrix(0, length(pair_var), a); b <- numeric(length(pair_var))
  for (r in seq_along(pair_var)) {
    A[r, match(pair_var[[r]]$i, trts)] <- 1; A[r, match(pair_var[[r]]$j, trts)] <- 1; b[r] <- pair_var[[r]]$v
  }
  v <- tryCatch(as.numeric(qr.solve(A, b)), error = function(e) rep(NA_real_, a))
  if (anyNA(v) || any(v <= 0)) vcr_abort("scenario_value_invalid", field, "The standard errors of this study's comparisons cannot belong to one set of arms: state its arms instead, or check the standard errors.")
  v
}

#' All studies of the scenario in the representation the fit uses, with the zero-cell increments applied and listed.
vcr_net_parse <- function(sc) {
  measure <- as.character(sc$measure)
  incr <- vcr_scalar(sc$continuityCorrection, 0.5)
  out <- list(); corrected <- character(0); excluded <- character(0)
  seen <- character(0)
  for (i in seq_along(sc$studies)) {
    st <- sc$studies[[i]]
    here <- sprintf("scenario.studies[%d]", i - 1L)
    id <- as.character(st$studyId)
    if (id %in% seen) vcr_abort("scenario_value_invalid", paste0(here, ".studyId"), "A study appears once.")
    seen <- c(seen, id)
    if (!is.null(st$arms)) {
      arms <- st$arms
      trt <- vapply(arms, function(a) as.character(a$treatment), character(1))
      if (anyDuplicated(trt)) vcr_abort("scenario_value_invalid", paste0(here, ".arms"), "A treatment appears once in a study.")
      if (measure %in% c("odds_ratio", "risk_ratio")) {
        e <- vapply(arms, function(a) vcr_scalar(a$events, NA_real_), numeric(1)); n <- vapply(arms, function(a) vcr_scalar(a$n, NA_real_), numeric(1))
        if (anyNA(e) || anyNA(n) || any(e > n)) vcr_abort("scenario_value_invalid", paste0(here, ".arms"), "A binary arm states its events and its size, and events do not exceed the size.")
        # no arm has an event (or every arm has only events): nothing to compare, left out as netmeta::pairwise leaves it out
        if (all(e == 0) || all(e == n)) { excluded <- c(excluded, id); next }
        if (any(e == 0 | e == n)) { corrected <- c(corrected, id); e <- e + incr; n <- n + 2 * incr }
        if (identical(measure, "odds_ratio")) { theta <- log(e / (n - e)); v <- 1 / e + 1 / (n - e) } else { theta <- log(e / n); v <- 1 / e - 1 / n }
      } else if (identical(measure, "mean_difference")) {
        m <- vapply(arms, function(a) vcr_scalar(a$mean, NA_real_), numeric(1)); s <- vapply(arms, function(a) vcr_scalar(a$sd, NA_real_), numeric(1))
        n <- vapply(arms, function(a) vcr_scalar(a$n, NA_real_), numeric(1))
        if (anyNA(m) || anyNA(s) || anyNA(n)) vcr_abort("scenario_value_invalid", paste0(here, ".arms"), "A continuous arm states its mean, its standard deviation and its size.")
        theta <- m; v <- s^2 / n
      } else vcr_abort("scenario_value_invalid", paste0(here, ".arms"), "A study states its arms only for an odds ratio, a risk ratio or a mean difference; for a ratio or difference on its own scale it states contrasts.")
      out[[length(out) + 1L]] <- .vcr_net_study(id, trt, theta, v)
    } else {
      cs <- st$contrasts
      if (!(measure %in% c("log_ratio", "difference", "odds_ratio", "risk_ratio", "mean_difference"))) vcr_abort("scenario_value_invalid", paste0(here, ".contrasts"), "Unknown measure.")
      tr <- vapply(cs, function(c) as.character(c$treatment), character(1)); co <- vapply(cs, function(c) as.character(c$comparator), character(1))
      eff <- vapply(cs, function(c) vcr_scalar(c$effect, NA_real_), numeric(1)); se <- vapply(cs, function(c) vcr_scalar(c$se, NA_real_), numeric(1))
      if (anyNA(eff) || anyNA(se) || any(se <= 0) || any(tr == co)) vcr_abort("scenario_value_invalid", paste0(here, ".contrasts"), "A comparison states two different treatments, an effect and a positive standard error.")
      trts <- .vcr_net_sort(c(tr, co)); a <- length(trts)
      key <- paste(pmin(tr, co), pmax(tr, co), sep = "\r")
      if (anyDuplicated(key)) vcr_abort("scenario_value_invalid", paste0(here, ".contrasts"), "A pair of treatments appears once in a study.")
      if (length(cs) != a * (a - 1L) / 2) vcr_abort("scenario_value_invalid", paste0(here, ".contrasts"),
        if (a == 2L) "A two-arm study states one comparison." else "A study with more than two arms states every pair of its arms, so that the correlation between its comparisons can be rebuilt.")
      pair_var <- lapply(seq_along(cs), function(r) list(i = tr[r], j = co[r], v = se[r]^2))
      va <- .vcr_net_arm_variances(trts, pair_var, paste0(here, ".contrasts"))
      # arm effects relative to the first sorted treatment: from the comparisons that involve it
      eff_vs_first <- stats::setNames(numeric(a), trts)
      for (t in trts[-1L]) {
        r <- which((tr == t & co == trts[1L]) | (tr == trts[1L] & co == t))
        eff_vs_first[t] <- if (tr[r] == t) eff[r] else -eff[r]
      }
      # the stated comparisons must be those the effects against the first treatment imply (a study with two arms has nothing to disagree with)
      if (a > 2L) for (r in seq_along(cs)) {
        implied <- eff_vs_first[[tr[r]]] - eff_vs_first[[co[r]]]
        if (abs(eff[r] - implied) > max(0.02, 0.25 * se[r])) {
          vcr_abort("scenario_value_invalid", paste0(here, ".contrasts"), sprintf(
            "The comparisons of this study do not agree with each other: %s against %s is stated as %s, and the study's other comparisons make it %s. Check the effects (a study's comparisons come from the same arms, so any one is the difference of two others up to rounding).",
            tr[r], co[r], format(signif(eff[r], 4)), format(signif(implied, 4))))
        }
      }
      out[[length(out) + 1L]] <- .vcr_net_study(id, trts, as.numeric(eff_vs_first), va)
    }
  }
  list(studies = out, corrected = corrected, excluded = excluded)
}

#' Connected components of the treatment graph.
.vcr_net_components <- function(studies, treatments) {
  comp <- stats::setNames(seq_along(treatments), treatments)
  # label propagation: every treatment takes the smallest label among those that share a study with it
  repeat {
    changed <- FALSE
    for (s in studies) {
      m <- min(comp[s$trt])
      for (t in s$trt) if (comp[[t]] != m) { comp[[t]] <- m; changed <- TRUE }
    }
    if (!changed) break
  }
  unname(split(names(comp), comp))
}

#' The generalized least-squares network fit at a given tau-squared.
#' @return effects against the reference, their covariance, Q and the pieces the tau-squared estimator needs.
.vcr_net_fit <- function(studies, treatments, reference, tau2 = 0, need_trace = FALSE) {
  basic <- setdiff(treatments, reference); nb <- length(basic)
  A <- matrix(0, nb, nb); b <- numeric(nb); yWy <- 0; m <- 0L
  Ws <- vector("list", length(studies)); Xs <- vector("list", length(studies))
  for (k in seq_along(studies)) {
    s <- studies[[k]]; r <- length(s$y)
    P <- if (r == 1L) matrix(1, 1, 1) else 0.5 * (diag(r) + matrix(1, r, r))
    W <- solve(s$S + tau2 * P)
    X <- matrix(0, r, nb)
    for (j in seq_len(r)) {
      cj <- match(s$trt[j + 1L], basic); cb <- match(s$trt[1L], basic)
      if (!is.na(cj)) X[j, cj] <- 1
      if (!is.na(cb)) X[j, cb] <- X[j, cb] - 1
    }
    A <- A + crossprod(X, W %*% X); b <- b + crossprod(X, W %*% s$y); yWy <- yWy + sum(s$y * (W %*% s$y)); m <- m + r
    Ws[[k]] <- W; Xs[[k]] <- X
  }
  Ainv <- tryCatch(solve(A), error = function(e) NULL)
  if (is.null(Ainv)) vcr_abort("network_not_computable", "scenario.studies", "The comparisons of this network do not determine all its effects.")
  d <- as.numeric(Ainv %*% b); names(d) <- basic
  Q <- yWy - as.numeric(crossprod(b, d))
  out <- list(d = d, V = Ainv, basic = basic, Q = max(0, Q), df = m - nb, m = m, W = Ws, X = Xs, tau2 = tau2)
  if (need_trace) {
    tr <- 0; M <- matrix(0, nb, nb)
    for (k in seq_along(studies)) {
      r <- length(studies[[k]]$y)
      P <- if (r == 1L) matrix(1, 1, 1) else 0.5 * (diag(r) + matrix(1, r, r))
      WP <- Ws[[k]] %*% P
      tr <- tr + sum(diag(WP))
      M <- M + crossprod(Xs[[k]], WP %*% Ws[[k]] %*% Xs[[k]])
    }
    out$trace <- tr - sum(diag(Ainv %*% M))
  }
  out
}

#' Effects of every treatment against every other, with standard errors, from a fit.
.vcr_net_pairs <- function(fit, treatments, reference, level) {
  n <- length(treatments)
  full <- stats::setNames(numeric(n), treatments); full[fit$basic] <- fit$d
  Vf <- matrix(0, n, n, dimnames = list(treatments, treatments)); Vf[fit$basic, fit$basic] <- fit$V
  z <- stats::qnorm(1 - (1 - level) / 2)
  est <- outer(full, full, "-")                                # est[i, j] = d_i - d_j (row minus column)
  varm <- outer(seq_len(n), seq_len(n), Vectorize(function(i, j) Vf[i, i] + Vf[j, j] - 2 * Vf[i, j]))
  dimnames(varm) <- list(treatments, treatments)
  varm[varm < 0] <- 0
  se <- sqrt(varm)
  list(est = est, se = se, lower = est - z * se, upper = est + z * se, p = 2 * stats::pnorm(-abs(est / ifelse(se > 0, se, NA_real_))))
}

.vcr_net_pscores <- function(pairs, direction) {
  n <- nrow(pairs$est)
  sgn <- if (identical(direction, "lower_better")) -1 else 1
  ps <- vapply(seq_len(n), function(i) mean(vapply(setdiff(seq_len(n), i), function(j) stats::pnorm(sgn * pairs$est[i, j] / pairs$se[i, j]), numeric(1))), numeric(1))
  stats::setNames(ps, rownames(pairs$est))
}

vcr_job_network_meta <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  assumed <- list()
  note <- function(key, value, basis) assumed[[length(assumed) + 1L]] <<- list(key = key, value = value, basis = basis)
  parsed <- vcr_net_parse(sc)
  studies <- parsed$studies
  treatments <- .vcr_net_sort(unlist(lapply(studies, function(s) s$trt)))
  n <- length(treatments)
  if (n < 2L) vcr_abort("scenario_value_invalid", "scenario.studies", "A network compares at least two treatments.")
  comps <- .vcr_net_components(studies, treatments)
  if (length(comps) > 1L) {
    vcr_abort("network_not_connected", "scenario.studies",
              paste0("The studies form ", length(comps), " separate networks: ", paste(vapply(comps, function(x) paste0("{", paste(x, collapse = ", "), "}"), character(1)), collapse = " and "), "."))
  }
  level <- vcr_scalar(sc$level, 0.95)
  if (is.null(sc$level)) note("level", 0.95, "the usual level of a published interval")
  model <- as.character(sc$model %||% "random")
  if (is.null(sc$model)) note("model", "random", "random effects: the studies differ in more than chance, and the common-effect results are shown beside")
  count <- vapply(treatments, function(t) sum(vapply(studies, function(s) t %in% s$trt, logical(1))), numeric(1))
  reference <- sc$reference
  if (is.null(reference)) {
    reference <- treatments[order(-count, seq_along(treatments))][1L]
    note("reference", reference, "the treatment in the most studies (ties by name); the league table and the P-scores do not depend on it")
  } else if (!(reference %in% treatments)) vcr_abort("scenario_value_invalid", "scenario.reference", "The reference is one of the treatments of the studies.")
  if (length(parsed$excluded)) note("excludedStudies", paste(parsed$excluded, collapse = ", "), "left out because no arm of the study has an event (or every arm has only events), so it compares nothing; netmeta::pairwise leaves such a study out too")
  if (length(parsed$corrected)) note("continuityCorrection", vcr_scalar(sc$continuityCorrection, 0.5), paste0("added to the events and non-events of every arm of the studies with a zero cell: ", paste(parsed$corrected, collapse = ", ")))

  fe <- .vcr_net_fit(studies, treatments, reference, 0, need_trace = TRUE)
  tau2 <- if (fe$df > 0 && fe$trace > 0) max(0, (fe$Q - fe$df) / fe$trace) else 0
  re <- .vcr_net_fit(studies, treatments, reference, tau2)
  i2 <- if (fe$df > 0 && fe$Q > 0) max(0, (fe$Q - fe$df) / fe$Q) else 0
  p_het <- if (fe$df > 0) stats::pchisq(fe$Q, fe$df, lower.tail = FALSE) else NA_real_

  # Q within and between designs (common-effect fit)
  designs <- unique(vapply(studies, function(s) s$design, character(1)))
  q_within <- 0; df_within <- 0L; design_rows <- list()
  for (dn in designs) {
    ss <- studies[vapply(studies, function(s) identical(s$design, dn), logical(1))]
    Wsum <- Reduce(`+`, lapply(ss, function(s) solve(s$S)))
    bsum <- Reduce(`+`, lapply(ss, function(s) solve(s$S, s$y)))
    ybar <- solve(Wsum, bsum)
    qd <- sum(vapply(ss, function(s) { r <- s$y - ybar; as.numeric(crossprod(r, solve(s$S, r))) }, numeric(1)))
    dfd <- (ss[[1L]]$arms - 1L) * (length(ss) - 1L)
    q_within <- q_within + qd; df_within <- df_within + dfd
    design_rows[[length(design_rows) + 1L]] <- list(design = strsplit(dn, " | ", fixed = TRUE)[[1L]], studies = length(ss), q = qd, df = dfd)
  }
  q_between <- max(0, fe$Q - q_within); df_between <- fe$df - df_within
  p_within <- if (df_within > 0) stats::pchisq(q_within, df_within, lower.tail = FALSE) else NA_real_
  p_between <- if (df_between > 0) stats::pchisq(q_between, df_between, lower.tail = FALSE) else NA_real_

  direction <- as.character(sc$direction)
  ratio <- sc$measure %in% VCR_NET_RATIO_MEASURES
  block <- function(fit) {
    pr <- .vcr_net_pairs(fit, treatments, reference, level)
    ps <- .vcr_net_pscores(pr, direction)
    back <- if (ratio) exp else identity
    cell <- function(i, j) list(row = treatments[i], column = treatments[j],
                                estimate = pr$est[i, j], se = pr$se[i, j], lower = pr$lower[i, j], upper = pr$upper[i, j],
                                natural = back(pr$est[i, j]), naturalLower = back(pr$lower[i, j]), naturalUpper = back(pr$upper[i, j]), p = pr$p[i, j],
                                directStudies = sum(vapply(studies, function(s) treatments[i] %in% s$trt && treatments[j] %in% s$trt, logical(1))))
    cells <- list()
    for (i in seq_len(n)) for (j in seq_len(n)) if (i != j) cells[[length(cells) + 1L]] <- cell(i, j)
    vs_ref <- lapply(setdiff(treatments, reference), function(t) { i <- match(t, treatments); j <- match(reference, treatments); cell(i, j) })
    list(pscores = as.list(ps), cells = cells, vsReference = vs_ref, tau2 = fit$tau2)
  }
  blocks <- list(common = block(fe), random = block(re))
  head <- blocks[[model]]
  order_ps <- names(sort(unlist(head$pscores), decreasing = TRUE, method = "radix"))

  measures <- list(
    vcr_measure("k", length(studies), source = "aggregate"),
    vcr_measure("treatments", n, source = "aggregate"),
    vcr_measure("tau_squared", tau2, source = "aggregate"),
    vcr_measure("tau", sqrt(tau2), source = "aggregate"),
    vcr_measure("i_squared", i2, source = "aggregate"))
  if (is.finite(p_het)) measures <- c(measures, list(vcr_measure("p_heterogeneity", p_het, source = "aggregate")))
  if (is.finite(p_between)) measures <- c(measures, list(vcr_measure("p_inconsistency", p_between, source = "aggregate")))

  list(status = "succeeded", measures = measures, counts = vcr_counts(realPatients = NULL, generatedRecords = 0),
       diagnostics = list(network = list(
         given = list(label = sc$label, measure = sc$measure, scale = if (ratio) "log" else "identity", direction = direction, model = model, level = level,
                      reference = reference, studies = length(studies), treatments = n, designs = length(designs),
                      multiArmStudies = sum(vapply(studies, function(s) s$arms > 2L, logical(1)))),
         treatments = lapply(treatments, function(t) list(name = t, studies = as.integer(count[[t]]))),
         designs = design_rows,
         heterogeneity = list(tau2 = tau2, tau = sqrt(tau2), i2 = i2, Q = fe$Q, df = fe$df, p = p_het),
         inconsistency = list(basis = "the common-effect fit", qWithinDesigns = q_within, dfWithinDesigns = df_within, pWithinDesigns = p_within,
                              qBetweenDesigns = q_between, dfBetweenDesigns = df_between, pBetweenDesigns = p_between),
         common = blocks$common, random = blocks$random, order = order_ps, assumed = assumed)))
}
