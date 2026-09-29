# N10-N13 — restricted mean survival time, the tau rule, E-values and time zero.

vcr_case("N10", c("AC-12", "AC-30"), function() {
  # Exponential with median 12, tau = 24: RMST = (1 - exp(-lambda*24))/lambda.
  dist <- vcr_dist_exponential_from_median(12)
  analytic <- vcr_rmst_analytic(dist, 24)
  want <- 12.984
  # Large sample, no censoring: the step-function integral must land on the
  # analytic value within 3 standard errors, and the implementation must agree
  # with survRM2 to machine precision on the same data.
  suppressMessages(library(survRM2))
  set.seed(424242L, kind = VCR_RNG_KIND)
  # Large, uncensored: is the step-function integral the analytic value?
  # (survRM2 is not asked to do this one -- `rmst2` builds an O(n^2) working
  # matrix and a 200,000-row call takes the interpreter out with it.)
  n <- 50000L
  d <- data.frame(time = stats::rexp(n, dist$rate), status = 1L)
  r <- vcr_rmst(d$time, d$status, 24)
  # Small, censored: does the implementation equal survRM2 exactly?
  m <- 2000L
  dc <- vcr_sim_tte(m / 2, m / 2, dist, 0.8, list(kind = "uniform", duration = 12), 24)
  s2 <- survRM2::rmst2(dc$time, dc$status, dc$arm, tau = 18)
  r1 <- vcr_rmst(dc$time[dc$arm == 1L], dc$status[dc$arm == 1L], 18)
  d_pkg <- abs(r1$rmst - s2$RMST.arm1$rmst[1])
  d_se <- abs(r1$se - s2$RMST.arm1$rmst[2])
  ok <- abs(round(analytic, 3) - want) < 1e-9 && abs(r$rmst - analytic) <= 3 * r$se &&
    d_pkg < 1e-9 && d_se < 1e-9
  list(pass = ok,
       detail = sprintf("analytic %.6f (want %.3f); empirical %.6f (+-%.6f, %.2f SE away, n=%d uncensored); vs survRM2 on censored n=%d |d|=%.2e (se |d|=%.2e)",
                        analytic, want, r$rmst, r$se, abs(r$rmst - analytic) / r$se, n, m, d_pkg, d_se))
})

vcr_case("N11", c("AC-12", "AC-07"), function() {
  # tau past the shortest arm's longest follow-up must be refused by name,
  # and the refusal must carry the largest usable tau.
  set.seed(7L, kind = VCR_RNG_KIND)
  d <- rbind(
    data.frame(arm = 1L, time = pmin(stats::rexp(200, 0.05), 30), status = 1L),
    data.frame(arm = 0L, time = pmin(stats::rexp(200, 0.07), 18), status = 1L))
  rule <- vcr_tau_rule(d$time, d$status, d$arm, 24)
  ok_rule <- !is.null(rule) && identical(rule$rule, "tau_beyond_followup") &&
    rule$maxUsableTau <= 18 + 1e-9
  path <- tempfile(fileext = ".csv"); utils::write.csv(d, path, row.names = FALSE)
  job <- list(jobId = "job_n11", studyId = "std_n11", kind = "rmst", method = "comparator.rmst",
              methodVersion = "1.0.0", protocolVersion = 1L, seed = 1L, cpuSecondsLimit = 60,
              inputs = list(list(kind = "snapshot", id = "snp_n11", hash = vcr_file_sha256(path), location = path)),
              scenario = list(tau = 24, treatmentColumn = "arm"))
  r <- vcr_run_job(job)
  usable <- vcr_tau_rule(d$time, d$status, d$arm, rule$maxUsableTau)
  unlink(path)
  ok <- ok_rule && identical(r$status, "not_estimable") &&
    identical(r$notEstimableRule, "tau_beyond_followup") && length(r$measures) == 0L &&
    is.null(usable)
  list(pass = ok,
       detail = sprintf("tau=24 refused as %s; largest usable tau %.4f (arm follow-ups %.4f / %.4f) and that tau is accepted; measures=%d",
                        r$notEstimableRule %||% "NULL", rule$maxUsableTau,
                        max(d$time[d$arm == 0L]), max(d$time[d$arm == 1L]), length(r$measures)))
})

vcr_case("N12", c("AC-30"), function() {
  suppressMessages(library(EValue))
  # `comparator.evalue` has no job kind of its own -- `VCR_JOB_METHODS` maps
  # 16 kinds onto 24 methods -- so it rides `pool_evidence`, which is the
  # nearest non-patient-level kind (an E-value is computed from a reported
  # effect, never from rows). See the report: the kind/method pairing rule
  # belongs in the domain, not in each caller's head.
  job <- function(rr, lo = NULL) {
    j <- list(jobId = "job_n12", studyId = "std_n12", kind = "pool_evidence",
              method = "comparator.evalue", methodVersion = "1.0.0", protocolVersion = 1L,
              seed = 1L, cpuSecondsLimit = 30, inputs = list(list(kind = "assumption", id = "asm_rr@1")),
              scenario = list(riskRatio = rr, confidenceLimit = lo))
    vcr_run_job(j)
  }
  r <- job(3.9, 1.8)
  if (!identical(r$status, "succeeded")) {
    return(list(pass = FALSE, detail = sprintf("job status %s: %s", r$status,
      paste(vapply(r$diagnostics$issues %||% list(), function(i) i$code, character(1)), collapse = ","))))
  }
  point <- Filter(function(m) m$name == "e_value", r$measures)[[1]]$value
  bound <- Filter(function(m) m$name == "e_value_confidence_limit", r$measures)[[1]]$value
  pkg_point <- EValue::evalues.RR(3.9)[2, 1]
  pkg_bound <- EValue::evalues.RR(3.9, lo = 1.8)[2, 2]
  ok <- abs(point - 7.26) < 5e-3 && abs(bound - 3.0) < 1e-6 &&
    abs(point - pkg_point) < 1e-6 && abs(bound - pkg_bound) < 1e-6
  list(pass = ok,
       detail = sprintf("RR 3.9 -> %.6f (want 7.26, EValue %.6f); CI limit 1.8 -> %.6f (want 3.0, EValue %.6f); max|d| vs package %.2e",
                        point, pkg_point, bound, pkg_bound, max(abs(point - pkg_point), abs(bound - pkg_bound))))
})

vcr_case("N13", c("AC-12"), function() {
  # Immortal time: treatment starts after eligibility, and only survivors can
  # start it. True hazard ratio is 1. Classifying by "ever treated" and
  # starting the clock at eligibility must look strongly protective;
  # aligning the clock (counting-process form) must recover 1.
  suppressMessages(library(survival))
  set.seed(20260928L, kind = VCR_RNG_KIND)
  n <- 4000L
  t_event <- stats::rexp(n, 0.05)
  t_start <- stats::rexp(n, 0.04)              # would-be initiation time
  admin <- 40
  obs <- pmin(t_event, admin)
  status <- as.integer(t_event <= admin)
  ever <- as.integer(t_start < obs)            # only survivors can start
  naive <- summary(survival::coxph(survival::Surv(obs, status) ~ ever))$coefficients
  # Correct alignment: split each subject at their initiation time.
  split <- do.call(rbind, lapply(seq_len(n), function(i) {
    if (ever[i] == 1L) {
      rbind(data.frame(start = 0, stop = t_start[i], event = 0L, trt = 0L),
            data.frame(start = t_start[i], stop = obs[i], event = status[i], trt = 1L))
    } else {
      data.frame(start = 0, stop = obs[i], event = status[i], trt = 0L)
    }
  }))
  aligned <- summary(survival::coxph(survival::Surv(start, stop, event) ~ trt, data = split))$coefficients
  biased <- naive[1, "z"] < -3
  recovered <- abs(aligned[1, "coef"]) <= 3 * aligned[1, "se(coef)"]
  list(pass = biased && recovered,
       detail = sprintf("true logHR 0; misaligned logHR %+.4f (z %.2f, %s); aligned logHR %+.4f (se %.4f, %.2f SE from 0)",
                        naive[1, "coef"], naive[1, "z"], if (biased) "biased as expected" else "NOT biased",
                        aligned[1, "coef"], aligned[1, "se(coef)"],
                        abs(aligned[1, "coef"]) / aligned[1, "se(coef)"]))
})
