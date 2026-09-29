# E10 — malformed input, resource limits, and what a caller can rely on.
#
# The review's malformed-input battery found jobs that ended in R errors
# ("subscript out of bounds", "argument is of length zero") instead of a named
# refusal, and a service whose limits (cores, replicates, CPU) were promised in
# its docs and not enforced by the engine. These cases hold the contract: a job
# never raises, a refusal names its field, a result is protocol-valid whatever
# happened, and the resource ceilings are the ceilings.

# Every leaf of a scenario, as the path that reaches it.
.e10_paths <- function(x, path = list()) {
  if (!is.list(x) || !length(x)) return(list(path))
  out <- list()
  keys <- if (!is.null(names(x)) && all(nzchar(names(x)))) names(x) else seq_along(x)
  for (k in keys) out <- c(out, .e10_paths(x[[k]], c(path, list(k))))
  out
}

.e10_set <- function(x, path, value) {
  if (length(path) == 1L) { x[path[[1]]] <- list(value); return(x) }
  x[[path[[1]]]] <- .e10_set(x[[path[[1]]]], path[-1], value)
  x
}

.e10_drop <- function(x, path) {
  if (length(path) == 1L) {
    if (is.character(path[[1]])) x[[path[[1]]]] <- NULL
    return(x)
  }
  x[[path[[1]]]] <- .e10_drop(x[[path[[1]]]], path[-1])
  x
}

vcr_case("E10a", c("AC-04", "AC-26"), function() {
  # Every leaf of every method's valid scenario is broken in turn -- a string
  # where a number is, a negative number, an empty array, an object -- and every
  # object key is dropped. Whatever happens, the job comes back as a protocol-valid
  # result: never an uncaught error, never the engine's catch-all `handler_error`
  # (which means "an R error nobody anticipated"), and a refusal always names the
  # field and carries a code. A battery that refuses nothing would prove nothing,
  # so it must also show that most breakages ARE refused.
  jobs <- vcr_test_handler_jobs()
  junk <- list("junk", -1, list(), list(x = 1))
  dir <- tempfile("e10a"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  tally <- list(runs = 0L, raised = character(0), handler_error = character(0), invalid_result = character(0),
                unnamed = character(0), refused = 0L, succeeded = 0L, leaked = character(0))
  one <- function(label, job) {
    r <- tryCatch(vcr_test_run(job, output_dir = dir), error = function(e) e)
    tally$runs <<- tally$runs + 1L
    if (inherits(r, "error")) { tally$raised <<- c(tally$raised, sprintf("%s: %s", label, substr(conditionMessage(r), 1, 80))); return(invisible()) }
    codes <- vcr_test_issue_codes(r)
    if ("handler_error" %in% codes) tally$handler_error <<- c(tally$handler_error, label)
    if (length(vcr_validate_result(r))) tally$invalid_result <<- c(tally$invalid_result, label)
    if (identical(r$status, "failed")) {
      tally$refused <<- tally$refused + 1L
      iss <- c(r$diagnostics$issues %||% list())
      if (!length(iss) || !all(vapply(iss, function(i) is.character(i$code) && nzchar(i$code) && is.character(i$field) && nzchar(i$field), logical(1)))) {
        tally$unnamed <<- c(tally$unnamed, label)
      }
      txt <- paste(vapply(iss, function(i) paste(i$code, i$field, i$detail), character(1)), collapse = " ")
      if (grepl("/home/|/tmp/|Rscript|\\.R#|Error in ", txt)) tally$leaked <<- c(tally$leaked, label)
    } else tally$succeeded <<- tally$succeeded + 1L
    invisible()
  }
  for (k in seq_along(jobs)) {
    cs <- jobs[[k]]
    base <- vcr_test_job(cs[[1]], cs[[2]], cs[[3]], seed = 5L, replicates = if (length(cs) >= 4L) min(cs[[4]], 60L) else NULL)
    for (path in .e10_paths(cs[[2]])) {
      if (!length(path)) next
      lab <- sprintf("%s:%s", cs[[1]], paste(path, collapse = "."))
      for (j in seq_along(junk)) {
        job <- base; job$scenario <- .e10_set(job$scenario, path, junk[[j]])
        one(sprintf("%s=%d", lab, j), job)
      }
      if (is.character(path[[length(path)]])) { job <- base; job$scenario <- .e10_drop(job$scenario, path); one(paste0(lab, "=drop"), job) }
    }
  }
  # the job's own fields. Assigned, not merged: `modifyList` would treat an
  # emptied `inputs` or `scenario` as "no change". A refusal of a job whose
  # seed, method, version or replicate count is itself malformed cannot echo a
  # valid one, so protocol validity is asked only of the other mutations.
  cs <- jobs[[which(vapply(jobs, function(x) x[[1]] == "design.simulate", logical(1)))]]
  base <- vcr_test_job(cs[[1]], cs[[2]], cs[[3]], seed = 5L, replicates = 60L)
  echoed <- c("seed", "replicates", "methodVersion", "method", "jobId", "studyId")
  muts <- list(list("seed", "x"), list("seed", -1), list("seed", 1.5), list("replicates", "x"), list("replicates", 0), list("replicates", 1e12),
               list("cores", 0), list("cores", "x"), list("cpuSecondsLimit", -1), list("cpuSecondsLimit", "x"), list("methodVersion", 1),
               list("inputs", list()), list("inputs", "x"), list("inputs", list("x")), list("scenario", "x"), list("scenario", list()),
               list("method", "nope.nope"), list("kind", "nope"), list("jobId", "../x"), list("studyId", 5), list("unknownField", 1))
  job_level <- 0L; job_level_bad <- character(0)
  for (mut in muts) {
    job <- base; job[[mut[[1]]]] <- mut[[2]]
    r <- tryCatch(vcr_test_run(job, output_dir = dir), error = function(e) e)
    job_level <- job_level + 1L
    lab <- paste("job", mut[[1]], format(mut[[2]]))
    if (inherits(r, "error")) { job_level_bad <- c(job_level_bad, paste("raised", lab)); next }
    codes <- vcr_test_issue_codes(r)
    if (!(r$status %in% c("failed", "succeeded")) || "handler_error" %in% codes) job_level_bad <- c(job_level_bad, lab)
    if (identical(r$status, "failed") && !length(codes)) job_level_bad <- c(job_level_bad, paste("no code", lab))
    if (!(mut[[1]] %in% echoed) && length(vcr_validate_result(r))) job_level_bad <- c(job_level_bad, paste("invalid result", lab))
  }
  # things that are not jobs at all
  for (junk_job in list(NULL, "x", 1, list(), list(1, 2), list(jobId = 5))) {
    r <- tryCatch(vcr_run_job(junk_job), error = function(e) e)
    job_level <- job_level + 1L
    if (inherits(r, "error") || !identical(r$status, "failed") || !length(vcr_test_issue_codes(r)) || "handler_error" %in% vcr_test_issue_codes(r)) {
      job_level_bad <- c(job_level_bad, paste("non-job", deparse(junk_job)[1]))
    }
  }
  tally$raised <- c(tally$raised, job_level_bad); tally$runs <- tally$runs + job_level
  bad <- c(tally$raised, tally$handler_error, tally$invalid_result, tally$unnamed, tally$leaked)
  list(pass = tally$runs > 1000L && length(bad) == 0L && tally$refused > 0.7 * tally$runs && tally$succeeded > 0L,
       detail = sprintf("%d broken jobs over %d methods: %d refused by name, %d still valid (an optional field emptied); uncaught errors %d, handler_error %d, protocol-invalid results %d, refusals without a code+field %d, R internals in a message %d%s",
                        tally$runs, length(jobs), tally$refused, tally$succeeded, length(tally$raised), length(tally$handler_error), length(tally$invalid_result),
                        length(tally$unnamed), length(tally$leaked),
                        if (length(bad)) paste0(" -- e.g. ", paste(utils::head(bad, 6), collapse = " | ")) else ""))
})

.e10_with_env <- function(vars, code) {
  old <- Sys.getenv(names(vars), unset = NA_character_, names = TRUE)
  for (k in names(vars)) if (is.na(vars[[k]])) Sys.unsetenv(k) else do.call(Sys.setenv, stats::setNames(list(vars[[k]]), k))
  on.exit(for (k in names(old)) if (is.na(old[[k]])) Sys.unsetenv(k) else do.call(Sys.setenv, stats::setNames(list(old[[k]]), k)), add = TRUE)
  force(code)
}

vcr_case("E10b", c("AC-28", "AC-04"), function() {
  # The resource ceilings are the ceilings. (1) A job's `cores` can only LOWER the
  # container's `VCR_ENGINE_CORES` (the service documents "R applies min()"; R
  # used the job's number over the environment's, so a job asking for 64 cores
  # on a 2-core allowance took 64). (2) `VCR_ENGINE_MAX_REPLICATES` refuses a job
  # that asks for more, and a run its precision floor exceeds is capped, reported
  # `limited`, and gives the same numbers on one core or two. (3) The CPU budget
  # is 0.9 of the smaller of the job's limit and `VCR_ENGINE_CPU_LIMIT`: a job
  # that would run for minutes stops in seconds and returns the measures of the
  # replicates that finished, with the code that says why. (4) A cancel request
  # stops the simulation, the bootstrap, the accrual forecast and the synthetic
  # copies alike, and nothing is invented for the part that did not run.
  phys <- suppressWarnings(parallel::detectCores(logical = FALSE)); if (!is.finite(phys) || phys < 1L) phys <- 1L
  cores <- .e10_with_env(c(VCR_ENGINE_CORES = "2"), c(none = vcr_cores(NULL), one = vcr_cores(1), big = vcr_cores(64), two = vcr_cores(2)))
  cores_free <- .e10_with_env(c(VCR_ENGINE_CORES = NA_character_), c(none = vcr_cores(NULL), three = vcr_cores(3), junk = vcr_cores("x"), zero = vcr_cores(0)))
  ok_cores <- cores[["none"]] == min(2L, phys) && cores[["one"]] == 1L && cores[["big"]] == min(2L, phys) && cores[["two"]] == min(2L, phys) &&
    cores_free[["none"]] == 1L && cores_free[["three"]] == min(3L, phys) && cores_free[["junk"]] == 1L && cores_free[["zero"]] == 1L

  sc <- list(design = list(kind = "two_arm_fixed", nTreat = 50, nControl = 50), endpoint = list(type = "continuous"), truth = list(effect = 0.4, sd = 1),
             analysis = list(method = "ttest", alpha = 0.025, sided = 1), performance = list("power"))
  cap <- .e10_with_env(c(VCR_ENGINE_MAX_REPLICATES = "600", VCR_ENGINE_CORES = "2"), {
    over <- vcr_test_run(vcr_test_job("design.simulate", sc, seed = 7L, replicates = 1000L))
    a <- vcr_test_run(vcr_test_job("design.simulate", sc, seed = 7L, replicates = 300L, cores = 1L))
    b <- vcr_test_run(vcr_test_job("design.simulate", sc, seed = 7L, replicates = 300L, cores = 2L))
    list(over = over, a = a, b = b)
  })
  ok_cap <- identical(cap$over$status, "failed") && "replicates_invalid" %in% vcr_test_issue_codes(cap$over) &&
    identical(cap$a$status, "succeeded") && cap$a$diagnostics$replicatesCompleted == 600L && isTRUE(cap$a$diagnostics$replicatesCapped) &&
    identical(cap$a$conclusion, "limited") && identical(vcr_measure_value(cap$a, "power"), vcr_measure_value(cap$b, "power")) &&
    cap$a$manifest$cores == 1L && cap$b$manifest$cores == min(2L, phys)

  budget_job <- function(limit) { j <- vcr_test_job("design.simulate", sc, seed = 7L, replicates = 150000L); j$cpuSecondsLimit <- limit; j }
  t0 <- proc.time()[["elapsed"]]
  b_job <- vcr_test_run(budget_job(3))
  t_job <- proc.time()[["elapsed"]] - t0
  done_job <- b_job$diagnostics$replicatesCompleted
  ok_budget <- identical(b_job$status, "failed") && "cpu_budget_exhausted" %in% vcr_test_issue_codes(b_job) && length(vcr_validate_result(b_job)) == 0L &&
    !is.null(vcr_get_measure(b_job, "power")) && done_job >= 500L && done_job < 150000L && t_job < 3 * 0.9 + 3 && b_job$manifest$cpuSeconds > 1.5
  # The environment's ceiling counts the process's whole CPU life (it mirrors the
  # kernel limit the service sets on the child), the job's own limit counts from
  # the job's start, and the budget is 0.9 of the smaller.
  burn <- function(seconds) { t <- proc.time()[["user.self"]]; while (proc.time()[["user.self"]] - t < seconds) NULL }
  ctx <- .e10_with_env(c(VCR_ENGINE_CPU_LIMIT = NA_character_), {
    vcr_ctx_begin(NULL, 1); early <- vcr_interrupt(); burn(1.05); late <- vcr_interrupt(); vcr_ctx_end(); after <- vcr_interrupt()
    vcr_ctx_begin(NULL, 3600); free <- vcr_interrupt(); vcr_ctx_end()
    list(early = early, late = late, after = after, free = free)
  })
  env_first <- .e10_with_env(c(VCR_ENGINE_CPU_LIMIT = "1"), { vcr_ctx_begin(NULL, 3600); r <- vcr_interrupt(); vcr_ctx_end(); r })
  env_roomy <- .e10_with_env(c(VCR_ENGINE_CPU_LIMIT = "100000"), { vcr_ctx_begin(NULL, 3600); r <- vcr_interrupt(); vcr_ctx_end(); r })
  ok_ctx <- is.null(ctx$early) && identical(ctx$late, "cpu_budget") && is.null(ctx$after) && is.null(ctx$free) &&
    identical(env_first, "cpu_budget") && is.null(env_roomy)

  cf <- tempfile("cancel"); file.create(cf); on.exit(unlink(cf), add = TRUE)
  run_c <- function(method, scenario, inputs = NULL, replicates = NULL) vcr_run_job(vcr_test_json(vcr_test_job(method, scenario, inputs, seed = 3L, replicates = replicates)), cancel_file = cf)
  jobs <- vcr_test_handler_jobs()
  pick <- function(m) jobs[[which(vapply(jobs, function(x) x[[1]] == m, logical(1)))]]
  staggered <- pick("accrual.poisson_gamma")
  staggered[[2]]$sites <- lapply(seq_along(staggered[[2]]$sites), function(i) { x <- staggered[[2]]$sites[[i]]; x$startTime <- 2 * (i - 1); x })
  canceled <- lapply(c("design.simulate", "comparator.entropy_balance", "accrual.poisson_gamma", "population.synthpop"), function(m) {
    cs <- if (m == "accrual.poisson_gamma") staggered else pick(m); r <- run_c(cs[[1]], cs[[2]], cs[[3]], if (length(cs) >= 4L) cs[[4]] else NULL)
    list(method = m, status = r$status, measures = length(r$measures), valid = length(vcr_validate_result(r)) == 0L, codes = vcr_test_issue_codes(r))
  })
  ok_cancel <- all(vapply(canceled, function(x) identical(x$status, "canceled") && x$valid && !length(x$codes), logical(1))) &&
    all(vapply(canceled[-1], function(x) x$measures == 0L, logical(1)))
  # ... and without the request the same accrual job runs to a forecast
  free_run <- vcr_run_job(vcr_test_json(vcr_test_job("accrual.poisson_gamma", staggered[[2]], staggered[[3]], seed = 3L, replicates = staggered[[4]])))
  ok_cancel <- ok_cancel && identical(free_run$status, "succeeded") && length(free_run$measures) > 0L
  list(pass = ok_cores && ok_cap && ok_budget && ok_ctx && ok_cancel,
       detail = sprintf("cores with a 2-core ceiling: request none/1/64/2 -> %s (machine %d); no ceiling: none/3/'x'/0 -> %s; replicate ceiling 600: 1000 requested -> %s, 300 requested -> %d run (floor 5000), conclusion %s, power identical on 1 and 2 cores (%.4f); CPU budget 0.9 x 3 s -> stopped after %d of 150000 replicates in %.1f s (cpu %.2f s) with %s and a partial power; context: job limit 1 s -> %s before, %s after 1.05 s of work, %s once ended; environment limit 1 s over job limit 3600 s -> %s, roomy environment -> %s; cancel request -> %s",
                        paste(cores, collapse = "/"), phys, paste(cores_free, collapse = "/"), paste(vcr_test_issue_codes(cap$over), collapse = ","),
                        cap$a$diagnostics$replicatesCompleted, cap$a$conclusion, vcr_measure_value(cap$a, "power"),
                        done_job, t_job, b_job$manifest$cpuSeconds, paste(vcr_test_issue_codes(b_job), collapse = ","),
                        ctx$early %||% "go on", ctx$late %||% "go on", ctx$after %||% "go on", env_first %||% "go on", env_roomy %||% "go on",
                        paste(vapply(canceled, function(x) sprintf("%s=%s", x$method, x$status), character(1)), collapse = ", ")))
})

vcr_case("E10c", c("AC-31", "AC-11"), function() {
  # Common random numbers, through the jobs a scenario comparison actually runs
  # (plan 5.2: the same virtual patient under two scenarios). Same seed, two
  # scenarios, read back from the output tables: (1) binary, control rate 0.45 vs
  # 0.55 -- nobody who was a case stops being one, and about a tenth of the
  # subjects (those whose uniform lies between the rates) change; (2) continuous,
  # effect 0.2 vs 0.7 -- the outcomes differ by exactly 0.5 for treated subjects and
  # by zero for controls; (3) time to event, hazard ratio 0.7 vs 0.5 -- every
  # control row is bit-for-bit the same and so is every entry time; (4) the same
  # with dropout switched on: nobody's entry time or event time moves.
  dir <- tempfile("e10c"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  n <- 20000L
  gen <- function(method, sc, tag) { r <- vcr_test_run(vcr_test_job(method, sc, seed = 1010L, job_id = paste0("job_e10c_", tag)), output_dir = dir); stopifnot(identical(r$status, "succeeded")); vcr_test_table(r, "virtual-patients", dir) }
  d <- list(nTreat = n / 2, nControl = n / 2)
  b1 <- gen("patients.binary", list(design = d, endpoint = list(type = "binary"), truth = list(controlRate = 0.45, treatmentRate = 0.45)), "b1")
  b2 <- gen("patients.binary", list(design = d, endpoint = list(type = "binary"), truth = list(controlRate = 0.55, treatmentRate = 0.55)), "b2")
  c1 <- gen("patients.continuous", list(design = d, endpoint = list(type = "continuous"), truth = list(effect = 0.2, sd = 1)), "c1")
  c2 <- gen("patients.continuous", list(design = d, endpoint = list(type = "continuous"), truth = list(effect = 0.7, sd = 1)), "c2")
  acc <- list(kind = "uniform", duration = 12, followup = 18)
  t1 <- gen("patients.time_to_event", list(design = list(nTreat = 500, nControl = 500), endpoint = list(type = "time_to_event"), truth = list(controlMedian = 12, hazardRatio = 0.7), accrual = acc), "t1")
  t2 <- gen("patients.time_to_event", list(design = list(nTreat = 500, nControl = 500), endpoint = list(type = "time_to_event"), truth = list(controlMedian = 12, hazardRatio = 0.5), accrual = acc), "t2")
  t3 <- gen("patients.time_to_event", list(design = list(nTreat = 500, nControl = 500), endpoint = list(type = "time_to_event"), truth = list(controlMedian = 12, hazardRatio = 0.7),
                                           accrual = c(acc, list(dropoutAnnual = 0.15))), "t3")
  up <- sum(b2$y > b1$y); down <- sum(b2$y < b1$y)
  ok_bin <- down == 0L && abs(up / n - 0.10) < 3 * sqrt(0.10 * 0.90 / n) && identical(b1$arm, b2$arm)
  ok_con <- max(abs((c2$y - c1$y) - 0.5 * c1$arm)) < 1e-9
  key <- c("arm", "entry", "time", "status")
  ctrl <- function(x) x[x$arm == 0L, key]
  ok_tte_hr <- identical(t1$entry, t2$entry) && isTRUE(all.equal(ctrl(t1), ctrl(t2), tolerance = 1e-9)) && !isTRUE(all.equal(t1$time[t1$arm == 1L], t2$time[t2$arm == 1L]))
  ok_tte_drop <- identical(t1$entry, t3$entry) && all(t3$time <= t1$time + 1e-9) && all(t3$status <= t1$status) && any(t3$time < t1$time - 1e-9) &&
    all(t3$status[t3$time >= t1$time - 1e-9] == t1$status[t3$time >= t1$time - 1e-9])
  list(pass = ok_bin && ok_con && ok_tte_hr && ok_tte_drop,
       detail = sprintf("binary 0.45 -> 0.55: %d subjects become cases (%.4f of %d, expected 0.10), %d stop being cases; continuous 0.2 -> 0.7: outcomes differ by delta x arm to %.0e; time to event HR 0.7 -> 0.5: entry times and all %d control rows identical, treated times differ; dropout on: entry identical, %d subjects observed earlier, none later",
                        up, up / n, n, down, max(abs((c2$y - c1$y) - 0.5 * c1$arm)), sum(t1$arm == 0L), sum(t3$time < t1$time - 1e-9)))
})

vcr_case("E10d", c("AC-04"), function() {
  # Every issue code the engine can raise is one somebody has a message for. A
  # literal code in any R source file must be in the protocol's registry (the
  # domain's VCR_PROTOCOL_ISSUE_CODES) or in the engine's own closed list
  # (VCR_ENGINE_OWN_ISSUE_CODES); a misspelt code is a refusal nobody can render.
  # The walk proves it walked (files, literals counted).
  files <- list.files(file.path(VCR_ROOT, "R"), pattern = "\\.R$", full.names = TRUE)
  lines <- unlist(lapply(files, function(f) { l <- readLines(f, warn = FALSE); l[!grepl("^\\s*#", l)] }))
  hits <- unlist(regmatches(lines, gregexpr("(vcr_abort|vcr_issue|vcr_abort_issue|raise|bad)\\(\"[a-z_]+\"", lines)))
  literals <- sort(unique(sub("^.*\\(\"", "", sub("\"$", "", hits))))
  own <- VCR_ENGINE_OWN_ISSUE_CODES
  path <- file.path(VCR_ROOT, "..", "..", "OpenScience", "packages", "domain", "src", "errorCodes.mjs")
  well_formed <- all(grepl("^[a-z][a-z_]+$", own)) && !anyDuplicated(own)
  if (!file.exists(path)) {
    return(list(pass = well_formed && length(literals) > 60L && all(own %in% literals),
                detail = sprintf("%d literal codes in %d files; the engine's own list has %d well-formed entries, each raised somewhere; the domain source tree is not present, so the protocol registry was not consulted", length(literals), length(files), length(own))))
  }
  src <- paste(readLines(path, warn = FALSE), collapse = "\n")
  i <- regexpr("VCR_PROTOCOL_ISSUE_CODES", src, fixed = TRUE)
  blk <- substr(src, i, i + regexpr("\\]\\)", substr(src, i, nchar(src))) - 1L)
  registry <- unique(unlist(regmatches(blk, gregexpr("'[a-z_]+'", blk)))); registry <- gsub("'", "", registry)
  unknown <- setdiff(literals, c(registry, own))
  unused <- setdiff(own, literals)
  overlap <- intersect(own, registry)
  list(pass = well_formed && length(registry) > 50L && length(literals) > 60L && !length(unknown) && !length(unused) && !length(overlap),
       detail = sprintf("%d literal codes in %d R files: %d in the protocol registry (%d codes), %d in the engine's own list (%d entries); in neither: %s; own entries never raised: %s; in both lists: %s",
                        length(literals), length(files), sum(literals %in% registry), length(registry), sum(literals %in% own), length(own),
                        if (length(unknown)) paste(unknown, collapse = ",") else "none", if (length(unused)) paste(unused, collapse = ",") else "none",
                        if (length(overlap)) paste(overlap, collapse = ",") else "none"))
})
