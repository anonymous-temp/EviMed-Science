# Sparse numeric smoothing is scoped to 1.2.0; neither the rows nor fields may disappear.
vcr_case("N199a", c("AC-04", "AC-31"), function() {
  d <- data.frame(sparse = c(rep(1, 950), seq_len(50)), regular = seq_len(1000),
                  constant = rep(7, 1000), binary = rep(0:1, 500))
  kind <- RNGkind(); on.exit(do.call(RNGkind, as.list(kind)), add=TRUE)
  RNGkind("Mersenne-Twister")
  old <- tryCatch(vcr_population_synthpop(d, m = 1L, seed = 9981L), error = identity)
  replay <- tryCatch(vcr_population_synthpop(d, m = 1L, seed = 9981L, sparse_aware = FALSE), error = identity)
  newer <- tryCatch(vcr_population_synthpop(d, m = 1L, seed = 9981L, sparse_aware = TRUE), error = identity)
  # Captured from the pre-1.2 implementation on the pinned aarch64 R runtime.
  legacy_hash <- if (!inherits(old, "error")) vcr_sha256(vcr_canonical_json(as.list(old$data[[1]]))) else ""
  golden <- !grepl("aarch64", R.version$platform, fixed=TRUE) || identical(legacy_hash, "58d734ab8b5158fce0dd85fbe464e377ed8643e6fc2efd34ecb3e4539c3eeaa3")
  ok <- golden && !inherits(old, "error") && !inherits(replay, "error") && identical(old$data, replay$data) && length(old$smoothingSkippedColumns) == 0 &&
    !inherits(newer, "error") && identical(unlist(newer$smoothingSkippedColumns), "sparse") &&
    nrow(newer$data[[1]]) == nrow(d) && identical(names(newer$data[[1]]), names(d)) &&
    all(as.character(newer$data[[1]]$constant) == "7") && all(as.character(newer$data[[1]]$binary) %in% c("0", "1"))
  input <- vcr_test_input(cbind(USUBJID=sprintf("S%04d",seq_len(nrow(d))), d), "snp_n199:subject", shape="subject")
  job <- vcr_test_job("population.synthpop", list(holdoutShare=0,m=5L), list(input), seed=9981L)
  job$methodVersion <- "1.2.0"
  actual <- vcr_test_run(job)
  reported <- identical(actual$status, "succeeded") && identical(unlist(actual$diagnostics$smoothingSkippedColumns), "sparse") && actual$counts$generatedRecords == 5000
  # An unrelated failure is not converted into an apparently successful copy.
  fail <- tryCatch(vcr_population_synthpop(data.frame(missing=rep(NA_real_,1000), regular=seq_len(1000)), m=1L, seed=9982L, sparse_aware=TRUE), error=identity)
  missing_ok <- inherits(fail,"error") || ("missing" %in% names(fail$data[[1]]) && all(is.na(fail$data[[1]]$missing)))
  ns <- asNamespace("synthpop"); real_syn <- get("syn", ns); unlockBinding("syn", ns)
  on.exit({assign("syn", real_syn, envir=ns); lockBinding("syn", ns)}, add=TRUE)
  assign("syn", function(...) stop("unrelated engine error"), envir=ns)
  unrelated <- tryCatch(vcr_population_synthpop(d,m=1L,seed=9981L,sparse_aware=TRUE),error=identity)
  error_ok <- inherits(unrelated,"error") && identical(conditionMessage(unrelated),"unrelated engine error")
  list(pass = ok && missing_ok && reported && error_ok, detail = sprintf("legacy smoother unchanged (%s); new method keeps 1000 rows and reports only sparse numeric column (%s); all-missing remains missing or is explicitly refused (%s)", !inherits(old,"error"), ok, missing_ok))
})

vcr_case("N199b", c("AC-04", "AC-31"), function() {
  set.seed(99199); a<-data.frame(x=rnorm(200), group=factor(rep(letters[1:3],length.out=200)))
  b<-data.frame(x=rnorm(200), group=factor(rep(letters[1:3],length.out=200),levels=letters[1:3]))
  small<-vcr_utility_propensity(a,b,size_guard=TRUE); legacy<-vcr_utility_propensity(a,b)
  common<-intersect(names(small),names(legacy)); same<-identical(small[common],legacy[common])
  f<-vcr_model_formula('..syn..',c('x','group'),pairwise=TRUE); full<-rbind(cbind(a,..syn..=0),cbind(b,..syn..=1))
  dims<-ncol(model.matrix(f,full)); expected<-6L
  wide<-as.data.frame(matrix(rnorm(300*78),nrow=300));names(wide)<-sprintf('x%02d',seq_len(78))
  guarded<-vcr_utility_propensity(wide,wide,size_guard=TRUE)
  high_ok<-identical(guarded$available,FALSE) && guarded$designColumns==3082 && guarded$designCells==600*3082 &&
    'design_columns_limit' %in% unlist(guarded$reason) && is.na(guarded$sPMSE) && identical(vcr_band(guarded$sPMSE,vcr_quality_bands()$sPmse),'unknown')
  const<-vcr_utility_propensity(data.frame(x=rep(1,100)),data.frame(x=rep(1,100)),size_guard=TRUE)
  constant_ok<-identical(const$available,FALSE) && 'constant_predictor' %in% unlist(const$reason)
  one<-data.frame(x=seq_len(100), group=factor(rep('a',100),levels=c('a','b','c')))
  onelevel<-vcr_utility_propensity(one,one,size_guard=TRUE)
  factor_ok<-identical(onelevel$available,FALSE) && 'constant_predictor' %in% unlist(onelevel$reason)
  qc<-data.frame(x=seq_len(100),constant=rep(1,100))
  quality<-vcr_quality_report(qc,qc,propensity_size_guard=TRUE)
  bycopy<-.vcr_quality_by_copy(qc,list(qc),NULL,NULL,propensity_size_guard=TRUE)
  propagation<-identical(quality$fidelity$global$available,FALSE) && identical(quality$bands$sPMSE,"unknown") &&
    identical(quality$bands$propensityAuc,"unknown") && grepl("constant_predictor",bycopy$propensityUnavailableReason[[1]],fixed=TRUE)
  list(pass=same && dims==expected && high_ok && constant_ok && factor_ok && propagation,
    detail=sprintf('small factor/numeric design is %d columns and unchanged (%s); 78-variable pairwise design is %d columns and explicitly unavailable (%s); constant and unused-level factors are refused (%s)',dims,same,guarded$designColumns,high_ok,constant_ok && factor_ok))
})

vcr_case("N199c", c("AC-04"), function() {
  job <- .n60_job(.n60_data(n=60L), "n199c")
  issues <- lapply(c("1.0.0","1.1.0","1.2.0"), function(version) {
    job$methodVersion <- version
    vapply(vcr_validate_job(vcr_test_json(job)), function(i) i$code, character(1))
  })
  ok <- "method_version_mismatch" %in% issues[[1]] && !length(issues[[2]]) && !length(issues[[3]])
  list(pass=ok,detail="calibration is refused at 1.0, accepted at 1.1 and 1.2")
})

vcr_case("N199d", c("AC-04", "AC-31"), function() {
  set.seed(1994); d<-data.frame(USUBJID=sprintf('P%03d',seq_len(120)), x=rnorm(120), missing=rep(c(0,0,0,1),30), y=rnorm(120), absent=rep(c(0,1,0,0),30))
  d$x[d$missing==1]<-5;d$y[d$absent==1]<- -2
  rules<-list(list(valueColumn='x',indicatorColumn='missing',imputedValue=5,missingValue=1L),list(valueColumn='y',indicatorColumn='absent',imputedValue= -2,missingValue=1L))
  inp<-vcr_test_input(d,'snp_n199d:subject',shape='subject')
  job<-vcr_test_job('population.synthpop',list(holdoutShare=0,m=5L,imputationRules=rules),list(inp),seed=1994L)
  dir<-tempfile('n199d');dir.create(dir);on.exit(unlink(dir,recursive=TRUE),add=TRUE)
  r<-vcr_test_run(job,output_dir=dir)
  out<-if(identical(r$status,'succeeded'))vcr_test_table(r,'synthetic-population',dir) else data.frame()
  good<-nrow(out)==600 && all(out$x[as.character(out$missing)=='1']==5) && all(out$y[as.character(out$absent)=='1']== -2) && length(r$diagnostics$imputationCorrections)==5
  old<-job;old$methodVersion<-'1.2.0'; oldcodes<-vapply(vcr_validate_job(vcr_test_json(old)),function(i)i$code,character(1))
  bad<-d;bad$x[bad$missing==1][1]<-9
  badinput<-vcr_test_input(bad,'snp_n199bad:subject',shape='subject');invalid<-job;invalid$inputs<-list(badinput)
  refused<-vcr_test_run(invalid)
  unknown<-d;unknown$missing[1]<-NA
  unknown_ok<-inherits(tryCatch(vcr_validate_imputation_rules(unknown,rules),error=identity),'error')
  dup<-c(rules,list(rules[[1]])); duplicate_ok<-inherits(tryCatch(vcr_validate_imputation_rules(d,dup),error=identity),'error')
  direct<-vcr_apply_imputation_rules(data.frame(x=c(9,8),missing=c(1,0),y=c(7,2),absent=c(1,0)),rules)
  fixed<-identical(direct$data$x,c(5,8)) && identical(direct$data$y,c(-2,2)) && direct$report[[1]]$corrected==1
  list(pass=good && 'method_version_mismatch' %in% oldcodes && identical(refused$status,'failed') && unknown_ok && duplicate_ok && fixed,
       detail=sprintf('two declared encodings preserved over five copies (%s); invalid source/unknown/duplicate refused (%s); unmarked values unchanged (%s); 1.2 rejects new rule (%s)',good,identical(refused$status,'failed') && unknown_ok && duplicate_ok,fixed,'method_version_mismatch' %in% oldcodes))
})

vcr_case("N199e", c("AC-04", "AC-31"), function() {
  fill <- 2.1333333333333333; declared <- fill - 3e-15
  d<-data.frame(USUBJID=sprintf('F%02d',seq_len(20)),x=seq_len(20)/7,flag=factor(c(rep('0',19),'1'),levels=c('0','1')))
  d$x[20]<-fill
  rules<-list(list(valueColumn='x',indicatorColumn='flag',imputedValue=declared,missingValue=1L))
  inp<-vcr_test_input(d,'snp_n199e:subject',shape='subject')
  inputpath<-file.path(vcr_test_data_root(),inp$location); precise<-d;precise$x<-sprintf('%.17g',d$x)
  write.csv(precise,inputpath,row.names=FALSE,na='');inp$hash<-vcr_file_sha256(inputpath)
  job<-vcr_test_job('population.synthpop',list(holdoutShare=0,m=5L,imputationRules=rules),list(inp),seed=1995L)
  dir<-tempfile('n199e');dir.create(dir);on.exit(unlink(dir,recursive=TRUE),add=TRUE)
  expected_declared<-vcr_test_json(job)$scenario$imputationRules[[1]]$imputedValue
  direct<-tryCatch(vcr_population_synthpop(d[,c('x','flag')],m=1L,seed=1995L,sparse_aware=TRUE,imputation_rules=rules,exact_imputation=TRUE),error=identity)
  direct_ok<-!inherits(direct,'error') && all(as.character(direct$data[[1]]$flag) %in% c('0','1'))
  r<-vcr_test_run(job,output_dir=dir)
  out<-if(identical(r$status,'succeeded'))vcr_test_table(r,'synthetic-population',dir) else data.frame()
  flags<-if(nrow(out))as.numeric(as.character(out$flag)) else numeric(0)
  bindings<-if(identical(r$status,'succeeded'))r$diagnostics$imputationCorrections[[1]]$rules[[1]] else list()
  safe<-nrow(out)==100 && all(flags %in% 0:1) && all(out$x[flags==1]==fill) && identical(bindings$sourceBoundValue,sprintf('%.17g',fill)) && identical(bindings$declaredValue,sprintf('%.17g',expected_declared)) && direct_ok
  # Both the new opt-in CSV and the historical default write and read here.
  numbers<-c(fill,pi,0.1,-1.2345678901234567,1e-100,1e100);csvdir<-tempfile('n199csv');dir.create(csvdir);on.exit(unlink(csvdir,recursive=TRUE),add=TRUE)
  vcr_write_table(data.frame(x=numbers),'roundtrip',csvdir,roundtrip_numeric=TRUE)
  readback<-read.csv(file.path(csvdir,'roundtrip.csv'))$x
  vcr_write_table(data.frame(x=numbers),'legacy',csvdir)
  expected<-tempfile();on.exit(unlink(expected),add=TRUE);write.csv(data.frame(x=numbers),expected,row.names=FALSE,na='')
  legacy<-identical(readBin(file.path(csvdir,'legacy.csv'),'raw',n=1e6),readBin(expected,'raw',n=1e6))
  list(pass=safe && identical(readback,numbers) && legacy, detail=sprintf('declared near-fill binds exact source; factor 19:1 remains binary (%s); doubles round-trip bit-identically (%s); legacy bytes unchanged (%s); status=%s issue=%s rows=%d bound=%s declared=%s',safe,identical(readback,numbers),legacy,r$status,paste(vapply(r$diagnostics$issues %||% list(),function(z)paste(z$code,z$detail),character(1)),collapse=';'),nrow(out),bindings$sourceBoundValue %||% 'none',bindings$declaredValue %||% 'none'), extra=if(!safe) list(status=r$status,issues=r$diagnostics$issues,bindings=bindings,rows=nrow(out)) else NULL)
})

vcr_case("N199f", c("AC-04"), function() {
  set.seed(1996);a<-as.data.frame(matrix(rnorm(300*78),nrow=300));names(a)<-sprintf('x%02d',1:78)
  i<-vcr_test_input(a,'snp_n199fa:subject',shape='subject',source='observed')
  j<-vcr_test_input(a,'snp_n199fb:subject',shape='subject',source='synthetic')
  job<-vcr_test_job('population.quality',list(trainingInputId=i$id,syntheticInputId=j$id),list(i,j),seed=1996L)
  r<-vcr_test_run(job);g<-r$diagnostics$quality$fidelity$global
  ok<-identical(r$status,'succeeded') && identical(g$available,FALSE) && g$designColumns==3082 && identical(r$diagnostics$quality$bands$sPMSE,'unknown')
  list(pass=ok,detail=sprintf('standalone quality 1.2 reports oversized propensity as unavailable, not a pass (%s)',ok))
})
