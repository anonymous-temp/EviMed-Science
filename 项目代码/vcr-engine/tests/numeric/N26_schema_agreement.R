# N26 — the engine and the domain read one contract.
#
# The domain's scenario schemas (`R/domain-snapshot.json`, generated from
# `@evimed/domain`) say which keys a scenario may carry, and the engine refuses
# the rest by path: an ignored key is a silent parameter change. The reverse
# drift is as bad: a handler that reads a key the schema does not list is a
# handler no job can ever reach. `tests/helpers/scenario-schema-additions.json`
# lists every key the handlers read that the domain's schemas did not list when
# the engine was repaired (44 of them; the domain has adopted all). This case
# looks every one up in the domain's schemas and fails, naming each that is
# missing or unreachable; it also asserts that it looked them all up, so an
# emptied list cannot pass it.

vcr_case("N26", c("AC-04", "AC-30"), function() {
  gaps <- .vcr_test_env$schema_gaps
  raw <- vcr_domain_raw()
  methods <- names(raw$scenarioSchemas)
  named <- vapply(gaps, function(g) sprintf("%s:%s%s", g$method, if (nzchar(g$path)) paste0(g$path, ".") else "", g$key), character(1))
  checked <- .vcr_test_env$schema_checked; found <- .vcr_test_env$schema_found
  list(pass = length(gaps) == 0L && checked >= 40L && found == checked && length(methods) == length(vcr_domain()$methods),
       detail = sprintf("%d scenario schemas for %d methods; %d of %d keys the handlers read found in the domain's schemas%s",
                        length(methods), length(vcr_domain()$methods), found, checked,
                        if (length(gaps)) paste0("; missing or unreachable: ", paste(named, collapse = ", ")) else ""))
})
