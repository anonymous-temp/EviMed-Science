# N00 — the engine's protocol mirror agrees with @evimed/domain.
#
# This is the case that makes every other case meaningful: the numbers below
# are only the right numbers if the engine is answering the job the control
# plane thinks it queued.

vcr_case("N00a", c("AC-04"), function() {
  # The generated snapshot must still equal what the live domain exports.
  gen <- file.path(VCR_ROOT, "tests", "helpers", "emit-domain-snapshot.mjs")
  if (!nzchar(Sys.which("node"))) {
    return(list(pass = TRUE, detail = "skipped: node not on PATH (container build has no Node by design)"))
  }
  tmp <- tempfile(fileext = ".json")
  system2("node", c(shQuote(gen), shQuote(tmp)), stdout = NULL, stderr = NULL)
  same <- identical(readLines(tmp, warn = FALSE), readLines(file.path(VCR_ROOT, "R", "domain-snapshot.json"), warn = FALSE))
  unlink(tmp)
  list(pass = same, detail = sprintf("R/domain-snapshot.json %s the live @evimed/domain exports",
                                     if (same) "equals" else "DIFFERS FROM"))
})

vcr_case("N00b", c("AC-04", "AC-30"), function() {
  # Every declared method has a handler and no handler is undeclared.
  issues <- vcr_engine_self_check()
  d <- vcr_domain()
  list(pass = length(issues) == 0L,
       detail = sprintf("%d/%d domain methods implemented, %d issues",
                        length(intersect(names(vcr_engine_handlers()), names(d$methods))),
                        length(d$methods), length(issues)))
})

vcr_case("N00c", c("AC-04"), function() {
  # Canonical JSON: R must produce the bytes JavaScript's JSON.stringify does,
  # or the scenario hash means two different things on the two sides.
  cases <- list(
    list(value = list(b = 2, a = 1), want = '{"a":1,"b":2}'),
    list(value = list(a = 0.1, b = 1e-7, c = 1e21), want = '{"a":0.1,"b":1e-7,"c":1e+21}'),
    list(value = list(x = list(2, 1), y = "中"), want = '{"x":[2,1],"y":"中"}'),
    list(value = list(k = NULL, j = TRUE), want = '{"j":true}'),
    list(value = list(n = 0.30000000000000004), want = '{"n":0.30000000000000004}')
  )
  got <- vapply(cases, function(c_) vcr_canonical_json(c_$value), character(1))
  want <- vapply(cases, function(c_) c_$want, character(1))
  ok <- identical(got, want)
  list(pass = ok, detail = sprintf("%d/%d canonical JSON strings match JSON.stringify%s",
                                   sum(got == want), length(cases),
                                   if (ok) "" else paste0("; first mismatch: ", got[which(got != want)[1]])))
})

vcr_case("N00d", c("AC-04"), function() {
  # The regex literals are not exported by the domain, so read them out of the
  # source text. A drift here is silent and would show up as a control plane
  # queueing jobs the engine refuses.
  src <- file.path(VCR_ROOT, "..", "..", "OpenScience", "packages", "domain", "src", "vcrEngineJob.mjs")
  if (!file.exists(src)) return(list(pass = TRUE, detail = "skipped: domain source not present in this image"))
  txt <- readLines(src, warn = FALSE)
  grab <- function(name) {
    line <- grep(sprintf("^const %s = /", name), txt, value = TRUE)
    if (!length(line)) return(NA_character_)
    sub("/$", "", sub(sprintf("^const %s = /", name), "", line[1]))
  }
  pairs <- list(c(grab("ID"), .VCR_ID_RE), c(grab("INPUT_ID"), .VCR_INPUT_ID_RE), c(grab("SHA256"), .VCR_SHA_RE))
  same <- vapply(pairs, function(p) identical(p[1], p[2]), logical(1))
  list(pass = all(same),
       detail = sprintf("ID/INPUT_ID/SHA256 regexes: %s",
                        paste(ifelse(same, "same", paste0("DRIFT(", vapply(pairs, function(p) p[1], character(1)), ")")), collapse = " ")))
})

vcr_case("N00e", c("AC-28", "AC-04"), function() {
  # The two sides of the protocol must plan the same number of replicates.
  if (!nzchar(Sys.which("node"))) return(list(pass = TRUE, detail = "skipped: node not on PATH"))
  src <- file.path(VCR_ROOT, "..", "..", "OpenScience", "packages", "domain", "src", "vcrEngineJob.mjs")
  if (!file.exists(src)) return(list(pass = TRUE, detail = "skipped: domain source not present in this image"))
  # Probe the plan's three quoted targets plus adversarial ones where a
  # "round a bit" rule and an "ulp nudge" rule would part company.
  probes <- list(list("proportion", 0.001, 0.025, 1), list("proportion", 0.005, 0.95, 1),
                 list("mean", 0.005, 0.5, 0.2), list("proportion", 0.0007, 0.31, 1),
                 list("mean", 0.001, 0.5, 1), list("proportion", 0.01, 0.5, 1),
                 list("mean", 0.002, 0.5, 2))
  args <- paste(vapply(probes, function(p_) sprintf(
    "m.replicatesForMcse({measure:'%s',target:%s,p:%s,sd:%s})", p_[[1]], format(p_[[2]], scientific = FALSE),
    format(p_[[3]], scientific = FALSE), format(p_[[4]], scientific = FALSE)), character(1)), collapse = ",")
  script <- sprintf("import('%s').then(m=>{console.log([%s].join(','))})", normalizePath(src), args)
  out <- suppressWarnings(system2("node", c("--input-type=module", "-e", shQuote(script)), stdout = TRUE, stderr = FALSE))
  js <- as.numeric(strsplit(paste(out, collapse = ""), ",")[[1]])
  r <- vapply(probes, function(p_) vcr_replicates_for_mcse(p_[[1]], p_[[2]], p = p_[[3]], sd = p_[[4]]), numeric(1))
  same <- length(js) == length(r) && all(js == r)
  list(pass = same,
       detail = if (same) sprintf("domain and engine agree on %d targets: %s", length(r), paste(r[1:3], collapse = "/"))
                else sprintf("DRIFT on %d/%d targets: domain %s vs engine %s",
                             sum(js != r), length(r), paste(js, collapse = "/"), paste(r, collapse = "/")))
})
