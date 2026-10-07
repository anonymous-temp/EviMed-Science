# N45 — the profile of a generated population (2026-10-07).
#
# A scenario, literature or empirical synthetic population carries a profile in
# `diagnostics.profile`: one entry per variable, computed from the generated
# table alone. These cases hold it to the table it describes (every figure is
# recomputed from the written CSV by other code), to the scenario it echoes, to
# the small-cell rule for a table made from real people, and to the domain's
# contract (`validatePopulationProfile`, asked through Node).

# the figure the engine prints for a number: four significant digits
.n45_sig <- function(x) signif(x, 4L)
.n45_entry <- function(profile, name) { hit <- Filter(function(e) identical(e$variable, name), profile); if (length(hit)) hit[[1]] else NULL }
# the domain's verdict on a profile: the issues, `character(0)` for a valid one, and NULL when Node is not here to ask
.n45_verdict <- function(profile) {
  if (!.n00_have_domain()) return(NULL)
  f <- tempfile(fileext = ".json"); on.exit(unlink(f), add = TRUE)
  writeLines(vcr_result_json(profile), f)
  as.character(unlist(.n00_node("emit-profile-verdict.mjs", f)$issues))
}
.n45_said <- function(verdict) if (is.null(verdict)) "(not asked: no node)" else if (length(verdict)) paste(verdict, collapse = " ") else "valid"

vcr_case("N45a", c("AC-02", "AC-09", "AC-11"), function() {
  # A scenario population: four variables (a bounded normal, a binary, a three-level categorical, a lognormal),
  # a missingness rule and a constraint. Every figure of the profile is recomputed from the CSV the job wrote,
  # by code that shares nothing with the profile's: summary statistics by `mean`/`sd`/`quantile`, the histogram by
  # `cut` on seven equal-width intervals, level counts by `table`. The scenario's own words come back: the label, the
  # family and parameters, the bounds and the rule that names the variable.
  n <- 1500L
  sc <- list(n = n, population = list(
    variables = list(
      list(name = "age", label = "年龄", family = "normal", mean = 63, sd = 9, min = 18, max = 95),
      list(name = "female", family = "bernoulli", prob = 0.45),
      list(name = "stage", family = "categorical", probs = list(0.5, 0.3, 0.2)),
      list(name = "bmi", family = "lognormal", meanlog = 3.3, sdlog = 0.15)),
    constraints = list(list(name = "adult", rule = list(op = "compare", column = "age", comparator = "gte", value = 18))),
    missing = list(list(kind = "MCAR", variable = "bmi", rate = 0.1, reason = "not_measured"))))
  dir <- tempfile("n45a"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  r <- vcr_test_run(vcr_test_job("population.scenario", sc, seed = 4501L, job_id = "job_n45a"), output_dir = dir)
  d <- vcr_test_table(r, "population", dir)
  p <- r$diagnostics$profile
  age <- .n45_entry(p, "age"); fem <- .n45_entry(p, "female"); stg <- .n45_entry(p, "stage"); bmi <- .n45_entry(p, "bmi")
  # seven left-closed bins from the smallest to the largest value (`include.lowest` closes the last one on the right as well)
  hist_ref <- function(x) { x <- x[!is.na(x)]; as.integer(table(cut(x, seq(min(x), max(x), length.out = 8L), include.lowest = TRUE, right = FALSE))) }
  fig <- function(e, x) {
    x <- x[!is.na(x)]; q <- stats::quantile(x, c(.25, .5, .75), names = FALSE)
    c(mean = e$mean - .n45_sig(mean(x)), sd = e$sd - .n45_sig(stats::sd(x)), median = e$median - .n45_sig(q[2]), q1 = e$q1 - .n45_sig(q[1]),
      q3 = e$q3 - .n45_sig(q[3]), min = e$min - .n45_sig(min(x)), max = e$max - .n45_sig(max(x)))
  }
  worst <- max(abs(c(fig(age, d$age), fig(bmi, d$bmi))))
  counts_ok <- identical(as.integer(unlist(age$histogram$counts)), hist_ref(d$age)) && identical(as.integer(unlist(bmi$histogram$counts)), hist_ref(d$bmi))
  lv <- function(e) vapply(e$levels, function(l) l$n, numeric(1))
  levels_ok <- identical(as.integer(lv(fem)), as.integer(table(d$female))) && identical(as.integer(lv(stg)), as.integer(table(d$stage))) &&
    identical(vapply(stg$levels, function(l) l$level, character(1)), c("1", "2", "3")) &&
    all(abs(vapply(stg$levels, function(l) l$p, numeric(1)) - .n45_sig(as.numeric(table(d$stage)) / n)) < 1e-12)
  said_ok <- identical(age$label, "年龄") && is.null(fem$label) && identical(age$declared$family, "normal") && identical(age$declared$params$mean, 63) && identical(age$declared$params$sd, 9) &&
    identical(vapply(age$declared$constraints, function(cn) cn$kind, character(1)), c("bounds", "rule")) && identical(age$declared$constraints[[1]]$max, 95) &&
    identical(age$declared$constraints[[2]]$name, "adult") && identical(fem$declared$params$prob, 0.45) && identical(length(stg$declared$params$probs), 3L) &&
    identical(bmi$declared$family, "lognormal") && length(bmi$declared$constraints) == 0L
  shape_ok <- identical(age$kind, "continuous") && identical(fem$kind, "binary") && identical(stg$kind, "categorical") && age$n == n && age$missing == 0L &&
    bmi$missing == sum(is.na(d$bmi)) && bmi$missing > 0L && length(age$histogram$breaks) == 8L && length(age$histogram$counts) == 7L &&
    sum(unlist(age$histogram$counts)) == n && sum(unlist(bmi$histogram$counts)) == n - bmi$missing && is.null(age$suppressed) && !any(c("parameterDraw") %in% vapply(p, function(e) e$variable, character(1)))
  verdict <- .n45_verdict(p)
  list(pass = identical(r$status, "succeeded") && length(p) == 4L && worst < 1e-9 && counts_ok && levels_ok && said_ok && shape_ok && !length(verdict),
       detail = sprintf("%d variables of %d rows: every summary of age and bmi equals the recomputation from the CSV (worst gap %.1g), both histograms and every level count equal the independent tabulation (%s/%s), the label, family, parameters, bounds and rule are echoed (%s), %d missing bmi counted apart; the domain's contract says %s",
                        length(p), n, worst, counts_ok, levels_ok, said_ok, bmi$missing, .n45_said(verdict)))
})

vcr_case("N45b", c("AC-11", "AC-20"), function() {
  # A literature population: a continuous row with bounds, a binary proportion, a labelled categorical row (the levels
  # keep the order the table gave them, not the alphabet's) and a lognormal row. The profile says what the table stated.
  n <- 2000L
  tbl <- list(list(variable = "age", label = "年龄", mean = 61, sd = 9, min = 30),
              list(variable = "male", proportion = 0.6),
              list(variable = "ecog", proportions = list(0.5, 0.3, 0.2), levels = list("low", "mid", "high")),
              list(variable = "alt", mean = 40, sd = 20, distribution = "lognormal"))
  r <- vcr_test_run(vcr_test_job("population.literature", list(baselineTable = tbl, n = n), seed = 4502L, job_id = "job_n45b"))
  p <- r$diagnostics$profile
  age <- .n45_entry(p, "age"); male <- .n45_entry(p, "male"); ecog <- .n45_entry(p, "ecog"); alt <- .n45_entry(p, "alt")
  ok <- identical(r$status, "succeeded") && length(p) == 4L && identical(age$label, "年龄") && identical(age$declared$family, "normal") && identical(age$declared$params$mean, 61) &&
    identical(age$declared$constraints[[1]]$min, 30) && age$min >= 30 && identical(male$kind, "binary") && identical(male$declared$params$prob, 0.6) &&
    identical(ecog$kind, "categorical") && identical(vapply(ecog$levels, function(l) l$level, character(1)), c("low", "mid", "high")) &&
    identical(ecog$declared$params$levels, c("low", "mid", "high")) && sum(vapply(ecog$levels, function(l) l$n, numeric(1))) == n &&
    identical(alt$declared$family, "lognormal") && identical(alt$declared$params$sd, 20) && abs(alt$mean - 40) < 4 * 20 / sqrt(n)
  verdict <- .n45_verdict(p)
  list(pass = ok && !length(verdict),
       detail = sprintf("literature table of 4 rows: levels in the stated order low/mid/high (%d/%d/%d of %d), age lower bound 30 respected (min %.1f), the lognormal row declared as such with generated mean %.1f against 40; the domain's contract says %s",
                        ecog$levels[[1]]$n, ecog$levels[[2]]$n, ecog$levels[[3]]$n, n, age$min, alt$mean, .n45_said(verdict)))
})

vcr_case("N45c", c("AC-17", "AC-26", "AC-27"), function() {
  # A table made from real people keeps the small-cell rule. (1) The profile helper on a crafted table: a three-level
  # column of 100/60/7 rows hides the 7 and, with it, the next-smallest cell (60), because showing the 100 and hiding only
  # the 7 would let the 7 be recovered from the total; a hidden level keeps its name and loses n and p. A column whose
  # cells all sit below the floor is withheld whole. A histogram bin below the floor is hidden like a cell, the extremes of a
  # table too small to hide a single record are not shown, and a count of missing values below the floor is hidden.
  # (2) A synthetic population through the job: no number the profile shows for a level is below the floor, and its declared block is null.
  min_cell <- vcr_limit("minCellSize", 10)
  big <- data.frame(g = rep(c("A", "B", "C"), c(100, 60, 7)), stringsAsFactors = FALSE)
  pg <- vcr_population_profile(big, empirical = TRUE)[[1]]
  hid <- vapply(pg$levels, function(l) isTRUE(l$suppressed), logical(1)); names(hid) <- vapply(pg$levels, function(l) l$level, character(1))
  all_small <- vcr_population_profile(data.frame(g = rep(c("A", "B", "C"), c(4, 3, 2)), stringsAsFactors = FALSE), empirical = TRUE)[[1]]
  set.seed(5L, kind = VCR_RNG_KIND); x <- c(stats::rnorm(190), 6.5, 6.6, 6.7)   # three records far out: the top bin holds three people
  px <- vcr_population_profile(data.frame(x = x), empirical = TRUE)[[1]]
  tiny <- vcr_population_profile(data.frame(x = stats::rnorm(60)), empirical = TRUE)[[1]]
  miss <- vcr_population_profile(data.frame(x = c(rep(NA_real_, 4), stats::rnorm(400))), empirical = TRUE)[[1]]
  free <- vcr_population_profile(big, empirical = FALSE)[[1]]
  bins_hidden <- vapply(px$histogram$counts, is.null, logical(1))
  ref_bins <- as.integer(table(cut(x, seq(min(x), max(x), length.out = 8L), include.lowest = TRUE, right = FALSE)))   # the same seven bins, tabulated by other code
  helper_ok <- identical(unname(hid), c(FALSE, TRUE, TRUE)) && identical(pg$levels[[1]]$n, 100L) && is.null(pg$levels[[2]]$n) && is.null(pg$levels[[2]]$p) && is.null(pg$levels[[3]]$n) &&
    identical(unlist(pg$suppressed), "levels") && identical(all_small$withheld, "small_cells") && length(all_small$levels) == 0L &&
    sum(bins_hidden) >= 2L && bins_hidden[7] && identical(as.integer(unlist(px$histogram$counts[!bins_hidden])), ref_bins[!bins_hidden]) && all(ref_bins[bins_hidden] > 0L) && "histogram" %in% unlist(px$suppressed) &&
    is.null(tiny$min) && is.null(tiny$max) && all(c("min", "max") %in% unlist(tiny$suppressed)) && is.numeric(tiny$median) &&
    is.null(miss$missing) && "missing" %in% unlist(miss$suppressed) &&
    # an unsuppressed table (a scenario or literature population) shows everything, small cells included
    identical(free$levels[[3]]$n, 7L) && is.null(free$suppressed)
  # (2) through the job: synthpop on a table of 400 rows with a rare level
  set.seed(4503L, kind = VCR_RNG_KIND)
  m <- 400L
  real <- data.frame(age = stats::rnorm(m, 60, 10), sex = stats::rbinom(m, 1L, 0.5), grp = sample(c("a", "b", "c", "d", "e", "f"), m, TRUE, prob = c(0.45, 0.3, 0.2, 0.03, 0.015, 0.005)), stringsAsFactors = FALSE)
  inp <- vcr_test_input(real, "snp_n45c:1")
  r <- vcr_test_run(vcr_test_job("population.synthpop", list(m = 5L, holdoutShare = 0.2), list(inp), seed = 4503L, job_id = "job_n45c"))
  p <- r$diagnostics$profile
  grp <- .n45_entry(p, "grp")
  shown <- Filter(function(l) !isTRUE(l$suppressed), grp$levels)
  floor_ok <- all(vapply(shown, function(l) l$n >= min_cell, logical(1))) && all(vapply(Filter(function(l) isTRUE(l$suppressed), grp$levels), function(l) is.null(l$n) && is.null(l$p), logical(1)))
  job_ok <- identical(r$status, "succeeded") && length(p) == 3L && is.null(grp$declared) && floor_ok && identical(r$diagnostics$profileCopy, 1L) && r$counts$realPatients == 0
  verdict <- c(.n45_verdict(p), .n45_verdict(list(pg)), .n45_verdict(list(px)), .n45_verdict(list(tiny)), .n45_verdict(list(miss)), .n45_verdict(list(all_small)))
  list(pass = helper_ok && job_ok && !length(verdict),
       detail = sprintf("crafted 100/60/7: hidden %s, the lone 100 shown; all-small column %s; a three-person top bin hidden with a neighbour (%d bins hidden); extremes withheld at 60 rows (%s); 4 missing hidden; the unsuppressed table shows the 7; synthpop job: %d levels of grp, %d shown, none below %d, declared null; the domain's contract says %s",
                        paste(names(hid)[hid], collapse = "+"), all_small$withheld, sum(bins_hidden), paste(unlist(tiny$suppressed), collapse = "/"), length(grp$levels), length(shown), min_cell,
                        .n45_said(verdict)))
})

vcr_case("N45d", c("AC-04", "AC-31"), function() {
  # The profile is a function of the table: the same seed gives the same profile bit for bit on one core and eight (the generators do
  # not use the cores), a population with several parameter draws is profiled as the table it wrote (the rows of every draw), and a
  # variable with one value, or with only missing values, still gets a well-formed entry.
  sc <- list(n = 300L, parameterDraws = 4L, population = list(variables = list(
    list(name = "age", family = "normal", mean = 60, sd = 9, paramSd = list(mean = 2)),
    list(name = "all_yes", family = "bernoulli", prob = 1))))
  one <- vcr_test_run(vcr_test_job("population.scenario", sc, seed = 4504L, cores = 1L, job_id = "job_n45d1"))
  eight <- vcr_test_run(vcr_test_job("population.scenario", sc, seed = 4504L, cores = 8L, job_id = "job_n45d1"))
  p <- one$diagnostics$profile
  age <- .n45_entry(p, "age"); yes <- .n45_entry(p, "all_yes")
  const <- vcr_population_profile(data.frame(c = rep(5.5, 40)))[[1]]
  hist_const <- unlist(const$histogram$counts)
  allna <- vcr_population_profile(data.frame(x = rep(NA_real_, 20)))[[1]]
  ok <- identical(one$status, "succeeded") && identical(vcr_result_json(one$diagnostics$profile), vcr_result_json(eight$diagnostics$profile)) && identical(age$n, 1200L) &&
    identical(yes$levels[[2]]$n, 1200L) && identical(yes$levels[[1]]$n, 0L) &&
    identical(const$sd, 0) && const$min == 5.5 && const$max == 5.5 && sum(hist_const) == 40L && identical(sum(hist_const > 0), 1L) && all(diff(unlist(const$histogram$breaks)) > 0) &&
    identical(allna$missing, 20L) && is.null(allna$mean) && is.null(allna$histogram) && identical(allna$kind, "continuous")
  verdict <- c(.n45_verdict(p), .n45_verdict(list(const)), .n45_verdict(list(allna)))
  list(pass = ok && !length(verdict),
       detail = sprintf("4 parameter draws of 300 profiled as the 1200-row table; 1 and 8 cores give the same profile; a constant column has sd 0 and one occupied bin of 40 with strictly increasing breaks; a declared level nobody drew is listed with n 0; an all-missing column has no summary and says 20 missing; the domain's contract says %s",
                        .n45_said(verdict)))
})
