# N65 — the rpact adapter (algorithm round G5, 2026-11-03).
#
# rpact is a runtime package: it cannot be the check of a method that runs on it. What this case holds is the adapter itself, against
# properties that are outside rpact:
#
#   a  rpact is called from R/rpact_adapter.R and from nowhere else in R/ (a grep, so that a later method cannot reach round it)
#   b  the caller's random number generator is the same after a call as before: its kind and its state, found or absent, and a
#      simulation does not depend on the generator the caller was using
#   c  the same job seed gives bit-identical results (output hash) on one core and on two, and a rerun
#   d  a simulation that is stopped keeps what it has: with a spent CPU budget the result is limited, says why, and reports the iterations
#      each scenario ran (a whole number of batches), never the planned count
#   e  rpact's own error text never reaches the person: a call that fails is the named refusal with the fixed sentence

.n65_job <- function(cores, seed = 6501L, extra = list()) vcr_test_job("design.confirmatory", vcr_test_conf_scenario(list(
  design = list(kind = "sample_size_reestimation", informationRates = c(0.5, 1), conditionalPower = 0.8, maxSampleSizeFactor = 1.5),
  endpoint = list(type = "continuous"), truth = list(plannedEffect = 0.4, effects = list(0.3), sd = 1))), seed = seed, cores = cores, extra = extra)

vcr_case("N65a", c("AC-10"), function() {
  files <- list.files(file.path(VCR_ROOT, "R"), pattern = "\\.R$", full.names = TRUE)
  uses <- vapply(files, function(f) {
    lines <- readLines(f, warn = FALSE)
    code <- lines[!grepl("^\\s*#", lines)]
    any(grepl("rpact::", code, fixed = TRUE)) || any(grepl("library\\(\\s*rpact|requireNamespace\\(\\s*[\"']rpact", code))
  }, logical(1))
  names(uses) <- basename(files)
  list(pass = identical(names(uses)[uses], "rpact_adapter.R"),
       detail = sprintf("files under R/ that call rpact (outside comments): %s", paste(names(uses)[uses], collapse = ", ")))
})

vcr_case("N65b", c("AC-31"), function() {
  # the caller's generator: kind L'Ecuyer, a state of its own; and a caller with no state at all
  set.seed(6502, kind = "L'Ecuyer-CMRG")
  before <- get(".Random.seed", envir = .GlobalEnv); kind_before <- RNGkind()
  design <- vcr_rpact_inverse_normal(c(0.5, 1), 0.025)
  sim <- function(take, seed, s) vcr_rpact_sim_reestimation("continuous", design, 0.3, c(60, 120), 240, 0.8, 0.5, take, seed, sd = 1)
  a <- vcr_rpact_batches(sim, 400L, 77L, batch = 200L)
  kept <- identical(get(".Random.seed", envir = .GlobalEnv), before) && identical(RNGkind(), kind_before)
  # the same trials whatever generator the caller was on
  set.seed(1, kind = "Mersenne-Twister"); b <- vcr_rpact_batches(sim, 400L, 77L, batch = 200L)
  set.seed(2, kind = "Wichmann-Hill"); c_ <- vcr_rpact_batches(sim, 400L, 77L, batch = 200L)
  independent <- identical(a$rows, b$rows) && identical(a$rows, c_$rows)
  # and no state at all: the adapter leaves none behind
  rm(".Random.seed", envir = .GlobalEnv)
  invisible(vcr_rpact_batches(sim, 200L, 77L, batch = 200L))
  clean <- !exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
  RNGkind("L'Ecuyer-CMRG"); set.seed(1)
  list(pass = kept && independent && clean, detail = sprintf("generator state and kind restored after a call: %s; same rows on L'Ecuyer, Mersenne-Twister and Wichmann-Hill callers: %s; no state created for a caller with none: %s; batches %d, iterations %d",
                                                          kept, independent, clean, a$batches, a$done[1]))
})

vcr_case("N65c", c("AC-31"), function() {
  one <- vcr_test_run(.n65_job(1L)); two <- vcr_test_run(.n65_job(2L)); again <- vcr_test_run(.n65_job(1L))
  other <- vcr_test_run(.n65_job(1L, seed = 6503L))
  same <- identical(one$manifest$outputHash, two$manifest$outputHash) && identical(one$manifest$outputHash, again$manifest$outputHash)
  list(pass = identical(one$status, "succeeded") && same && !identical(one$manifest$outputHash, other$manifest$outputHash),
       detail = sprintf("output hash 1 core %s.., 2 cores %s.., rerun %s.., another seed %s..; power %.4f vs %.4f",
                        substr(one$manifest$outputHash, 1, 10), substr(two$manifest$outputHash, 1, 10), substr(again$manifest$outputHash, 1, 10), substr(other$manifest$outputHash, 1, 10),
                        vcr_measure_value(one, "power"), vcr_measure_value(two, "power")))
})

vcr_case("N65d", c("AC-38"), function() {
  # a CPU budget of one second is spent inside the first batches of a multi-arm run (20,000 iterations of the null and 5,000 of each alternative)
  sc <- list(design = list(kind = "multi_arm_selection", informationRates = c(0.5, 1), activeArms = 3, plannedSize = 80), endpoint = list(type = "continuous"),
             truth = list(effectScenarios = list(list(0.2, 0.4, 0.6)), sd = 1))
  r <- vcr_test_run(vcr_test_job("design.confirmatory", vcr_test_conf_scenario(sc), seed = 6504L, extra = list(cpuSecondsLimit = 1L)))
  done <- unlist(r$diagnostics$confirmatory$iterations)
  planned <- c(20000L, 5000L)
  codes <- vcr_test_issue_codes(r)
  list(pass = identical(r$status, "failed") && identical(r$conclusion, "limited") && "cpu_budget_exhausted" %in% codes && length(r$measures) > 0L &&
         all(done < planned) && all(done %% 1000L == 0L) && length(r$diagnostics$confirmatory$effects) > 0L,
       detail = sprintf("status %s, conclusion %s, issues %s, %d measures kept; iterations per scenario %s of %s", r$status, r$conclusion, paste(codes, collapse = ","), length(r$measures),
                        paste(done, collapse = "/"), paste(planned, collapse = "/")))
})

vcr_case("N65e", c("AC-10"), function() {
  # an argument rpact rejects: a stage-one fraction its design cannot place (information rates that do not end at 1 are refused
  # by the validator first, so the adapter is called directly with a design rpact will not build)
  r <- tryCatch(vcr_rpact_design(c(0.5, 1), 0.025, 0.9, spending = "hwang_shih_decani", gamma = NULL), vcr_refusal = function(e) e$issue)
  fixed_text <- is.list(r) && identical(r$code, "design_not_computable") && identical(r$detail, "The design could not be computed with these settings.")
  list(pass = fixed_text, detail = sprintf("refusal %s: %s", if (is.list(r)) r$code else "none", if (is.list(r)) r$detail else "the call succeeded"))
})
