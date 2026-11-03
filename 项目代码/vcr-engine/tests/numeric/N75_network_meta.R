# N75 — evidence.network: frequentist network meta-analysis (algorithm round C5, 2026-11-03).
#
# The reference that is not the method's own code is `netmeta` (Balduzzi et al. 2023; Rücker 2012's graph-theoretical method), held to the engine on two
# data sets that ship with it and between them exercise every path: `Senn2013` (diabetes, mean differences stated as contrasts, a three-arm study among
# 26, ten treatments) and `smokingcessation` (arm data of 24 studies, two of them with three arms and two with a zero cell, four treatments, odds
# ratios). Held to it: every treatment effect against the reference and every pair of the league table with its standard error, the common-effect and
# the random-effects model, tau-squared, Q and its degrees of freedom, I-squared, the split of Q into within and between designs, and the P-scores.
# Beyond netmeta: a network of two treatments is a pairwise meta-analysis (DerSimonian-Laird in closed form), the answer does not depend on the order
# the studies or the arms are written in, and a network that is not connected is refused by name with its parts.

.n75_job <- function(sc, id) vcr_test_job("evidence.network", sc, NULL, job_id = paste0("job_", id))
.n75_cell <- function(blk, row, col) { for (c in blk$cells) if (identical(c$row, row) && identical(c$column, col)) return(c); NULL }

.n75_compare <- function(dn, net, treatments, pscores_small) {
  d <- c(tau2 = abs(dn$heterogeneity$tau2 - net$tau2), Q = abs(dn$heterogeneity$Q - net$Q), df = abs(dn$heterogeneity$df - net$df.Q))
  worst_est <- 0; worst_se <- 0
  for (m in c("common", "random")) {
    blk <- dn[[m]]
    te <- if (m == "common") net$TE.common else net$TE.random; se <- if (m == "common") net$seTE.common else net$seTE.random
    for (i in treatments) for (j in treatments) if (i != j) {
      cl <- .n75_cell(blk, i, j)
      worst_est <- max(worst_est, abs(cl$estimate - te[i, j])); worst_se <- max(worst_se, abs(cl$se - se[i, j]))
    }
  }
  dd <- netmeta::decomp.design(net)$Q.decomp
  q <- c(within = abs(dn$inconsistency$qWithinDesigns - dd["Within designs", "Q"]), dfw = abs(dn$inconsistency$dfWithinDesigns - dd["Within designs", "df"]),
         between = abs(dn$inconsistency$qBetweenDesigns - dd["Between designs", "Q"]), dfb = abs(dn$inconsistency$dfBetweenDesigns - dd["Between designs", "df"]),
         pb = abs(dn$inconsistency$pBetweenDesigns - dd["Between designs", "pval"]))
  nr <- netmeta::netrank(net, small.values = pscores_small)
  ps <- c(common = max(abs(unlist(dn$common$pscores)[treatments] - nr$ranking.common[treatments])), random = max(abs(unlist(dn$random$pscores)[treatments] - nr$ranking.random[treatments])))
  list(heterogeneity = d, estimate = worst_est, se = worst_se, q = q, pscores = ps, worst = max(d, worst_est, worst_se, q, ps))
}

vcr_case("N75a", c("AC-08", "AC-30"), function() {
  if (!requireNamespace("netmeta", quietly = TRUE)) return(list(pass = FALSE, detail = "error: the cross-check package netmeta is not installed (the run must not skip silently)"))
  suppressMessages(library(netmeta))
  data("Senn2013", package = "netmeta")
  net <- netmeta(TE, seTE, treat1, treat2, studlab, data = Senn2013, sm = "MD", reference.group = "plac", common = TRUE, random = TRUE)
  studies <- unname(lapply(split(Senn2013, Senn2013$studlab), function(x) list(studyId = as.character(x$studlab[1]),
    contrasts = lapply(seq_len(nrow(x)), function(i) list(treatment = as.character(x$treat1[i]), comparator = as.character(x$treat2[i]), effect = x$TE[i], se = x$seTE[i])))))
  r <- vcr_test_run(.n75_job(list(measure = "difference", direction = "lower_better", studies = studies, reference = "plac"), "n75a"))
  if (!identical(r$status, "succeeded")) return(list(pass = FALSE, detail = paste("the job did not succeed:", paste(vcr_test_issue_codes(r), collapse = ", "))))
  cmp <- .n75_compare(r$diagnostics$network, net, rownames(net$TE.random), "good")
  dn <- r$diagnostics$network
  list(pass = cmp$worst < 1e-8 && length(vcr_validate_result(r)) == 0L && dn$given$multiArmStudies == 1L,
       detail = sprintf("Senn2013 (26 studies, 10 treatments, one three-arm study in contrast form) against netmeta: tau2 %.6f vs %.6f, Q %.4f (df %d), Q within %.4f (df %d) and between designs %.4f (df %d, p %.5f); largest differences: effects %.1e, standard errors %.1e, P-scores %.1e (all 90 pairs, both models)",
                        dn$heterogeneity$tau2, net$tau2, dn$heterogeneity$Q, as.integer(dn$heterogeneity$df), dn$inconsistency$qWithinDesigns, as.integer(dn$inconsistency$dfWithinDesigns),
                        dn$inconsistency$qBetweenDesigns, as.integer(dn$inconsistency$dfBetweenDesigns), dn$inconsistency$pBetweenDesigns, cmp$estimate, cmp$se, max(cmp$pscores)))
})

vcr_case("N75b", c("AC-08", "AC-30"), function() {
  if (!requireNamespace("netmeta", quietly = TRUE)) return(list(pass = FALSE, detail = "error: the cross-check package netmeta is not installed (the run must not skip silently)"))
  suppressMessages(library(netmeta))
  data("smokingcessation", package = "netmeta")
  sm <- smokingcessation
  pw <- pairwise(list(treat1, treat2, treat3), event = list(event1, event2, event3), n = list(n1, n2, n3), data = sm, sm = "OR")
  net <- netmeta(pw, reference.group = "A", common = TRUE, random = TRUE)
  studies <- lapply(seq_len(nrow(sm)), function(i) {
    arms <- list()
    for (j in 1:3) { t <- sm[[paste0("treat", j)]][i]; nn <- sm[[paste0("n", j)]][i]
      if (!is.na(nn) && nzchar(as.character(t))) arms[[length(arms) + 1L]] <- list(treatment = as.character(t), events = sm[[paste0("event", j)]][i], n = nn) }
    list(studyId = paste0("s", i), arms = arms)
  })
  r <- vcr_test_run(.n75_job(list(measure = "odds_ratio", direction = "higher_better", studies = studies, reference = "A"), "n75b"))
  if (!identical(r$status, "succeeded")) return(list(pass = FALSE, detail = paste("the job did not succeed:", paste(vcr_test_issue_codes(r), collapse = ", "))))
  dn <- r$diagnostics$network
  cmp <- .n75_compare(dn, net, rownames(net$TE.random), "bad")
  corrected <- unlist(lapply(dn$assumed, function(a) if (identical(a$key, "continuityCorrection")) a$basis))
  list(pass = cmp$worst < 1e-8 && length(vcr_validate_result(r)) == 0L && dn$given$multiArmStudies == 2L && length(corrected) == 1L && grepl("s6", corrected) && grepl("s15", corrected),
       detail = sprintf("smokingcessation (24 studies, 4 treatments, two three-arm studies, two zero-cell studies, odds ratios from arm data) against netmeta: tau2 %.6f vs %.6f, Q %.4f (df %d), Q between designs %.4f (df %d); largest differences: effects %.1e, standard errors %.1e, P-scores %.1e; the corrected studies are named in the result (%s)",
                        dn$heterogeneity$tau2, net$tau2, dn$heterogeneity$Q, as.integer(dn$heterogeneity$df), dn$inconsistency$qBetweenDesigns, as.integer(dn$inconsistency$dfBetweenDesigns),
                        cmp$estimate, cmp$se, max(cmp$pscores), if (length(corrected)) "yes" else "no"))
})

vcr_case("N75c", c("AC-08", "AC-30"), function() {
  # Two treatments are a pairwise meta-analysis: the effect, its standard error and tau-squared are the DerSimonian-Laird ones written out; and the answer
  # does not depend on how the studies and the arms are ordered, on which treatment is the reference, or on the number of cores.
  y <- c(-0.40, -0.10, -0.55, -0.20, 0.05); s <- c(0.15, 0.20, 0.25, 0.12, 0.30)
  studies <- lapply(seq_along(y), function(i) list(studyId = paste0("p", i), contrasts = list(list(treatment = "T", comparator = "C", effect = y[i], se = s[i]))))
  r <- vcr_test_run(.n75_job(list(measure = "log_ratio", direction = "lower_better", studies = studies, reference = "C"), "n75c1"))
  w <- 1 / s^2; fe <- sum(w * y) / sum(w); Q <- sum(w * (y - fe)^2); df <- length(y) - 1L
  tau2 <- max(0, (Q - df) / (sum(w) - sum(w^2) / sum(w)))
  wr <- 1 / (s^2 + tau2); re <- sum(wr * y) / sum(wr); se_re <- 1 / sqrt(sum(wr)); se_fe <- 1 / sqrt(sum(w))
  dn <- r$diagnostics$network
  cl_r <- .n75_cell(dn$random, "T", "C"); cl_c <- .n75_cell(dn$common, "T", "C")
  d_pair <- c(abs(dn$heterogeneity$tau2 - tau2), abs(cl_r$estimate - re), abs(cl_r$se - se_re), abs(cl_c$estimate - fe), abs(cl_c$se - se_fe), abs(dn$heterogeneity$Q - Q))
  # permutation: studies reversed, arms listed the other way round (a contrast stated as C against T has the opposite sign), reference the other treatment
  flipped <- lapply(rev(seq_along(y)), function(i) list(studyId = paste0("p", i), contrasts = list(list(treatment = "C", comparator = "T", effect = -y[i], se = s[i]))))
  r2 <- vcr_test_run(.n75_job(list(measure = "log_ratio", direction = "lower_better", studies = flipped, reference = "T", model = "random"), "n75c1"))
  cl_r2 <- .n75_cell(r2$diagnostics$network$random, "T", "C")
  d_perm <- c(abs(cl_r2$estimate - cl_r$estimate), abs(cl_r2$se - cl_r$se), abs(r2$diagnostics$network$heterogeneity$tau2 - dn$heterogeneity$tau2))
  r3 <- vcr_test_run(vcr_test_job("evidence.network", list(measure = "log_ratio", direction = "lower_better", studies = studies, reference = "C"), NULL, job_id = "job_n75c1", cores = 2L))
  same <- identical(r$manifest$outputHash, r3$manifest$outputHash)
  list(pass = max(d_pair) < 1e-12 && max(d_perm) < 1e-12 && same && is.na(dn$inconsistency$pBetweenDesigns),
       detail = sprintf("two treatments, five studies: against the pairwise DerSimonian-Laird written out (tau2 %.5f, random effect %.5f se %.5f, common effect %.5f se %.5f, Q %.4f): largest difference %.1e; studies reversed, arms swapped and the other reference: %.1e; same hash on 1 and 2 cores: %s",
                        tau2, re, se_re, fe, se_fe, Q, max(d_pair), max(d_perm), same))
})

vcr_case("N75d", c("AC-08", "AC-25"), function() {
  # Refusals are named and cost nothing else: a network in two parts lists the parts; a study with three arms that states only some of its pairs, and
  # a study whose standard errors cannot belong to one set of arms, are refused by their path; a binary study without counts is refused; a reference that is no
  # treatment is refused. A study set that is fine runs (the zero-cell study is corrected and named).
  mk <- function(id, t, c, e, s) list(studyId = id, contrasts = list(list(treatment = t, comparator = c, effect = e, se = s)))
  sc <- function(studies, ...) c(list(measure = "log_ratio", direction = "lower_better", studies = studies), list(...))
  apart <- vcr_test_run(.n75_job(sc(list(mk("a", "B", "A", -0.2, 0.1), mk("b", "B", "A", -0.3, 0.1), mk("c", "D", "C", -0.1, 0.1), mk("d", "D", "C", -0.2, 0.1))), "n75d1"))
  incomplete <- vcr_test_run(.n75_job(sc(list(list(studyId = "t", contrasts = list(list(treatment = "B", comparator = "A", effect = -0.2, se = 0.1), list(treatment = "C", comparator = "A", effect = -0.3, se = 0.1))), mk("u", "C", "B", -0.1, 0.1))), "n75d2"))
  impossible <- vcr_test_run(.n75_job(sc(list(list(studyId = "t", contrasts = list(list(treatment = "B", comparator = "A", effect = -0.2, se = 0.5), list(treatment = "C", comparator = "A", effect = -0.3, se = 0.1), list(treatment = "C", comparator = "B", effect = -0.1, se = 0.1))), mk("u", "C", "B", -0.1, 0.1))), "n75d3"))
  nocounts <- vcr_test_run(.n75_job(list(measure = "odds_ratio", direction = "lower_better", studies = list(
    list(studyId = "a", arms = list(list(treatment = "A", events = 5, n = 50), list(treatment = "B", events = 9, n = 55))),
    list(studyId = "b", arms = list(list(treatment = "A", n = 40), list(treatment = "B", events = 7, n = 41))))), "n75d4"))
  badref <- vcr_test_run(.n75_job(sc(list(mk("a", "B", "A", -0.2, 0.1), mk("b", "B", "A", -0.3, 0.1)), reference = "Z"), "n75d5"))
  good <- vcr_test_run(.n75_job(list(measure = "odds_ratio", direction = "lower_better", studies = list(
    list(studyId = "a", arms = list(list(treatment = "A", events = 0, n = 50), list(treatment = "B", events = 9, n = 55))),
    list(studyId = "b", arms = list(list(treatment = "A", events = 6, n = 40), list(treatment = "B", events = 7, n = 41))),
    list(studyId = "c", arms = list(list(treatment = "A", events = 4, n = 30), list(treatment = "B", events = 8, n = 33))))), "n75d6"))
  has <- function(r, code) code %in% vcr_test_issue_codes(r)
  parts <- apart$diagnostics$issues[[1]]$detail
  ok_assumed <- any(vapply(good$diagnostics$network$assumed, function(a) identical(a$key, "continuityCorrection") && grepl("a", a$basis, fixed = TRUE), logical(1)))
  list(pass = identical(apart$status, "failed") && has(apart, "network_not_connected") && grepl("A, B", parts, fixed = TRUE) && grepl("C, D", parts, fixed = TRUE) && length(apart$measures) == 0L &&
        has(incomplete, "scenario_value_invalid") && has(impossible, "scenario_value_invalid") && has(nocounts, "scenario_value_invalid") && has(badref, "scenario_value_invalid") &&
        identical(good$status, "succeeded") && ok_assumed,
       detail = sprintf("two separate networks: %s (%s); three-arm study with two pairs: %s; standard errors that cannot belong to one set of arms: %s; binary arm without events: %s; unknown reference: %s; a zero-cell study runs, corrected and named: %s",
                        has(apart, "network_not_connected"), parts, has(incomplete, "scenario_value_invalid"), has(impossible, "scenario_value_invalid"), has(nocounts, "scenario_value_invalid"), has(badref, "scenario_value_invalid"), ok_assumed))
})
