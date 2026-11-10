# The held-out world of the matched-budget search benchmark (addendum D6): an exact truth table, written before any search was run on it.
# Two-arm comparison of means, SD 1, true difference 0.5, one-sided test of the pooled-variance t statistic against the NORMAL critical value
# z(1 - alpha): the cutoff ignores the estimated variance, so the type I error is P(T_{2n-2} > z) and exceeds alpha at every size. Power is the
# noncentral t tail. Designs: n per arm 40, 45, ..., 80 times alpha {0.025, 0.02, 0.015}, in that order (n slowest). The second world (addendum D6b) is
# `Rscript heldout-world.R <out> 0.45 65 105`.
args <- commandArgs(trailingOnly = TRUE)  # output file, then optionally the true difference and the range of n per arm (default: the first held-out world)
diffs <- if (length(args) >= 4) as.numeric(args[2]) else 0.5
range <- if (length(args) >= 4) as.numeric(args[3:4]) else c(40, 80)
out <- character()
for (n in seq(range[1], range[2], by = 5)) for (alpha in c(0.025, 0.02, 0.015)) {
  df <- 2 * n - 2; z <- qnorm(1 - alpha); ncp <- diffs * sqrt(n / 2)
  out <- c(out, sprintf("%d\t%s\t%.15g\t%.15g", n, format(alpha), pt(z, df, ncp = ncp, lower.tail = FALSE), pt(z, df, lower.tail = FALSE)))
}
writeLines(out, args[1])  # one design per line: n per arm, alpha, true power, true type I error; heldout-world.mjs turns it into the world file
