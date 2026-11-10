# N94 — comparator.borrowing as a job (algorithm round C10-C12, 2026-11-03): the whole handler through the protocol, as the service runs it.
#
#   a  a power prior on a rate with the analysis: the measures it names, each calculated and none simulated (no Monte-Carlo error is claimed for
#      an exact number); the three rows (no borrowing, the prior, full borrowing) and the stated discount; the defaults it took are listed
#   b  a self-adapting prior with its operating characteristics: the table's rows carry exact measures, the table of conflict against borrowing,
#      and the worst type I error over the drifts is the largest of the rows
#   c  an elastic prior on a mean: the function's constants and the two percentiles are in the result, the defaults are listed as assumptions,
#      the result is the same on a second run, and a design at 2,000 patients an arm finishes in seconds
#   d  refusals are by name and keep the rest: a drift that puts a rate outside (0, 1), responders above patients, a delta no current sample
#      can see; a job the schema refuses never reaches the handler

.n94_run <- function(sc, seed = 9401L) vcr_test_run(vcr_test_job("comparator.borrowing", sc, seed = seed))
.n94_m <- function(r, name) vcr_measure_value(r, name)

vcr_case("N94a", c("AC-30"), function() {
  r <- .n94_run(list(endpoint = list(type = "binary"), historical = list(responders = 90, n = 300), current = list(responders = 40, n = 150),
                     treatment = list(responders = 100, n = 300), prior = list(kind = "power", a0 = 0.3)))
  b <- r$diagnostics$borrowing; rows <- b$posterior$rows
  sim <- any(vapply(r$measures, function(m) isTRUE(m$simulated), logical(1)))
  names_ <- vapply(r$measures, function(m) m$name, character(1))
  want <- c("borrowing_weight", "borrowed_sample_size", "control_posterior_mean", "probability_treatment_better")
  assumed <- vapply(b$assumed, function(a) a$key, character(1))
  list(pass = identical(r$status, "succeeded") && identical(r$conclusion, "estimable") && !length(vcr_test_issue_codes(r)) && !sim && all(want %in% names_) &&
         abs(.n94_m(r, "borrowing_weight") - 0.3) < 1e-12 && abs(.n94_m(r, "borrowed_sample_size") - 0.3 * 300) < 1e-9 &&
         identical(vapply(rows, function(x) x$label, character(1)), c("none", "chosen", "full")) && all(c("analysis.alpha", "prior.vague", "treatment.prior") %in% assumed),
       detail = sprintf("power prior a0 = 0.3 on 90/300 historical, 40/150 now, 100/300 treated: status %s, weight %.2f, borrowed sample size %.1f (= 0.3 x 300), control posterior mean %.4f (none %.4f, full %.4f), Pr(treatment better) %.4f (none %.4f, full %.4f); no measure is simulated; the defaults taken are listed: %s",
                        r$status, .n94_m(r, "borrowing_weight"), .n94_m(r, "borrowed_sample_size"), rows[[2]]$mean$value, rows[[1]]$mean$value, rows[[3]]$mean$value,
                        rows[[2]]$probabilityBetter$value, rows[[1]]$probabilityBetter$value, rows[[3]]$probabilityBetter$value, paste(assumed, collapse = ", ")))
})

vcr_case("N94b", c("AC-30"), function() {
  r <- .n94_run(list(endpoint = list(type = "binary"), historical = list(responders = 90, n = 300), prior = list(kind = "sam", delta = 0.1),
                     operatingCharacteristics = list(nControl = 150, nTreatment = 300, drifts = list(-0.1, 0, 0.1), effect = 0.1), analysis = list(alpha = 0.025)))
  b <- r$diagnostics$borrowing; oc <- b$operatingCharacteristics$rows
  worst_rows <- max(vapply(oc, function(x) x$chosen$typeOneError$value, numeric(1)))
  conflict <- b$conflict$rows; cw <- vapply(conflict, function(x) x$weight$value, numeric(1)); cd <- vapply(conflict, function(x) x$difference, numeric(1))
  zero <- which(abs(cd) < 1e-12)
  list(pass = identical(r$status, "succeeded") && abs(.n94_m(r, "type_one_error_worst") - worst_rows) < 1e-15 && length(oc) == 3L &&
         all(vapply(oc, function(x) !isTRUE(x$chosen$power$simulated) && identical(x$chosen$power$source, "calculated"), logical(1))) &&
         cw[zero] == max(cw) && length(conflict) == 7L && is.null(b$posterior) && is.null(b$prior),
       detail = sprintf("SAM prior, historical 90/300, delta 0.1, 150 control and 300 treated: type I error by drift %s with borrowing against %s without; worst %.4f; power at no drift %.4f; the discount at differences of -2 to 2 deltas: %s",
                        paste(sprintf("%.4f", vapply(oc, function(x) x$chosen$typeOneError$value, numeric(1))), collapse = ", "),
                        paste(sprintf("%.4f", vapply(oc, function(x) x$none$typeOneError$value, numeric(1))), collapse = ", "), worst_rows, .n94_m(r, "power"),
                        paste(sprintf("%.3f", cw), collapse = ", ")))
})

vcr_case("N94c", c("AC-30"), function() {
  sc <- list(endpoint = list(type = "continuous"), historical = list(mean = 10, sd = 4, n = 120), current = list(mean = 11, n = 60), prior = list(kind = "elastic", delta = 2),
             operatingCharacteristics = list(nControl = 60, nTreatment = 90, drifts = list(-2, 0, 2), effect = 1.5))
  r1 <- .n94_run(sc); r2 <- .n94_run(sc)
  b <- r1$diagnostics$borrowing; e <- b$elastic
  assumed <- vapply(b$assumed, function(a) a$key, character(1))
  big <- list(endpoint = list(type = "binary"), historical = list(responders = 600, n = 2000), prior = list(kind = "elastic", delta = 0.05),
              operatingCharacteristics = list(nControl = 2000, nTreatment = 2000, drifts = as.list(seq(-0.1, 0.1, length.out = 21)), effect = 0.05))
  t0 <- Sys.time(); rb <- .n94_run(big); secs <- as.numeric(difftime(Sys.time(), t0, units = "secs"))
  g_chk <- 1 / (1 + exp(e$a + e$b * log(e$tq0)))
  list(pass = identical(r1$status, "succeeded") && identical(vcr_output_hash(r1), vcr_output_hash(r2)) && abs(g_chk - 0.99) < 1e-12 && e[["function"]] == "logistic" &&
         all(c("prior.q0", "prior.q1", "prior.c1", "prior.c2", "prior.function") %in% assumed) && identical(rb$status, "succeeded") && secs < 30,
       detail = sprintf("elastic prior on a mean (10, sd 4, 120; 11 of 60 now; delta 2): weight %.4f, constants a %.3f and b %.3f from T_q0 %.3f and T_q1 %.3f (g(T_q0) = %.4f), the defaults listed as assumptions (%s); the same job twice gives the same output hash; a binary design at 2,000 patients an arm and 21 drifts: %s in %.1f s",
                        .n94_m(r1, "borrowing_weight"), e$a, e$b, e$tq0, e$tq1, g_chk, paste(setdiff(assumed, c("analysis.alpha", "treatment.prior", "historical.sd")), collapse = ", "), rb$status, secs))
})

vcr_case("N94d", c("AC-30"), function() {
  refused <- function(sc) { r <- .n94_run(sc); list(status = r$status, code = if (length(r$issues)) as.character(r$issues[[1L]]$code) else vcr_test_issue_codes(r)[1L]) }
  base <- list(endpoint = list(type = "binary"), historical = list(responders = 90, n = 300))
  drift <- refused(c(base, list(prior = list(kind = "power", a0 = 0.5), operatingCharacteristics = list(nControl = 100, nTreatment = 100, drifts = list(0.8), effect = 0.1))))
  over <- refused(c(base[1], list(historical = list(responders = 400, n = 300), current = list(responders = 40, n = 150), prior = list(kind = "power", a0 = 0.5))))
  tiny <- refused(c(base, list(current = list(responders = 5, n = 20), prior = list(kind = "elastic", delta = 0.02))))
  schema <- refused(c(base, list(prior = list(kind = "power", a0 = 0.5))))
  list(pass = all(c(drift$status, over$status, tiny$status, schema$status) == "failed") && all(c(drift$code, over$code, tiny$code) == "scenario_value_invalid") && identical(schema$code, "scenario_field_missing"),
       detail = sprintf("a drift that takes the control rate outside (0, 1): %s %s; more responders than patients: %s %s; a delta of 0.02 with 20 current patients: %s %s; neither the analysis nor the operating characteristics asked: %s %s",
                        drift$status, drift$code, over$status, over$code, tiny$status, tiny$code, schema$status, schema$code))
})
