# Export only the two official cached data frames; no package, API or model.
args <- commandArgs(trailingOnly = TRUE)
cache <- new.env(parent = emptyenv())
load(args[[1]], envir = cache)
export <- function(object, role, filename) {
  dat <- cache[[object]]
  stopifnot(identical(class(dat), "data.frame"), nrow(dat) == 79L)
  fields <- c("SNP", "beta", "se", "effect_allele", "other_allele", "eaf", "pval", "samplesize", "chr", "pos")
  source <- ifelse(fields == "SNP", "SNP", paste0(fields, ".", role))
  if (role == "outcome") source[fields %in% c("chr", "pos")] <- c("chr", "pos")
  result <- dat[, source]
  names(result) <- fields
  stopifnot(!anyDuplicated(result$SNP), all(is.finite(result$beta)), all(result$se > 0))
  write.csv(result, file.path(args[[2]], filename), row.names = FALSE)
}
export("bmi_exp_dat", "exposure", "bmi_exposure.csv")
export("chd_out_dat", "outcome", "chd_outcome.csv")
