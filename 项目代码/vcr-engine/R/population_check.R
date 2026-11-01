# ---------------------------------------------------------------------------
# population_check.R -- population.check: a generated population held against a SECOND baseline table
# (remediation plan D2, 2026-11-01).
#
# Hidden knowledge:
#
# - **What the page used to call a calibration is a comparison with the inputs.** A generated population is drawn from the numbers it
#   was given, so holding it against those same numbers (the strip on the population page) says the generator did what it was told and
#   nothing about whether the numbers describe any real people. This method is the other thing: the generated table against a second
#   baseline table that did not make it. It can say "the two agree on these variables"; it cannot say "the population is valid", and
#   the result says what it did not look at (`coverage`): only each variable's own distribution is compared, never the joint
#   structure, the tails or a subgroup.
# - **Margins only, from the profile.** The generated side is the profile the population job already wrote (`diagnostics.profile`:
#   mean, SD and levels per variable), copied in by the control plane, never typed by a caller. The reference side is a baseline table
#   of the same shape `population.literature` takes, whose numbers the control plane has bound to quoted sources.
# - **A difference is a size, not a verdict.** Each variable gets a standardized difference (the reference's own SD, or the pooled
#   binary one) or, for a categorical variable, the total variation distance; a row is `close` at or under the domain's SMD floor and
#   `apart` above it. Nothing is rejected, filtered or re-fitted by the result.
# - **Sampling error is said only when the reference said its size.** With `referenceN` a row carries the standard error of the
#   difference of the two means or proportions; without it the row carries none, because the reference's own sampling error is
#   unknown and an invented one would look like a precision.
# ---------------------------------------------------------------------------

#' The kind of a reference row: the fields it states decide it.
.vcr_check_reference_kind <- function(row) {
  if (!is.null(row$proportions)) "categorical" else if (!is.null(row[["proportion"]])) "binary" else "continuous"
}

#' A generated profile entry's levels as a named numeric vector of proportions (NULL cells are dropped).
.vcr_check_levels <- function(g) {
  cells <- g$levels
  if (!length(cells)) return(NULL)
  p <- vapply(cells, function(cell) { v <- cell$p; if (is.null(v) || !is.finite(suppressWarnings(as.numeric(v)))) NA_real_ else as.numeric(v) }, numeric(1))
  names(p) <- vapply(cells, function(cell) as.character(cell$level), character(1))
  p
}

.vcr_check_num <- function(x) if (is.null(x)) NA_real_ else suppressWarnings(as.numeric(x))

#' The comparison of one variable. Always returns a row; a pair that cannot be compared says why and carries no numbers.
.vcr_check_variable <- function(ref, gen, floor_, ref_n) {
  kind <- .vcr_check_reference_kind(ref)
  row <- list(variable = as.character(ref$variable), label = if (!is.null(ref$label)) as.character(ref$label) else if (!is.null(gen$label)) as.character(gen$label) else NULL,
              kind = kind, state = "not_comparable")
  gk <- as.character(gen$kind %||% "")
  gn <- .vcr_check_num(gen$n)
  se <- function(v_ref, v_gen) if (is.finite(ref_n) && is.finite(gn) && gn > 0) sqrt(v_ref / ref_n + v_gen / gn) else NA_real_
  put <- function(row, diff, smd, se_diff = NA_real_) {
    row$difference <- diff
    if (is.finite(smd)) row$standardizedDifference <- smd
    row$state <- if (is.finite(smd) && abs(smd) <= floor_) "close" else if (is.finite(smd)) "apart" else "not_comparable"
    if (is.finite(se_diff) && se_diff > 0) { row$standardError <- se_diff; row$withinTwoStandardErrors <- abs(diff) <= 2 * se_diff }
    row
  }
  if (identical(kind, "continuous")) {
    if (!identical(gk, "continuous")) return(c(row, list(reason = "kind_differs", generatedKind = gk)))
    gm <- .vcr_check_num(gen$mean); gs <- .vcr_check_num(gen$sd)
    rm <- .vcr_check_num(ref$mean); rs <- .vcr_check_num(ref$sd)
    row$generated <- list(mean = gm, sd = if (is.finite(gs)) gs else NULL); row$reference <- list(mean = rm, sd = rs)
    if (!is.finite(gm) || !is.finite(rm) || !is.finite(rs) || rs <= 0) return(c(row, list(reason = "value_missing")))
    row <- put(row, gm - rm, (gm - rm) / rs, se(rs^2, if (is.finite(gs)) gs^2 else NA_real_))
    if (is.finite(gs)) row$sdRatio <- gs / rs
    return(row)
  }
  if (identical(kind, "binary")) {
    lv <- if (identical(gk, "binary") || identical(gk, "categorical")) .vcr_check_levels(gen) else NULL
    if (is.null(lv) || !("1" %in% names(lv)) || length(lv) != 2L) return(c(row, list(reason = "kind_differs", generatedKind = gk)))
    pg <- lv[["1"]]; pr <- .vcr_check_num(ref[["proportion"]])
    row$generated <- list(proportion = pg); row$reference <- list(proportion = pr)
    if (!is.finite(pg) || !is.finite(pr)) return(c(row, list(reason = "value_missing")))
    pooled <- sqrt((pg * (1 - pg) + pr * (1 - pr)) / 2)
    smd <- if (pooled > 0) (pg - pr) / pooled else if (pg == pr) 0 else NA_real_
    return(put(row, pg - pr, smd, se(pr * (1 - pr), pg * (1 - pg))))
  }
  # categorical: the reference's proportions against the generated levels, by name when the reference named its levels, else by position
  lv <- if (identical(gk, "categorical") || identical(gk, "binary")) .vcr_check_levels(gen) else NULL
  pr <- vapply(ref$proportions, function(x) as.numeric(x), numeric(1))
  nm <- if (!is.null(ref$levels)) vapply(ref$levels, as.character, character(1)) else NULL
  if (is.null(lv)) return(c(row, list(reason = "kind_differs", generatedKind = gk)))
  if (!is.null(nm) && all(nm %in% names(lv))) pg <- lv[nm]
  else if (length(lv) == length(pr)) { pg <- lv; nm <- names(lv) }
  else return(c(row, list(reason = "levels_differ")))
  if (anyNA(pg)) return(c(row, list(reason = "value_missing")))
  diffs <- as.numeric(pg) - pr
  tv <- 0.5 * sum(abs(diffs))
  row$levels <- lapply(seq_along(pr), function(i) list(level = nm[i], generated = as.numeric(pg)[i], reference = pr[i], difference = diffs[i]))
  row$totalVariation <- tv
  row$difference <- max(abs(diffs))
  # the same floor, read as the share of the population that would have to move to make the two agree
  row$state <- if (tv <= floor_) "close" else "apart"
  row
}

vcr_job_population_check <- function(job, output_dir = NULL, ...) {
  sc <- job$scenario
  floor_ <- vcr_limit("smdFloor", 0.1)
  ref_n <- .vcr_check_num(sc$referenceN)
  reference <- sc$baselineTable
  generated <- sc$generated
  if (!length(reference)) vcr_abort("scenario_field_missing", "scenario.baselineTable", "The second baseline table has at least one variable.")
  if (!length(generated)) vcr_abort("scenario_field_missing", "scenario.generated", "The generated population's profile is filled in from the population the check is about.")
  gnames <- vapply(generated, function(g) as.character(g$variable), character(1))
  rnames <- vapply(reference, function(r) as.character(r$variable), character(1))
  if (anyDuplicated(rnames)) vcr_abort("scenario_value_invalid", "scenario.baselineTable", "Each variable of the second baseline table appears once.")
  rows <- lapply(seq_along(reference), function(i) {
    at <- match(rnames[i], gnames)
    if (is.na(at)) return(list(variable = rnames[i], kind = .vcr_check_reference_kind(reference[[i]]), state = "not_comparable", reason = "not_in_population"))
    .vcr_check_variable(reference[[i]], generated[[at]], floor_, ref_n)
  })
  comparable <- Filter(function(r) !identical(r$state, "not_comparable"), rows)
  if (!length(comparable)) {
    vcr_abort("scenario_value_invalid", "scenario.baselineTable",
              "None of the second baseline table's variables could be compared with the generated population: they are not in it, or they are another kind of variable there.")
  }
  smds <- vapply(comparable, function(r) if (is.finite(r$standardizedDifference %||% NA_real_)) abs(r$standardizedDifference) else NA_real_, numeric(1))
  tvs <- vapply(comparable, function(r) if (is.finite(r$totalVariation %||% NA_real_)) r$totalVariation else NA_real_, numeric(1))
  worst <- max(c(smds, tvs), na.rm = TRUE)
  apart <- sum(vapply(comparable, function(r) identical(r$state, "apart"), logical(1)))
  not_in_reference <- setdiff(gnames, rnames)
  list(status = "succeeded", conclusion = "estimable",
       measures = list(
         vcr_measure("variables_compared", length(comparable), source = "calculated"),
         vcr_measure("variables_apart", apart, source = "calculated"),
         vcr_measure("worst_difference", if (is.finite(worst)) worst else 0, source = "calculated",
                     note = "the largest standardized difference (or total variation distance of a categorical variable) over the compared variables")),
       counts = vcr_counts(),
       diagnostics = list(
         floor = floor_, referenceN = if (is.finite(ref_n)) ref_n else NULL, rows = rows,
         coverage = list(
           compared = length(comparable), referenceVariables = length(reference), generatedVariables = length(generated),
           referenceOnly = as.list(rnames[!(rnames %in% gnames)]), generatedOnly = as.list(not_in_reference),
           notComparable = as.list(vapply(Filter(function(r) identical(r$state, "not_comparable"), rows), function(r) as.character(r$variable), character(1))),
           notCompared = list("joint_distribution", "distribution_shape")),
         note = "each variable's own distribution against a second baseline table; not the joint structure, the tails or any subgroup, and not a validation of the population"))
}
