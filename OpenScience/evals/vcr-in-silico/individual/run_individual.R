#!/usr/bin/env Rscript
# The frozen evaluation of individual prediction (plan R33). Everything it may do is in PROTOCOL.md; protocol.json carries the data hashes
# and the numbers it checks. It refuses to run on data whose hash is not the frozen one.
#
#   Rscript --vanilla run_individual.R --engine <vcr-engine dir> --jm <aids.rda> --actg <ACTG175.txt, the data member of speff2trial 1.0.5> --out <result.json> [--selftest]
#
# `--selftest` runs the same code on synthetic data drawn from the model itself (no real file is read) and exists to test the runner before
# the first real evaluation; its output is never a result.
#
# Reads: survival::pbcseq (in R), JM::aids (the extracted data file), ACTG175 (speff2trial 1.0.5, its data member). Writes aggregates only.

args <- commandArgs(trailingOnly = TRUE)
arg <- function(k, default = NULL) { i <- match(paste0("--", k), args); if (is.na(i)) default else args[i + 1L] }
selftest <- "--selftest" %in% args
lib <- Sys.getenv("VCR_R_LIBS", ""); if (nzchar(lib)) .libPaths(c(lib, .libPaths()))
engine <- arg("engine"); out_file <- arg("out")
stopifnot(!is.null(engine), !is.null(out_file))
here <- dirname(normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE)[1L])))
protocol <- jsonlite::fromJSON(file.path(here, "protocol.json"), simplifyVector = FALSE)
Sys.setenv(VCR_ENGINE_ROOT = engine)
source(file.path(engine, "R", "engine.R")); vcr_engine_load(engine)

sha256_file <- function(p) digest::digest(file = p, algo = "sha256")
sha256_text <- function(s) digest::digest(s, algo = "sha256", serialize = FALSE)

# --- the frozen inputs ---------------------------------------------------------------------------------------------------------------
check_hash <- function(path, expected, what) {
  got <- sha256_file(path)
  if (!identical(got, expected)) stop(sprintf("%s: the file's SHA-256 is %s, the protocol froze %s", what, got, expected))
  got
}
if (!selftest) {
  check_hash(arg("jm"), protocol$data$jmAids$sha256, "JM aids.rda")
  check_hash(arg("actg"), protocol$data$actg175$memberSha256, "ACTG175.txt")
  pbc_text <- paste(utils::capture.output(utils::write.csv(survival::pbcseq, row.names = FALSE)), collapse = "\n")
  if (!identical(sha256_text(pbc_text), protocol$data$pbcseq$csvSha256)) stop("survival::pbcseq is not the frozen data (CSV SHA-256 differs)")
  check_hash(file.path(engine, "R", "individualize.R"), protocol$code$individualizeR, "individualize.R")
}

# --- datasets: each one is a long table plus the rules that cut it ----------------------------------------------------------------------
# A spec: dataset name, `long` (id, t, y, plus design columns), `design(d)` -> fixed-effects matrix, `history(d)` -> logical rows usable at the
# origin, `target(d, hist)` -> index of the primary target row (or NULL), `later(d, hist)` -> rows of all later visits for the horizon table,
# `horizon(d)` -> horizon of a row from the origin in the dataset's own unit.
spec_pbcseq <- function() {
  p <- survival::pbcseq; p <- p[!is.na(p$bili) & p$bili > 0, ]
  spec_pbc_rules(data.frame(id = as.character(p$id), t = p$day / 365.25, day = p$day, y = log(p$bili), trt = as.numeric(p$trt), age = p$age - 50, female = as.numeric(p$sex == "f")))
}
spec_pbc_rules <- function(d) {
  design <- function(d) cbind("(Intercept)" = 1, t = d$t, trt = d$trt, trt_t = d$trt * d$t, age = d$age, female = d$female)
  P <- protocol$datasets$pbcseq
  list(name = "pbcseq", unit = "months", scale = "log serum bilirubin", long = d, design = design,
       history = function(x) x$day <= P$historyDaysMax,
       target = function(x, hist) { cand <- which(!hist & abs(x$day - P$targetDay) <= P$targetWindowDays); if (!length(cand)) NULL else cand[which.min(abs(x$day[cand] - P$targetDay))] },
       later = function(x, hist) which(!hist & x$day <= P$laterDaysMax),
       hscale = 12, minHistory = P$minHistory, bins = unlist(P$horizonBinsMonths))
}
spec_aids <- function(path) {
  e <- new.env(); load(path, envir = e)
  a <- e$aids; stopifnot(is.data.frame(a))
  d <- data.frame(id = as.character(a$patient), t = a$obstime, y = a$CD4, ddI = as.numeric(a$drug == "ddI"), male = as.numeric(a$gender == "male"),
                  prevOI = as.numeric(a$prevOI == "AIDS"), azt = as.numeric(a$AZT == "failure"))
  design <- function(d) cbind("(Intercept)" = 1, t = d$t, ddI = d$ddI, ddI_t = d$ddI * d$t, male = d$male, prevOI = d$prevOI, azt = d$azt)
  P <- protocol$datasets$aids
  list(name = "aids", unit = "months", scale = "square root of CD4", long = d, design = design,
       history = function(x) x$t <= P$historyMonthsMax,
       target = function(x, hist) { cand <- which(x$t == P$targetMonth); if (!length(cand)) NULL else cand[1L] },
       later = function(x, hist) which(!hist & x$t <= P$laterMonthsMax),
       hscale = 1, minHistory = P$minHistory, bins = unlist(P$horizonBinsMonths))
}
spec_actg <- function(path) {
  x <- utils::read.table(path, header = TRUE)
  P <- protocol$datasets$actg175
  base <- data.frame(id = as.character(x$pidnum), age = x$age - 35, male = x$gender, arm1 = as.numeric(x$arms == 1), arm2 = as.numeric(x$arms == 2), arm3 = as.numeric(x$arms == 3))
  mk <- function(col, t) cbind(base, t = t, y = sqrt(x[[col]]))[!is.na(x[[col]]), ]
  d <- rbind(mk("cd40", 0), mk("cd420", P$week420), mk("cd496", P$week496))
  d <- d[order(d$id, d$t), ]
  design <- function(d) cbind("(Intercept)" = 1, t = d$t, arm1 = d$arm1, arm2 = d$arm2, arm3 = d$arm3, arm1_t = d$arm1 * d$t, arm2_t = d$arm2 * d$t, arm3_t = d$arm3 * d$t, age = d$age, male = d$male)
  list(name = "actg175", unit = "weeks", scale = "square root of CD4 count", long = d, design = design,
       history = function(x) x$t <= P$week420,
       target = function(x, hist) { cand <- which(x$t == P$week496); if (!length(cand)) NULL else cand[1L] },
       later = function(x, hist) integer(0), hscale = 1, minHistory = P$minHistory, bins = unlist(P$horizonBinsWeeks))
}
spec_selftest <- function() {
  set.seed(1L); n <- 160L; ids <- rep(seq_len(n), each = 7L); day <- rep(c(0, 100, 190, 235, 330, 400, 600), n)
  b0 <- rnorm(n, 0, 1)[ids]; b1 <- rnorm(n, 0, 0.4)[ids]
  d <- data.frame(id = as.character(ids), t = day / 365.25, day = day, y = 1 + 0.3 * day / 365.25 + b0 + b1 * day / 365.25 + rnorm(n * 7L, 0, 0.4),
                  trt = rep(rbinom(n, 1, 0.5), each = 7L), age = rep(rnorm(n), each = 7L), female = rep(rbinom(n, 1, 0.5), each = 7L))
  s <- spec_pbc_rules(d); s$name <- "selftest"; s
}

# --- one dataset's out-of-fold evaluation ----------------------------------------------------------------------------------------------
# the first 8 hex digits are a 32-bit number; `strtoi` returns NA above 2^31 - 1, so it is read as two 16-bit halves (a double holds it exactly)
fold_of <- function(name, id, k) {
  h <- sha256_text(paste0(name, ":", id))
  (strtoi(substr(h, 1L, 4L), 16L) * 65536 + strtoi(substr(h, 5L, 8L), 16L)) %% k
}

predictions <- function(s, folds = protocol$folds) {
  d <- s$long; d$fold <- vapply(d$id, function(i) fold_of(s$name, i, folds), numeric(1))
  by_id <- split(seq_len(nrow(d)), factor(d$id, levels = unique(d$id)))
  # per person: the history rows, the primary target, the later rows
  cut <- lapply(by_id, function(r) {
    x <- d[r, ]; hist <- s$history(x)
    if (sum(hist) < s$minHistory) return(NULL)
    tg <- s$target(x, hist)
    if (is.null(tg)) return(NULL)
    list(id = x$id[1L], fold = x$fold[1L], hist = r[hist], target = r[tg], later = r[s$later(x, hist)])
  })
  cut <- Filter(Negate(is.null), cut)
  rows <- list(); later_rows <- list(); fits <- list()
  for (k in seq_len(folds) - 1L) {
    train <- d[d$fold != k, ]
    f <- vcr_lmm_fit(train$y, s$design(train), train$t, train$id)
    fits[[as.character(k)]] <- f[c("beta", "sd0", "sd1", "rho", "sigma", "converged", "nObs", "nPeople")]
    # the training people who meet the same rules: the baselines' error spread and the population mean of the target
    tr <- Filter(function(p) p$fold != k, cut)
    err_locf <- err_lin <- tgt <- numeric(0)
    for (p in tr) {
      h <- d[p$hist, ]; y <- d$y[p$target]; tg <- d[p$target, ]
      err_locf <- c(err_locf, y - h$y[which.max(h$t)]); err_lin <- c(err_lin, y - lin_pred(h, tg$t)); tgt <- c(tgt, y)
    }
    sd_locf <- sqrt(mean(err_locf^2)); sd_lin <- sqrt(mean(err_lin^2)); mean_t <- mean(tgt); sd_t <- stats::sd(tgt)
    for (p in Filter(function(p) p$fold == k, cut)) {
      h <- d[p$hist, ]; tg <- d[p$target, ]; Xn <- s$design(tg)
      eb <- vcr_lmm_individualize(f, Xn, tg$t, s$design(h), h$t, h$y); pm <- vcr_lmm_population_predict(f, Xn, tg$t)
      rows[[length(rows) + 1L]] <- data.frame(id = p$id, y = tg$y, horizon = (tg$t - max(h$t)) * s$hscale,
        locf = h$y[which.max(h$t)], locf_sd = sd_locf, lin = lin_pred(h, tg$t), lin_sd = sd_lin, popmean = mean_t, popmean_sd = sd_t,
        popmodel = pm$mean, popmodel_sd = pm$sd, eb = eb$mean, eb_sd = eb$sd, nhist = nrow(h))
      if (length(p$later)) {
        lt <- d[p$later, ]; ebl <- vcr_lmm_individualize(f, s$design(lt), lt$t, s$design(h), h$t, h$y)
        later_rows[[length(later_rows) + 1L]] <- data.frame(id = p$id, y = lt$y, horizon = (lt$t - max(h$t)) * s$hscale, locf = h$y[which.max(h$t)], lin = vapply(lt$t, function(z) lin_pred(h, z), numeric(1)),
          popmodel = vcr_lmm_population_predict(f, s$design(lt), lt$t)$mean, eb = ebl$mean)
      }
    }
  }
  list(primary = do.call(rbind, rows), later = if (length(later_rows)) do.call(rbind, later_rows) else NULL, fits = fits, eligible = length(cut))
}

#' The per-person least-squares line through the history, evaluated at `t0`; a history of one time (or all at the same time) is its last value.
lin_pred <- function(h, t0) {
  if (nrow(h) < 2L || length(unique(h$t)) < 2L) return(h$y[which.max(h$t)])
  b <- stats::coef(stats::lm.fit(cbind(1, h$t), h$y)); unname(b[1L] + b[2L] * t0)
}

# --- metrics ---------------------------------------------------------------------------------------------------------------------------
METHODS <- c("locf", "lin", "popmean", "popmodel", "eb")
interval_score <- function(y, mu, sd, level) {
  z <- stats::qnorm(1 - (1 - level) / 2); l <- mu - z * sd; u <- mu + z * sd; a <- 1 - level
  (u - l) + 2 / a * pmax(l - y, 0) + 2 / a * pmax(y - u, 0)
}
metric_rows <- function(P) {
  out <- list()
  for (m in METHODS) {
    mu <- P[[m]]; sd <- if (m %in% c("locf", "lin", "popmean", "popmodel", "eb")) P[[paste0(m, "_sd")]] else NA
    e <- P$y - mu
    row <- list(method = m, n = nrow(P), mae = mean(abs(e)), rmse = sqrt(mean(e^2)), bias = mean(e))
    for (l in protocol$levels) {
      z <- stats::qnorm(1 - (1 - l) / 2); row[[paste0("cover", round(100 * l))]] <- mean(abs(e) <= z * sd)
      row[[paste0("is", round(100 * l))]] <- mean(interval_score(P$y, mu, sd, l))
    }
    pit <- stats::pnorm(P$y, mu, sd)
    row$pit <- as.numeric(table(factor(pmin(floor(pit * 10), 9L), levels = 0:9)))
    out[[m]] <- row
  }
  out
}

boot_ci <- function(P, stat, B, seed) {
  set.seed(seed)
  ids <- unique(P$id); idx <- split(seq_len(nrow(P)), factor(P$id, levels = ids))
  vals <- numeric(B)
  for (b in seq_len(B)) { pick <- sample.int(length(ids), replace = TRUE); vals[b] <- stat(P[unlist(idx[pick], use.names = FALSE), , drop = FALSE]) }
  stats::quantile(vals, c(0.025, 0.975), names = FALSE)
}

claim_for <- function(P, B, seed) {
  d_locf <- function(x) mean(abs(x$y - x$eb)) - mean(abs(x$y - x$locf))
  d_lin <- function(x) mean(abs(x$y - x$eb)) - mean(abs(x$y - x$lin))
  ci_locf <- boot_ci(P, d_locf, B, seed + 1L); ci_lin <- boot_ci(P, d_lin, B, seed + 2L)
  est <- c(locf = d_locf(P), lin = d_lin(P))
  helps <- ci_locf[2L] < 0 && ci_lin[2L] < 0
  list(maeDifferenceVsLocf = list(estimate = est[["locf"]], ci95 = ci_locf), maeDifferenceVsLinear = list(estimate = est[["lin"]], ci95 = ci_lin), individualizationHelps = helps)
}

horizon_table <- function(L, bins) {
  if (is.null(L)) return(NULL)
  edges <- c(bins, Inf); lab <- character(0); rows <- list()
  for (i in seq_along(bins)) {
    sel <- L$horizon > bins[i] & L$horizon <= edges[i + 1L]
    if (!any(sel)) next
    x <- L[sel, ]
    rows[[length(rows) + 1L]] <- c(list(from = bins[i], to = if (is.finite(edges[i + 1L])) edges[i + 1L] else NA, n = nrow(x), people = length(unique(x$id))),
                                   lapply(stats::setNames(METHODS[METHODS != "popmean"], METHODS[METHODS != "popmean"]), function(m) list(mae = mean(abs(x$y - x[[m]])), rmse = sqrt(mean((x$y - x[[m]])^2)))))
  }
  rows
}

run_dataset <- function(s) {
  r <- predictions(s)
  P <- r$primary
  # the protocol's denominator is the whole eligible set: a person that fell out of every fold is a defect, never a smaller sample
  if (length(unique(P$id)) != r$eligible) stop(sprintf("%s: %d eligible people but %d tested", s$name, r$eligible, length(unique(P$id))))
  B <- protocol$bootstrap$replicates
  mets <- metric_rows(P)
  # each method's own MAE / RMSE with a person-bootstrap CI
  for (m in METHODS) {
    mets[[m]]$maeCi95 <- boot_ci(P, function(x) mean(abs(x$y - x[[m]])), B, protocol$bootstrap$seed + 10L)
    mets[[m]]$rmseCi95 <- boot_ci(P, function(x) sqrt(mean((x$y - x[[m]])^2)), B, protocol$bootstrap$seed + 20L)
    mets[[m]]$is95Ci95 <- boot_ci(P, function(x) mean(interval_score(x$y, x[[m]], x[[paste0(m, "_sd")]], 0.95)), B, protocol$bootstrap$seed + 30L)
    for (l in protocol$levels) mets[[m]][[paste0("cover", round(100 * l), "Ci95")]] <- boot_ci(P, function(x) mean(abs(x$y - x[[m]]) <= stats::qnorm(1 - (1 - l) / 2) * x[[paste0(m, "_sd")]]), B, protocol$bootstrap$seed + 40L + round(100 * l))
  }
  list(dataset = s$name, scale = s$scale, eligiblePeople = r$eligible, testedPeople = length(unique(P$id)), predictions = nrow(P),
       metrics = unname(mets), claim = claim_for(P, B, protocol$bootstrap$seed), horizon = horizon_table(r$later, s$bins), fits = r$fits)
}

# --- main ------------------------------------------------------------------------------------------------------------------------------
specs <- if (selftest) list(spec_selftest()) else list(spec_pbcseq(), spec_aids(arg("jm")), spec_actg(arg("actg")))
res <- lapply(specs, run_dataset)
doc <- list(schema = 1, selftest = selftest, protocolSha256 = sha256_file(file.path(here, "protocol.json")),
            sourceCommit = arg("source-commit", NA_character_), runnerSha256 = sha256_file(file.path(here, "run_individual.R")),
            individualizeSha256 = sha256_file(file.path(engine, "R", "individualize.R")), rVersion = R.version.string,
            datasets = res)
writeLines(jsonlite::toJSON(doc, auto_unbox = TRUE, digits = 8, pretty = TRUE, na = "null"), out_file)
cat(sprintf("wrote %s (%s)\n", out_file, if (selftest) "SELFTEST, not a result" else "evaluation"))
