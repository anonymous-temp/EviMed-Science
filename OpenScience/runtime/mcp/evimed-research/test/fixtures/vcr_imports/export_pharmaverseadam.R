# Exports the three pharmaverseadam 1.3.0 datasets (Apache-2.0) the ADaM fixtures are built from as CSV,
# with R's Date and POSIXct values already in SAS's epoch (1960-01-01) as numbers, which is what a
# SAS-written transport file holds. Run once, then `make_adam_fixtures.py` writes the .xpt files:
#
#   Rscript export_pharmaverseadam.R <pharmaverseadam>/data <directory for the CSV files>
args <- commandArgs(trailingOnly = TRUE)
sas_days <- 3653  # days from 1960-01-01 to 1970-01-01
for (spec in list(c("adsl", "ADSL"), c("adae", "ADAE"), c("adtte_onco", "ADTTE"))) {
  env <- new.env()
  load(file.path(args[1], paste0(spec[1], ".rda")), envir = env)
  frame <- as.data.frame(get(spec[1], env), stringsAsFactors = FALSE)
  for (name in names(frame)) {
    value <- frame[[name]]
    if (inherits(value, "Date")) frame[[name]] <- as.numeric(value) + sas_days
    else if (inherits(value, "POSIXct")) frame[[name]] <- as.numeric(value) + sas_days * 86400
    else if (!is.numeric(value) && !is.character(value)) frame[[name]] <- as.character(value)
  }
  write.csv(frame, file.path(args[2], paste0(spec[2], ".csv")), row.names = FALSE, na = "")
}
