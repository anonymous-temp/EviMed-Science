# N97 — per-record privacy and attribute inference of a synthetic population (algorithm round P2, 2026-11-03)
#
#   a  the per-record membership risk against its closed form: a generator that copies c of n training records makes those c records' risk
#      (c + 1) / (c + 2) exactly, and a generator that copied nothing leaves every record's risk at a coin (0.5)
#   b  the tail the average hides (Yao et al. 2025): 10% of the people copied, the membership AUC (a mean over all records) stays on the product's
#      green line while the share of records above the risk bound shows the copied tenth
#   c  no row is ever shown, and a count of 1 to 9 people is not: a planted record is not in the result, a small at-risk group is described by nothing
#   d  attribute inference against an independent nearest-neighbour search written in the case, the Wilson intervals against prop.test,
#      and the control: an attribute any stranger can infer has a high attack rate and no risk
#   e  the inferenceRisk band is computed: red for a copying generator, green for fresh draws, and absent under a 1.0.0 label
#   f  the job: population.quality with a holdout, the privacy block and a table of copies, the measures it names, one run twice

.n97_mk <- function(n) {
  x1 <- stats::rnorm(n, 60, 10); x2 <- stats::rbinom(n, 1L, 0.5); g <- sample(c("a", "b", "c"), n, TRUE, c(0.5, 0.3, 0.2))
  data.frame(x1 = x1, x2 = x2, g = g, y = stats::rbinom(n, 1L, stats::plogis(-3 + 0.05 * x1 + 1.2 * x2)), stringsAsFactors = FALSE)
}

vcr_case("N97a", c("AC-04"), function() {
  set.seed(9701L, kind = VCR_RNG_KIND)
  n <- 400L; copied <- 100L
  tr <- .n97_mk(n); ho <- .n97_mk(n)
  syn <- rbind(tr[seq_len(copied), ], .n97_mk(n - copied))
  ranges <- lapply(tr[vapply(tr, is.numeric, logical(1))], function(v) diff(range(v)))
  m_tr <- vcr_gower_nearest(tr, syn, ranges); m_ho <- vcr_gower_nearest(ho, syn, ranges)
  r_tr <- .vcr_record_risk(m_tr$dcr, m_tr$dcr, m_ho$dcr)
  # the closed form: copies sit at distance 0, no holdout record does, so F_train(0) = (c + 1)/(n + 1) and F_hold(0) = 1/(n + 1)
  closed <- (copied + 1) / (copied + 2)
  # fresh draws from the same mechanism: the distances of the two groups to one synthetic table are not independent draws, so the mean risk is
  # averaged over twelve datasets, as C2-16 does for the nearest-neighbour share
  means <- vapply(1:12, function(i) {
    tr_i <- .n97_mk(n); ho_i <- .n97_mk(n); fresh <- .n97_mk(n)
    a <- vcr_gower_nearest(tr_i, fresh, ranges)$dcr; b <- vcr_gower_nearest(ho_i, fresh, ranges)$dcr
    c(train = mean(.vcr_record_risk(a, a, b)), holdout = mean(.vcr_record_risk(b, a, b)))
  }, numeric(2))
  list(pass = all(abs(r_tr[m_tr$dcr == 0] - closed) < 1e-12) && sum(m_tr$dcr == 0) >= copied && all(m_ho$dcr > 0) &&
         all(abs(rowMeans(means) - 0.5) < 0.02) && all(abs(means - 0.5) < 0.08),
       detail = sprintf("400 training records, %d copied into the synthetic table: the copies' risk is %.10f at every one (closed form (c + 1)/(c + 2) = %.10f); fresh draws from the same mechanism, twelve datasets: mean risk %.3f for training and %.3f for holdout records (a coin is 0.5; the largest single dataset is %.3f from it)",
                        copied, mean(r_tr[m_tr$dcr == 0]), closed, mean(means["train", ]), mean(means["holdout", ]), max(abs(means - 0.5))))
})

vcr_case("N97b", c("AC-04"), function() {
  # the mean hides the copied tenth: the membership AUC of the whole table sits at 0.5 + 0.1 / 2 = 0.55 (green is <= 0.55), the share above 0.9
  set.seed(9702L, kind = VCR_RNG_KIND)
  n <- 500L; copied <- 50L
  tr <- .n97_mk(n); ho <- .n97_mk(n); syn <- rbind(tr[seq_len(copied), ], .n97_mk(n - copied))
  d <- vcr_disclosure_report(tr, syn, ho, privacy = list(bound = 0.75, attacks = 200L))
  ranges <- lapply(tr[vapply(tr, is.numeric, logical(1))], function(v) diff(range(v)))
  a <- vcr_gower_nearest(tr, syn, ranges)$dcr; b <- vcr_gower_nearest(ho, syn, ranges)$dcr
  share_tr <- function(bound) mean(.vcr_record_risk(a, a, b) > bound); share_ho <- function(bound) mean(.vcr_record_risk(b, a, b) > bound)
  at75 <- Filter(function(x) isTRUE(x$stated), d$perRecord$riskShares)[[1]]
  band <- vcr_band(d$membershipAuc, vcr_quality_bands()$membershipAuc)
  list(pass = d$membershipAuc < 0.58 && band %in% c("green", "yellow") && share_tr(0.9) >= copied / n && share_tr(0.9) < copied / n + 0.03 &&
         share_ho(0.9) < 0.03 && !is.null(at75$trainingShare) && abs(at75$trainingShare - share_tr(0.75)) < 1e-15 && at75$trainingShare >= copied / n &&
         (is.null(at75$holdoutShare) || abs(at75$holdoutShare - share_ho(0.75)) < 1e-15),
       detail = sprintf("50 of 500 people copied: membership AUC %.3f (band %s, the mean over everyone); the share of training records above a risk of 0.9 is %.3f against %.3f of the holdout, the copied tenth is 0.100; above the stated 0.75: %.3f in the result (%.3f by hand) against %.3f of the holdout",
                        d$membershipAuc, band, share_tr(0.9), share_ho(0.9), at75$trainingShare, share_tr(0.75), share_ho(0.75)))
})

vcr_case("N97c", c("AC-04", "AC-31"), function() {
  # nothing about a person is shown: a planted record with an unmistakable value is copied into the synthetic table and is not in the result;
  # an at-risk group below the floor of ten people is described by nothing; a count of 1 to 9 is withheld and so is its share
  set.seed(9703L, kind = VCR_RNG_KIND)
  n <- 300L
  tr <- .n97_mk(n); ho <- .n97_mk(n)
  tr$x1[1] <- 1234.5678; tr$g[1] <- "rare-site"
  syn <- rbind(tr[1:3, ], .n97_mk(n - 3L))
  d <- vcr_disclosure_report(tr, syn, ho, privacy = list(bound = 0.75, attacks = 100L))
  json <- jsonlite::toJSON(d$perRecord, auto_unbox = TRUE, digits = NA, null = "null")
  few <- Filter(function(x) isTRUE(x$stated), d$perRecord$riskShares)[[1]]
  # many copied: the group is large enough to be described, and every cell shown holds at least ten people
  syn2 <- rbind(tr[1:90, ], .n97_mk(n - 90L))
  d2 <- vcr_disclosure_report(tr, syn2, ho, privacy = list(bound = 0.75, attacks = 100L))
  g2 <- d2$perRecord$atRiskGroup
  shown <- vapply(g2$rows, function(r) r$atRisk, numeric(1))
  json2 <- jsonlite::toJSON(d2$perRecord, auto_unbox = TRUE, digits = NA, null = "null")
  list(pass = !grepl("1234.5678", json, fixed = TRUE) && !grepl("rare-site", json, fixed = TRUE) && !grepl("1234.5678", json2, fixed = TRUE) &&
         isTRUE(few$trainingRecords$suppressed) && is.null(few$trainingRecords$count) && is.null(few$trainingShare) && is.null(d$perRecord$atRiskGroup) &&
         !is.null(g2) && g2$size >= 90L && length(shown) > 0L && all(shown >= vcr_limit("minCellSize", 10)) &&
         isTRUE(d$perRecord$distanceToClosest$exactCopies$suppressed),
       detail = sprintf("3 planted copies of people (one with x1 = 1234.5678 and a one-person site): the count and share above the bound are withheld (a count of 1 to 9), the at-risk group is not described, the exact-copy count is withheld, and neither the value nor the site is anywhere in the result; with 90 copies the group of %d is described by %d cells, the smallest holding %d people",
                        g2$size, length(shown), min(shown)))
})

vcr_case("N97d", c("AC-04"), function() {
  set.seed(9704L, kind = VCR_RNG_KIND)
  n <- 400L
  tr <- .n97_mk(n); ho <- .n97_mk(n)
  vars <- names(tr); ranges <- lapply(tr[vapply(tr, is.numeric, logical(1))], function(v) diff(range(v)))
  # (1) an exact copy: the closest synthetic record on the other columns is the person's own, so the attack succeeds for everyone and the risk is 1
  ai <- vcr_attribute_inference(tr, ho, tr, vars, ranges, secrets = c("g"), attacks = n)
  one <- ai$secrets[[1]]
  # an independent search: for each holdout person the nearest copy on x1, x2, y by plain matrix arithmetic, the guess is that record's g
  rng_x1 <- ranges$x1; rng_y <- ranges$y; rng_x2 <- ranges$x2
  guess <- vapply(seq_len(n), function(i) {
    dist <- (abs(ho$x1[i] - tr$x1) / rng_x1 + abs(ho$x2[i] - tr$x2) / rng_x2 + abs(ho$y[i] - tr$y) / rng_y) / 3
    tr$g[which.min(dist)]
  }, character(1))
  control_hand <- mean(guess == ho$g)
  wil <- stats::prop.test(round(one$successControl * one$attacksControl), one$attacksControl, correct = FALSE)$conf.int
  # (2) fresh draws, the same mechanism: the attack is no better on the people in the data than on strangers
  fresh <- .n97_mk(n)
  ai2 <- vcr_attribute_inference(tr, ho, fresh, vars, ranges, secrets = c("g", "x2"), attacks = n)
  # (3) a column a stranger can read off the others: x2 is a function of x1 in this population. The attack succeeds for everyone and leaks nothing.
  mk3 <- function(m) { x1 <- stats::rnorm(m, 60, 10); data.frame(x1 = x1, x2 = as.integer(x1 > 60), g = sample(c("a", "b", "c"), m, TRUE), y = stats::rnorm(m)) }
  tr3 <- mk3(n); ho3 <- mk3(n); syn3 <- mk3(n)
  rg3 <- lapply(tr3[vapply(tr3, is.numeric, logical(1))], function(v) diff(range(v)))
  ai3 <- vcr_attribute_inference(tr3, ho3, syn3, names(tr3), rg3, secrets = "x2", attacks = n)
  s3 <- ai3$secrets[[1]]
  s2 <- ai2$secrets
  list(pass = abs(one$successMain - 1) < 1e-12 && abs(one$risk - 1) < 1e-12 && abs(one$successControl - control_hand) < 1e-12 &&
         abs(one$successControl - round(one$successControl * n) / n) < 1e-12 &&
         abs(wil[1] - .vcr_wilson(round(one$successControl * n), n)[1]) < 1e-9 && abs(wil[2] - .vcr_wilson(round(one$successControl * n), n)[2]) < 1e-9 &&
         all(vapply(s2, function(s) s$riskLow < 0 && s$riskHigh > 0, logical(1))) &&
         s3$successControl > 0.85 && s3$successMain > 0.85 && s3$riskLow < 0 && s3$riskHigh > 0 && abs(s3$risk) < 0.2,
       detail = sprintf("copy of the training table, secret g: success on training people %.3f, on holdout people %.3f (independent nearest-neighbour search: %.6f against %.6f), risk %.3f; Wilson interval of the control rate (%.4f, %.4f) against prop.test (%.4f, %.4f); fresh draws: risk %s, every interval holds 0; x2 read off x1 for strangers: success %.3f on the people in the data and %.3f on strangers, risk %.3f (%.3f, %.3f)",
                        one$successMain, one$successControl, control_hand, one$successControl, one$risk, .vcr_wilson(round(one$successControl * n), n)[1], .vcr_wilson(round(one$successControl * n), n)[2], wil[1], wil[2],
                        paste(sprintf("%.3f", vapply(s2, function(s) s$risk, numeric(1))), collapse = " and "), s3$successMain, s3$successControl, s3$risk, s3$riskLow, s3$riskHigh))
})

vcr_case("N97e", c("AC-04"), function() {
  # the band the quality suite defined and nothing computed is computed: the worst attribute's lower confidence limit on the risk
  set.seed(9705L, kind = VCR_RNG_KIND)
  n <- 400L; tr <- .n97_mk(n); ho <- .n97_mk(n)
  rep_copy <- vcr_quality_report(tr, tr, ho, inference = list(proper = FALSE, privacy = list(bound = 0.75, attacks = 200L)), copies = list(tr))
  rep_fresh <- vcr_quality_report(tr, .n97_mk(n), ho, inference = list(proper = FALSE, privacy = list(bound = 0.75, attacks = 200L)), copies = list(.n97_mk(n)))
  rep_old <- vcr_quality_report(tr, tr, ho)
  list(pass = identical(rep_copy$bands$inferenceRisk, "red") && identical(rep_fresh$bands$inferenceRisk, "green") && is.null(rep_old$bands$inferenceRisk) &&
         is.null(rep_old$disclosure$attributeInference) && is.null(rep_old$disclosure$perRecord) &&
         rep_copy$disclosure$attributeInference$worstRiskLowerLimit > 0.1 && rep_fresh$disclosure$attributeInference$worstRiskLowerLimit < 0.05,
       detail = sprintf("worst lower confidence limit on the attribute-inference risk: copying generator %.3f (band %s), fresh draws %.3f (band %s); without the privacy request there is no band and no new block",
                        rep_copy$disclosure$attributeInference$worstRiskLowerLimit, rep_copy$bands$inferenceRisk, rep_fresh$disclosure$attributeInference$worstRiskLowerLimit, rep_fresh$bands$inferenceRisk))
})

vcr_case("N97f", c("AC-04", "AC-31"), function() {
  # the job: a quality report of a table of five copies (the engine's own release shape, a `copy` column) with a holdout
  set.seed(9706L, kind = VCR_RNG_KIND)
  n <- 300L; tr <- .n97_mk(n); ho <- .n97_mk(n)
  stacked <- do.call(rbind, lapply(1:5, function(k) cbind(copy = k, if (k == 1L) rbind(tr[1:40, ], .n97_mk(n - 40L)) else .n97_mk(n))))
  in_tr <- vcr_test_input(tr, "tr_n97f@1", source = "observed"); in_ho <- vcr_test_input(ho, "ho_n97f@1", source = "observed")
  in_sy <- vcr_test_input(stacked, "sy_n97f@1", source = "synthetic", kind = "snapshot_file")
  sc <- list(trainingInputId = "tr_n97f@1", syntheticInputId = "sy_n97f@1", holdoutInputId = "ho_n97f@1",
             analyses = list(list(name = "x2 on y", kind = "glm", outcome = "y", predictors = list("x1", "x2"), target = "x2", family = "binomial")),
             privacy = list(membershipRiskBound = 0.75, secrets = list("g", "x2"), attacks = 150L))
  r1 <- vcr_test_run(vcr_test_job("population.quality", sc, list(in_tr, in_ho, in_sy), seed = 9707L))
  r2 <- vcr_test_run(vcr_test_job("population.quality", sc, list(in_tr, in_ho, in_sy), seed = 9707L))
  q <- r1$diagnostics$quality; nm <- vapply(r1$measures, function(m) m$name, character(1))
  list(pass = identical(r1$status, "succeeded") && identical(vcr_output_hash(r1), vcr_output_hash(r2)) && q$release$copies == 5L && nrow(r1$diagnostics$qualityByCopy) == 5L &&
         q$utility$specific[["x2 on y"]]$combined$copies == 5L && isTRUE(q$disclosure$perRecord$available) && length(q$disclosure$attributeInference$secrets) == 2L &&
         all(c("attribute_inference_risk", "s_pmse") %in% nm) && identical(r1$counts$generatedRecords, 5 * n),
       detail = sprintf("a quality job over a table with a copy column (5 copies of 300, the first holding 40 copied people): %d copies read, the declared analysis combined over them, the share of training records above 0.75 is %s against %s of the holdout, attribute-inference risk %.3f (band %s); the same job twice has the same output hash",
                        q$release$copies, format(Filter(function(x) isTRUE(x$stated), q$disclosure$perRecord$riskShares)[[1]]$trainingShare %||% NA), format(Filter(function(x) isTRUE(x$stated), q$disclosure$perRecord$riskShares)[[1]]$holdoutShare %||% NA),
                        max(0, vapply(q$disclosure$attributeInference$secrets, function(s) s$risk, numeric(1))), q$bands$inferenceRisk))
})
