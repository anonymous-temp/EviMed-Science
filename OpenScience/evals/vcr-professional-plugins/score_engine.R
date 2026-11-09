root <- '/repo/项目代码/vcr-engine'; source(file.path(root,'R/engine.R')); vcr_engine_load(root)
a<-read.csv('/clinical/engine_train.csv',check.names=FALSE);a$USUBJID<-NULL
b<-read.csv('/clinical/synthetic-one.csv',check.names=FALSE);b$copy<-NULL
stopifnot(nrow(a)==4000,nrow(b)==4000,identical(names(a),names(b)))
before<-proc.time();start<-Sys.time();Rprof('/clinical/quality-profile.out',interval=.02)
q<-vcr_quality_report(a,b,NULL,copies=list(b),generator=list(family='synthpop_cart',m=1L),inference=NULL,propensity_size_guard=TRUE)
Rprof(NULL)
writeLines(jsonlite::toJSON(list(report=q,cpuSeconds=sum((proc.time()-before)[1:2]),wallSeconds=as.numeric(difftime(Sys.time(),start,units='secs'))),auto_unbox=TRUE,null='null',na='null',digits=NA,pretty=TRUE),'/clinical/engine-quality.json')
