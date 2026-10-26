# Source-bound deterministic model primitives. These verify mathematics, not target-population clinical validity.
.n52_fit_job <- function(distribution = "exponential", source = "observed") {
  data <- data.frame(USUBJID = paste0("S", 1:5), time = c(1,2,3,4,6), status = c(1,1,0,1,0))
  input <- vcr_test_input(data, "model_fit", source = source)
  vcr_test_job("model.survival_fit", list(inputId = input$id, idColumn = "USUBJID", timeColumn = "time",
    statusColumn = "status", statusEncoding = "event", distribution = distribution, timeUnit = "months", horizons = c(1,3,8)), list(input))
}
vcr_case("N52a", c("AC-04", "AC-27"), function() {
  result <- vcr_run_job(vcr_test_json(.n52_fit_job()))
  model <- result$diagnostics$model
  rate_reference <- 3 / 16 # Censored exponential MLE: events / total time at risk.
  delta <- abs(model$distribution$rate - rate_reference)
  list(pass = identical(result$status, "succeeded") && delta < 1e-8 && result$counts$realPatients == 5 &&
         model$medianParameterQuantiles$p10 < model$median && model$medianParameterQuantiles$p90 > model$median,
       detail = sprintf("exponential rate=%.10f; events/sum(time)=%.10f; delta=%.3g", model$distribution$rate, rate_reference, delta))
})
vcr_case("N52b", c("AC-04"), function() {
  set.seed(291, kind = "Mersenne-Twister")
  event <- stats::rweibull(300, shape = 1.3, scale = 9)
  censor <- stats::runif(300, 4, 15)
  time <- pmin(event, censor); status <- as.numeric(event <= censor)
  errors <- vapply(c("exponential", "weibull", "lognormal", "loglogistic"), function(distribution) {
    fit <- vcr_fit_survival_baseline(time, status, distribution, c(3,9,18))
    # Independent likelihood optimized from base-R density/survival functions, no survreg fit reused.
    negative_loglik <- function(theta) {
      mu <- theta[1]; sigma <- if (distribution == "exponential") 1 else exp(theta[2])
      z <- (log(time) - mu) / sigma
      density <- switch(distribution,
        exponential = stats::dexp(time, exp(-mu), log = TRUE),
        weibull = stats::dweibull(time, shape = 1 / sigma, scale = exp(mu), log = TRUE),
        lognormal = stats::dlnorm(time, meanlog = mu, sdlog = sigma, log = TRUE),
        loglogistic = -log(sigma) - log(time) + stats::dlogis(z, log = TRUE))
      survival <- switch(distribution,
        exponential = stats::pexp(time, exp(-mu), lower.tail = FALSE, log.p = TRUE),
        weibull = stats::pweibull(time, shape = 1 / sigma, scale = exp(mu), lower.tail = FALSE, log.p = TRUE),
        lognormal = stats::plnorm(time, meanlog = mu, sdlog = sigma, lower.tail = FALSE, log.p = TRUE),
        loglogistic = stats::plogis(z, lower.tail = FALSE, log.p = TRUE))
      -sum(status * density + (1 - status) * survival)
    }
    initial <- if (distribution == "exponential") log(stats::median(time)) else c(log(stats::median(time)), 0)
    reference <- stats::optim(initial, negative_loglik, method = "BFGS", control = list(reltol = 1e-12, maxit = 2000))
    max(abs(fit$location - reference$par[1]), if (length(reference$par) > 1) abs(log(fit$aftScale) - reference$par[2]) else 0)
  }, numeric(1))
  list(pass = all(errors < 2e-4), detail = paste(names(errors), format(errors, digits=4), collapse = "; "))
})
vcr_case("N52c", c("AC-27"), function() {
  result <- vcr_run_job(vcr_test_json(.n52_fit_job(source = "reconstructed")))
  no_events <- vcr_fit_survival_baseline(c(1,2,3), c(0,0,0), "weibull", c(1,2))
  list(pass = identical(result$status, "succeeded") && result$counts$realPatients == 0 &&
    result$counts$reconstructedPseudoPatients == 5 && !no_events$estimable && identical(no_events$rule, "too_few_events"),
    detail = sprintf("real=%s; reconstructed=%s; no-event estimable=%s", result$counts$realPatients, result$counts$reconstructedPseudoPatients, no_events$estimable))
})
.n52_equation_job <- function(family = "logistic", baseline = TRUE) {
  data <- data.frame(USUBJID = paste0("S", 1:3), age = c(40,60,NA))
  input <- vcr_test_input(data, "prognostic_rows")
  term <- list(column="age",coefficient=0.05,transform="identity",unit="years",center=50,scale=1)
  model <- list(family=family,terms=list(term))
  if (family != "cox") model$intercept <- -1
  if (family == "linear") model$residualSd <- 2
  if (family == "cox" && baseline) model$baseline <- list(reference="centered",survival=0.8,horizon=12,timeUnit="months")
  vcr_test_job("model.prognostic_apply", list(inputId=input$id,idColumn="USUBJID",sourceCondition="control",
    endpoint=list(type=switch(family,linear="continuous",logistic="binary",cox="time_to_event"),horizon=12,timeUnit="months"),
    inputUnits=list(age="years"),model=model),list(input))
}
vcr_case("N52d", c("AC-04", "AC-27"), function() {
  fits <- lapply(c("linear","logistic","cox"), function(family) vcr_run_job(vcr_test_json(.n52_equation_job(family))))
  values <- vapply(fits, function(result) result$measures[[1]]$value, numeric(1))
  expected <- c(-1, mean(stats::plogis(c(-1.5,-0.5))), mean(1 - 0.8^exp(c(-0.5,0.5))))
  delta <- max(abs(values - expected))
  list(pass = delta < 1e-12 && all(vapply(fits,function(result) result$diagnostics$invalidPredictions == 1 &&
    !result$diagnostics$causalEffectIdentified,logical(1))),
    detail = sprintf("linear/logistic/centered-Cox max absolute error=%.3g; invalid per model=1", delta))
})
vcr_case("N52e", c("AC-04"), function() {
  score <- vcr_run_job(vcr_test_json(.n52_equation_job("cox", baseline=FALSE)))
  wrong <- .n52_equation_job(); wrong$scenario$inputUnits$age <- "months"
  refused <- vcr_run_job(vcr_test_json(wrong))
  list(pass = identical(score$status,"succeeded") && !score$diagnostics$absoluteRiskAvailable &&
    identical(score$measures[[1]]$name,"mean_relative_score") && length(refused$measures)==0 &&
    identical(refused$conclusion,"not_estimable"), detail = "Cox without baseline: relative score only; wrong units: zero predictions, not zero risk")
})
vcr_case("N52f", c("AC-04", "AC-27"), function() {
  job <- .n52_equation_job("cox")
  ref <- vcr_apply_prognostic_equation(data.frame(age=50), job$scenario$model, list(age="years"))
  unknown <- job; unknown$scenario$model$baseline$reference <- NULL
  bad <- vcr_run_job(vcr_test_json(unknown))
  uncentered <- job; uncentered$scenario$model$terms[[1]]$center <- NULL
  bad_center <- vcr_run_job(vcr_test_json(uncentered))
  list(pass=abs(ref$meanPrediction - 0.2)<1e-12 && identical(bad$status,"failed") && identical(bad_center$status,"failed"),
    detail="Mean age 50 at source-centered S0=0.8 yields 20% risk; unknown baseline reference or omitted center is refused, never 93.4% risk")
})
vcr_case("N52g", c("AC-04", "AC-27"), function() {
  data <- data.frame(USUBJID=paste0("I",1:5),time=c(1,2,3,4,6),status=c(1,1,0,1,0),unused=1:5)
  input <- vcr_test_input(data,"source_columns",source="imputed")
  input$columnSources <- list(time="observed",status="observed",unused="imputed")
  job <- .n52_fit_job();job$inputs <- list(input);job$scenario$inputId <- input$id
  good <- vcr_test_run(job)
  job$inputs[[1]]$columnSources$time <- "imputed"; weak <- vcr_test_run(job)
  list(pass=identical(good$measures[[1]]$source,"calculated") && identical(weak$measures[[1]]$source,"imputed") &&
    identical(good$diagnostics$valueSourcesUsed$weakest,"observed") && identical(weak$diagnostics$valueSourcesUsed$weakest,"imputed"),
    detail="Unused imputed column does not downgrade fit; an imputed time column marks the estimate imputed")
})
vcr_case("N52h", c("AC-04", "AC-31"), function() {
  population <- data.frame(age=seq(30,69))
  input <- vcr_test_input(population,"paired_population",source="synthetic")
  sc <- list(endpoint=list(type="continuous"),design=list(nTreat=20,nControl=20),truth=list(effect=0.5,sd=1),pairing=list(key="population_v1",replicate=1))
  dir <- tempfile("paired-output-");dir.create(dir);on.exit(unlink(dir,recursive=TRUE),add=TRUE)
  run <- function(scenario,id) { job<-vcr_test_job("patients.continuous",scenario,list(input),seed=812,job_id=id);result<-vcr_test_run(job,output_dir=dir);list(result=result,data=vcr_test_table(result,"virtual-patients",dir)) }
  a<-run(sc,"job_a"); altered<-sc;altered$truth$effect<-1.2;b<-run(altered,"job_b")
  repeated<-sc;repeated$pairing$replicate<-2;c<-run(repeated,"job_c")
  legacy<-vcr_test_job("patients.continuous",within(sc,rm(pairing)),list(input),seed=812,job_id="old");legacy$methodVersion<-"1.0.0"
  old<-vcr_test_run(legacy,output_dir=dir);old_data<-vcr_test_table(old,"virtual-patients",dir)
  old_id<-paste0("vp_",substr(vcr_sha256("812:old:1"),1,12))
  set.seed(812,kind=VCR_RNG_KIND);assign(".Random.seed",parallel::nextRNGStream(.Random.seed),envir=.GlobalEnv);reference_draws<-runif(5)
  vcr_patient_randomization(vcr_test_job("patients.continuous",repeated,list(input),seed=812));actual_draws<-runif(5)
  list(pass=identical(a$data$patientId,b$data$patientId) && identical(a$data$patientId,c$data$patientId) &&
    max(abs((b$data$y-a$data$y)-0.7*a$data$arm))<1e-12 && !identical(a$data$y,c$data$y) && old_data$patientId[1]==old_id && identical(reference_draws,actual_draws),
    detail="Different paired job ids retain immutable cohort identities and arm-specific common draws; replicate 2 changes draws, legacy 1.0 preserves historical ids")
})
vcr_case("N52i", c("AC-04"), function() {
  fit <- vcr_fit_survival_baseline(c(1,2,3,4,6),c(1,1,0,1,0),"weibull",c(3,6))
  variants <- fit$baselineParameterScenarios
  other_ok <- all(vapply(c("lognormal","loglogistic"),function(distribution) {
    other <- vcr_fit_survival_baseline(c(1,2,3,4,6),c(1,1,0,1,0),distribution,c(3,6))
    all(vapply(other$baselineParameterScenarios,function(scenario) abs(scenario$median - if(distribution=="lognormal")exp(scenario$controlDistribution$meanlog) else scenario$controlDistribution$scale)<1e-12,logical(1)))
  },logical(1)))
  medians <- vapply(variants,function(v) v$controlDistribution$scale*log(2)^(1/v$controlDistribution$shape),numeric(1))
  list(pass=max(abs(medians-unlist(fit$medianParameterQuantiles)))<1e-12 && all(diff(medians)>0) &&
    !variants$p10$shapeUncertaintyIncluded && other_ok,
    detail="R emits P10/P50/P90 fitted-median parameter scenarios; Weibull medians reproduce those quantiles exactly with shape fixed")
})
vcr_case("N52j", c("AC-04", "AC-27"), function() {
  job <- .n52_equation_job()
  job$scenario$cohortRules <- list(list(name="older",rule=list(op="compare",column="age",comparator="gte",value=50)))
  dir<-tempfile("n52cohort-");dir.create(dir);on.exit(unlink(dir,recursive=TRUE),add=TRUE)
  result<-vcr_test_run(job,output_dir=dir); table<-vcr_test_table(result,"prognostic-predictions",dir)
  expected<-stats::plogis(-1+0.05*(60-50))
  list(pass=identical(result$status,"succeeded") && result$counts$realPatients==1 && result$diagnostics$cohort$startingRows==3 &&
    result$diagnostics$cohort$keptRows==1 && identical(table$patientId,"S2") && abs(result$measures[[1]]$value-expected)<1e-12,
    detail="Only the selected older cohort member S2 is predicted; excluded/unknown rows do not reappear as whole-snapshot controls")
})
