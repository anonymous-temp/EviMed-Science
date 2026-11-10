# The held-out world of the matched-budget search benchmark (addendum D6): an exact truth table, written before any search was run on it.
# Two-arm comparison of means, SD 1, true difference 0.5, one-sided test of the pooled-variance t statistic against the NORMAL critical value
# z(1 - alpha): the cutoff ignores the estimated variance, so the type I error is P(T_{2n-2} > z) and exceeds alpha at every size. Power is the
# noncentral t tail. Designs: n per arm 40, 45, ..., 80 times alpha {0.025, 0.02, 0.015}, in that order (n slowest).
args <- commandArgs(trailingOnly = TRUE)
out <- character()
for (n in seq(40, 80, by = 5)) for (alpha in c(0.025, 0.02, 0.015)) {
  df <- 2 * n - 2; z <- qnorm(1 - alpha); ncp <- 0.5 * sqrt(n / 2)
  out <- c(out, sprintf("%d\t%s\t%.15g\t%.15g", n, format(alpha), pt(z, df, ncp = ncp, lower.tail = FALSE), pt(z, df, lower.tail = FALSE)))
}
writeLines(out, args[1])  # one design per line: n per arm, alpha, true power, true type I error; heldout-world.mjs turns it into the world file
