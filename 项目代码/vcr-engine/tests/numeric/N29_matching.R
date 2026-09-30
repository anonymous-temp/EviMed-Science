# N29 — eligibility matching: the Kleene truth table, through the job.

vcr_case("N29", c("AC-13", "AC-15", "AC-09"), function() {
  # Every verdict of the three-valued eligibility logic is asserted, not just that
  # the job ran. The bug this pins (CE-18): a criterion that does not APPLY to the
  # patient was set to "satisfied" for both kinds, so the pregnancy exclusion of a
  # man read as "this exclusion holds" and made him ineligible. An inclusion that
  # cannot apply cannot exclude (it is satisfied); an exclusion that cannot apply
  # is not triggered (it is not satisfied). "Unknown" blocks a positive verdict but
  # is never a negative one; a definite failure beats an unknown; a state that is
  # not in the vocabulary is refused by name, not read as unknown.
  crit <- function(id, kind, state, na = FALSE) { x <- list(id = id, kind = kind, type = if (kind == "exclusion") "pregnancy" else "diagnosis", state = state); if (na) x$notApplicable <- TRUE; x }
  df <- data.frame(USUBJID = "P001", stringsAsFactors = FALSE)
  in_t <- vcr_test_input(df, "snp_n29:subject", "subject")
  run <- function(criteria) vcr_test_run(vcr_test_job("matching.evaluate", list(criteria = criteria), list(in_t), job_id = "job_n29"))
  verdict <- function(criteria) { r <- run(criteria); if (identical(r$status, "succeeded")) r$diagnostics$eligibility else paste0("REFUSED:", paste(vcr_test_issue_codes(r), collapse = ",")) }
  cases <- list(
    list("all inclusions satisfied, a non-applicable exclusion (a man, pregnancy)", list(crit("i1", "inclusion", "satisfied"), crit("i2", "inclusion", "satisfied"), crit("e1", "exclusion", "unknown", na = TRUE)), "eligible"),
    list("the same, the exclusion applicable and not satisfied", list(crit("i1", "inclusion", "satisfied"), crit("e1", "exclusion", "not_satisfied")), "eligible"),
    list("an applicable exclusion that holds", list(crit("i1", "inclusion", "satisfied"), crit("e1", "exclusion", "satisfied")), "ineligible"),
    list("a non-applicable inclusion cannot exclude", list(crit("i1", "inclusion", "not_satisfied", na = TRUE), crit("i2", "inclusion", "satisfied")), "eligible"),
    list("an inclusion not satisfied", list(crit("i1", "inclusion", "not_satisfied"), crit("i2", "inclusion", "satisfied")), "ineligible"),
    list("an unknown inclusion blocks a positive verdict", list(crit("i1", "inclusion", "satisfied"), crit("i2", "inclusion", "unknown")), "insufficient_evidence"),
    list("an unknown applicable exclusion blocks it too", list(crit("i1", "inclusion", "satisfied"), crit("e1", "exclusion", "unknown")), "insufficient_evidence"),
    list("a definite failure beats an unknown", list(crit("i1", "inclusion", "not_satisfied"), crit("i2", "inclusion", "unknown")), "ineligible"),
    list("a pending re-check after everything else holds", list(crit("i1", "inclusion", "satisfied"), crit("i2", "inclusion", "pending_recheck")), "pending"),
    list("a single criterion", list(crit("i1", "inclusion", "satisfied")), "eligible"),
    list("a state outside the vocabulary (a typo) is refused", list(crit("i1", "inclusion", "satisified")), "REFUSED:scenario_value_invalid"))
  got <- vapply(cases, function(cs) verdict(cs[[2]]), character(1))
  want <- vapply(cases, function(cs) cs[[3]], character(1))
  r0 <- run(cases[[1]][[2]])
  tb_ok <- identical(r0$diagnostics$criteria$effectiveState, c("satisfied", "satisfied", "not_satisfied")) &&
    vcr_measure_value(r0, "criteria_total") == 3 && vcr_measure_value(r0, "criteria_unknown") == 1 && vcr_measure_value(r0, "criteria_not_satisfied") == 0
  list(pass = identical(got, want) && tb_ok,
       detail = sprintf("%d/%d verdicts as the truth table says (%s); the non-applicable exclusion's effective state is 'not_satisfied' and the counts are total 3 / unknown 1 / not satisfied 0",
                        sum(got == want), length(cases), paste(ifelse(got == want, "ok", paste0("WRONG:", got)), collapse = " ")))
})
