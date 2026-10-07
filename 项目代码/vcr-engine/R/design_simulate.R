# ---------------------------------------------------------------------------
# design_simulate.R — the ADEMP runner: aims, data-generating mechanism,
# estimand, methods, performance measures (Morris et al. 2019; plan 5.4).
#
# Hidden knowledge:
#
# - **Replicates are stored, not accumulated.** Every replicate's raw
#   quantities are kept by index and reduced once at the end, in index order.
#   That is what makes a resumed run and a one-shot run produce the same bits,
#   and a 1-core and an 8-core run produce the same bits (AC-31). Running
#   totals are smaller and are the reason most simulation frameworks cannot
#   promise this.
# - **Failed replicates are counted and reported, never dropped.** ADEMP is
#   explicit about it and it is also the honest thing: a design whose analysis
#   fails to converge 4% of the time has an operating characteristic that
#   includes the 4%.
# - **The checkpoint carries the scenario hash.** Resuming into a checkpoint
#   written for a different scenario would silently blend two experiments, so
#   the hash is checked and a mismatch starts over rather than continuing.
# - **Cancellation is checked between batches and the batch size is chosen
#   for latency, not throughput.** 500 replicates of a 300-patient survival
#   trial is well under a second, so "cancel takes effect immediately" is true
#   to within a batch, and whatever batches finished are kept (AC-38).
# - **The replicate count is derived, not typed.** `vcr_plan_replicates()`
#   turns a target Monte-Carlo standard error into a count via
#   p(1-p)/target^2, then applies the floors (20,000 under the null, 5,000
#   under an alternative). A scenario that asks for a type-I error to +-0.001
#   gets 24,375 whether or not anyone remembered (AC-28, N05).
# - **The analytic value travels with the simulated one.** Where a closed form
#   exists it is computed and attached, and the difference is reported in
#   MCSE units so AC-29 ("within 3 MCSE") is a number on the result rather
#   than a thing someone checks by hand.
# - **A design the runner does not implement is refused, never simulated as
#   something else.** Binary exact single-arm, frozen Simon boundaries and the
#   explicit stratified beta-binomial external-control generator have distinct
#   branches before any two-arm default. Unsupported endpoints are refused.
#   The group-sequential run is the time-to-event one
#   (the domain's design table lists no other), and it looks in *calendar* time: the k-th
#   target event's own calendar time decides who has entered and who has been
#   observed, which is what makes `expected_events` and `expected_sample_size`
#   at the stopping look mean something (CE-9).
# - **A failed replicate counts against the design.** Power, type-I error and
#   coverage are divided by the replicates that ran, with a failure counted as
#   "did not reject / did not cover"; bias and the empirical SE can only use the
#   replicates that produced an estimate and say how many those were. Dropping
#   the failures from the denominator (what the first version did) makes an
#   analysis that breaks down in exactly the hard cases look better than one
#   that does not (CE-27).
# ---------------------------------------------------------------------------

# `vcr_is_null_scenario` (the estimand decides, an explicit `truth$null` wins, a JSON
# integer 0 is as null as a double 0) is defined once, in protocol.R, next to the
# replicate floor and the measure names that share it (CE-27, EB-18).

#' How many replicates this scenario needs.
#' Hidden knowledge: "is this the null scenario?" is answered from the
#' *estimand*, not from a field name. A binary scenario written as
#' `controlRate = 0.3, treatmentRate = 0.3` has no `effect` field and no
#' `hazardRatio` field, so a name-based test calls it an alternative, gives it
#' the 5,000-replicate floor instead of 20,000, and labels its measure `power`
#' instead of `type_one_error`. Both errors are silent and both survive review.
vcr_plan_replicates <- function(scenario, requested = NULL, estimand = NULL) {
  flag <- scenario$truth$null
  is_null_case <- if (is.logical(flag) && length(flag) == 1L && !is.na(flag)) flag
                  else if (!is.null(estimand) && length(estimand) == 1L && is.finite(estimand)) abs(estimand) < 1e-12
                  else vcr_is_null_scenario(scenario)
  target <- vcr_scalar(scenario$targetMcse, NULL)
  p <- if (is_null_case) (vcr_scalar(scenario$analysis$alpha, 0.025)) else 0.5
  floor_ <- vcr_replicate_floor(is_null_case, target, p)
  n <- as.integer(max(floor_, requested %||% 0))
  cap <- vcr_max_replicates()
  capped <- n > cap
  list(replicates = as.integer(min(n, cap)), isNull = is_null_case, targetMcse = target,
       floor = floor_, basisProportion = p, capped = capped)
}

#' Monte-Carlo standard errors for the ADEMP performance measures.
vcr_mcse_proportion <- function(p, n) sqrt(p * (1 - p) / n)
vcr_mcse_mean <- function(x) stats::sd(x) / sqrt(length(x))
vcr_mcse_empse <- function(x) stats::sd(x) / sqrt(2 * (length(x) - 1))

#' The designs each endpoint can be simulated under. Anything else is refused.
VCR_SIMULATED_DESIGNS <- c("two_arm_fixed", "group_sequential", "single_arm", "single_arm_external", "simon_two_stage")

#' The documented bias of the analytic log-rank power, as a proportion. It is a
#' first-order approximation (`vcr_logrank_power`): measured against an
#' independent 12,000-replicate simulation it is within about a percentage point
#' at the effect sizes a trial is designed for, and its largest measured gap is 1.3
#' points (HR 0.6, 140/70: 0.7544 against 0.7412). The cross-check against a
#' simulation holds an approximation to three Monte-Carlo errors *plus* this, because
#' at a hundred thousand replicates the error alone is a fifth of a point, and a
#' correct approximation would read as disagreeing with a correct simulation.
VCR_LOGRANK_APPROXIMATION_BIAS <- 0.015
VCR_ANALYSIS_METHODS <- list(continuous = c("ttest", "ancova"), binary = c("risk_difference", "logistic"),
                             time_to_event = c("logrank", "rmst"))

.vcr_check_design <- function(scenario) {
  kind <- scenario$design$kind %||% "two_arm_fixed"
  endpoint <- scenario$endpoint$type
  if (!(kind %in% VCR_SIMULATED_DESIGNS)) {
    vcr_abort("design_not_supported", "scenario.design.kind",
              sprintf("'%s' is not a declared simulated design and is not run as something else.", kind))
  }
  if (!(endpoint %in% names(VCR_ANALYSIS_METHODS))) {
    vcr_abort("endpoint_not_supported", "scenario.endpoint.type", "The endpoint is continuous, binary or time_to_event.")
  }
  if (kind %in% c("single_arm","single_arm_external","simon_two_stage")) {
    # the analyses a single-arm design runs, by endpoint (VCR_SINGLE_ARM_METHODS, the domain's table): the external-control and
    # Simon designs are binary-endpoint designs, the plain single-arm design also has a continuous and a time-to-event analysis
    allowed <- VCR_SINGLE_ARM_METHODS[[kind]][[endpoint]]
    if (is.null(allowed)) vcr_abort("design_not_supported","scenario.endpoint.type",
      if (identical(kind, "single_arm")) "A single-arm design is simulated for a binary, continuous or time-to-event endpoint." else "This single-arm implementation requires a binary endpoint.")
    method<-scenario[["analysis"]][["method"]] %||% allowed[1]
    if (!(method %in% allowed)) vcr_abort("scenario_value_invalid","scenario.analysis.method","The analysis must match the declared single-arm design.")
    issues<-vcr_validate_scenario("design.simulate",scenario)
    if(length(issues))vcr_abort(issues[[1]]$code,issues[[1]]$field,issues[[1]]$detail)
    return(method)
  }
  method <- scenario$analysis$method %||% VCR_ANALYSIS_METHODS[[endpoint]][1]
  if (!(method %in% VCR_ANALYSIS_METHODS[[endpoint]])) {
    vcr_abort("scenario_value_invalid", "scenario.analysis.method",
              sprintf("A %s endpoint is analysed by %s.", endpoint, paste(VCR_ANALYSIS_METHODS[[endpoint]], collapse = " or ")))
  }
  if (identical(kind, "group_sequential")) {
    if (!identical(endpoint, "time_to_event") || !identical(method, "logrank")) {
      vcr_abort("design_not_supported", "scenario.design.kind",
                "A group-sequential design is simulated for a time-to-event endpoint analysed by the log-rank test; other endpoints are not run as a fixed design.")
    }
    rates <- vcr_num(scenario$design$informationRates)
    if (length(rates) < 2L) vcr_abort("scenario_field_missing", "scenario.design.informationRates", "A group-sequential design lists at least two information rates.")
  }
  method
}

.vcr_need <- function(x, field, what) {
  v <- vcr_scalar(x, NULL)
  if (is.null(v)) vcr_abort("scenario_field_missing", field, what)
  v
}

.vcr_single_binary_runner <- function(sc,alpha,sided) {
  d<-sc$design;tr<-sc$truth;n<-vcr_scalar(d$n);p0<-vcr_scalar(tr$nullRate);p<-vcr_scalar(tr$responseRate)
  if (identical(d$kind,"single_arm")) {
    rule<-vcr_exact_binomial(n,p0,p,alpha,sc$analysis$alternative)
    return(list(estimand=p-p0,run=function(i){
      x<-stats::rbinom(1,n,p);k<-x+1L
      c(estimate=x/n-p0,se=sqrt(p*(1-p)/n),p=rule$pValues[k],reject=as.numeric(rule$reject[k]),
        ci_low=rule$ciLow[k]-p0,ci_high=rule$ciHigh[k]-p0,sampleSize=n,generatedRecords=n)
    }))
  }
  n1<-vcr_scalar(d$n1);r1<-vcr_scalar(d$r1);r<-vcr_scalar(d$r)
  list(estimand=p-p0,run=function(i){
    x1<-stats::rbinom(1,n1,p);stop_early<-x1<=r1
    size<-if(stop_early)n1 else n
    x<-x1+if(stop_early)0 else stats::rbinom(1,n-n1,p)
    # The stopped sample proportion is explicitly the naive estimator. No
    # fixed-sample CI is mislabeled as a sequentially adjusted confidence bound.
    c(estimate=x/size-p0,reject=as.numeric(!stop_early && x>r),earlyStop=as.numeric(stop_early),
      sampleSize=size,generatedRecords=size,look=if(stop_early)1 else 2)
  })
}

#' A synthetic external-control operating-characteristic model, not observed
#' controls: fixed target covariate mixture, selected historical mixture, two
#' stratum response laws and finite beta parameter information. Standardizing
#' both arms to the declared treatment target defines ATT. Historical drift is
#' uncorrected by the analysis and its resulting bias is deliberately measured.
.vcr_external_binary_runner <- function(sc,alpha,sided) {
  ex<-sc$external;n<-vcr_scalar(sc$design$n);ne<-vcr_scalar(ex$n)
  q<-vcr_scalar(ex$targetPrevalence);qs<-vcr_scalar(ex$sourcePrevalence);w<-c(1-q,q)
  p0<-vcr_num(sc$truth$controlRates);p1<-vcr_num(sc$truth$treatmentRates)
  info<-vcr_scalar(ex$parameterInformation);drift<-vcr_scalar(ex$logOddsDrift)
  sensitivity<-vcr_num(ex$sensitivityDrifts);estimand<-sum(w*(p1-p0))
  nt<-c(n-round(n*q),round(n*q));active<-w>0
  unsupported<-any(active & (nt<2 | c(1-qs,qs)==0))
  if(unsupported)return(list(estimand=estimand,notEstimableRule="outside_common_support",externalControl=list(
    targetPrevalence=q,sourcePrevalence=qs,estimand="ATT",reason="A target stratum has no historical support or fewer than two trial draws.")))
  shift<-function(p,delta)ifelse(p<=0,0,ifelse(p>=1,1,stats::plogis(stats::qlogis(p)+delta)))
  compare<-function(yt,nc,up,uc,delta){
    mu<-shift(p0,delta)
    latent<-mu;inside<-mu>0 & mu<1
    latent[inside]<-stats::qbeta(up[inside],info*mu[inside],info*(1-mu[inside]))
    yc<-stats::qbinom(uc,nc,latent)
    pt<-yt/pmax(1,nt);pc<-yc/pmax(1,nc)
    ess<-1/sum(w[active]^2/nc[active])
    if(any(nc[active]<2)||!is.finite(ess)||ess<vcr_domain()$limits$essFloor)return(c(estimate=NA_real_,se=NA_real_,reject=NA_real_,ci_low=NA_real_,ci_high=NA_real_,externalEss=ess,externalParameterVariance=NA_real_))
    # Unbiased p(1-p) estimate under the declared beta-binomial law. Finite
    # historical parameter uncertainty persists as n_external increases.
    variance_p<-pc*(1-pc)*nc/(pmax(1,nc-1))*(info+1)/info
    vt<-pt*(1-pt)/pmax(1,nt-1)
    vc<-variance_p*(1+(nc-1)/(info+1))/pmax(1,nc)
    parameter_variance<-sum(w[active]^2*variance_p[active]/(info+1))
    estimate<-sum(w*(pt-pc));se<-sqrt(sum(w[active]^2*(vt[active]+vc[active])))
    z<-if(se>0)estimate/se else if(estimate==0)0 else sign(estimate)*Inf
    critical<-stats::qnorm(1-alpha/sided)
    pval<-if(sided==1)stats::pnorm(z,lower.tail=FALSE) else 2*stats::pnorm(-abs(z))
    c(estimate=estimate,se=se,p=pval,reject=as.numeric(if(sided==1)z>critical else abs(z)>critical),
      ci_low=estimate-critical*se,ci_high=estimate+critical*se,externalEss=ess,externalParameterVariance=parameter_variance)
  }
  list(estimand=estimand,externalControl=list(kind=ex$kind,estimand="ATT",targetPrevalence=q,sourcePrevalence=qs,
    parameterInformation=info,logOddsDrift=drift,analysis="stratified risk difference with beta-binomial variance; asymptotic Wald inference",
    limitation="Synthetic binary two-stratum scenario only. Unmeasured confounding, finite-sample calibration and drift are not certified away.",sensitivityDrifts=sensitivity),
    run=function(i){
      nc1<-stats::rbinom(1,ne,qs);nc<-c(ne-nc1,nc1)
      yt<-stats::rbinom(2,nt,p1);up<-stats::runif(2);uc<-stats::runif(2)
      main<-compare(yt,nc,up,uc,drift)
      extra<-numeric(0)
      for(k in seq_along(sensitivity)){
        r<-compare(yt,nc,up,uc,sensitivity[k])
        covered<-if(all(is.finite(r[c("ci_low","ci_high")])))as.numeric(r["ci_low"]<=estimand && r["ci_high"]>=estimand) else NA_real_
        extra<-c(extra,stats::setNames(c(r["estimate"],r["reject"],covered),paste0(c("sensitivityEstimate_","sensitivityReject_","sensitivityCoverage_"),k)))
      }
      c(main,sampleSize=n,externalSize=ne,generatedRecords=n+ne,extra)
    })
}

#' Build the generate/analyse pair for a scenario.
#'
#' A scenario is
#'   design:   list(kind, nTreat, nControl, allocation, informationRates, spending, ...)
#'   endpoint: list(type, ...)
#'   truth:    the data-generating parameters (the effect is required)
#'   analysis: list(method, alpha, sided, tau, covariates)
#'   accrual:  list(kind, duration, followup, dropoutAnnual)
vcr_scenario_runner <- function(scenario) {
  method <- .vcr_check_design(scenario)
  endpoint <- scenario$endpoint$type
  design <- scenario$design
  truth <- scenario$truth
  analysis <- scenario$analysis %||% list()
  alpha <- vcr_scalar(analysis$alpha, 0.025)
  sided <- vcr_check_sided(analysis$sided)
  if (identical(design$kind, "single_arm") && !identical(endpoint, "binary")) return(.vcr_single_arm_runner(scenario, alpha, sided))
  if (design$kind %in% c("single_arm","simon_two_stage")) return(.vcr_single_binary_runner(scenario,alpha,sided))
  if (identical(design$kind,"single_arm_external")) return(.vcr_external_binary_runner(scenario,alpha,sided))
  n1 <- .vcr_need(design$nTreat, "scenario.design.nTreat", "A simulated design states its treatment-arm size.")
  n0 <- vcr_scalar(design$nControl, n1)
  gs <- identical(design$kind, "group_sequential")
  gs_design <- if (gs) vcr_group_sequential(vcr_num(design$informationRates), alpha / sided,
                                            design$spending %||% "obrien_fleming") else NULL
  acc <- scenario$accrual
  # a deterministic calendar length, when the scenario states an accrual
  duration_fixed <- if (!is.null(acc) && !is.null(acc$duration)) vcr_scalar(acc$duration, 0) + vcr_scalar(acc$followup, 0) else NA_real_

  if (identical(endpoint, "continuous")) {
    effect <- .vcr_need(truth$effect, "scenario.truth.effect", "A continuous scenario states the treatment effect (0 for the null).")
    sd <- vcr_scalar(truth$sd, 1)
    rho <- vcr_scalar(truth$baselineCorrelation, 0)
    return(list(estimand = effect, run = function(i) {
      d <- vcr_sim_continuous(n1, n0, effect, sd, rho)
      r <- if (identical(method, "ancova")) vcr_analyse_ancova(d, alpha, sided) else vcr_analyse_ttest(d, alpha, sided)
      c(r, sampleSize = n1 + n0, duration = duration_fixed)
    }))
  }

  if (identical(endpoint, "binary")) {
    p0 <- vcr_scalar(truth$controlRate, NULL)
    p1 <- vcr_binary_treatment_rate(p0, vcr_scalar(truth$treatmentRate, NULL),
                                    vcr_scalar(truth$riskDifference, NULL), vcr_scalar(truth$oddsRatio, NULL))
    cl <- vcr_scalar(truth$covariateLogit, 0)
    estimand <- if (identical(method, "logistic")) log((p1 / (1 - p1)) / (p0 / (1 - p0))) else p1 - p0
    return(list(estimand = estimand, run = function(i) {
      d <- vcr_sim_binary(n1, n0, p0, p_treat = p1, covariate_logit = cl)
      r <- if (identical(method, "logistic")) vcr_analyse_logistic(d, alpha, sided) else vcr_analyse_risk_difference(d, alpha, sided)
      c(r, sampleSize = n1 + n0, duration = duration_fixed)
    }))
  }

  # time to event
  hr <- .vcr_need(truth$hazardRatio, "scenario.truth.hazardRatio", "A time-to-event scenario states the hazard ratio (1 for the null).")
  dist <- vcr_control_distribution(truth)
  accrual <- acc %||% list(kind = "uniform", duration = 0)
  followup <- vcr_scalar(acc$followup, Inf)
  dropout <- vcr_scalar(acc$dropoutAnnual, 0)
  max_fu <- vcr_scalar(acc$maxFollowup, Inf)
  tau <- vcr_scalar(analysis$tau, NULL)
  if (identical(method, "rmst") && is.null(tau)) vcr_abort("scenario_field_missing", "scenario.analysis.tau", "An RMST analysis states its horizon tau.")
  estimand <- if (identical(method, "rmst")) {
    vcr_rmst_analytic(.vcr_scale_hazard(dist, hr), tau) - vcr_rmst_analytic(dist, tau)
  } else log(hr)
  list(estimand = estimand, groupSequential = gs_design, run = function(i) {
    d <- vcr_sim_tte(n1, n0, dist, hr, accrual, followup, dropout, max_followup = max_fu)
    dur <- if (is.finite(followup)) .vcr_accrual_end(d$entry, accrual) + followup else max(d$entry + d$time)
    if (identical(method, "rmst")) {
      rule <- vcr_tau_rule(d$time, d$status, d$arm, tau)
      if (!is.null(rule)) return(c(estimate = NA_real_, se = NA_real_, statistic = NA_real_,
                                   p = NA_real_, reject = NA_real_, ci_low = NA_real_,
                                   ci_high = NA_real_, events = sum(d$status), sampleSize = n1 + n0, duration = dur))
      r <- vcr_rmst_difference(d$time, d$status, d$arm, tau)
      z <- r$estimate / r$se
      crit <- stats::qnorm(1 - alpha / sided)
      return(c(estimate = r$estimate, se = r$se, statistic = z,
               p = if (sided == 1) stats::pnorm(z, lower.tail = FALSE) else 2 * stats::pnorm(-abs(z)),
               reject = as.numeric(if (sided == 1) z > crit else abs(z) > crit),
               ci_low = r$estimate - crit * r$se, ci_high = r$estimate + crit * r$se,
               events = sum(d$status), sampleSize = n1 + n0, duration = dur))
    }
    if (gs) return(.vcr_run_group_sequential(d, gs_design, alpha, sided))
    r <- vcr_analyse_logrank(d, alpha, sided)
    c(r, sampleSize = n1 + n0, duration = dur)
  })
}

#' The control distribution a time-to-event scenario states: an explicit
#' distribution, or a median (exponential). Neither is refused.
vcr_control_distribution <- function(truth) {
  d <- truth$controlDistribution
  if (is.list(d)) return(vcr_dist_normalize(d))
  m <- vcr_scalar(truth$controlMedian, NULL)
  if (is.null(m) || !(m > 0)) {
    vcr_abort("scenario_field_missing", "scenario.truth.controlMedian", "A time-to-event scenario states a control median or a control distribution.")
  }
  vcr_dist_exponential_from_median(m)
}

#' Numeric fields of a distribution spec as numbers, whatever the JSON parser
#' made of them.
vcr_dist_normalize <- function(d) {
  out <- d
  for (k in c("rate", "shape", "scale")) if (!is.null(d[[k]])) out[[k]] <- vcr_scalar(d[[k]])
  for (k in c("breaks", "rates")) if (!is.null(d[[k]])) out[[k]] <- vcr_num(d[[k]])
  out
}

.vcr_scale_hazard <- function(dist, hr) {
  kind <- dist$kind %||% "exponential"
  if (identical(kind, "exponential")) return(list(kind = "exponential", rate = dist$rate * hr))
  if (identical(kind, "weibull")) return(list(kind = "weibull", shape = dist$shape,
                                              scale = dist$scale * hr^(-1 / dist$shape)))
  if (identical(kind, "piecewise")) return(list(kind = "piecewise", breaks = dist$breaks,
                                                rates = dist$rates * hr))
  stop(".vcr_scale_hazard: unknown distribution kind ", kind)
}

#' One group-sequential time-to-event replicate, looking in calendar time.
#'
#' Look k is the calendar time of the k-th target event. Only those who have
#' entered by then are in the analysis, each observed up to that time; the last
#' look uses all the data. The trial stops at the first crossing, and the
#' replicate reports the events and the sample size *at that look* (with the
#' calendar time), which is what the design's expected values are averages of.
.vcr_run_group_sequential <- function(d, gs, alpha, sided) {
  cal <- d$entry + d$time
  ev_cal <- sort(cal[d$status == 1L])
  total_events <- length(ev_cal)
  K <- length(gs$informationRates)
  targets <- ceiling(gs$informationRates * total_events)
  rejected <- 0; look <- K
  est <- NA_real_; se <- NA_real_
  events_at <- total_events; n_at <- nrow(d); dur_at <- max(cal)
  for (k in seq_len(K)) {
    if (targets[k] < 2) next
    if (k < K) {
      cutoff <- ev_cal[min(targets[k], total_events)]
      dk <- d[d$entry <= cutoff, , drop = FALSE]
      dk$status <- as.integer(dk$status == 1L & (dk$entry + dk$time) <= cutoff)
      dk$time <- pmin(dk$time, cutoff - dk$entry)
    } else {
      cutoff <- max(cal); dk <- d
    }
    r <- vcr_analyse_logrank(dk, alpha, sided)
    z <- -as.numeric(r["statistic"])        # upper-tail convention: benefit is positive
    est <- as.numeric(r["estimate"]); se <- as.numeric(r["se"])
    hit <- is.finite(z) && (if (sided == 1) z > gs$criticalValues[k] else abs(z) > gs$criticalValues[k])
    if (hit) {
      rejected <- 1; look <- k
      events_at <- sum(dk$status); n_at <- nrow(dk); dur_at <- cutoff
      break
    }
    if (k == K) { events_at <- total_events; n_at <- nrow(d); dur_at <- max(cal) }
  }
  crit <- stats::qnorm(1 - alpha / sided)
  c(estimate = est, se = se, statistic = NA_real_, p = NA_real_,
    reject = rejected, ci_low = est - crit * se, ci_high = est + crit * se,
    events = events_at, look = look, sampleSize = n_at, duration = dur_at)
}

#' Run a scenario. Returns the result's `measures`, `diagnostics` and the raw
#' per-replicate matrix (which the caller may write out as a table).
vcr_run_simulation <- function(scenario, seed, replicates = NULL, cores = 1L,
                               checkpoint = NULL, cancel_file = NULL,
                               batch_size = 500L, progress = NULL,
                               cpu_seconds_limit = Inf) {
  runner <- vcr_scenario_runner(scenario)
  if(!is.null(runner$notEstimableRule))return(list(status="not_estimable",notEstimableRule=runner$notEstimableRule,measures=list(),issues=list(),values=NULL,
    scenarioHash=vcr_scenario_hash(scenario),diagnostics=list(conclusion="not_estimable",replicatesCompleted=0,replicatesUsable=0,externalControl=runner$externalControl)))
  plan <- vcr_plan_replicates(scenario, replicates, runner$estimand)
  n_rep <- plan$replicates
  hash <- vcr_scenario_hash(scenario)
  started <- proc.time()[["elapsed"]]
  cpu0 <- vcr_cpu_seconds()
  # A batch of zero would never advance; a batch of one is legal and slow.
  batch_size <- max(1L, as.integer(batch_size %||% 500L))

  done <- 0L
  values <- NULL
  first_failure <- NULL
  bank <- vcr_stream_bank(seed)
  if (!is.null(checkpoint) && file.exists(checkpoint)) {
    cp <- tryCatch(readRDS(checkpoint), error = function(e) NULL)
    if (!is.null(cp) && identical(cp$scenarioHash, hash) && identical(as.integer(cp$seed), as.integer(seed)) &&
        identical(as.integer(cp$batchSize), as.integer(batch_size))) {
      done <- cp$done; values <- cp$values
      bank <- vcr_stream_bank(seed, state = cp$streamState)
    }
  }

  canceled <- FALSE
  over_budget <- FALSE
  while (done < n_rep) {
    if (!is.null(cancel_file) && file.exists(cancel_file)) { canceled <- TRUE; break }
    reason <- vcr_interrupt()
    if (identical(reason, "canceled")) { canceled <- TRUE; break }
    cpu_now <- vcr_cpu_seconds() - cpu0
    if (identical(reason, "cpu_budget") || (is.finite(cpu_seconds_limit) && cpu_now > cpu_seconds_limit)) { over_budget <- TRUE; break }
    take <- min(batch_size, n_rep - done)
    streams <- bank$take(take)
    idx <- done + seq_len(take)
    out <- vcr_map_streams(streams, function(i) {
      tryCatch(runner$run(i), error = function(e) {
        structure(stats::setNames(NA_real_, "estimate"), failure = substr(conditionMessage(e), 1, 200))
      })
    }, cores = cores, indices = idx)
    if (is.null(first_failure)) {
      for (o in out) { f <- attr(o, "failure"); if (!is.null(f)) { first_failure <- f; break } }
    }
    nms <- unique(unlist(lapply(out, names)))
    mat <- matrix(NA_real_, nrow = take, ncol = length(nms), dimnames = list(NULL, nms))
    for (j in seq_len(take)) { v <- out[[j]]; mat[j, names(v)] <- as.numeric(v) }
    values <- if (is.null(values)) mat else {
      cols <- union(colnames(values), colnames(mat))
      fill <- function(m) { add <- setdiff(cols, colnames(m)); if (length(add)) m <- cbind(m, matrix(NA_real_, nrow(m), length(add), dimnames = list(NULL, add))); m[, cols, drop = FALSE] }
      rbind(fill(values), fill(mat))
    }
    done <- done + take
    if (!is.null(checkpoint)) {
      tmp <- paste0(checkpoint, ".tmp")
      saveRDS(list(scenarioHash = hash, seed = seed, done = done, values = values,
                   streamState = bank$state(), batchSize = batch_size), tmp)
      file.rename(tmp, checkpoint)
    }
    if (!is.null(progress)) progress(done, n_rep)
  }

  summary <- vcr_summarize_replicates(values, runner$estimand, scenario, done)
  if(!is.null(runner$externalControl) && !is.null(values) && nrow(values)>0) {
    ec<-runner$externalControl;ec$sensitivity<-list()
    for(k in seq_along(ec$sensitivityDrifts)){
      est<-values[,paste0("sensitivityEstimate_",k)];rej<-values[,paste0("sensitivityReject_",k)];cov<-values[,paste0("sensitivityCoverage_",k)]
      good<-is.finite(est);total<-nrow(values)
      prob<-sum(rej[is.finite(rej)])/total;coverage<-sum(cov[is.finite(cov)])/total
      ec$sensitivity[[k]]<-list(logOddsDrift=ec$sensitivityDrifts[k],replicates=total,usable=sum(good),
        rejectionProbability=prob,rejectionMcse=vcr_mcse_proportion(prob,total),coverage=coverage,coverageMcse=vcr_mcse_proportion(coverage,total),
        bias=if(sum(good)>1)mean(est[good])-runner$estimand else NULL,biasMcse=if(sum(good)>1)vcr_mcse_mean(est[good]) else NULL)
    }
    summary$diagnostics$externalControl<-ec
  }
  # A run held below its precision floor by this engine's replicate ceiling
  # (`VCR_ENGINE_MAX_REPLICATES`) reports its MCSEs, and says it is limited.
  if (isTRUE(plan$capped)) summary$diagnostics$conclusion <- "limited"
  cpu <- vcr_cpu_seconds() - cpu0
  all_failed <- done > 0L && isTRUE(summary$diagnostics$replicatesUsable == 0)
  issues <- list()
  if (all_failed) issues[[length(issues) + 1L]] <- vcr_issue("replicates_all_failed", "replicates",
    sprintf("Every replicate failed to produce an estimate%s.", if (!is.null(first_failure)) paste0(" (first failure: ", first_failure, ")") else ""))
  if (over_budget) issues[[length(issues) + 1L]] <- vcr_issue("cpu_budget_exhausted", "cpuSecondsLimit",
    "The CPU budget ran out before every replicate ran; the measures below use the replicates that finished.")
  list(
    measures = summary$measures,
    diagnostics = c(summary$diagnostics, list(
      replicatesPlanned = n_rep, replicatesCompleted = done,
      replicateFloor = plan$floor, isNullScenario = plan$isNull, replicatesCapped = plan$capped,
      targetMcse = plan$targetMcse, batchSize = batch_size, cores = cores,
      canceled = canceled, overCpuBudget = over_budget,
      firstFailure = first_failure,
      elapsedSeconds = proc.time()[["elapsed"]] - started, cpuSeconds = cpu)),
    issues = issues,
    values = values, scenarioHash = hash,
    status = if (canceled) "canceled" else if (over_budget || all_failed) "failed" else "succeeded"
  )
}

#' Reduce the per-replicate matrix to ADEMP performance measures with MCSEs.
#'
#' An empty or absent `performance` means every measure the method defines
#' (the domain's rule; an empty list used to mean "none" and returned a
#' succeeded result with no measures, EB-12).
vcr_summarize_replicates <- function(values, estimand, scenario, done) {
  if (is.null(values) || !nrow(values)) {
    return(list(measures = list(), diagnostics = list(replicatesUsable = 0, replicatesFailed = done)))
  }
  wanted <- vcr_chr(scenario$performance)
  all_measures <- length(wanted) == 0L
  if (all_measures) wanted <- c("power", "type_one_error", "bias", "coverage", "expected_sample_size", "duration_months", "cost")
  alpha <- vcr_scalar(scenario$analysis$alpha, 0.025)
  est <- values[, "estimate"]
  usable <- is.finite(est)
  n <- sum(usable)
  total <- nrow(values)
  measures <- list()
  notes <- list()
  add <- function(m) measures[[length(measures) + 1L]] <<- m
  src <- "synthetic"
  is_null <- vcr_plan_replicates(scenario, NULL, estimand)$isNull

  rej <- values[, "reject"]
  if (any(c("power", "type_one_error") %in% wanted) && any(is.finite(rej))) {
    p <- sum(rej[is.finite(rej)]) / total            # a failed replicate did not reject
    mcse <- vcr_mcse_proportion(p, total)
    name <- if (is_null) "type_one_error" else "power"
    add(vcr_measure(name, p, simulated = TRUE, mcse = mcse, source = src,
                    interval = vcr_interval("monte_carlo", max(0, p - 1.96 * mcse), min(1, p + 1.96 * mcse))))
  }
  if ("bias" %in% wanted && n > 1) {
    b <- mean(est[usable]) - estimand
    add(vcr_measure("bias", b, simulated = TRUE, mcse = vcr_mcse_mean(est[usable]), source = src))
    add(vcr_measure("empirical_se", stats::sd(est[usable]), simulated = TRUE,
                    mcse = vcr_mcse_empse(est[usable]), source = src))
    mse <- mean((est[usable] - estimand)^2)
    add(vcr_measure("mse", mse, simulated = TRUE,
                    mcse = stats::sd((est[usable] - estimand)^2) / sqrt(n), source = src))
  }
  if ("coverage" %in% wanted && all(c("ci_low", "ci_high") %in% colnames(values))) {
    ok <- is.finite(values[, "ci_low"]) & is.finite(values[, "ci_high"])
    if (any(ok)) {
      covered <- ok & values[, "ci_low"] <= estimand & values[, "ci_high"] >= estimand
      covered[is.na(covered)] <- FALSE
      cov <- mean(covered)
      add(vcr_measure("coverage", cov, simulated = TRUE, mcse = vcr_mcse_proportion(cov, total), source = src))
    }
  }
  if ("expected_sample_size" %in% wanted && "sampleSize" %in% colnames(values)) {
    s <- values[, "sampleSize"]; s <- s[is.finite(s)]
    if (length(s) > 1L) add(vcr_measure("expected_sample_size", mean(s), simulated = TRUE, mcse = vcr_mcse_mean(s), source = src))
  }
  if ("events" %in% colnames(values)) {
    e <- values[, "events"]; e <- e[is.finite(e)]
    if (length(e) > 1L) add(vcr_measure("expected_events", mean(e), simulated = TRUE, mcse = vcr_mcse_mean(e), source = src))
  }
  if ("look" %in% colnames(values)) {
    l <- values[, "look"]; l <- l[is.finite(l)]
    if (length(l) > 1L) add(vcr_measure("expected_analyses", mean(l), simulated = TRUE, mcse = vcr_mcse_mean(l), source = src))
  }
  if ("earlyStop" %in% colnames(values)) {
    pet<-mean(values[,"earlyStop"])
    add(vcr_measure("early_stop_probability",pet,simulated=TRUE,mcse=vcr_mcse_proportion(pet,total),source=src))
    notes[[length(notes)+1L]]<-vcr_issue("performance_measure_unsupported","performance",
      "Simon response estimates are naive stopped proportions; sequentially adjusted confidence intervals are not implemented, so coverage is not reported.")
  }
  if ("externalEss" %in% colnames(values)) {
    ess<-values[,"externalEss"];good<-is.finite(ess)
    if(sum(good)>1)add(vcr_measure("mean_external_effective_sample_size",mean(ess[good]),simulated=TRUE,mcse=vcr_mcse_mean(ess[good]),source=src))
  }
  dur <- if ("duration" %in% colnames(values)) values[, "duration"] else numeric(0)
  dur <- dur[is.finite(dur)]
  if ("duration_months" %in% wanted) {
    if (length(dur) > 1L) add(vcr_measure("duration_months", mean(dur), simulated = TRUE,
                                          mcse = if (stats::sd(dur) > 0) vcr_mcse_mean(dur) else 0, source = src))
    else notes[[length(notes) + 1L]] <- vcr_issue("performance_measure_unsupported", "performance",
      "duration_months needs the scenario's accrual duration (and follow-up) to be stated; it was not computed.")
  }
  if ("cost" %in% wanted) {
    cs <- scenario$costs
    ss <- if ("sampleSize" %in% colnames(values)) values[, "sampleSize"] else numeric(0)
    if (is.list(cs) && length(dur) > 1L && length(ss[is.finite(ss)]) > 1L) {
      per <- (vcr_scalar(cs$perPatient, 0) * values[, "sampleSize"] + vcr_scalar(cs$perSite, 0) * vcr_scalar(cs$sites, 0) +
                vcr_scalar(cs$perMonth, 0) * values[, "duration"])
      per <- per[is.finite(per)]
      add(vcr_measure("cost", mean(per), simulated = TRUE, mcse = if (stats::sd(per) > 0) vcr_mcse_mean(per) else 0, source = src,
                      note = "perPatient x N + perSite x sites + perMonth x duration"))
    } else {
      notes[[length(notes) + 1L]] <- vcr_issue("performance_measure_unsupported", "performance",
        "cost needs costs (perPatient, perSite, perMonth, sites) and an accrual duration; it was not computed.")
    }
  }
  fail_share <- (total - n) / total
  list(measures = measures,
       diagnostics = list(replicatesUsable = n, replicatesFailed = total - n, failureShare = fail_share,
                          estimand = estimand, alpha = alpha,
                          conclusion = if (fail_share > 0.01) "limited" else "estimable",
                          performanceNotComputed = notes))
}

#' Analytic counterpart of a simulated scenario, where one exists, plus the
#' difference in MCSE units (AC-29).
vcr_analytic_check <- function(scenario, measures) {
  endpoint <- scenario$endpoint$type
  design <- scenario$design
  truth <- scenario$truth
  alpha <- vcr_scalar(scenario$analysis$alpha, 0.025)
  sided <- vcr_check_sided(scenario$analysis$sided)
  is_null <- vcr_is_null_scenario(scenario)
  analytic <- NULL
  if (design$kind %in% c("single_arm","simon_two_stage") && identical(endpoint, "binary")) {
    p<-vcr_scalar(truth$responseRate);p0<-vcr_scalar(truth$nullRate)
    name<-if(is_null)"type_one_error" else "power"
    refs<-if(identical(design$kind,"single_arm")){
      ex<-vcr_exact_binomial(vcr_scalar(design$n),p0,p,alpha,scenario$analysis$alternative)
      stats::setNames(ex$power,name)
    } else {
      n<-vcr_scalar(design$n);n1<-vcr_scalar(design$n1);r1<-vcr_scalar(design$r1);r<-vcr_scalar(design$r)
      pet<-stats::pbinom(r1,n1,p)
      stats::setNames(c(.vcr_simon_prob(p,n1,n,r1,r),pet,n1+(1-pet)*(n-n1)),c(name,"early_stop_probability","expected_sample_size"))
    }
    checks<-lapply(seq_along(refs),function(k){
      m<-Filter(function(x)identical(x$name,names(refs)[k]),measures)
      out<-list(name=names(refs)[k],value=unname(refs[k]),basis="exact_binomial_enumeration")
      if(length(m)){
        delta<-m[[1]]$value-refs[k];se<-m[[1]]$mcse
        out<-c(out,list(simulated=m[[1]]$value,difference=unname(delta),mcse=se,withinThreeMcse=abs(delta)<=3*se+1e-12,
          differenceInMcse=if(se>0)unname(delta)/se else if(abs(delta)<1e-12)0 else NULL))
      }
      out
    })
    primary<-checks[[1]];if(length(checks)>1)primary$additionalChecks<-checks[-1]
    return(primary)
  }
  n1 <- vcr_scalar(design$nTreat, NA_real_); n0 <- vcr_scalar(design$nControl, n1)
  fixed <- identical(design$kind %||% "two_arm_fixed", "two_arm_fixed")
  method <- scenario$analysis$method %||% NULL
  if (identical(endpoint, "continuous") && fixed && !identical(method, "ancova")) {
    analytic <- list(name = if (is_null) "type_one_error" else "power",
                     value = if (is_null) alpha
                             else vcr_power_means(vcr_scalar(truth$effect), vcr_scalar(truth$sd, 1), n1, n0, alpha, sided))
  }
  if (identical(endpoint, "binary") && fixed && !identical(method, "logistic")) {
    p0 <- vcr_scalar(truth$controlRate)
    p1 <- vcr_binary_treatment_rate(p0, vcr_scalar(truth$treatmentRate, NULL), vcr_scalar(truth$riskDifference, NULL), vcr_scalar(truth$oddsRatio, NULL))
    analytic <- list(name = if (is_null) "type_one_error" else "power",
                     value = if (is_null) alpha else vcr_power_proportions(p0, p1, n1, n0, alpha, sided))
  }
  if (identical(endpoint, "time_to_event") && fixed && !identical(method %||% "logrank", "rmst")) {
    hr <- vcr_scalar(truth$hazardRatio, 1)
    if (is_null) {
      analytic <- list(name = "type_one_error", value = alpha, basis = "nominal_alpha")
    } else {
      dist <- vcr_control_distribution(truth)
      accrual <- scenario$accrual %||% list()
      # The at-risk-process reference for a stated number of patients (see
      # `vcr_logrank_power` for its measured accuracy); Schoenfeld's value at
      # the expected events is kept beside it so the size of the approximation
      # is visible rather than argued about.
      exact <- vcr_logrank_power(hr, dist, n1, n0,
                                 vcr_scalar(accrual$duration, 0),
                                 vcr_scalar(accrual$followup, Inf),
                                 vcr_dropout_hazard(vcr_scalar(accrual$dropoutAnnual, 0)),
                                 alpha, vcr_scalar(accrual$maxFollowup, Inf), sided = sided)
      analytic <- list(name = "power", value = exact$power,
                       basis = "asymptotic_logrank_score",
                       schoenfeld = exact$schoenfeldPower,
                       expectedEvents = exact$expectedEvents)
    }
  }
  # a single-arm trial of a mean or of a survival time against its benchmark: the exact t / z power, or the one-sample log-rank approximation
  if (is.null(analytic) && identical(design$kind, "single_arm") && !identical(endpoint, "binary")) analytic <- vcr_single_arm_analytic(scenario)
  if (is.null(analytic)) return(NULL)
  sim <- Filter(function(m) identical(m$name, analytic$name), measures)
  if (!length(sim)) return(analytic)
  d <- sim[[1]]$value - analytic$value
  mcse <- sim[[1]]$mcse
  # An exact closed form is held to the simulation's own error; an approximation is
  # held to that error plus the bias it is documented to carry, and the result says so.
  bias <- if (identical(analytic$basis, "asymptotic_logrank_score")) VCR_LOGRANK_APPROXIMATION_BIAS
          else if (isTRUE(analytic$basis %in% c("first_order_one_sample_logrank", "asymptotic_one_sample_logrank"))) VCR_ONE_SAMPLE_LOGRANK_APPROXIMATION_BIAS else 0
  tolerance <- 3 * mcse + bias
  c(analytic, list(simulated = sim[[1]]$value, difference = d, mcse = mcse,
                   differenceInMcse = if (mcse > 0) d / mcse else NA_real_,
                   withinThreeMcse = abs(d) <= 3 * mcse,
                   approximationBias = bias, tolerance = tolerance, withinTolerance = abs(d) <= tolerance,
                   toleranceBasis = if (bias > 0) "three Monte-Carlo standard errors plus the documented bias of a first-order approximation"
                                    else "three Monte-Carlo standard errors"))
}

#' A design grid: designs x truth scenarios, every cell one immutable run.
#'
#' The cell seed is `(seed + k * 7919) mod (2^31 - 1)` in *double* arithmetic:
#' the integer version overflowed to NA at seeds near the top of the range and
#' every cell of the grid failed (CE-2).
vcr_design_grid <- function(base_scenario, designs, truths, seed, replicates = NULL,
                            cores = 1L, cancel_file = NULL, checkpoint_dir = NULL,
                            progress = NULL, batch_size = 500L, cpu_seconds_limit = Inf) {
  cells <- list(); k <- 0L
  total <- length(designs) * length(truths)
  cpu0 <- vcr_cpu_seconds()
  for (di in seq_along(designs)) for (ti in seq_along(truths)) {
    k <- k + 1L
    override <- list(design = designs[[di]], truth = truths[[ti]])
    sc <- base_scenario
    sc$designs <- NULL; sc$truths <- NULL
    sc$design <- utils::modifyList(sc$design %||% list(), override$design)
    sc$truth <- utils::modifyList(sc$truth %||% list(), override$truth)
    # Each cell gets its own seed derived from the job seed and the cell index,
    # so adding a cell never changes another cell's numbers.
    cell_seed <- as.integer((as.numeric(seed) + k * 7919) %% 2147483647)
    cp <- if (is.null(checkpoint_dir)) NULL else file.path(checkpoint_dir, sprintf("cell-%03d.rds", k))
    remaining <- if (is.finite(cpu_seconds_limit)) max(0, cpu_seconds_limit - (vcr_cpu_seconds() - cpu0)) else Inf
    res <- tryCatch(
      vcr_run_simulation(sc, cell_seed, replicates, cores, cp, cancel_file, batch_size = batch_size,
                         progress = NULL, cpu_seconds_limit = remaining),
      vcr_refusal = function(e) list(measures = list(), diagnostics = list(), status = "failed",
                                     scenarioHash = vcr_scenario_hash(sc), refusal = e$issue))
    if (!is.null(cp) && identical(res$status, "succeeded") && file.exists(cp)) unlink(cp)
    cells[[k]] <- list(designIndex = di, truthIndex = ti, design = designs[[di]],
                       truth = truths[[ti]], seed = cell_seed,
                       parameters = vcr_canonical_json(list(design = designs[[di]], truth = truths[[ti]])),
                       scenarioHash = res$scenarioHash, measures = res$measures,
                       diagnostics = res$diagnostics, status = res$status, refusal = res$refusal)
    if (!is.null(progress)) progress(k, total)
    if (res$status %in% c("canceled") || (identical(res$status, "failed") && isTRUE(res$diagnostics$overCpuBudget))) break
  }
  cells
}

#' Deterministic Pareto dominance over a set of design cells: a design is
#' dominated when another is at least as good on every declared metric and
#' strictly better on one. The platform greys out dominated designs; it never
#' ranks the rest (plan 5.4).
vcr_dominated_designs <- function(rows, maximize = character(), minimize = character()) {
  n <- nrow(rows)
  dominated <- logical(n)
  for (i in seq_len(n)) for (j in seq_len(n)) {
    if (i == j) next
    ge <- all(vapply(maximize, function(m) rows[[m]][j] >= rows[[m]][i], logical(1))) &&
          all(vapply(minimize, function(m) rows[[m]][j] <= rows[[m]][i], logical(1)))
    gt <- any(vapply(maximize, function(m) rows[[m]][j] > rows[[m]][i], logical(1))) ||
          any(vapply(minimize, function(m) rows[[m]][j] < rows[[m]][i], logical(1)))
    if (ge && gt) { dominated[i] <- TRUE; break }
  }
  dominated
}

`%||%` <- function(a, b) if (is.null(a)) b else a
