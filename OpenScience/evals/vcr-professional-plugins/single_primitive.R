root <- '/repo/项目代码/vcr-engine'; source(file.path(root,'R/engine.R')); vcr_engine_load(root)
d <- read.csv('/clinical/engine_train.csv',check.names=FALSE); stopifnot(nrow(d)==4000,!anyDuplicated(d$USUBJID)); d$USUBJID <- NULL
before <- proc.time(); started <- Sys.time()
r <- vcr_population_synthpop(d,m=1L,seed=20261029L,sparse_aware=TRUE)
write.csv(cbind(copy=1L,r$data[[1]]),'/clinical/synthetic-one.csv',row.names=FALSE)
writeLines(jsonlite::toJSON(list(method='population.synthpop primitive',version='1.2.0 rules',notProductJob=TRUE,trainingRows=nrow(d),copies=r$m,generatedRows=r$generatedRecords,smoothingSkippedColumns=r$smoothingSkippedColumns,smoothingNotApplied=r$smoothingNotApplied,cpuSeconds=sum((proc.time()-before)[1:2]),wallSeconds=as.numeric(difftime(Sys.time(),started,units='secs'))),auto_unbox=TRUE,null='null',digits=NA,pretty=TRUE),'/clinical/single-result.json')
