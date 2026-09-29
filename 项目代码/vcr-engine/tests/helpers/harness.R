# ---------------------------------------------------------------------------
# harness.R — a one-line-per-case runner.
#
# Hidden knowledge: the output format is a contract with the release process,
# not a convenience. Every line is
#
#     <ID> PASS|FAIL <AC tags> | <the actual numbers>
#
# and the last line is `PASSED x/y`, because the acceptance table is built by
# grepping these lines. A case that prints "ok" without its numbers cannot be
# put in front of a reviewer and is therefore treated as a failure of the
# case, not of the code: `vcr_case()` requires a `detail` string.
#
# Cases are deliberately not testthat: the engine's container has no testthat,
# and a numeric acceptance case whose failure message is "expect_equal(...)
# is not TRUE" is worth less than one whose failure message is the two
# numbers and the tolerance.
# ---------------------------------------------------------------------------

.vcr_test_env <- new.env(parent = emptyenv())
.vcr_test_env$results <- list()
.vcr_test_env$only <- Sys.getenv("VCR_TEST_ONLY", "")

#' Register and run one case.
#'
#' @param id `N01`, `C2-03`, `E02` ... printed first so the line is greppable.
#' @param ac character vector of acceptance-scenario ids this case covers.
#' @param fn a function returning list(pass = <logical>, detail = "<numbers>").
vcr_case <- function(id, ac, fn) {
  if (nzchar(.vcr_test_env$only) && !grepl(.vcr_test_env$only, id)) return(invisible(NULL))
  started <- Sys.time()
  out <- tryCatch(fn(), error = function(e) list(pass = FALSE, detail = paste("error:", conditionMessage(e))))
  secs <- as.numeric(difftime(Sys.time(), started, units = "secs"))
  pass <- isTRUE(out$pass)
  detail <- out$detail %||% "(no detail)"
  line <- sprintf("%-6s %s %s | %s  [%.1fs]", id, if (pass) "PASS" else "FAIL",
                  paste(ac, collapse = ","), detail, secs)
  cat(line, "\n", sep = "")
  utils::flush.console()
  .vcr_test_env$results[[length(.vcr_test_env$results) + 1L]] <-
    list(id = id, ac = ac, pass = pass, detail = detail, seconds = secs)
  invisible(pass)
}

vcr_case_summary <- function() {
  r <- .vcr_test_env$results
  n <- length(r)
  k <- sum(vapply(r, function(x) isTRUE(x$pass), logical(1)))
  failed <- Filter(function(x) !isTRUE(x$pass), r)
  if (length(failed)) {
    cat("\nFAILED CASES\n")
    for (f in failed) cat(sprintf("  %s (%s): %s\n", f$id, paste(f$ac, collapse = ","), f$detail))
  }
  cat(sprintf("\nPASSED %d/%d\n", k, n))
  invisible(k == n)
}

#' Numeric comparison helpers that always report the numbers they compared.
vcr_near <- function(got, want, tol, scale = c("absolute", "relative")) {
  scale <- match.arg(scale)
  d <- abs(got - want)
  if (identical(scale, "relative")) d <- d / pmax(abs(want), .Machine$double.eps)
  list(pass = all(is.finite(d)) && max(d) <= tol, diff = max(d), tol = tol, scale = scale)
}

vcr_within_mcse <- function(got, want, mcse, multiple = 3) {
  d <- abs(got - want)
  list(pass = all(is.finite(d)) && all(d <= multiple * mcse), diff = max(d),
       mcse = mcse, multiple = multiple, ratio = max(d / mcse))
}

`%||%` <- function(a, b) if (is.null(a)) b else a
