#!/usr/bin/env Rscript
# build-ad-adascog-parameter-set.R — write R/models/ad_adascog11_camd_adsim3.json from adsim 3.0's released posterior (plan T06).
#
# Run once, offline, by hand; the engine never runs it and never reads the archive:
#
#   curl -o adsim_3.0.tar.gz https://storage.googleapis.com/google-code-archive-downloads/v2/code.google.com/alzheimers-disease-progression-model-adascog/adsim_3.0.tar.gz
#   sha1sum adsim_3.0.tar.gz      # bf03894a7b86eec4113bd457d5fcf6386b14a65c (the archive's own listing)
#   tar -xzf adsim_3.0.tar.gz -C <an empty directory>
#   Rscript --vanilla scripts/build-ad-adascog-parameter-set.R <dir>/adsim/data/posterior.rda R/models/ad_adascog11_camd_adsim3.json
#
# Hidden knowledge:
#
# - **The numbers are the authors' own, copied, never re-estimated.** `posterior.rda` holds one object, `posterior`: a 1,600 x 60 numeric matrix
#   of MCMC draws (the CAMD/C-Path ADAS-cog model of Rogers et al. 2012 as shipped with the simulation package adsim 3.0, DESCRIPTION Date
#   2013-8-07, licence GPL (>= 2)). The script refuses a file whose SHA-256 is not the one the source audit recorded, so a different file can
#   never be written under this id.
# - **Only the columns the simulation reads are kept**, in the matrix's own order: the 19 of the disease and placebo model (`acRun`), the 5 of
#   the dropout model (`dropTime`), the 8 of the covariate generator (`.simApoE`, `.simAge`, `.simGen`) and the 9 fitted AChE-inhibitor
#   parameters (kept so a numeric case can hold the file to the donepezil ET50 of Romero et al. 2015; the simulator does not use them). Left out:
#   the six "M" variance families, `omegaStudy[1..9]`, the derived `beta` and `keq` (the engine computes them from `aucPlacebo`, `kel` and
#   `keqMinusKel`) and the two `deviance` columns.
# - **The copy is exact.** Each value is written with 15 significant digits, and with 17 where jsonlite's own number parser (the one the
#   engine reads the file with) would not give back the same double from 15 (three values of the 65,600: its parser is not correctly
#   rounded); the script reads the whole file back and stops unless every draw is identical to the matrix's, bit for bit.
# ---------------------------------------------------------------------------

local({
  lib <- Sys.getenv("VCR_R_LIBS", "")
  if (nzchar(lib) && dir.exists(lib)) .libPaths(c(lib, .libPaths()))
})
args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 2L) stop("usage: build-ad-adascog-parameter-set.R <posterior.rda> <output.json>")
rda <- args[[1]]; out <- args[[2]]

SOURCE_SHA256 <- "f41cfd47ed3a94633169afb1246377a236697279425e4b4bf2c844069bf678be"
got <- digest::digest(file = rda, algo = "sha256")
if (!identical(got, SOURCE_SHA256)) stop(sprintf("posterior.rda has SHA-256 %s, not %s: not the adsim 3.0 file", got, SOURCE_SHA256))

env <- new.env(parent = emptyenv())
loaded <- load(rda, envir = env)
if (!identical(loaded, "posterior")) stop("posterior.rda holds ", paste(loaded, collapse = ", "), ", not the one matrix `posterior`")
post <- env[["posterior"]]
if (!is.matrix(post) || !is.double(post) || !identical(dim(post), c(1600L, 60L))) stop("`posterior` is not a 1600 x 60 numeric matrix")

KEEP <- c("nuAlpha", "nuEta", "lambdaEtaBMMSE", "lambdaAlphaBMMSE", "lambdaAlphaAge", "lambdaAlphaApo1", "lambdaAlphaApo2", "lambdaAlphaGen",
          "aucPlacebo", "kel", "keqMinusKel", "phiEpsilon", "kappaEpsilon", "phiEta", "kappaEta", "phiAlpha", "kappaAlpha", "psiEta", "psiAlpha",
          "pApo[1]", "pApo[2]", "pApo[3]", "Eage[1]", "Eage[2]", "Eage[3]", "Vage", "pGen",
          "gamma[1]", "gamma[2]", "gamma[3]", "eStar[1]", "eStar[2]", "eStar[3]", "et50[1]", "et50[2]", "et50[3]",
          "beta0", "betaAge", "betaBmmse", "v", "sdStudy")
cols <- colnames(post)
if (anyDuplicated(cols[cols %in% KEEP]) || !all(KEEP %in% cols)) stop("a kept column is missing or named twice in `posterior`")
KEEP <- cols[cols %in% KEEP]   # the matrix's own order
if (!all(is.finite(post[, KEEP]))) stop("a kept column has a value that is not finite")

draws <- lapply(stats::setNames(KEEP, KEEP), function(k) unname(post[, k]))
doc <- list(
  id = "camd-adas-cog-11", version = "adsim-3.0",
  title = "ADAS-cog 11 drug-disease-trial model of mild and moderate Alzheimer disease (CAMD / C-Path, Rogers et al. 2012), posterior released with adsim 3.0",
  source = list(
    artifact = "adsim 3.0, 2013-08-07", package = "adsim", packageVersion = "3.0", packageDate = "2013-8-07", licence = "GPL (>= 2)",
    url = "https://storage.googleapis.com/google-code-archive-downloads/v2/code.google.com/alzheimers-disease-progression-model-adascog/adsim_3.0.tar.gz",
    archiveSha1 = "bf03894a7b86eec4113bd457d5fcf6386b14a65c", archiveSha256 = "497a7dac9fec9a17bb1a176df233ef101decf573d28c82700219c10f95b315c2",
    file = "adsim/data/posterior.rda", object = "posterior", sourceSha256 = SOURCE_SHA256, sourceColumns = ncol(post),
    publication = "Rogers JA et al. J Pharmacokinet Pharmacodyn 2012;39(5):479-498, doi:10.1007/s10928-012-9263-3"),
  endpoint = list(name = "ADAS-cog 11", min = 0, max = 70, unit = "points", higherIsWorse = TRUE),
  timeUnit = "weeks",
  reference = list(bmmse = 21, age = 75, female = 0, apoe4Alleles = 0),
  drugs = list(order = c("donepezil", "galantamine", "rivastigmine"), referenceDoseMg = c(5, 24, 6)),
  draws = nrow(post), columns = KEEP,
  medians = lapply(draws, stats::median),
  values = draws)

#' One column as JSON text: 15 significant digits, 17 for a value the parser would not read back from 15.
column_json <- function(x) {
  tok <- sprintf("%.15g", x)
  again <- jsonlite::fromJSON(paste0("[", paste(tok, collapse = ","), "]"))
  tok[again != x] <- sprintf("%.17g", x[again != x])
  paste0("[", paste(tok, collapse = ","), "]")
}
values_json <- paste0("{", paste(sprintf("%s:%s", vapply(KEEP, function(k) jsonlite::toJSON(k, auto_unbox = TRUE), character(1)),
                                         vapply(KEEP, function(k) column_json(draws[[k]]), character(1))), collapse = ","), "}")
doc$values <- "__VALUES__"
text <- sub("\"__VALUES__\"", values_json, jsonlite::toJSON(doc, auto_unbox = TRUE, digits = I(15), pretty = FALSE), fixed = TRUE)
back <- jsonlite::fromJSON(text, simplifyVector = TRUE)
if (!identical(back[["medians"]], lapply(draws, stats::median)) && !isTRUE(all.equal(unlist(back[["medians"]]), unlist(lapply(draws, stats::median)), tolerance = 1e-14))) stop("the medians do not read back")
same <- vapply(KEEP, function(k) identical(back[["values"]][[k]], draws[[k]]), logical(1))
if (!all(same)) stop("the JSON copy does not read back bit for bit: ", paste(KEEP[!same], collapse = ", "))
writeLines(text, out, useBytes = TRUE)
cat(sprintf("wrote %s: %d draws x %d columns, %d bytes, sha256 %s\n", out, nrow(post), length(KEEP), file.size(out), digest::digest(file = out, algo = "sha256")))
