# Regenerates the two CSV files in this directory from the maicplus 0.1.2 example
# data (CRAN, 2025-02-21). Not run by the test suite: the engine's library does
# not contain maicplus on purpose (it is a reference, never a dependency).
#
#   Rscript make-fixture.R            # needs maicplus 0.1.2 installed
#
# The vignette's published numbers (maicplus 0.1.2, "Anchored and unanchored MAIC
# for time-to-event") are reproduced from these rows by N34.
suppressMessages(library(maicplus))
data(centered_ipd_twt); data(adtte_twt); data(pseudo_ipd_twt)
cov <- c("AGE_CENTERED", "AGE_SQUARED_CENTERED", "SEX_MALE_CENTERED", "ECOG0_CENTERED", "SMOKE_CENTERED", "N_PR_THER_MEDIAN_CENTERED")
stopifnot(identical(centered_ipd_twt$ARM, adtte_twt$ARM))
# the two-arm study's patients (arm A and the common comparator C), covariates already centred on the
# aggregate-data trial's means as shipped; the outcome is TIME / EVENT (EVENT = 1 is an event), the columns
# the vignette's Cox models read. The package's own AVAL / CNSR columns are NOT used: for the arm-C rows
# they repeat arm A's values and disagree with TIME / EVENT.
ipd <- merge(centered_ipd_twt[, c("USUBJID", "ARM", cov)], adtte_twt[, c("USUBJID", "TIME", "EVENT")], by = "USUBJID", sort = FALSE)
ipd <- ipd[match(centered_ipd_twt$USUBJID, ipd$USUBJID), ]
write.csv(ipd, "ipd_two_arm.csv", row.names = FALSE)
# the aggregate-data trial's reconstructed patients (arm B and the common comparator C)
write.csv(pseudo_ipd_twt[, c("ARM", "TIME", "EVENT")], "pseudo_ipd_two_arm.csv", row.names = FALSE)
# The single-arm vignette's data is the A rows of the first file and the B rows of the second (checked
# when this fixture was made: identical TIME, EVENT and covariates).
