root <- Sys.getenv('VCR_EVAL_ENGINE_ROOT','/repo/项目代码/vcr-engine'); clin <- Sys.getenv('VCR_EVAL_CLINICAL','/clinical'); source(file.path(root,'R/engine.R')); vcr_engine_load(root); source(file.path(root,'tests/helpers/harness.R')); invisible(vcr_test_data_root())
a <- read.csv(file.path(clin,'hr-a-paired.csv')); input <- vcr_test_input(a,'snp_hr_a:subject',shape='subject',source='observed')
sc <- list(inputId=input$id,idColumn='USUBJID',sourceCondition='control',endpoint=list(type='continuous',outcomeColumn='hr_24',horizon=1,timeUnit='days'),predictors=list(list(column='hr_early',unit='bpm')),folds=5L,comparison=list(ranger=FALSE))
train <- vcr_test_run(vcr_test_job('model.prognostic_train',sc,list(input),seed=20261105L))
out <- list(training=train, heldout=list())
if (identical(train$status,'succeeded')) {
 eq <- train$diagnostics$model$equation
 for (g in c('b','c')) {
  d<-read.csv(file.path(clin,paste0('hr-',g,'-paired.csv'))); inp<-vcr_test_input(d[,c('USUBJID','hr_early')],paste0('snp_hr_',g,':subject'),shape='subject',source='observed')
  scenario<-list(inputId=inp$id,idColumn='USUBJID',sourceCondition='control',endpoint=list(type='continuous',horizon=1,timeUnit='days'),inputUnits=list(hr_early='bpm'),model=eq)
  dir<-file.path(clin,paste0('hr-pred-',g));dir.create(dir,showWarnings=FALSE)
  r<-vcr_test_run(vcr_test_job('model.prognostic_apply',scenario,list(inp)),output_dir=dir)
  if (identical(r$status,'succeeded')) {
   p<-vcr_test_table(r,'prognostic-predictions',dir); joined<-merge(d,p,by.x='USUBJID',by.y='patientId',all.x=TRUE,sort=FALSE); err<-joined$prediction-joined$hr_24
   out$heldout[[g]]<-list(result=r,n=nrow(d),scored=sum(is.finite(err)),mae=mean(abs(err),na.rm=TRUE),rmse=sqrt(mean(err^2,na.rm=TRUE)),bias=mean(err,na.rm=TRUE),calibration=as.list(coef(lm(hr_24~prediction,joined))))
  } else out$heldout[[g]]<-list(result=r,n=nrow(d))
 }
}
writeLines(jsonlite::toJSON(out,auto_unbox=TRUE,null='null',na='null',digits=NA,pretty=TRUE),file.path(clin,'hr-model-result.json'))
