# C2-01 - C2-07 — synthetic cohorts: reproducibility, recovery, invariants,
# whether the quality metrics can go red, and the count separation.

.c2_rule_cmp <- function(col, cmp, value) list(op = "compare", column = col, comparator = cmp, value = value)

.c2_spec <- function() list(
  variables = list(
    list(name = "age", family = "normal", mean = 62, sd = 10, min = 18, max = 90),
    list(name = "male", family = "bernoulli", prob = 0.55),
    list(name = "egfr", family = "normal", mean = 75, sd = 20, min = 15),
    list(name = "biomarker", family = "lognormal", meanlog = 1.2, sdlog = 0.6)),
  correlation = list(list(1, 0.10, -0.50, 0.20),
                     list(0.10, 1, 0.05, 0.00),
                     list(-0.50, 0.05, 1, -0.10),
                     list(0.20, 0.00, -0.10, 1)),
  # Rules over the generated columns, in the closed grammar (no expressions).
  # The last two span variables: a man with a very high biomarker is
  # implausible in this made-up disease, and a young person does not have a low
  # eGFR. They bind (about a fifth of the draws break one of them) so the case can
  # FAIL; the previous "no male pregnancy" rule was over a lognormal column and
  # could never be broken.
  constraints = list(
    list(name = "adult", rule = .c2_rule_cmp("age", "gte", 18)),
    list(name = "age_upper", rule = .c2_rule_cmp("age", "lte", 90)),
    list(name = "egfr_floor", rule = .c2_rule_cmp("egfr", "gte", 15)),
    list(name = "no_male_high_marker", rule = list(op = "not", operand = list(op = "all", operands = list(
      .c2_rule_cmp("male", "eq", 1), .c2_rule_cmp("biomarker", "gt", 4.5))))),
    list(name = "no_young_low_egfr", rule = list(op = "not", operand = list(op = "all", operands = list(
      .c2_rule_cmp("age", "lt", 50), .c2_rule_cmp("egfr", "lt", 55)))))))

.c2_generate <- function(seed, n = 5000L, dir = NULL, spec = .c2_spec()) {
  job <- vcr_test_job("population.scenario", list(population = spec, n = as.integer(n)), seed = seed, job_id = sprintf("job_c2_%d", seed))
  out <- dir %||% tempfile("c2out"); dir.create(out, showWarnings = FALSE, recursive = TRUE)
  list(result = vcr_test_run(job, output_dir = out), dir = out)
}

vcr_case("C2-01", c("AC-04"), function() {
  a <- .c2_generate(20260928L); b <- .c2_generate(20260928L); c_ <- .c2_generate(20260929L)
  ha <- a$result$tables[[1]]$sha256; hb <- b$result$tables[[1]]$sha256; hc <- c_$result$tables[[1]]$sha256
  # the hash in the manifest is the hash of the bytes on disk
  disk_ok <- identical(ha, vcr_file_sha256(file.path(a$dir, a$result$tables[[1]]$location)))
  same_hash <- identical(ha, hb)
  diff_hash <- !identical(ha, hc)
  same_scen <- identical(a$result$scenarioHash, c_$result$scenarioHash)  # same scenario, other seed
  version <- identical(a$result$methodVersion, vcr_domain()$methods[["population.scenario"]]$version)
  for (x in list(a, b, c_)) unlink(x$dir, recursive = TRUE)
  list(pass = same_hash && diff_hash && same_scen && version && disk_ok && identical(a$result$status, "succeeded"),
       detail = sprintf("same seed -> same table sha256 (%s); other seed -> different (%s); scenario hash unchanged by seed (%s); methodVersion %s",
                        substr(ha, 1, 12), substr(hc, 1, 12), substr(a$result$scenarioHash, 1, 12),
                        a$result$methodVersion))
})

vcr_case("C2-02", c("AC-11"), function() {
  # Recover the declared marginals and correlations from N = 20,000 draws,
  # each within 4 Monte-Carlo standard errors -- six checks, including the
  # binary-continuous correlation (the sixth was cut from the list, `checks[1:5]`,
  # because its expected value had been written down wrongly; it is derived here
  # by integration over the copula, not by a formula).
  spec <- .c2_spec(); spec$constraints <- NULL          # recovery of the DECLARED marginals: no rules
  g <- .c2_generate(4242L, n = 20000L, spec = spec)
  d <- utils::read.csv(file.path(g$dir, g$result$tables[[1]]$location))
  unlink(g$dir, recursive = TRUE)
  n <- nrow(d)
  # The truncated normals shift their moments slightly; the truncation is
  # declared, so the comparison is against the truncated moments.
  lo <- (18 - 62) / 10; hi <- (90 - 62) / 10
  z <- (stats::dnorm(lo) - stats::dnorm(hi)) / (stats::pnorm(hi) - stats::pnorm(lo))
  age_mean <- 62 + 10 * z
  age_sd <- 10 * sqrt(1 + (lo * stats::dnorm(lo) - hi * stats::dnorm(hi)) / (stats::pnorm(hi) - stats::pnorm(lo)) - z^2)
  lo2 <- (15 - 75) / 20
  egfr_mean <- 75 + 20 * stats::dnorm(lo2) / (1 - stats::pnorm(lo2))
  # cor(age, male) with a latent correlation of 0.10: male = 1{Z2 > c}, age = q(Phi(Z1)) truncated.
  # E[age * male] = integral age(z1) P(Z2 > c | z1) phi(z1) dz1 by Gauss-Hermite.
  gh <- .vcr_gauss_hermite(200L); z1 <- sqrt(2) * gh$nodes; w1 <- gh$weights / sqrt(pi)
  cut <- stats::qnorm(1 - 0.55); rho <- 0.10
  age_of <- function(z) { p_lo <- stats::pnorm(18, 62, 10); p_hi <- stats::pnorm(90, 62, 10); stats::qnorm(p_lo + stats::pnorm(z) * (p_hi - p_lo), 62, 10) }
  p_male_given <- 1 - stats::pnorm((cut - rho * z1) / sqrt(1 - rho^2))
  e_age_male <- sum(w1 * age_of(z1) * p_male_given)
  age_moment <- sum(w1 * age_of(z1)); age_var <- sum(w1 * age_of(z1)^2) - age_moment^2
  cor_age_male <- (e_age_male - age_moment * 0.55) / (sqrt(age_var) * sqrt(0.55 * 0.45))
  checks <- list(
    list(name = "age mean", got = mean(d$age), want = age_mean, mcse = stats::sd(d$age) / sqrt(n)),
    list(name = "age sd", got = stats::sd(d$age), want = age_sd, mcse = stats::sd(d$age) / sqrt(2 * (n - 1))),
    list(name = "male", got = mean(d$male), want = 0.55, mcse = sqrt(0.55 * 0.45 / n)),
    list(name = "egfr mean", got = mean(d$egfr), want = egfr_mean, mcse = stats::sd(d$egfr) / sqrt(n)),
    list(name = "cor(age,egfr)", got = stats::cor(d$age, d$egfr), want = -0.50, mcse = (1 - 0.25) / sqrt(n)),
    list(name = "cor(age,male)", got = stats::cor(d$age, d$male), want = cor_age_male, mcse = 1 / sqrt(n)))
  ratios <- vapply(checks, function(c_) abs(c_$got - c_$want) / c_$mcse, numeric(1))
  list(pass = length(checks) == 6L && all(ratios <= 4),
       detail = sprintf("N=%d: %s (all within 4 MCSE: %s)", n,
                        paste(vapply(seq_along(checks), function(i)
                          sprintf("%s %.4f vs %.4f [%.2f MCSE]", checks[[i]]$name, checks[[i]]$got,
                                  checks[[i]]$want, ratios[i]), character(1)), collapse = "; "),
                        all(ratios <= 4)))
})

vcr_case("C2-03", c("AC-03"), function() {
  # Hard constraints are an invariant, and the case can fail. The constraints
  # span variables, so they cannot be satisfied by truncating a marginal; about a
  # fifth of the first draws break one of them (`initialViolations` proves the
  # rules were binding), the violating rows are drawn again from the same stream,
  # and the table that comes back has none -- counted here on the CSV itself,
  # independently of the engine's own report. Rows that never violated anything
  # are the same rows as in the unconstrained population (common random
  # numbers), so adding a rule changes only the rows it has to. A rule that
  # cannot be satisfied under the marginals is a FAILED job with a named code, not
  # a table plus a number in a diagnostic.
  n <- 20000L
  g <- .c2_generate(303L, n = n)
  viol <- g$result$diagnostics$constraintViolations
  m <- Filter(function(x) x$name == "constraint_violations", g$result$measures)[[1]]
  d <- utils::read.csv(file.path(g$dir, g$result$tables[[1]]$location))
  enforce <- g$result$diagnostics$constraintEnforcement
  indep <- sum(d$age < 18 | d$age > 90 | d$egfr < 15 | (d$male == 1 & d$biomarker > 4.5) | (d$age < 50 & d$egfr < 55))
  free_spec <- .c2_spec(); free_spec$constraints <- NULL
  free <- .c2_generate(303L, n = n, spec = free_spec)
  d0 <- utils::read.csv(file.path(free$dir, free$result$tables[[1]]$location))
  same_rows <- mean(d$age == d0$age & d$biomarker == d0$biomarker)
  broke0 <- (d0$male == 1 & d0$biomarker > 4.5) | (d0$age < 50 & d0$egfr < 55) | d0$age < 18 | d0$age > 90 | d0$egfr < 15
  redrawn_share <- mean(broke0)
  # an impossible rule: age below 0 for adults
  imp_spec <- .c2_spec(); imp_spec$constraints <- list(list(name = "impossible", rule = .c2_rule_cmp("age", "lt", 0)))
  imp <- .c2_generate(304L, n = 500L, spec = imp_spec)
  ok <- identical(g$result$status, "succeeded") && sum(viol$violations) == 0 && m$value == 0 && indep == 0L &&
    sum(viol$initialViolations) > 0.1 * n && enforce$rowsRedrawn > 0 && enforce$roundsUsed < enforce$maxRounds &&
    abs(same_rows - (1 - redrawn_share)) < 1e-9 &&
    identical(imp$result$status, "failed") && "constraint_unsatisfiable" %in% vcr_test_issue_codes(imp$result)
  out <- list(pass = ok,
       detail = sprintf("%d declared constraints; %d rows broke one before enforcement (%s), %d redrawn in %d rounds, %d violations in %d records afterwards (independent count on the CSV: %d); %.4f of rows equal the unconstrained population's (= 1 - share of its rows that break a rule, %.4f); an impossible rule -> %s (%s)",
                        nrow(viol), sum(viol$initialViolations), paste(sprintf("%s=%d", viol$rule, viol$initialViolations), collapse = " "),
                        enforce$rowsRedrawn, enforce$roundsUsed, sum(viol$violations), n, indep, same_rows, 1 - redrawn_share,
                        imp$result$status, paste(vcr_test_issue_codes(imp$result), collapse = ",")))
  for (x in list(g, free, imp)) unlink(x$dir, recursive = TRUE)
  out
})

vcr_case("C2-04", c("AC-04"), function() {
  # The metrics must be able to go red. Three generators: the identity (return
  # the training rows), an ideal one (independent draws from the same
  # mechanism) and a column-shuffled one.
  set.seed(404L, kind = VCR_RNG_KIND)
  mk <- function(n) {
    x1 <- stats::rnorm(n, 60, 10); x2 <- stats::rbinom(n, 1L, 0.5)
    data.frame(x1 = x1, x2 = x2, y = 0.5 * x1 + 3 * x2 + stats::rnorm(n))
  }
  train <- mk(400L); holdout <- mk(400L)
  identity_gen <- train
  ideal_gen <- mk(400L)
  shuffled <- ideal_gen; shuffled$y <- sample(shuffled$y)
  rep_id <- vcr_quality_report(train, identity_gen, holdout)
  rep_ideal <- vcr_quality_report(train, ideal_gen, holdout)
  rep_shuf <- vcr_quality_report(train, shuffled, holdout)
  worst_pair <- function(r) if (nrow(r$fidelity$pairwise)) max(r$fidelity$pairwise$value) else 0
  red_identity <- rep_id$disclosure$exactReplicationRate == 1 &&
    rep_id$disclosure$membershipAuc > 0.60 &&
    rep_id$disclosure$nearestNeighbourInTrainShare > 0.60
  green_ideal <- abs(rep_ideal$disclosure$membershipAuc - 0.5) < 0.05 &&
    abs(rep_ideal$disclosure$nearestNeighbourInTrainShare - 0.5) < 0.05 &&
    rep_ideal$disclosure$exactReplicationRate == 0
  red_shuffled <- worst_pair(rep_shuf) > 0.10
  list(pass = red_identity && green_ideal && red_shuffled,
       detail = sprintf("identity: replication %.3f, MIA AUC %.3f, NN-in-train %.3f (red); ideal: MIA AUC %.3f, NN-in-train %.3f, replication %.3f (green); column-shuffled: worst pairwise |d| %.3f (red)",
                        rep_id$disclosure$exactReplicationRate, rep_id$disclosure$membershipAuc,
                        rep_id$disclosure$nearestNeighbourInTrainShare,
                        rep_ideal$disclosure$membershipAuc, rep_ideal$disclosure$nearestNeighbourInTrainShare,
                        rep_ideal$disclosure$exactReplicationRate, worst_pair(rep_shuf)))
})

vcr_case("C2-05", c("AC-09"), function() {
  # Generating ten times as many records must not move the observed patient
  # count or the event count, and the synthesis must record how many real
  # records it was fitted to and how many copies it made -- and DELIVER those
  # copies: the job used to report 10 x 240 generated records and write one copy
  # of 240. Also: a holdout share of 0 works (it emptied the training table),
  # fewer than five copies are refused, rare levels are merged before synthesis,
  # and every copy is scored, not only the first.
  #
  # The table is the one the control plane hands the job: a SUBJECT table, one row
  # per person, with its pseudonymous key `USUBJID`. (This case used to delete the
  # key first, so no case ever ran the real shape: with the key in, every pseudonym
  # was a level held by one row, the merge listed all of them BY NAME in
  # `diagnostics.rareLevelsMerged`, and the propensity model fitted to a 240-level
  # factor took minutes.) The key is not a variable, so the synthetic table has none;
  # the result says how many levels it merged in which column and never a level's
  # name, and no string anywhere in the diagnostics is a pseudonym or a value that
  # fewer than the small-cell floor of rows hold -- a profile may name the levels
  # that enough people share, and that is all it may name.
  set.seed(505L, kind = VCR_RNG_KIND)
  n <- 300L
  real <- data.frame(USUBJID = sprintf("S%03d", seq_len(n)), age = stats::rnorm(n, 60, 10), sex = stats::rbinom(n, 1L, 0.5),
                     event = stats::rbinom(n, 1L, 0.3), site = sample(c("north", "south", "east", "rare"), n, TRUE, prob = c(0.45, 0.3, 0.22, 0.03)),
                     stringsAsFactors = FALSE)
  real$site[real$site == "rare"] <- "north"; real$site[sample.int(n, 6L)] <- "rare"   # exactly six rows: below the floor whatever the split
  # a mutation column: two common genotypes and three held by one to three people each (a name that points at a person)
  real$genotype <- c(rep("exon19del", 150L), rep("L858R", 144L), "L861Q", "G719A", "G719A", "S768I", "S768I", "S768I")[sample.int(n)]
  inp <- vcr_test_input(real, "snp_c205:subject", shape = "subject", source = "observed")
  run <- function(sc, dir = NULL) vcr_test_run(vcr_test_job("population.synthpop", sc, list(inp), seed = 505L, job_id = "job_c205"), output_dir = dir)
  out <- tempfile("c2out"); dir.create(out)
  r <- run(list(m = 10L, holdoutShare = 0.2), out)
  gen <- vcr_measure_value(r, "generated_records"); train_obs <- vcr_measure_value(r, "training_observations"); copies <- vcr_measure_value(r, "synthetic_copies")
  tb <- vcr_test_table(r, "synthetic-population", out)
  r0 <- run(list(m = 5L, holdoutShare = 0))
  r_few <- run(list(m = 3L, holdoutShare = 0.2))
  counts_of <- function(res) {
    merged <- res$diagnostics$rareLevelsMerged
    stats::setNames(vapply(merged, function(x) as.numeric(x$mergedLevelCount %||% NA_real_), numeric(1)), vapply(merged, function(x) as.character(x$column), character(1)))
  }
  merged <- r$diagnostics$rareLevelsMerged
  merged_count <- counts_of(r)       # the training split decides which rare levels it holds: at most the table's
  all_count <- counts_of(r0)         # no holdout: the whole table is the training table, so the count is the table's
  # every string in the diagnostics, against the values few rows hold and the pseudonyms
  strings <- function(x) if (is.character(x)) x else if (is.list(x)) unlist(lapply(x, strings), use.names = FALSE) else character(0)
  floor_ <- vcr_limit("minCellSize", 10)
  few <- unique(unlist(lapply(real[vapply(real, is.character, logical(1))], function(v) { t <- table(v); names(t)[t < floor_] })))
  seen <- unique(c(strings(r$diagnostics), strings(r0$diagnostics)))
  leaked <- intersect(seen, c(real$USUBJID, few))
  ok <- identical(r$status, "succeeded") && r$counts$realPatients == 0 && gen == train_obs * copies && copies == 10 &&
    identical(r$diagnostics$inferenceLabel, "exploratory") && nrow(tb) == gen && identical(sort(unique(tb$copy)), 1:10) &&
    !("rare" %in% tb$site) && !any(c("L861Q", "G719A", "S768I") %in% tb$genotype) &&
    !("USUBJID" %in% names(tb)) && identical(unlist(r$diagnostics$subjectKeyDropped), "USUBJID") &&
    identical(all_count[["site"]], 1) && identical(all_count[["genotype"]], 3) && identical(sort(names(all_count)), c("genotype", "site")) &&
    merged_count[["site"]] == 1 && merged_count[["genotype"]] >= 1 && merged_count[["genotype"]] <= 3 && !("USUBJID" %in% names(merged_count)) &&
    !any(vapply(merged, function(x) "mergedLevels" %in% names(x), logical(1))) && length(leaked) == 0L && length(setdiff(few, real$USUBJID)) == 4L &&
    nrow(r$diagnostics$qualityByCopy) == 10L &&
    identical(r0$status, "succeeded") && identical(r0$diagnostics$holdoutRows, 0L) && isFALSE(r0$diagnostics$quality$disclosure$available) &&
    identical(r_few$status, "failed")
  out_r <- list(pass = ok,
       detail = sprintf("a subject table with its USUBJID key: %d generated records from %d training observations x %d copies, and the table on disk has %d rows in %d copies and no key column; realPatients stays %s; inference labelled %s; rare levels merged before synthesis (the whole table, no holdout): site %s level(s), genotype %s level(s), the key column none (dropped: %s); no level name in the report (%s); %d strings in the diagnostics, %d of them a pseudonym or a value held by fewer than %d rows (%d such values in the table besides the pseudonyms); %d per-copy quality rows; holdoutShare 0 -> %s with the disclosure axis withheld (%s); m=3 -> %s (%s); allowed uses %s",
                        gen, train_obs, copies, nrow(tb), length(unique(tb$copy)), r$counts$realPatients, r$diagnostics$inferenceLabel,
                        all_count[["site"]], all_count[["genotype"]], paste(unlist(r$diagnostics$subjectKeyDropped), collapse = ","),
                        paste(vapply(merged, function(x) paste(names(x), collapse = "/"), character(1)), collapse = " | "),
                        length(seen), length(leaked), floor_, length(setdiff(few, real$USUBJID)),
                        nrow(r$diagnostics$qualityByCopy), r0$status, r0$diagnostics$quality$disclosure$reason %||% "?",
                        r_few$status, paste(vcr_test_issue_codes(r_few), collapse = ","),
                        paste(unlist(r$diagnostics$allowedUses), collapse = "/")))
  unlink(out, recursive = TRUE)
  out_r
})

vcr_case("C2-05b", c("AC-09", "AC-26"), function() {
  # What the rare-level merge reports. The merge folds every level held by fewer than the small-cell floor of rows into
  # "other" before synthesis, and its report named the levels it folded. A level below the floor is a small cell, and the
  # engine's rule for a merged cell (`vcr_suppress_cells`) is that nothing of it is kept but that it was merged: no count, no
  # complement, no name. So the report is the column and the number of levels, and the table it returns is the same table it
  # always returned. A per-study pseudonym is a level held by one row: forty rows, forty ids, three rare genotypes.
  set.seed(5051L, kind = VCR_RNG_KIND)
  d <- data.frame(USUBJID = sprintf("p_%04x", sample.int(65535L, 40L)), age = stats::rnorm(40L, 60, 9), stringsAsFactors = FALSE)
  d$egfr <- sample(c(rep("exon19del", 20L), rep("L858R", 17L), "L861Q", "G719A", "S768I"))
  m <- .vcr_merge_rare_levels(d, 10)
  by <- stats::setNames(m$report, vapply(m$report, function(x) as.character(x$column), character(1)))
  strings <- function(x) if (is.character(x)) x else if (is.list(x)) unlist(lapply(x, strings), use.names = FALSE) else character(0)
  named <- intersect(strings(m$report), c(d$USUBJID, unique(d$egfr)))
  ok <- identical(names(by), c("USUBJID", "egfr")) && identical(by$USUBJID$mergedLevelCount, 40L) && identical(by$egfr$mergedLevelCount, 3L) &&
    length(named) == 0L && setequal(unique(m$data$egfr), c("L858R", "exon19del", "other")) && sum(m$data$egfr == "other") == 3L &&
    all(m$data$USUBJID == "other")
  list(pass = ok,
       detail = sprintf("columns reported: %s; levels merged per column: %s; level names in the report: %d (%s); the table folds the 3 rare genotypes and the %d pseudonyms into 'other'",
                        paste(names(by), collapse = ", "), paste(vapply(by, function(x) as.character(x$mergedLevelCount %||% NA), character(1)), collapse = " / "),
                        length(named), paste(utils::head(named, 3L), collapse = ", "), sum(m$data$USUBJID == "other")))
})

vcr_case("C2-06", c("AC-20"), function() {
  # Every number a validation report would print must be present in the stored
  # metrics, with the seed and version that produced it. The check is
  # structural: walk the report and confirm each leaf is a finite number or a
  # named string, and that the generator block carries seed and version.
  set.seed(606L, kind = VCR_RNG_KIND)
  mk <- function(n) data.frame(a = stats::rnorm(n), b = stats::rbinom(n, 1L, 0.4))
  train <- mk(300L); syn <- mk(300L); hold <- mk(300L)
  rep_ <- vcr_quality_report(train, syn, hold,
                             generator = list(family = "reference", seed = 606L, version = vcr_engine_version()))
  leaves <- function(x, path = "") {
    if (is.data.frame(x)) return(unlist(lapply(names(x), function(n) leaves(x[[n]], paste0(path, "/", n)))))
    if (is.list(x)) return(unlist(lapply(names(x) %||% seq_along(x), function(n) leaves(x[[n]], paste0(path, "/", n)))))
    if (length(x) == 0L) return(character(0))
    if (is.numeric(x) && !all(is.finite(x))) return(paste0(path, "=nonfinite"))
    character(0)
  }
  bad <- leaves(rep_)
  has_prov <- !is.null(rep_$generator$seed) && !is.null(rep_$generator$version) &&
    !is.null(rep_$bandSources$sPmse)
  list(pass = length(bad) == 0L && has_prov && isTRUE(rep_$advisory),
       detail = sprintf("report has %d band verdicts, all numeric leaves finite (%d non-finite), provenance seed=%s version=%s, S_pMSE band source '%s', advisory=%s",
                        length(rep_$bands), length(bad), rep_$generator$seed, rep_$generator$version,
                        rep_$bandSources$sPmse, rep_$advisory))
})

vcr_case("C2-07", c("AC-04"), function() {
  # Five planted unique outliers must be visible in the disclosure report:
  # their distance to the synthetic data must be distinguishable from the bulk.
  set.seed(707L, kind = VCR_RNG_KIND)
  n <- 300L
  base <- data.frame(a = stats::rnorm(n), b = stats::rnorm(n))
  outliers <- data.frame(a = c(8, 8.5, 9, 9.5, 10), b = c(8, -8, 9, -9, 10))
  train <- rbind(base, outliers)
  holdout <- data.frame(a = stats::rnorm(n), b = stats::rnorm(n))
  syn <- train[sample.int(nrow(train), nrow(train), replace = TRUE), ]   # a memorizing generator
  ranges <- lapply(train, function(v) diff(range(v)))
  nn <- vcr_gower_nearest(train, syn, ranges)
  idx_out <- (n + 1L):nrow(train)
  singled <- mean(nn$dcr[idx_out] == 0) >= 0.8
  rep_ <- vcr_quality_report(train, syn, holdout)
  ok <- singled && rep_$disclosure$exactReplicationRate > 0.5
  list(pass = ok,
       detail = sprintf("%d/%d planted outliers reproduced exactly (distance 0) by a memorizing generator; overall replication rate %.3f vs holdout %.3f; MIA AUC %.3f",
                        sum(nn$dcr[idx_out] == 0), length(idx_out),
                        rep_$disclosure$exactReplicationRate, rep_$disclosure$exactReplicationRateHoldout,
                        rep_$disclosure$membershipAuc))
})
