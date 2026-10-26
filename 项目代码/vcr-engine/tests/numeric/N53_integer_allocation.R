# N53 — integer allocation is part of the analytic sample-size contract.
# Independent normal-quantile formulas, per-arm ceilings and a noncentral-t check.
.n53_scenario <- function(endpoint = "continuous", allocation = 0.5) list(
  design = list(kind = "two_arm_fixed", allocation = allocation), endpoint = list(type = endpoint),
  truth = if (endpoint == "continuous") list(effect = 5, sd = 12) else list(controlRate = 0.3, treatmentRate = 0.45),
  analysis = list(alpha = 0.05, power = 0.8, sided = 2))
.n53_run <- function(scenario, version = NULL) {
  job <- vcr_test_job("design.analytic", scenario, job_id = "job_n53")
  if (!is.null(version)) job$methodVersion <- version
  vcr_test_run(job)
}
.n53_mean_raw <- function(allocation) (qnorm(0.975) + qnorm(0.8))^2 * 12^2 / (allocation * (1-allocation) * 5^2)
.n53_names <- function(result) vapply(result$measures, function(m) m$name, character(1))

vcr_case("N53a", c("AC-29", "AC-30"), function() {
  r <- .n53_run(.n53_scenario())
  raw <- .n53_mean_raw(0.5); arm <- ceiling(raw / 2)
  # Reference: noncentral t, not the normal quantiles used to size the design.
  df <- 2 * arm - 2; critical <- qt(0.975, df); ncp <- 5 / (12 * sqrt(2 / arm))
  exact_t <- pt(critical, df, ncp = ncp, lower.tail = FALSE) + pt(-critical, df, ncp = ncp)
  basis <- r$diagnostics$sampleSize
  ok <- identical(r$status, "succeeded") && vcr_measure_value(r, "required_total") == 2 * arm &&
    vcr_measure_value(r, "required_treatment") == arm && vcr_measure_value(r, "required_control") == arm &&
    vcr_measure_value(r, "required_per_arm") == arm && identical(basis$basis, "normal_approximation") &&
    identical(basis$powerCheckBasis, "pooled_two_sample_t") && abs(basis$powerAtAllocatedN - exact_t) < 1e-12 &&
    abs(basis$unrounded$total - raw) < 1e-10 && exact_t < 0.8
  list(pass = ok, detail = sprintf("raw total %.9f; integer %g+%g=%g; pooled-t power %.9f is below the normal target .8 (not an exact-t size)",
    raw, vcr_measure_value(r, "required_treatment"), vcr_measure_value(r, "required_control"), vcr_measure_value(r, "required_total"), exact_t))
})

vcr_case("N53b", c("AC-29", "AC-30"), function() {
  sc <- .n53_scenario(allocation = 0.7); raw <- .n53_mean_raw(0.7)
  nt <- ceiling(raw * 0.7); nc <- ceiling(raw * 0.3); r <- .n53_run(sc)
  points <- r$diagnostics$powerCurve$series[[1]]$points
  at <- points[[which.min(vapply(points, function(p) abs(p$x - 5), numeric(1)))]]
  reference <- stats::power.t.test(n = NULL, delta = 5, sd = 12, sig.level = 0.05, power = 0.8, type = "two.sample")$n
  df <- nt + nc - 2; ncp <- 5 / (12 * sqrt(1/nt + 1/nc)); crit <- qt(0.975,df)
  checked <- pt(crit,df,ncp=ncp,lower.tail=FALSE)+pt(-crit,df,ncp=ncp)
  ok <- vcr_measure_value(r,"required_total") == nt+nc && vcr_measure_value(r,"required_treatment") == nt &&
    vcr_measure_value(r,"required_control") == nc && !("required_per_arm" %in% .n53_names(r)) &&
    abs(at$y - checked) < 1e-12 && abs(r$diagnostics$sampleSize$allocationAchieved-nt/(nt+nc)) < 1e-12 && reference > 91 &&
    !("required_per_arm" %in% .n53_names(.n53_run(.n53_scenario(allocation = 0.5 + 1e-13))))
  list(pass=ok,detail=sprintf("allocation .7: %d+%d=%d, curve at effect5 %.9f; re-splitting ceil(total) would incorrectly add a treatment subject; exact balanced t needs %.6f per arm",nt,nc,nt+nc,at$y,reference))
})

vcr_case("N53c", c("AC-29", "AC-30"), function() {
  allocations <- c(0.5, 0.7)
  ok <- vapply(allocations, function(a) {
    r <- .n53_run(.n53_scenario("binary",a)); ratio <- a/(1-a); pbar <- (ratio*.45+.3)/(ratio+1)
    # Independent pooled-null / alternative-variance normal formula.
    raw_control <- ((qnorm(.975)*sqrt((1+1/ratio)*pbar*(1-pbar)) + qnorm(.8)*sqrt(.45*.55/ratio+.3*.7))/.15)^2
    nt <- ceiling(ratio*raw_control); nc <- ceiling(raw_control)
    vcr_measure_value(r,"required_total")==nt+nc && vcr_measure_value(r,"required_treatment")==nt &&
      vcr_measure_value(r,"required_control")==nc &&
      identical(r$diagnostics$sampleSize$basis,"normal_approximation") &&
      identical("required_per_arm" %in% .n53_names(r),a==0.5)
  },logical(1))
  list(pass=all(ok),detail=paste("binary independently allocated arm totals at .5/.7:",paste(ok,collapse="/")))
})

vcr_case("N53d", c("AC-29", "AC-30"), function() {
  ok <- vapply(c("1.0.0","1.1.0"),function(version) all(vapply(c(0.5,0.7),function(a) all(vapply(c("continuous","binary"),function(endpoint) {
    sc <- .n53_scenario(endpoint,a); r <- .n53_run(sc,version)
    raw <- if(endpoint=="continuous") vcr_n_means(5,12,.05,.8,a,2) else vcr_n_proportions(.3,.45,.05,.8,a,2)
    identical(r$status,"succeeded") && vcr_measure_value(r,"required_total")==ceiling(raw$total) &&
      !("required_treatment" %in% .n53_names(r)) && is.null(r$diagnostics$sampleSize) &&
      if(endpoint=="continuous") vcr_measure_value(r,"required_per_arm")==ceiling(raw$treat) else vcr_measure_value(r,"required_control")==ceiling(raw$control)
  },logical(1))),logical(1))),logical(1))
  list(pass=all(ok),detail=paste("legacy1.0/1.1 continuous+binary, equal/unequal replay measures and diagnostics retain their historical contract:",paste(ok,collapse="/")))
})

vcr_case("N53e", c("AC-29", "AC-30"), function() {
  # Independently integrate arm event probabilities, then ceil each unrounded arm.
  ok <- vapply(c(.5,.6,2/3,.7), function(a) all(vapply(c("exponential","weibull"),function(family) {
    dist <- if(family=="exponential")list(kind=family,rate=log(2)/12)else list(kind=family,shape=1.7,scale=12/log(2)^(1/1.7))
    sc <- list(design=list(kind="two_arm_fixed",allocation=a),endpoint=list(type="time_to_event"),timeUnit="months",truth=list(hazardRatio=.7,controlDistribution=dist),accrual=list(duration=18,followup=12),analysis=list(alpha=.05,power=.8,sided=2))
    r <- .n53_run(sc)
    s0 <- function(t)if(family=="exponential")exp(-dist$rate*t)else exp(-(t/dist$scale)^dist$shape)
    p0 <- integrate(function(t)1-s0(t),12,30,rel.tol=1e-11)$value/18
    p1 <- integrate(function(t)1-s0(t)^.7,12,30,rel.tol=1e-11)$value/18
    events <- (qnorm(.975)+qnorm(.8))^2/(a*(1-a)*log(.7)^2)
    raw <- events/((1-a)*p0+a*p1); nt<-ceiling(raw*a);nc<-ceiling(raw*(1-a))
    basis <- r$diagnostics$sampleSize
    # The plotted power curve uses these same allocated arms and their event count.
    curve <- r$diagnostics$powerCurve; points <- curve$series[[1]]$points
    at <- points[[which.min(vapply(points,function(p)abs(p$x-.7),numeric(1)))]]
    ncp <- abs(log(.7))*sqrt((nt*p1+nc*p0)*(nt/(nt+nc))*(nc/(nt+nc)))
    # Holding the engine's display to the allocated arms is a consistency check;
    # event counts and rounding above are the independent numerical reference.
    checked <- vcr_logrank_power(.7,dist,nt,nc,18,12,0,.05,sided=2)$power
    vcr_measure_value(r,"required_patients")==nt+nc && vcr_measure_value(r,"required_treatment")==nt && vcr_measure_value(r,"required_control")==nc && abs(basis$expectedEventsAtAllocatedN-(nt*p1+nc*p0))<1e-8 && abs(at$y-checked)<1e-10 && basis$basis=="schoenfeld_event_probability"
  },logical(1))),logical(1))
  list(pass=all(ok),detail=paste("TTE integer allocations and plotted logrank power, exponential/Weibull at .5/.6/2:3/.7:",paste(ok,collapse="/")))
})
vcr_case("N53f", c("AC-29", "AC-30"), function() {
  sc<-list(design=list(kind="two_arm_fixed",allocation=2/3),endpoint=list(type="time_to_event"),truth=list(hazardRatio=.7,controlMedian=12),accrual=list(duration=18,followup=12),analysis=list(alpha=.05,power=.8,sided=2))
  legacy<-lapply(c("1.0.0","1.1.0"),function(version).n53_run(sc,version))
  only_events<-sc;only_events$accrual<-NULL;r<-.n53_run(only_events)
  list(pass=all(vapply(legacy,function(r)is.null(r$diagnostics$sampleSize)&&!("required_treatment"%in%.n53_names(r)),logical(1))) && !("required_patients"%in%.n53_names(r)),detail="Legacy TTE rounding retained; absent accrual produces event requirement only")
})
