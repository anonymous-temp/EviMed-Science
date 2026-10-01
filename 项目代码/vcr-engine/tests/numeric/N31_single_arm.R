# Binary single-arm references are independent count enumeration, not two-arm surrogates.
vcr_case("N31a", c("AC-29", "AC-30"), function() {
  rows <- list(c(40, .2, .4), c(20, 0, 1), c(20, 1, 0), c(25, .4, .2))
  worst <- 0
  for (row in rows) for (alternative in c("greater", "less", "two.sided")) {
    n <- row[1]; p0 <- row[2]; p1 <- row[3]
    reference <- vapply(0:n, function(x) stats::binom.test(x, n, p0, alternative = alternative)$p.value, numeric(1))
    got <- vcr_exact_binomial(n, p0, p1, .05, alternative)
    worst <- max(worst, abs(got$pValues - reference), abs(got$power - sum(dbinom(0:n, n, p1)[reference <= .05])))
  }
  critical<-vcr_exact_binomial(40,.2,.4,.05,"greater")
  countRule<-min(critical$rejectCounts)==13
  list(pass = worst < 1e-12 && countRule && !critical$reject[13] && critical$reject[14], detail = sprintf("12 exact rejection rules including p0=0/1: maximum binom.test/enumeration difference %.3g; n40/p0=.2 success starts at 13 responses", worst))
})

vcr_case("N31b", c("AC-09", "AC-10", "AC-11", "AC-28", "AC-29"), function() {
  base <- list(design = list(kind = "simon_two_stage", n1 = 10, n = 29, r1 = 1, r = 5), endpoint = list(type = "binary"),
    truth = list(nullRate = .1, alternativeRate = .3, responseRate = .1), analysis = list(method = "simon_boundary", alpha = .05, sided = 1),
    performance = list("power", "expected_sample_size", "coverage"))
  rows <- lapply(c(.1, .3), function(p) {
    sc <- base; sc$truth$responseRate <- p
    r <- vcr_test_run(vcr_test_job("design.simulate", sc, seed = 3131L, cores = VCR_TEST_CORES))
    # Independent full joint binomial table, with stage-one futility applied explicitly.
    joint <- outer(dbinom(0:10, 10, p), dbinom(0:19, 19, p))
    continue <- outer(0:10, 0:19, function(a,b) a > 1)
    reject <- continue & outer(0:10, 0:19, function(a,b) a+b > 5)
    ref <- c(sum(joint[reject]), pbinom(1, 10, p), 10 + 19 * (1-pbinom(1,10,p)))
    names_ <- c(if (p == .1) "type_one_error" else "power", "early_stop_probability", "expected_sample_size")
    checks <- lapply(seq_along(names_), function(i) { m <- vcr_get_measure(r,names_[i]); !is.null(m) && abs(m$value-ref[i]) <= 3*m$mcse })
    list(ok = identical(r$status,"succeeded") && all(unlist(checks)) && r$counts$realPatients == 0 && is.null(vcr_get_measure(r,"coverage")),
         text = sprintf("p=%.1f rejection %.4f/PET %.4f/EN %.3f (independent %.4f/%.4f/%.3f)",p,vcr_measure_value(r,names_[1]),vcr_measure_value(r,names_[2]),vcr_measure_value(r,names_[3]),ref[1],ref[2],ref[3]))
  })
  list(pass = all(vapply(rows, function(x)x$ok, logical(1))), detail = paste(vapply(rows,function(x)x$text,character(1)),collapse="; "))
})

vcr_case("N31c", c("AC-07", "AC-09", "AC-10", "AC-11"), function() {
  sc <- list(design=list(kind="single_arm_external",n=400), endpoint=list(type="binary"),
    truth=list(controlRates=list(.2,.4),treatmentRates=list(.2,.4)),
    external=list(kind="stratified_beta_binomial",n=1000,targetPrevalence=.5,sourcePrevalence=.3,parameterInformation=10000,
      logOddsDrift=0,sensitivityDrifts=list(-.3,0,.3)),
    analysis=list(method="stratified_risk_difference",estimand="ATT",alpha=.025,sided=1), performance=list("power","bias","coverage"))
  r <- vcr_test_run(vcr_test_job("design.simulate",sc,seed=3132L,cores=VCR_TEST_CORES))
  m <- vcr_get_measure(r,"type_one_error"); b <- vcr_get_measure(r,"bias"); cov <- vcr_get_measure(r,"coverage")
  runner <- vcr_scenario_runner(sc); set.seed(3); vals <- replicate(1000,runner$run(1)["externalParameterVariance"])
  more <- sc; more$external$parameterInformation <- 1000000; runner2 <- vcr_scenario_runner(more); set.seed(3)
  vals2 <- replicate(1000,runner2$run(1)["externalParameterVariance"])
  no_overlap <- sc; no_overlap$external$sourcePrevalence <- 0
  unavailable <- vcr_test_run(vcr_test_job("design.simulate",no_overlap,seed=3132L))
  drift <- sc; drift$external$logOddsDrift <- .5
  d <- vcr_test_run(vcr_test_job("design.simulate",drift,seed=3132L,cores=VCR_TEST_CORES))
  ok <- identical(r$status,"succeeded") && abs(m$value-.025) <= 3*m$mcse && abs(b$value) <= 3*b$mcse && abs(cov$value-.95)<=3*cov$mcse &&
    r$counts$realPatients==0 && mean(vals2)<mean(vals)/50 && identical(unavailable$status,"not_estimable") &&
    vcr_measure_value(d,"bias") < -.06 && length(r$diagnostics$externalControl$sensitivity)==3
  list(pass=ok,detail=sprintf("null %.4f (+-%.4f), bias %.5f (+-%.5f), coverage %.4f; represented variance %.3g->%.3g; no-overlap %s; drift bias %.4f; synthetic only",m$value,m$mcse,b$value,b$mcse,cov$value,mean(vals),mean(vals2),unavailable$status,vcr_measure_value(d,"bias")))
})

vcr_case("N31d", c("AC-04","AC-31","AC-38"), function() {
  sc <- list(design=list(kind="single_arm",n=40),endpoint=list(type="binary"),truth=list(nullRate=.2,responseRate=.4),
    analysis=list(method="exact_binomial",alternative="greater",sided=1,alpha=.05),performance=list("power","bias","coverage"))
  one <- vcr_run_simulation(sc,3133L,cores=1L); eight <- vcr_run_simulation(sc,3133L,cores=8L)
  dir <- tempfile("single-arm-resume-");dir.create(dir);on.exit(unlink(dir,recursive=TRUE));cp<-file.path(dir,"checkpoint.rds");cancel<-file.path(dir,"cancel")
  partial <- vcr_run_simulation(sc,3133L,cores=1L,checkpoint=cp,cancel_file=cancel,progress=function(done,total)if(done>=1000)file.create(cancel))
  unlink(cancel);resumed<-vcr_run_simulation(sc,3133L,cores=8L,checkpoint=cp)
  list(pass=identical(one$values,eight$values)&&identical(one$values,resumed$values)&&partial$status=="canceled"&&partial$diagnostics$replicatesCompleted==1000,
    detail=sprintf("1/8 cores and resume: %d rows identical; canceled checkpoint retained %d",nrow(one$values),partial$diagnostics$replicatesCompleted))
})

vcr_case("N31e", c("AC-09","AC-29","AC-30"), function() {
  # Independent beta-binomial moments: Var(Y/m)=p(1-p)(1+(m-1)/(I+1))/m.
  # Fix trial response at zero so the replicate contrast isolates historical
  # uncertainty, instead of comparing the variance formula to its own code.
  sc<-list(design=list(kind="single_arm_external",n=100),endpoint=list(type="binary"),
    truth=list(controlRates=list(.3,.3),treatmentRates=list(0,0)),
    external=list(kind="stratified_beta_binomial",n=100,targetPrevalence=0,sourcePrevalence=0,
      parameterInformation=100,logOddsDrift=0,sensitivityDrifts=list(0)),
    analysis=list(method="stratified_risk_difference",estimand="ATT",alpha=.025,sided=1),performance=list("bias"))
  sim<-vcr_run_simulation(sc,3134L,replicates=20000L,cores=VCR_TEST_CORES)
  estimate<-sim$values[,"estimate"];refMean<--.3;refVar<-.3*.7*(1+99/101)/100
  squared<-(estimate-refMean)^2;varianceMcse<-stats::sd(squared)/sqrt(length(squared))
  exact<-list(design=list(kind="single_arm",n=40),endpoint=list(type="binary"),truth=list(nullRate=0,responseRate=1),
    analysis=list(method="exact_binomial",alternative="greater",alpha=.05,sided=1))
  r<-vcr_test_run(vcr_test_job("design.simulate",exact,seed=3134L))
  analytic<-vcr_test_run(vcr_test_job("design.analytic",exact,seed=3134L))
  list(pass=abs(mean(estimate)-refMean)<=3*stats::sd(estimate)/sqrt(length(estimate))&&abs(mean(squared)-refVar)<=3*varianceMcse&&
    identical(r$status,"succeeded")&&identical(analytic$status,"succeeded")&&vcr_measure_value(analytic,"power")==1&&vcr_measure_value(analytic,"type_one_error")==0&&vcr_measure_value(r,"power")==1&&r$counts$realPatients==0&&r$counts$generatedRecords==200000,
    detail=sprintf("historical mean %.5f vs -.3; independent beta-binomial variance %.6f vs %.6f (+-%.6f); exact p0=0,p1=1 power %.1f, synthetic records %d",mean(estimate),mean(squared),refVar,varianceMcse,vcr_measure_value(r,"power"),r$counts$generatedRecords))
})

vcr_case("N31f", c("AC-04","AC-10","AC-29"), function() {
  sc<-list(design=list(kind="single_arm",n=30),endpoint=list(type="binary"),truth=list(nullRate=.2,responseRate=.4),
    analysis=list(method="exact_binomial",alternative="greater",alpha=.05,sided=1),performance=list("power"),
    designs=list(list(n=30),list(n=60)),truths=list(list(responseRate=.2),list(responseRate=.4)))
  dir<-tempfile("single-arm-grid-");dir.create(dir);on.exit(unlink(dir,recursive=TRUE))
  r<-vcr_test_run(vcr_test_job("design.grid",sc,seed=3135L,cores=VCR_TEST_CORES),output_dir=dir)
  cells<-r$diagnostics$cells
  # Cell four has the same immutable seed/scenario as an individually queued job.
  isolated<-sc;isolated$designs<-NULL;isolated$truths<-NULL;isolated$design$n<-60
  seed<-as.integer((3135+4*7919)%%2147483647)
  one<-vcr_test_run(vcr_test_job("design.simulate",isolated,seed=seed,cores=VCR_TEST_CORES))
  tab<-vcr_test_table(r,"operating-characteristics",dir)
  powers<-lapply(cells,function(c)Filter(function(m)m$name=="power",c$measures))
  chosen<-if(length(powers)>=4 && length(powers[[4]]))powers[[4]][[1]]$value else NA_real_
  list(pass=identical(r$status,"succeeded")&&length(cells)==4&&nrow(tab)==4&&is.finite(chosen)&&chosen==vcr_measure_value(one,"power"),
    detail=sprintf("single-arm projected grid status %s, %d cells/%d table rows; cell4 power %.4f equals isolated %.4f",r$status,length(cells),if(is.null(tab))0 else nrow(tab),chosen,vcr_measure_value(one,"power")))
})

vcr_case("N31g", c("AC-04","AC-31","AC-38"), function() {
  scenarios<-list(
    list(design=list(kind="simon_two_stage",n1=10,n=29,r1=1,r=5),endpoint=list(type="binary"),truth=list(nullRate=.1,alternativeRate=.3,responseRate=.3),
      analysis=list(method="simon_boundary",alpha=.05,sided=1),performance=list("power","expected_sample_size")),
    list(design=list(kind="single_arm_external",n=100),endpoint=list(type="binary"),truth=list(controlRates=list(.2,.4),treatmentRates=list(.4,.6)),
      external=list(kind="stratified_beta_binomial",n=200,targetPrevalence=.5,sourcePrevalence=.3,parameterInformation=100,logOddsDrift=0,sensitivityDrifts=list(-.3,0,.3)),
      analysis=list(method="stratified_risk_difference",estimand="ATT",alpha=.025,sided=1),performance=list("power","bias","coverage")))
  rows<-lapply(seq_along(scenarios),function(k){
    sc<-scenarios[[k]];one<-vcr_run_simulation(sc,3136L+k,cores=1L);eight<-vcr_run_simulation(sc,3136L+k,cores=8L)
    dir<-tempfile("branch-resume-");dir.create(dir);on.exit(unlink(dir,recursive=TRUE));cp<-file.path(dir,"cp.rds");cancel<-file.path(dir,"cancel")
    partial<-vcr_run_simulation(sc,3136L+k,cores=1L,checkpoint=cp,cancel_file=cancel,progress=function(done,total)if(done>=500)file.create(cancel))
    unlink(cancel);resumed<-vcr_run_simulation(sc,3136L+k,cores=8L,checkpoint=cp)
    list(pass=identical(one$values,eight$values)&&identical(one$values,resumed$values)&&partial$status=="canceled"&&partial$diagnostics$replicatesCompleted==500,
      detail=sprintf("%s %d rows, 1/8/resume identical",sc$design$kind,nrow(one$values)))
  })
  list(pass=all(vapply(rows,function(x)x$pass,logical(1))),detail=paste(vapply(rows,function(x)x$detail,character(1)),collapse="; "))
})
