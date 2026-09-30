# Z99 — the suite must have walked every method.
#
# A test that scans "every handler" and silently scans none is worse than no
# test, so this last case reads what actually went through `vcr_run_job` while
# the other cases ran (the wrapper in tests/run_all.R records it) and fails if
# any declared method was never run, or if fewer than the declared methods ran.

vcr_case("Z99", c("AC-04", "AC-30"), function() {
  if (nzchar(.vcr_test_env$only)) {
    return(list(pass = TRUE, detail = sprintf("filtered run ('%s'): the coverage rule applies to a full run only", .vcr_test_env$only)))
  }
  ran <- vcr_test_methods_run()
  declared <- names(vcr_domain()$methods)
  missing <- setdiff(declared, ran)
  # A method that only the structural cases touch (E05 asks that a job of every
  # method answers with a valid result, E10 breaks them) has no number that could
  # be wrong: every method is also run by at least one case that asserts one.
  structural <- c("E05", "E10a", "E10b")
  by_case <- vcr_test_methods_by_case()
  numeric_run <- unique(unlist(by_case[setdiff(names(by_case), structural)]))
  only_structural <- setdiff(declared, numeric_run)
  list(pass = length(ran) >= 24L && length(missing) == 0L && length(only_structural) == 0L && length(declared) == 24L,
       detail = sprintf("%d/%d declared methods went through vcr_run_job in this run, %d/%d in a case that asserts numbers%s%s",
                        length(intersect(declared, ran)), length(declared), length(intersect(declared, numeric_run)), length(declared),
                        if (length(missing)) paste0("; never run: ", paste(missing, collapse = ", ")) else "",
                        if (length(only_structural)) paste0("; run only by structural cases: ", paste(only_structural, collapse = ", ")) else ""))
})
