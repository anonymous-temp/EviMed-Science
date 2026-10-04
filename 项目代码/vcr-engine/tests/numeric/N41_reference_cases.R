# N41 — reference cases for two methods whose numbers had none that was not their own code.
#
# The numerical-validation evidence records, per method, the reference cases that
# held it to something outside it (scripts/ops/vcr-method-references.mjs lists them
# and the generator fails when a dispatched method has none). Twelve methods had no
# entry; ten of them already had a case that compares against an independent
# computation (named in that file). These two did not:
#
# - `profile.snapshot` reports means, spreads and quantiles and the cells of a
#   categorical column; N24/N25 pin what is SUPPRESSED, never that what is shown is
#   right. Here every figure is recomputed from the definitions, by hand.
# - `population.synthpop` is held to the training table it was fitted to: a copy has
#   to reproduce the training marginals, correlations and a regression coefficient.
#   A synthesizer that kept the marginals and lost the associations would fail it.

# the figures of a column, from their definitions (no mean(), sd() or quantile())
.n41_mean <- function(x) sum(x) / length(x)
.n41_sd <- function(x) sqrt(sum((x - .n41_mean(x))^2) / (length(x) - 1))
.n41_quantile <- function(x, p) {          # R's type 7, written out: h = (n - 1) p + 1, linear between order statistics
  s <- sort(x); n <- length(s); h <- (n - 1) * p + 1; lo <- floor(h)
  if (lo >= n) s[n] else s[lo] + (h - lo) * (s[lo + 1L] - s[lo])
}

vcr_case("N41a", c("AC-02", "AC-26", "AC-30"), function() {
  # A table of 600 rows: a normal column, a skewed one with ties (integers), a column with 40 missing values, and two
  # categorical columns whose cells are all large enough to be shown. Every figure the profile prints is recomputed from its
  # definition and compared to 1e-9 (relative): mean, standard deviation (n - 1), the five quantiles by R's type-7 definition
  # written out, distinct count, missing count and rate, and each categorical cell. The row count and the counts of real patients
  # are the table's.
  set.seed(4101L, kind = VCR_RNG_KIND)
  n <- 600L
  df <- data.frame(USUBJID = sprintf("P%04d", seq_len(n)), age = stats::rnorm(n, 58, 12), visits = stats::rpois(n, 3.5) + 1L,
                   ldh = stats::rlnorm(n, 5.3, 0.4), site = sample(c("north", "south", "east"), n, TRUE, c(0.5, 0.3, 0.2)),
                   stage = sample(c("I", "II", "III", "IV"), n, TRUE, c(0.2, 0.3, 0.3, 0.2)), stringsAsFactors = FALSE)
  df$ldh[sample(n, 40)] <- NA
  inp <- vcr_test_input(df, "snp_n41a:subject", "subject")
  r <- vcr_test_run(vcr_test_job("profile.snapshot", vcr_empty_object(), list(inp), job_id = "job_n41a"))
  col <- function(nm) Filter(function(c_) identical(c_$column, nm), r$diagnostics$columns)[[1]]
  rel <- function(a, b) abs(a - b) / max(abs(b), 1e-12)
  worst <- 0
  numeric_check <- function(nm) {
    x <- df[[nm]]; xs <- x[!is.na(x)]; got <- col(nm)
    want <- c(mean = .n41_mean(xs), sd = .n41_sd(xs), p25 = .n41_quantile(xs, 0.25), median = .n41_quantile(xs, 0.5), p75 = .n41_quantile(xs, 0.75),
              p05 = .n41_quantile(xs, 0.05), p95 = .n41_quantile(xs, 0.95))
    have <- vapply(names(want), function(k) as.numeric(got[[k]]), numeric(1))
    worst <<- max(worst, max(vapply(names(want), function(k) rel(have[[k]], want[[k]]), numeric(1))))
    identical(got$kind, "numeric") && identical(as.integer(got$distinct), length(unique(xs))) &&
      identical(as.integer(got$missing), sum(is.na(x))) && abs(got$missingRate - sum(is.na(x)) / n) < 1e-12
  }
  num_ok <- all(vapply(c("age", "visits", "ldh"), numeric_check, logical(1)))
  cell_check <- function(nm) {
    got <- col(nm); want <- table(df[[nm]])
    have <- stats::setNames(vapply(got$cells, function(c_) c_$n, numeric(1)), vapply(got$cells, function(c_) c_$level, character(1)))
    identical(got$kind, "categorical") && setequal(names(have), names(want)) && all(have[names(want)] == as.numeric(want)) && is.null(got$withheld)
  }
  cat_ok <- all(vapply(c("site", "stage"), cell_check, logical(1)))
  ok <- identical(r$status, "succeeded") && num_ok && cat_ok && worst < 1e-9 && identical(vcr_measure_value(r, "rows"), 600) && r$counts$realPatients == 600L &&
    identical(vcr_measure_value(r, "columns"), 6)
  list(pass = ok,
       detail = sprintf("600 rows, 6 columns: age / visits / ldh mean, sd, p05, p25, median, p75, p95 recomputed from their definitions agree to %.1e (relative); distinct and missing counts equal (ldh: 40 missing = %s); site and stage cells equal table() and none is withheld; rows %s, realPatients %s",
                        worst, as.integer(col("ldh")$missing), vcr_measure_value(r, "rows"), r$counts$realPatients))
})

vcr_case("N41b", c("AC-09", "AC-11", "AC-30"), function() {
  # The synthesis against the table it was fitted to. 2,000 training rows with a continuous column (age), a binary one (sex), a
  # continuous one that depends on both (bmi), a three-level one (grp) and a binary outcome that depends on age and sex; five copies
  # (10,000 synthetic rows, no holdout). Each copy-pooled figure is compared with the training table's own: means within 0.05
  # standard deviations, standard deviations within 6%, the proportion of each level within 0.02, the correlations within 0.05 and the
  # logistic regression coefficients of the outcome within 0.20 (their standard errors are about 0.1). A synthesizer that kept the
  # marginals and lost the associations (every column drawn on its own) fails the correlations by construction: the case computes
  # that one too and requires it to fail, so the check can.
  set.seed(4102L, kind = VCR_RNG_KIND)
  n <- 2000L
  age <- stats::rnorm(n, 60, 10); sex <- stats::rbinom(n, 1L, 0.45)
  bmi <- 24 + 0.05 * (age - 60) + 2 * sex + stats::rnorm(n, 0, 3)
  grp <- sample(c("a", "b", "c"), n, TRUE, c(0.5, 0.3, 0.2))
  y <- stats::rbinom(n, 1L, stats::plogis(-1 + 0.03 * (age - 60) + 0.5 * sex))
  tr <- data.frame(age = age, sex = sex, bmi = bmi, grp = grp, y = y, stringsAsFactors = FALSE)
  inp <- vcr_test_input(tr, "snp_n41b:1", source = "observed")
  dir <- tempfile("n41b"); dir.create(dir); on.exit(unlink(dir, recursive = TRUE), add = TRUE)
  r <- vcr_test_run(vcr_test_job("population.synthpop", list(m = 5L, holdoutShare = 0), list(inp), seed = 7L, job_id = "job_n41b"), output_dir = dir)
  sy <- vcr_test_table(r, "synthetic-population", dir)
  syn <- sy[, names(tr)]
  figs <- function(d) c(age_mean = mean(d$age), age_sd = stats::sd(d$age), sex = mean(d$sex), bmi_mean = mean(d$bmi), bmi_sd = stats::sd(d$bmi),
                        grp_a = mean(d$grp == "a"), grp_b = mean(d$grp == "b"), y = mean(d$y),
                        cor_age_bmi = stats::cor(d$age, d$bmi), cor_sex_bmi = stats::cor(d$sex, d$bmi), cor_age_sex = stats::cor(d$age, d$sex),
                        beta_age = unname(stats::coef(stats::glm(y ~ age + sex, stats::binomial(), d))[["age"]]),
                        beta_sex = unname(stats::coef(stats::glm(y ~ age + sex, stats::binomial(), d))[["sex"]]))
  ft <- figs(tr); fs <- figs(syn)
  within <- function(d) {
    c(abs(d[["age_mean"]] - ft[["age_mean"]]) < 0.05 * stats::sd(tr$age), abs(d[["bmi_mean"]] - ft[["bmi_mean"]]) < 0.05 * stats::sd(tr$bmi),
      abs(d[["age_sd"]] / ft[["age_sd"]] - 1) < 0.06, abs(d[["bmi_sd"]] / ft[["bmi_sd"]] - 1) < 0.06,
      abs(d[["sex"]] - ft[["sex"]]) < 0.02, abs(d[["grp_a"]] - ft[["grp_a"]]) < 0.02, abs(d[["grp_b"]] - ft[["grp_b"]]) < 0.02, abs(d[["y"]] - ft[["y"]]) < 0.02,
      abs(d[["cor_age_bmi"]] - ft[["cor_age_bmi"]]) < 0.05, abs(d[["cor_sex_bmi"]] - ft[["cor_sex_bmi"]]) < 0.05, abs(d[["cor_age_sex"]] - ft[["cor_age_sex"]]) < 0.05,
      abs(d[["beta_age"]] - ft[["beta_age"]]) < 0.20 && abs(d[["beta_sex"]] - ft[["beta_sex"]]) < 0.20)
  }
  ok_syn <- all(within(fs))
  # the negative control: the marginals kept, every column drawn on its own
  set.seed(4103L, kind = VCR_RNG_KIND)
  shuf <- as.data.frame(lapply(syn, function(v) sample(v)), stringsAsFactors = FALSE)
  fshuf <- figs(shuf); fails_shuffled <- !all(within(fshuf)) && abs(fshuf[["cor_sex_bmi"]] - ft[["cor_sex_bmi"]]) > 0.2
  worst_cor <- max(abs(fs[c("cor_age_bmi", "cor_sex_bmi", "cor_age_sex")] - ft[c("cor_age_bmi", "cor_sex_bmi", "cor_age_sex")]))
  ok <- identical(r$status, "succeeded") && nrow(sy) == 5L * n && identical(sort(unique(sy$copy)), 1:5) && r$counts$realPatients == 0 && ok_syn && fails_shuffled
  list(pass = ok,
       detail = sprintf("2,000 training rows, 5 copies (%d synthetic rows): pooled means %.2f / %.2f vs training %.2f / %.2f, sd ratio %.3f / %.3f, sex %.3f vs %.3f, correlations worst |d| %.3f (age~bmi %.3f vs %.3f, sex~bmi %.3f vs %.3f), outcome coefficients age %.4f vs %.4f, sex %.3f vs %.3f; all %d checks pass %s; a column-shuffled copy (marginals kept) fails them (sex~bmi %.3f vs %.3f): %s",
                        nrow(sy), fs[["age_mean"]], fs[["bmi_mean"]], ft[["age_mean"]], ft[["bmi_mean"]], fs[["age_sd"]] / ft[["age_sd"]], fs[["bmi_sd"]] / ft[["bmi_sd"]], fs[["sex"]], ft[["sex"]],
                        worst_cor, fs[["cor_age_bmi"]], ft[["cor_age_bmi"]], fs[["cor_sex_bmi"]], ft[["cor_sex_bmi"]], fs[["beta_age"]], ft[["beta_age"]], fs[["beta_sex"]], ft[["beta_sex"]],
                        length(within(fs)), ok_syn, fshuf[["cor_sex_bmi"]], ft[["cor_sex_bmi"]], fails_shuffled))
})
