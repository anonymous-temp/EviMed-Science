base <- '/clinical'; set.seed(20261029)
read <- function(p) read.csv(file.path(base,p),check.names=FALSE,stringsAsFactors=FALSE)
train <- read(Sys.getenv('EVAL_TRAIN_FILE','reduced_a.csv')); tests <- lapply(c('b','c'), function(s) { x<-read(paste0(Sys.getenv('EVAL_TEST_PREFIX','reduced_'),s,'.csv')); y<-read(paste0('phys_',s,'_labels.csv')); stopifnot(identical(x$USUBJID,y$USUBJID));list(x=x,y=y$mortality) }); names(tests)<-c('B','C')
features <- setdiff(names(train),c('USUBJID','mortality')); stopifnot(all(vapply(tests,function(t) !('mortality'%in%names(t$x)) && all(features %in% names(t$x)),logical(1))))
fit <- function(d) {x<-d[,c(features,'mortality'),drop=FALSE];x$mortality<-as.numeric(as.character(x$mortality)); if('ICUType'%in%features) x$ICUType<-factor(x$ICUType,levels=1:4); suppressWarnings(glm(mortality~., data=x, family=binomial(),control=glm.control(maxit=80)))}
predict_test <- function(model, x) { newdata<-x[,features,drop=FALSE]; if('ICUType'%in%features) newdata$ICUType<-factor(newdata$ICUType,levels=1:4); p<-suppressWarnings(as.numeric(predict(model,newdata=newdata,type='response')));stopifnot(length(p)==nrow(x),all(is.finite(p))); pmin(pmax(p,1e-6),1-1e-6) }
metric <- function(y,p) {
 n1<-sum(y==1); n0<-sum(y==0); if(!n1||!n0)return(c(auc=NA,auprc=NA,brier=NA,intercept=NA,slope=NA))
 auc <- (sum(rank(p,ties.method='average')[y==1])-n1*(n1+1)/2)/(n1*n0)
 order <- order(p,decreasing=TRUE); ps<-p[order]; ys<-y[order]; ends<-which(c(diff(ps)!=0,TRUE)); tp<-cumsum(ys)[ends]; predicted<-ends; recall<-tp/n1; ap<-sum(diff(c(0,recall))*(tp/predicted))
 z<-qlogis(p); cal<-tryCatch(suppressWarnings(glm(y~z,family=binomial())),error=function(e) NULL)
 c(auc=auc,auprc=ap,brier=mean((p-y)^2),intercept=if(is.null(cal)) NA_real_ else unname(coef(cal)[1]),slope=if(is.null(cal)) NA_real_ else unname(coef(cal)[2]))
}
stopifnot(abs(metric(c(1,0,1,0),c(.9,.8,.2,.1))[["auc"]]-.75)<1e-12, abs(metric(c(1,0,1,0),c(.9,.8,.2,.1))[["auprc"]]-5/6)<1e-12)
evaluate <- function(y,p,reps=500L) { point<-metric(y,p); boot<-replicate(reps,{i<-sample.int(length(y),replace=TRUE); metric(y[i],p[i])}); bounds<-t(apply(boot,1,function(x) quantile(x,c(.025,.975),na.rm=TRUE,names=FALSE))); list(n=length(y),events=sum(y),point=as.list(point),bootstrap95=lapply(seq_along(point),function(i) list(metric=names(point)[i],low=bounds[i,1],high=bounds[i,2])),bootstrapReplicates=reps) }
real <- fit(train); pred_real<-lapply(tests,function(t) predict_test(real,t$x)); out<-list(design='A train / B and C held out, single fixed split, not an external hospital or trial', outcome='in-hospital mortality; no outcome field used as predictor', preprocessing='A-only median imputation and missingness indicators; no test outcome influences preprocessing', featureCount=length(features),syntheticAvailable=FALSE, realTrain=lapply(names(tests),function(g)evaluate(tests[[g]]$y,pred_real[[g]])));names(out$realTrain)<-names(tests)
subgroups <- function(t,p) {
  x<-t$x; valid_age<-if('Age_missing' %in% names(x)) x$Age_missing==0 else rep(TRUE,nrow(x)); valid_icu<-if('ICUType_missing' %in% names(x)) x$ICUType_missing==0 else rep(TRUE,nrow(x))
  groups<-c(list(age_lt65=valid_age & x$Age<65,age_65plus=valid_age & x$Age>=65),setNames(lapply(1:4,function(k) valid_icu & x$ICUType==k),paste0('ICUType_',1:4)))
  lapply(names(groups),function(name) {ix<-which(groups[[name]]); list(group=name,n=length(ix),events=sum(t$y[ix]),point=if(length(ix)>=20 && length(unique(t$y[ix]))==2) as.list(metric(t$y[ix],p[ix])) else NULL)})
}
out$realTrainSubgroups <- lapply(names(tests),function(g)subgroups(tests[[g]],pred_real[[g]]));names(out$realTrainSubgroups)<-names(tests)
out$subgroupsInterpretation <- 'Exploratory unadjusted age and ICU-type strata; no multiple-comparison correction; missing strata excluded; not a fairness or clinical-validation claim.'
out$modelFit <- list(real = list(converged = real$converged, iterations = real$iter, aliased = as.list(names(coef(real))[is.na(coef(real))])))
file <- file.path(base,paste0(Sys.getenv('EVAL_PREFIX','reduced'),'-engine-output'),'synthetic-population.csv')
if(file.exists(file) && Sys.getenv("BASELINE_ONLY") != "1") {
 syn<-read.csv(file,check.names=FALSE,stringsAsFactors=FALSE); stopifnot(all(c('copy','mortality',features)%in%names(syn))); copies<-sort(unique(syn$copy));models<-lapply(copies,function(k) fit(syn[syn$copy==k,,drop=FALSE])); predictions<-lapply(names(tests),function(g) sapply(models,function(m)predict_test(m,tests[[g]]$x)));names(predictions)<-names(tests)
 out$modelFit$synthetic <- lapply(models, function(model) list(converged = model$converged, iterations = model$iter, aliased = as.list(names(coef(model))[is.na(coef(model))])))
 out$syntheticAvailable<-TRUE;out$copies<-length(copies);out$syntheticRows<-nrow(syn);out$syntheticTrain<-lapply(names(tests),function(g){ mat<-predictions[[g]]; list(ensemble=evaluate(tests[[g]]$y,rowMeans(mat)),perCopy=lapply(seq_len(ncol(mat)),function(k)as.list(metric(tests[[g]]$y,mat[,k])))) });names(out$syntheticTrain)<-names(tests)
 out$syntheticSubgroups <- lapply(names(tests),function(g)subgroups(tests[[g]],rowMeans(predictions[[g]])));names(out$syntheticSubgroups)<-names(tests)
 out$pairedDifferences <- lapply(names(tests),function(g) {y<-tests[[g]]$y; synp<-rowMeans(predictions[[g]]); realp<-pred_real[[g]]; point<-metric(y,synp)-metric(y,realp); paired<-replicate(500,{i<-sample.int(length(y),replace=TRUE);metric(y[i],synp[i])-metric(y[i],realp[i])}); bounds<-t(apply(paired,1,function(x) quantile(x,c(.025,.975),na.rm=TRUE,names=FALSE)));list(point=as.list(point),bootstrap95=lapply(seq_along(point),function(i)list(metric=names(point)[i],low=bounds[i,1],high=bounds[i,2])),interpretation="synthetic ensemble minus real-training model; paired patient bootstrap; does not include generator uncertainty") });names(out$pairedDifferences)<-names(tests)

 # Marginal fidelity: KS statistic and standardized mean differences; missing indicators remain features.
 one<-syn[syn$copy==copies[1],,drop=FALSE]; vars<-c(features,'mortality'); fidelity<-lapply(vars,function(nm){a<-as.numeric(as.character(train[[nm]])); b<-as.numeric(as.character(one[[nm]])); sd0<-sd(a); list(variable=nm,ks=unname(suppressWarnings(stats::ks.test(a,b,exact=FALSE)$statistic)),meanDifference=mean(b)-mean(a),standardizedDifference=if(is.finite(sd0)&&sd0>0)(mean(b)-mean(a))/sd0 else NULL) });out$fidelity<-fidelity
 # Structural consistency checks on one release copy, not a clinical-validity verdict.
 recipe <- jsonlite::fromJSON(file.path(base,'preprocessing.json'),simplifyVector=FALSE)$recipe
 consistency <- lapply(intersect(names(recipe),features),function(nm){ flag<-paste0(nm,'_missing'); if(!(flag %in% features))return(NULL); missing<-one[[flag]]==1; list(variable=nm,syntheticMarkedMissing=sum(missing),imputedValueInconsistent=sum(missing & abs(one[[nm]]-as.numeric(recipe[[nm]]$median))>1e-8)) }); consistency<-Filter(Negate(is.null),consistency)
 out$structuralDiagnostics <- list(note='Heuristic numeric and encoding checks only; imputed values should equal the A-trained median when missing indicator is 1.',firstCopyRows=nrow(one),ageOutside0to120=if('Age'%in%features)sum(one$Age<0 | one$Age>120) else NULL,invalidICUType=if('ICUType'%in%features)sum(!(one$ICUType%in%1:4)) else NULL,missingImputationConsistency=consistency)
 # Diagnostic only: size-matched, 500 sampled rows, independent holdout B; Euclidean distances on training-standardized features.
 k<-min(500,nrow(train),nrow(one),nrow(tests$B$x),nrow(tests$C$x)); ia<-sample.int(nrow(train),k); is<-sample.int(nrow(one),k)
 mu<-vapply(train[,features,drop=FALSE],mean,numeric(1));sdv<-vapply(train[,features,drop=FALSE],sd,numeric(1));sdv[!is.finite(sdv)|sdv==0]<-1
 scale_features<-function(d) sweep(sweep(as.matrix(d[,features,drop=FALSE]),2,mu,'-'),2,sdv,'/')
 A<-scale_features(train[ia,]);S<-scale_features(one[is,]); nearest<-function(x,y) {d<-outer(rowSums(x*x),rowSums(y*y),'+')-2*tcrossprod(x,y);sqrt(pmax(0,apply(d,1,min)))}
 dt<-nearest(S,A); mtrain<-nearest(A,S)
 comparisons<-lapply(names(tests),function(group){ held<-scale_features(tests[[group]]$x[sample.int(nrow(tests[[group]]$x),k),]);dh<-nearest(S,held); mhold<-nearest(held,S); score<-c(-mtrain,-mhold); membershipAuc<-(sum(rank(score,ties.method='average')[seq_len(k)])-k*(k+1)/2)/(k*k);list(holdout=group,syntheticToTrainMedian=median(dt),syntheticToHoldoutMedian=median(dh),nearerTrainShare=mean(dt<dh)+0.5*mean(dt==dh),exactTrainMatchShare=mean(dt<1e-8),nearestDistanceMembershipAuc=membershipAuc)})
 out$privacyDiagnostic<-list(method='Size-matched samples of up to 500 rows, nearest Euclidean distances on A-standardized predictors; diagnostic, not a privacy guarantee',samplePerGroup=k,comparisons=comparisons,seed=20261029)
}
writeLines(jsonlite::toJSON(out,auto_unbox=TRUE,null='null',na='null',digits=NA,pretty=TRUE),file.path(base,Sys.getenv('EVAL_OUTPUT', if (Sys.getenv('BASELINE_ONLY') == '1') 'baseline-metrics.json' else paste0(Sys.getenv('EVAL_PREFIX','reduced'),'-prediction-metrics.json'))))
cat('PREDICTION_DONE synthetic=',out$syntheticAvailable,' B real AUROC=',round(out$realTrain$B$point$auc,4),' C=',round(out$realTrain$C$point$auc,4),'\n')
