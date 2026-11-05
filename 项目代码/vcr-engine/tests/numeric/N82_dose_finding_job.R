# N82 — the dose-finding job (algorithm round T7, 2026-11-03): design.dose, simulated designs on one toxicity curve.
#
# N81 holds the rules to the packages; this case holds the job that runs them:
#
#   a  the numbers of one design add up: the selection probabilities and "no dose" sum to one, the patients per dose sum to the size, the
#      correct selection is the selection of the dose closest to the target, patients below, at and above that dose sum to the size
#   b  asking about more designs never changes the numbers of the design asked about (the same curve, the same random numbers), and the
#      paired difference is the difference of the two designs' means with an error smaller than the two errors combined
#   c  the same seed gives a bit-identical result on one core and on two and on a rerun; another seed does not
#   d  a spent CPU budget keeps the batches that finished: limited, the named issue, a whole number of batches of trials, the measures
#   e  what a default is: a target, cohort, size, starting dose, skeleton the scenario did not state is listed with its value as an
#      assumption, and a stated one is not; the premises name BOIN's local, non-informative form; nothing in the result says that any
#      design is qualified, endorsed or accepted by anyone
#   f  the true MTD is the dose closest to the target, the lower one on a tie
#   g  speed: the four designs at the default 10,000 trials on a six-dose curve finish well inside the default CPU budget

.n82_curve <- list(0.05, 0.1, 0.2, 0.3, 0.45, 0.6)
.n82_job <- function(design, truth = list(toxicity = .n82_curve), seed = 8201L, trials = 4000L, cores = 1L, extra = list()) {
  vcr_test_run(vcr_test_job("design.dose", list(design = design, truth = truth), seed = seed, replicates = trials, cores = cores, extra = extra))
}
.n82_cell <- function(r, i, name) r$diagnostics$doseFinding$designs[[i]]$cells[[name]]

vcr_case("N82a", c("AC-28", "AC-29"), function() {
  r <- .n82_job(list(kind = "boin", compare = list("three_plus_three", "keyboard", "crm"), maxPatients = 30))
  K <- 6L; mtd <- r$diagnostics$doseFinding$curve$mtd
  worst <- 0
  for (i in seq_along(r$diagnostics$doseFinding$designs)) {
    sel <- vapply(seq_len(K), function(j) .n82_cell(r, i, sprintf("select_dose_%d", j))$value, numeric(1))
    pats <- vapply(seq_len(K), function(j) .n82_cell(r, i, sprintf("patients_dose_%d", j))$value, numeric(1))
    size <- .n82_cell(r, i, "expected_sample_size")$value
    parts <- .n82_cell(r, i, "patients_below_mtd")$value + .n82_cell(r, i, "patients_at_mtd")$value + .n82_cell(r, i, "patients_above_mtd")$value
    sel_parts <- .n82_cell(r, i, "select_below_mtd_probability")$value + sel[mtd] + .n82_cell(r, i, "select_above_mtd_probability")$value
    worst <- max(worst, abs(sum(sel) + .n82_cell(r, i, "select_none_probability")$value - 1), abs(sum(pats) - size), abs(parts - size),
                 abs(sel[mtd] - .n82_cell(r, i, "correct_dose_probability")$value), abs(sel_parts + .n82_cell(r, i, "select_none_probability")$value - 1))
  }
  list(pass = identical(r$status, "succeeded") && worst < 1e-9 && mtd == 4L && length(r$diagnostics$doseFinding$designs) == 4L,
       detail = sprintf("4 designs on one curve (MTD = dose %d): selection + none = 1, patients per dose = the size, below + at + above = the size, correct = selection of the MTD; worst gap %.1e (tol 1e-9)", mtd, worst))
})

vcr_case("N82b", c("AC-31"), function() {
  alone <- .n82_job(list(kind = "boin", maxPatients = 30))
  with <- .n82_job(list(kind = "boin", compare = list("three_plus_three", "crm"), maxPatients = 30))
  names_ <- names(alone$diagnostics$doseFinding$designs[[1]]$cells)
  identical_cells <- all(vapply(names_, function(n) identical(.n82_cell(alone, 1L, n)$value, .n82_cell(with, 1L, n)$value), logical(1)))
  # the difference of the paired designs
  d <- with$diagnostics$doseFinding$differences[[1]]   # three_plus_three against boin
  want <- .n82_cell(with, 2L, "correct_dose_probability")$value - .n82_cell(with, 1L, "correct_dose_probability")$value
  got <- d$cells$correct_dose_probability
  combined <- sqrt(.n82_cell(with, 2L, "correct_dose_probability")$mcse^2 + .n82_cell(with, 1L, "correct_dose_probability")$mcse^2)
  list(pass = identical_cells && abs(got$value - want) < 1e-12 && got$mcse < combined && identical(d$kind, "three_plus_three") && identical(d$against, "boin"),
       detail = sprintf("%d cells of BOIN identical alone and with two comparisons; 3+3 minus BOIN in correct selection %.4f (= %.4f - %.4f), paired error %.4f against the %.4f the two errors give", length(names_), got$value,
                        .n82_cell(with, 2L, "correct_dose_probability")$value, .n82_cell(with, 1L, "correct_dose_probability")$value, got$mcse, combined))
})

vcr_case("N82c", c("AC-31"), function() {
  design <- list(kind = "boin", compare = list("three_plus_three", "keyboard", "crm"), maxPatients = 24)
  one <- .n82_job(design, cores = 1L); two <- .n82_job(design, cores = 2L); again <- .n82_job(design, cores = 1L); other <- .n82_job(design, seed = 8202L)
  same <- identical(one$manifest$outputHash, two$manifest$outputHash) && identical(one$manifest$outputHash, again$manifest$outputHash)
  list(pass = identical(one$status, "succeeded") && same && !identical(one$manifest$outputHash, other$manifest$outputHash),
       detail = sprintf("output hash 1 core %s.., 2 cores %s.., rerun %s.., another seed %s..", substr(one$manifest$outputHash, 1, 10), substr(two$manifest$outputHash, 1, 10),
                        substr(again$manifest$outputHash, 1, 10), substr(other$manifest$outputHash, 1, 10)))
})

vcr_case("N82d", c("AC-38"), function() {
  r <- .n82_job(list(kind = "crm", compare = list("boin"), maxPatients = 30), trials = 200000L, extra = list(cpuSecondsLimit = 3L))
  done <- r$diagnostics$replicatesCompleted
  codes <- vcr_test_issue_codes(r)
  list(pass = identical(r$status, "failed") && identical(r$conclusion, "limited") && "cpu_budget_exhausted" %in% codes && length(r$measures) > 0L && done >= 1000L && done < 200000L && done %% 1000L == 0L &&
         identical(r$diagnostics$doseFinding$trials, done),
       detail = sprintf("status %s, conclusion %s, issues %s, %d measures kept; %d of 200000 trials ran (whole batches of 1000)", r$status, r$conclusion, paste(codes, collapse = ","), length(r$measures), as.integer(done)))
})

vcr_case("N82e", c("AC-10", "AC-18"), function() {
  bare <- .n82_job(list(kind = "crm", compare = list("boin", "keyboard", "three_plus_three")))
  keys <- vapply(bare$diagnostics$doseFinding$assumed, function(a) a$key, character(1))
  stated <- .n82_job(list(kind = "crm", compare = list("boin"), targetToxicity = 0.25, cohortSize = 2, maxPatients = 24, startDose = 2,
                          boin = list(safeRate = 0.15, toxicRate = 0.35), crm = list(skeleton = list(0.05, 0.1, 0.2, 0.3, 0.45, 0.6), priorVariance = 1.5, restrictEscalation = TRUE)))
  skeys <- vapply(stated$diagnostics$doseFinding$assumed, function(a) a$key, character(1))
  want_bare <- c("design.targetToxicity", "design.cohortSize", "design.maxPatients", "design.startDose", "design.boin.safeRate", "design.boin.toxicRate", "design.crm.skeleton", "design.crm.priorVariance", "design.keyboard.margin")
  never_stated <- c("design.targetToxicity", "design.cohortSize", "design.maxPatients", "design.startDose", "design.boin.safeRate", "design.crm.skeleton", "design.crm.priorVariance")
  text <- jsonlite::toJSON(bare, auto_unbox = TRUE, null = "null", digits = NA)
  method_rows <- vapply(bare$diagnostics$doseFinding$assumed, function(a) if (startsWith(a$key, "method.boin")) a$value else NA_character_, character(1))
  local_row <- any(grepl("local", method_rows, fixed = TRUE) & grepl("uniform prior", method_rows, fixed = TRUE))
  forbidden <- grepl("FDA|qualif|endors|approved|accepted|认定|批准|背书", text, ignore.case = TRUE)
  list(pass = all(want_bare %in% keys) && !any(never_stated %in% skeys) && local_row && !forbidden,
       detail = sprintf("defaults listed when the scenario leaves them out: %s; none of %d listed when it states them; BOIN's premise says local boundaries and a uniform prior: %s; qualified/endorsed/accepted wording anywhere in the result: %s",
                        paste(want_bare %in% keys, collapse = ""), length(never_stated), local_row, forbidden))
})

vcr_case("N82f", c("AC-29"), function() {
  tie <- .n82_job(list(kind = "boin", maxPatients = 12), truth = list(toxicity = list(0.2, 0.4)), trials = 1000L)
  top <- .n82_job(list(kind = "boin", maxPatients = 12), truth = list(toxicity = list(0.05, 0.1, 0.15)), trials = 1000L)
  list(pass = identical(tie$diagnostics$doseFinding$curve$mtd, 1L) && identical(top$diagnostics$doseFinding$curve$mtd, 3L),
       detail = sprintf("0.20 and 0.40 around a target of 0.30 are equally far: MTD = dose %d (the lower one); every dose below the target: MTD = dose %d (the highest)", as.integer(tie$diagnostics$doseFinding$curve$mtd), as.integer(top$diagnostics$doseFinding$curve$mtd)))
})

vcr_case("N82g", c("AC-37"), function() {
  started <- Sys.time()
  r <- vcr_test_run(vcr_test_job("design.dose", list(design = list(kind = "boin", compare = list("three_plus_three", "keyboard", "crm"), maxPatients = 30), truth = list(toxicity = .n82_curve)), seed = 8207L))
  secs <- as.numeric(difftime(Sys.time(), started, units = "secs"))
  list(pass = identical(r$status, "succeeded") && r$diagnostics$replicatesCompleted == 10000L && secs < 120,
       detail = sprintf("the default %d trials of BOIN, 3+3, the keyboard design and CRM on a six-dose curve: %.1f s (the default CPU budget is 600 s, the run stops at 540)", as.integer(r$diagnostics$replicatesCompleted), secs))
})

vcr_case("N82h", c("AC-28", "AC-29"), function() {
  # 3+3 honours the starting dose. Reference: a plain sequential simulator of the traditional rule written out for one trial at a time (three patients
  # per cohort, three more at 1/3, a dose with 2 or more of 3 or 6 too toxic, one dose down after it, the MTD is the highest dose with at most 1 of 6,
  # and a dose stepped down onto without a cohort of its own gets its six), started at dose 3 on the default curve. Mean patients at each dose and the
  # probability of selecting each dose are within 4 combined standard errors of it, through `boin` + compare and through `three_plus_three` alone.
  ptrue <- unlist(.n82_curve); K <- length(ptrue); start <- 3L
  one <- function() {
    N <- integer(K); Y <- integer(K); d <- start; down <- FALSE; sel <- 0L
    repeat {
      t <- sum(stats::runif(3L) < ptrue[d]); N[d] <- N[d] + 3L; Y[d] <- Y[d] + t
      n <- N[d]; y <- Y[d]
      if (y >= 2L) {
        if (d == 1L) { sel <- 0L; break }
        l <- d - 1L; down <- TRUE
        if (N[l] >= 6L) { sel <- l; break }
        d <- l
      } else if (n == 3L && (y == 1L || down)) { next }
      else if (down) { sel <- d; break }
      else if (d == K) { sel <- K; break }
      else d <- d + 1L
    }
    c(N, sel)
  }
  set.seed(8208L)
  M <- 20000L
  ref <- t(vapply(seq_len(M), function(i) one(), numeric(K + 1L)))
  ref_pat <- colMeans(ref[, 1:K]); ref_pat_se <- apply(ref[, 1:K], 2, stats::sd) / sqrt(M)
  ref_sel <- vapply(0:K, function(j) mean(ref[, K + 1L] == j), numeric(1))
  z_max <- 0; text <- character()
  for (case in list(list(kind = "boin", compare = list("three_plus_three")), list(kind = "three_plus_three", compare = NULL))) {
    r <- .n82_job(Filter(Negate(is.null), list(kind = case$kind, compare = case$compare, maxPatients = 30, startDose = start)), trials = M, seed = 8208L)
    idx <- which(vapply(r$diagnostics$doseFinding$designs, function(d) identical(d$kind, "three_plus_three"), logical(1)))
    pat <- vapply(seq_len(K), function(j) .n82_cell(r, idx, sprintf("patients_dose_%d", j))$value, numeric(1))
    pat_se <- vapply(seq_len(K), function(j) .n82_cell(r, idx, sprintf("patients_dose_%d", j))$mcse, numeric(1))
    sel <- vapply(seq_len(K), function(j) .n82_cell(r, idx, sprintf("select_dose_%d", j))$value, numeric(1))
    none <- .n82_cell(r, idx, "select_none_probability")$value
    z1 <- (pat - ref_pat) / sqrt(pat_se^2 + ref_pat_se^2 + 1e-12)
    es <- sqrt(c(none, sel) * (1 - c(none, sel)) / M + ref_sel * (1 - ref_sel) / M + 1e-12)
    z2 <- (c(none, sel) - ref_sel) / es
    z_max <- max(z_max, abs(z1), abs(z2))
    text <- c(text, sprintf("%s: patients at doses 1-2 %.2f/%.2f (reference %.2f/%.2f)", case$kind, pat[1], pat[2], ref_pat[1], ref_pat[2]))
  }
  list(pass = z_max < 4, detail = sprintf("start dose 3, %d trials: %s; largest difference %.2f combined standard errors (limit 4)", M, paste(text, collapse = "; "), z_max))
})

vcr_case("N82i", c("AC-07", "AC-28"), function() {
  # A toxicity curve that falls with dose, or a CRM skeleton that does not strictly rise, is refused with a reason: a dose-finding design on such a curve
  # selects a "correct" dose of 0.15% and still reports `estimable`. A plateau (equal neighbours) is a legitimate curve.
  code <- function(r) if (identical(r$status, "failed")) paste(vapply(r$diagnostics$issues %||% r$issues, function(x) paste0(x$code, "@", x$field), character(1)), collapse = ",") else r$status
  falling <- .n82_job(list(kind = "boin", compare = list("three_plus_three"), maxPatients = 30), truth = list(toxicity = list(0.3, 0.2, 0.1, 0.05, 0.02)), trials = 1000L)
  skel <- .n82_job(list(kind = "crm", maxPatients = 30, crm = list(skeleton = list(0.3, 0.2, 0.1, 0.05, 0.02))), truth = list(toxicity = list(0.02, 0.05, 0.1, 0.2, 0.3)), trials = 1000L)
  flat_skel <- .n82_job(list(kind = "crm", maxPatients = 30, crm = list(skeleton = list(0.05, 0.1, 0.1, 0.2, 0.3))), truth = list(toxicity = list(0.02, 0.05, 0.1, 0.2, 0.3)), trials = 1000L)
  plateau <- .n82_job(list(kind = "boin", maxPatients = 30), truth = list(toxicity = list(0.05, 0.1, 0.1, 0.3, 0.45)), trials = 1000L)
  refused <- function(r, field) identical(r$status, "failed") && grepl(paste0("scenario_value_invalid@", field), code(r), fixed = TRUE)
  list(pass = refused(falling, "scenario.truth.toxicity") && refused(skel, "scenario.design.crm.skeleton") && refused(flat_skel, "scenario.design.crm.skeleton") && identical(plateau$status, "succeeded"),
       detail = sprintf("falling curve: %s; falling skeleton: %s; skeleton with a tie: %s; a plateau in the curve: %s", code(falling), code(skel), code(flat_skel), code(plateau)))
})
