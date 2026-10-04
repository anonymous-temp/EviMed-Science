# Independent reference for the gene-expression-analysis capability: GSE5583 (wild type vs HDAC1 knock-out mouse
# embryonic stem cells, GPL81), computed with base R only. Nothing of the platform's code is used: the series
# matrix is read with readLines/read.delim, the transformation rule is GEO2R's, the test is base `t.test`
# (Welch, the default) and the adjustment is base `p.adjust(method = "BH")`.
#
#   Rscript reference_gse5583.R GSE5583_series_matrix.txt.gz reference_top_table.tsv
args <- commandArgs(trailingOnly = TRUE)
lines <- readLines(gzfile(args[1]))
begin <- grep("^!series_matrix_table_begin", lines)
end <- grep("^!series_matrix_table_end", lines)
ex <- read.delim(text = lines[(begin + 1):(end - 1)], header = TRUE, row.names = 1, check.names = FALSE,
                 na.strings = c("", "null", "NA"), quote = "\"")
ex <- as.matrix(ex)
# GEO2R's rule: take log2 when the values look linear.
qx <- as.numeric(quantile(ex, c(0, 0.25, 0.5, 0.75, 0.99, 1), na.rm = TRUE))
logc <- (qx[5] > 100) || (qx[6] - qx[1] > 50 && qx[2] > 0)
if (logc) {
  ex[which(ex <= 0)] <- NaN
  ex <- log2(ex)
}
samples <- colnames(ex)
reference <- c("GSM130365", "GSM130366", "GSM130367")  # wild type
comparison <- c("GSM130368", "GSM130369", "GSM130370") # HDAC1 knock out
stopifnot(all(c(reference, comparison) %in% samples))
res <- t(apply(ex, 1, function(row) {
  a <- row[reference]; b <- row[comparison]
  a <- a[!is.na(a)]; b <- b[!is.na(b)]
  if (length(a) < 2 || length(b) < 2) return(rep(NA_real_, 7))
  fit <- tryCatch(t.test(b, a, var.equal = FALSE), error = function(e) NULL)
  if (is.null(fit)) return(rep(NA_real_, 7))
  c(mean(a), mean(b), mean(b) - mean(a), unname(fit$statistic), unname(fit$parameter), fit$p.value, fit$conf.int[1])
}))
colnames(res) <- c("mean_reference", "mean_comparison", "log2_fold_change", "t", "df", "p_value", "ci95_low")
res <- res[!is.na(res[, "p_value"]), , drop = FALSE]
adj <- p.adjust(res[, "p_value"], method = "BH")
out <- data.frame(probe_id = rownames(res), res, adj_p_value = adj, check.names = FALSE)
out <- out[order(out$p_value, -abs(out$t), out$probe_id), ]
cat(sprintf("logc=%s probes_tested=%d adj_lt_0.05=%d adj_lt_0.01=%d\n", logc, nrow(out), sum(out$adj_p_value < 0.05), sum(out$adj_p_value < 0.01)))
write.table(out[1:50, ], args[2], sep = "\t", quote = FALSE, row.names = FALSE, col.names = TRUE)
write(sprintf("probes_tested\t%d\nadj_lt_0.05\t%d\nadj_lt_0.01\t%d\nlogc\t%s\nR\t%s\n", nrow(out), sum(out$adj_p_value < 0.05), sum(out$adj_p_value < 0.01), logc, R.version.string),
      paste0(args[2], ".summary"))
