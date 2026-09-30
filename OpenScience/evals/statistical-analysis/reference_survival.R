# Evaluator only: native survival reference, with explicit event coding and ties.
args <- commandArgs(trailingOnly = TRUE)
x <- read.csv(args[[1]])
fit <- survival::coxph(survival::Surv(time, status == 2) ~ age + factor(sex), data = x, ties = "efron")
s <- summary(fit)
km <- summary(survival::survfit(survival::Surv(time, status == 2) ~ 1, data = x))$table
ph <- survival::cox.zph(fit)
number <- function(value) format(value, digits = 17, scientific = FALSE, trim = TRUE)
field <- function(name, value) paste0('"', name, '":', number(value))
cat(paste0('{', paste(c(
  field("rows", nrow(x)), field("events", sum(x$status == 2)), field("censored", sum(x$status == 1)),
  field("median", km[["median"]]), field("medianLower", km[["0.95LCL"]]), field("medianUpper", km[["0.95UCL"]]),
  field("ageHR", s$conf.int[1, "exp(coef)"]), field("ageLower", s$conf.int[1, "lower .95"]), field("ageUpper", s$conf.int[1, "upper .95"]),
  field("femaleHR", s$conf.int[2, "exp(coef)"]), field("femaleLower", s$conf.int[2, "lower .95"]), field("femaleUpper", s$conf.int[2, "upper .95"]),
  field("ageP", s$coefficients[1, "Pr(>|z|)"]), field("femaleP", s$coefficients[2, "Pr(>|z|)"]),
  field("globalPhP", ph$table["GLOBAL", "p"]),
  paste0('"R":"', R.version.string, '"'), paste0('"survival":"', packageVersion("survival"), '"')
), collapse = ','), '}\n'))
