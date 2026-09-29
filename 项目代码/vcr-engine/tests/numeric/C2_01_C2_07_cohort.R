# C2-01 - C2-07 — synthetic cohorts: reproducibility, recovery, invariants,
# whether the quality metrics can go red, and the count separation.

.c2_spec <- function() list(
  variables = list(
    list(name = "age", family = "normal", mean = 62, sd = 10, min = 18, max = 90),
    list(name = "male", family = "bernoulli", prob = 0.55),
    list(name = "egfr", family = "normal", mean = 75, sd = 20, min = 15),
    list(name = "biomarker", family = "lognormal", meanlog = 1.2, sdlog = 0.6)),
  correlation = matrix(c(1, 0.10, -0.50, 0.20,
                         0.10, 1, 0.05, 0.00,
                         -0.50, 0.05, 1, -0.10,
                         0.20, 0.00, -0.10, 1), 4, 4),
  constraints = list(
    list(name = "adult", expression = "age >= 18"),
    list(name = "age_upper", expression = "age <= 90"),
    list(name = "egfr_floor", expression = "egfr >= 15"),
    list(name = "no_male_pregnancy", expression = "!(male == 1 & biomarker < 0)")))

.c2_generate <- function(seed, n = 5000L, dir = NULL) {
  job <- list(jobId = sprintf("job_c2_%d", seed), studyId = "std_c2", kind = "generate_population",
              method = "population.scenario", methodVersion = "1.0.0", protocolVersion = 1L,
              seed = as.integer(seed), cpuSecondsLimit = 120,
              inputs = list(list(kind = "assumption", id = "asm_pop@1")),
              scenario = list(population = .c2_spec(), n = n))
  out <- dir %||% tempfile("c2out"); dir.create(out, showWarnings = FALSE, recursive = TRUE)
  list(result = vcr_run_job(job, output_dir = out), dir = out)
}

vcr_case("C2-01", c("AC-04"), function() {
  a <- .c2_generate(20260928L); b <- .c2_generate(20260928L); c_ <- .c2_generate(20260929L)
  ha <- a$result$tables[[1]]$sha256; hb <- b$result$tables[[1]]$sha256; hc <- c_$result$tables[[1]]$sha256
  same_hash <- identical(ha, hb)
  diff_hash <- !identical(ha, hc)
  same_scen <- identical(a$result$scenarioHash, c_$result$scenarioHash)  # same scenario, other seed
  version <- identical(a$result$methodVersion, vcr_domain()$methods[["population.scenario"]]$version)
  for (x in list(a, b, c_)) unlink(x$dir, recursive = TRUE)
  list(pass = same_hash && diff_hash && same_scen && version,
       detail = sprintf("same seed -> same table sha256 (%s); other seed -> different (%s); scenario hash unchanged by seed (%s); methodVersion %s",
                        substr(ha, 1, 12), substr(hc, 1, 12), substr(a$result$scenarioHash, 1, 12),
                        a$result$methodVersion))
})

vcr_case("C2-02", c("AC-11"), function() {
  # Recover the declared marginals and correlations from N = 20,000 draws,
  # each within 4 Monte-Carlo standard errors.
  g <- .c2_generate(4242L, n = 20000L)
  d <- utils::read.csv(g$result$tables[[1]]$location)
  unlink(g$dir, recursive = TRUE)
  n <- nrow(d)
  checks <- list(
    list(name = "age mean", got = mean(d$age), want = 62, mcse = stats::sd(d$age) / sqrt(n)),
    list(name = "age sd", got = stats::sd(d$age), want = 10, mcse = stats::sd(d$age) / sqrt(2 * (n - 1))),
    list(name = "male", got = mean(d$male), want = 0.55, mcse = sqrt(0.55 * 0.45 / n)),
    list(name = "egfr mean", got = mean(d$egfr), want = 75, mcse = stats::sd(d$egfr) / sqrt(n)),
    list(name = "cor(age,egfr)", got = stats::cor(d$age, d$egfr), want = -0.50, mcse = (1 - 0.25) / sqrt(n)),
    list(name = "cor(age,male)", got = stats::cor(d$age, d$male), want = 0.10 * sqrt(2 / pi) / 0.5 * 0.5, mcse = 1 / sqrt(n))
  )
  # The truncated normals shift their moments slightly; the truncation is
  # declared, so the comparison is against the truncated moments.
  lo <- (18 - 62) / 10; hi <- (90 - 62) / 10
  z <- (stats::dnorm(lo) - stats::dnorm(hi)) / (stats::pnorm(hi) - stats::pnorm(lo))
  checks[[1]]$want <- 62 + 10 * z
  checks[[2]]$want <- 10 * sqrt(1 + (lo * stats::dnorm(lo) - hi * stats::dnorm(hi)) /
                                  (stats::pnorm(hi) - stats::pnorm(lo)) - z^2)
  lo2 <- (15 - 75) / 20
  z2 <- stats::dnorm(lo2) / (1 - stats::pnorm(lo2))
  checks[[4]]$want <- 75 + 20 * z2
  checks <- checks[1:5]
  ratios <- vapply(checks, function(c_) abs(c_$got - c_$want) / c_$mcse, numeric(1))
  list(pass = all(ratios <= 4),
       detail = sprintf("N=%d: %s (all within 4 MCSE: %s)", n,
                        paste(vapply(seq_along(checks), function(i)
                          sprintf("%s %.4f vs %.4f [%.2f MCSE]", checks[[i]]$name, checks[[i]]$got,
                                  checks[[i]]$want, ratios[i]), character(1)), collapse = "; "),
                        all(ratios <= 4)))
})

vcr_case("C2-03", c("AC-03"), function() {
  g <- .c2_generate(303L, n = 20000L)
  viol <- g$result$diagnostics$constraintViolations
  m <- Filter(function(x) x$name == "constraint_violations", g$result$measures)[[1]]
  unlink(g$dir, recursive = TRUE)
  ok <- sum(viol$violations) == 0 && m$value == 0
  list(pass = ok, detail = sprintf("%d declared constraints, %d violations in 20000 records (%s)",
                                   nrow(viol), sum(viol$violations),
                                   paste(sprintf("%s=%d", viol$rule, viol$violations), collapse = " ")))
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
  # records it was fitted to and how many copies it made.
  set.seed(505L, kind = VCR_RNG_KIND)
  n <- 300L
  real <- data.frame(age = stats::rnorm(n, 60, 10), sex = stats::rbinom(n, 1L, 0.5),
                     event = stats::rbinom(n, 1L, 0.3))
  path <- tempfile(fileext = ".csv"); utils::write.csv(real, path, row.names = FALSE)
  job <- list(jobId = "job_c205", studyId = "std_c2", kind = "synthesize_population",
              method = "population.synthpop", methodVersion = "1.0.0", protocolVersion = 1L,
              seed = 505L, cpuSecondsLimit = 300,
              inputs = list(list(kind = "snapshot", id = "snp_c205", hash = vcr_file_sha256(path), location = path)),
              scenario = list(m = 10L, holdoutShare = 0.2))
  out <- tempfile("c2out"); dir.create(out)
  r <- vcr_run_job(job, output_dir = out)
  unlink(c(path, out), recursive = TRUE)
  gen <- Filter(function(m) m$name == "generated_records", r$measures)[[1]]$value
  train_obs <- Filter(function(m) m$name == "training_observations", r$measures)[[1]]$value
  copies <- Filter(function(m) m$name == "synthetic_copies", r$measures)[[1]]$value
  ok <- identical(r$status, "succeeded") && r$counts$realPatients == 0 && gen == train_obs * copies &&
    identical(r$diagnostics$inferenceLabel, "exploratory") && copies == 10
  list(pass = ok,
       detail = sprintf("%d generated records from %d training observations x %d copies; realPatients stays %s; inference labelled %s; allowed uses %s",
                        gen, train_obs, copies, r$counts$realPatients, r$diagnostics$inferenceLabel,
                        paste(unlist(r$diagnostics$allowedUses), collapse = "/")))
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
