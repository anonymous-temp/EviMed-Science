# [IN] None
# [OUT] R script template strings
# [POS] r_scripts/templates.py - R script templates
"""R script templates for MR analysis."""

# --- Skip tracking, shared by every optional analysis ---

# An analysis that could not run and one that ran and found nothing look
# identical downstream unless the difference is recorded. That is how the
# contamination-mixture step went unnoticed: it guarded on a package named
# MRConMix, which exists nowhere, so requireNamespace() was always FALSE, the
# block never ran in any environment, and every report still read as complete.
_SKIP_TRACKING_BLOCK = """
sensitivity_skipped <- character(0)
note_skip <- function(name, reason) {{
    sensitivity_skipped <<- c(sensitivity_skipped, paste0(name, ": ", reason))
    cat(sprintf("%s skipped: %s\\n", name, reason))
}}
"""

# --- Optional sensitivity analyses, shared by the MOE and local templates ---

_SENSITIVITY_BLOCK = """
# --- Radial MR ---
tryCatch({{
    if (!requireNamespace("RadialMR", quietly = TRUE)) {{
        note_skip("radial_mr", "RadialMR package not installed")
    }} else {{
        radial_dat <- RadialMR::format_radial(
            dat$beta.exposure, dat$beta.outcome,
            dat$se.exposure, dat$se.outcome, dat$SNP)
        radial_res <- RadialMR::ivw_radial(radial_dat, alpha = 0.05)
        radial_df <- data.frame(
            global_q_pval = radial_res$coef[1, "Pr(>|t|)"],
            n_outliers = length(radial_res$outliers))
        write.csv(radial_df, file.path(output_dir, "radial.csv"),
            row.names=FALSE)
    }}
}}, error = function(e) {{
    note_skip("radial_mr", e$message)
}})

# --- Contamination mixture ---
# The method is MendelianRandomization::mr_conmix, reached through an MRInput
# object rather than loose vectors.
tryCatch({{
    if (!requireNamespace("MendelianRandomization", quietly = TRUE)) {{
        note_skip("contamination_mixture",
            "MendelianRandomization package not installed")
    }} else if (nrow(dat) < 5) {{
        note_skip("contamination_mixture",
            sprintf("needs at least 5 instruments, have %d", nrow(dat)))
    }} else {{
        conmix_res <- MendelianRandomization::mr_conmix(
            MendelianRandomization::mr_input(
                bx = dat$beta.exposure, bxse = dat$se.exposure,
                by = dat$beta.outcome, byse = dat$se.outcome))
        # A multimodal likelihood yields one interval per mode. Report the outer
        # bounds and how many there were, rather than keeping the first and
        # presenting a multimodal result as a single interval.
        conmix_df <- data.frame(
            estimate = conmix_res@Estimate,
            ci_lower = min(conmix_res@CILower),
            ci_upper = max(conmix_res@CIUpper),
            n_intervals = length(conmix_res@CILower),
            pval = conmix_res@Pvalue)
        write.csv(conmix_df, file.path(output_dir, "conmix.csv"),
            row.names=FALSE)
    }}
}}, error = function(e) {{
    note_skip("contamination_mixture", e$message)
}})
"""

# --- Shared plot generation block (PDF + PNG) ---

_PLOT_BLOCK = """
pdf(file.path(output_dir, "scatter_plot.pdf"))
mr_scatter_plot(mr_res, dat)
dev.off()

png(file.path(output_dir, "scatter_plot.png"), width=8, height=6,
    units="in", res=300)
mr_scatter_plot(mr_res, dat)
dev.off()

pdf(file.path(output_dir, "forest_plot.pdf"))
res_single <- mr_singlesnp(dat)
mr_forest_plot(res_single)
dev.off()

png(file.path(output_dir, "forest_plot.png"), width=8, height=6,
    units="in", res=300)
mr_forest_plot(res_single)
dev.off()

pdf(file.path(output_dir, "funnel_plot.pdf"))
mr_funnel_plot(res_single)
dev.off()

png(file.path(output_dir, "funnel_plot.png"), width=8, height=6,
    units="in", res=300)
mr_funnel_plot(res_single)
dev.off()

pdf(file.path(output_dir, "loo_plot.pdf"))
res_loo <- mr_leaveoneout(dat)
mr_leaveoneout_plot(res_loo)
dev.off()

png(file.path(output_dir, "loo_plot.png"), width=8, height=6,
    units="in", res=300)
mr_leaveoneout_plot(res_loo)
dev.off()
"""

MR_STANDARD_TEMPLATE = """
library(TwoSampleMR)
library(ieugwasr)
library(jsonlite)

{token_line}

output_dir <- "{output_dir}"
thresholds <- c({thresholds})
exposure_dat <- NULL

for (thresh in thresholds) {{
    tryCatch({{
        exposure_dat <- extract_instruments(
            outcomes = "{exposure_id}", p1 = thresh,
            clump = TRUE, r2 = 0.001, kb = 10000)
        if (!is.null(exposure_dat) && nrow(exposure_dat) >= 3) {{
            cat(sprintf("Found %d IVs at p < %e\\n", nrow(exposure_dat), thresh))
            break
        }}
    }}, error = function(e) {{
        cat(sprintf("Threshold %e failed: %s\\n", thresh, e$message))
    }})
}}

if (is.null(exposure_dat) || nrow(exposure_dat) < 3) {{
    result <- list(error = "Insufficient instrumental variables (< 3)")
    write(toJSON(result, auto_unbox=TRUE), file.path(output_dir, "mr_error.json"))
    quit(status = 0)
}}

exposure_dat$F_stat <- (exposure_dat$beta.exposure / exposure_dat$se.exposure)^2
f_stats <- data.frame(snp=exposure_dat$SNP, f_statistic=exposure_dat$F_stat,
    beta=exposure_dat$beta.exposure, se=exposure_dat$se.exposure,
    pval=exposure_dat$pval.exposure)
write.csv(f_stats, file.path(output_dir, "f_statistics.csv"), row.names=FALSE)

cat(sprintf("Mean F-statistic: %.2f\\n", mean(exposure_dat$F_stat)))
cat(sprintf("Weak instruments (F<10): %d\\n", sum(exposure_dat$F_stat < 10)))

outcome_dat <- extract_outcome_data(snps=exposure_dat$SNP, outcomes="{outcome_id}")
if (is.null(outcome_dat) || nrow(outcome_dat) == 0) {{
    result <- list(error = "No outcome data available")
    write(toJSON(result, auto_unbox=TRUE), file.path(output_dir, "mr_error.json"))
    quit(status = 0)
}}

dat <- harmonise_data(exposure_dat, outcome_dat)
dat <- dat[dat$mr_keep == TRUE, ]
if (nrow(dat) < 3) {{
    result <- list(error = "Insufficient harmonized SNPs (< 3)")
    write(toJSON(result, auto_unbox=TRUE), file.path(output_dir, "mr_error.json"))
    quit(status = 0)
}}

mr_res <- mr(dat)
mr_res$or <- exp(mr_res$b)
mr_res$ci_lower <- exp(mr_res$b - 1.96 * mr_res$se)
mr_res$ci_upper <- exp(mr_res$b + 1.96 * mr_res$se)
write.csv(mr_res, file.path(output_dir, "mr_results.csv"), row.names=FALSE)

het <- mr_heterogeneity(dat)
write.csv(het, file.path(output_dir, "heterogeneity.csv"), row.names=FALSE)

plt <- mr_pleiotropy_test(dat)
write.csv(plt, file.path(output_dir, "pleiotropy.csv"), row.names=FALSE)

# --- Steiger directionality test ---
tryCatch({{
    steiger <- directionality_test(dat)
    write.csv(steiger, file.path(output_dir, "steiger.csv"), row.names=FALSE)
    cat(sprintf("Steiger: correct_causal_direction=%s, p=%.4e\\n",
        steiger$correct_causal_direction, steiger$steiger_pval))
}}, error = function(e) {{
    cat(sprintf("Steiger test failed: %s\\n", e$message))
}})

""" + _SKIP_TRACKING_BLOCK + """
# --- MR-PRESSO outlier detection ---
tryCatch({{
    if (!requireNamespace("MRPRESSO", quietly = TRUE)) {{
        note_skip("mr_presso", "MRPRESSO package not installed")
    }} else {{
        presso <- MRPRESSO::mr_presso(
            BetaOutcome = "beta.outcome", BetaExposure = "beta.exposure",
            SdOutcome = "se.outcome", SdExposure = "se.exposure",
            OUTLIERtest = TRUE, DISTORTIONtest = TRUE,
            data = as.data.frame(dat), NbDistribution = 1000,
            SignifThreshold = 0.05)
        presso_main <- data.frame(
            exposure = "{exposure_id}", outcome = "{outcome_id}",
            global_p = presso$`MR-PRESSO results`$`Global Test`$Pvalue,
            n_outliers = sum(presso$`MR-PRESSO results`$`Outlier Test`$Pvalue < 0.05,
                na.rm = TRUE))
        write.csv(presso_main, file.path(output_dir, "mrpresso.csv"), row.names=FALSE)

        if (!is.null(presso$`MR-PRESSO results`$`Distortion Test`)) {{
            cat(sprintf("MR-PRESSO distortion p=%.4e\\n",
                presso$`MR-PRESSO results`$`Distortion Test`$Pvalue))
        }}
    }}
}}, error = function(e) {{
    note_skip("mr_presso", e$message)
}})
""" + _PLOT_BLOCK + """
summary <- list(exposure_id="{exposure_id}", outcome_id="{outcome_id}",
    n_instruments=nrow(dat), mean_f_statistic=mean(exposure_dat$F_stat),
    pval_threshold=thresh, status="success",
    skipped_analyses=I(sensitivity_skipped))
write(toJSON(summary, auto_unbox=TRUE), file.path(output_dir, "mr_summary.json"))
cat("MR analysis completed successfully\\n")
"""

MR_MOE_TEMPLATE = """
library(TwoSampleMR)
library(ieugwasr)
library(jsonlite)

{token_line}

output_dir <- "{output_dir}"
load(system.file("extdata", "rf.rdata", package = "TwoSampleMR"))

exposure_dat <- extract_instruments(outcomes = "{exposure_id}", p1 = 5e-08)
if (is.null(exposure_dat) || nrow(exposure_dat) < 3) {{
    exposure_dat <- extract_instruments(outcomes = "{exposure_id}", p1 = 5e-06)
}}
if (is.null(exposure_dat) || nrow(exposure_dat) < 3) {{
    result <- list(error = "Insufficient IVs for MOE analysis")
    write(toJSON(result, auto_unbox=TRUE), file.path(output_dir, "mr_error.json"))
    quit(status = 0)
}}

exposure_dat$F_stat <- (exposure_dat$beta.exposure / exposure_dat$se.exposure)^2

outcome_dat <- extract_outcome_data(snps=exposure_dat$SNP, outcomes="{outcome_id}")
if (is.null(outcome_dat) || nrow(outcome_dat) == 0) {{
    result <- list(error = "No outcome data available for MOE")
    write(toJSON(result, auto_unbox=TRUE), file.path(output_dir, "mr_error.json"))
    quit(status = 0)
}}

dat <- harmonise_data(exposure_dat, outcome_dat)
dat <- dat[dat$mr_keep == TRUE, ]

mr_res <- mr(dat)
mr_res$or <- exp(mr_res$b)
mr_res$ci_lower <- exp(mr_res$b - 1.96 * mr_res$se)
mr_res$ci_upper <- exp(mr_res$b + 1.96 * mr_res$se)
write.csv(mr_res, file.path(output_dir, "mr_results.csv"), row.names=FALSE)

tryCatch({{
    moe_res <- mr_wrapper(dat)
    moe_df <- mr_moe(moe_res, rf)
    write.csv(moe_df, file.path(output_dir, "moe_results.csv"), row.names=FALSE)
}}, error = function(e) {{ cat(sprintf("MOE failed: %s\\n", e$message)) }})

het <- mr_heterogeneity(dat)
write.csv(het, file.path(output_dir, "heterogeneity.csv"), row.names=FALSE)
plt <- mr_pleiotropy_test(dat)
write.csv(plt, file.path(output_dir, "pleiotropy.csv"), row.names=FALSE)

# --- Steiger directionality test ---
tryCatch({{
    steiger <- directionality_test(dat)
    write.csv(steiger, file.path(output_dir, "steiger.csv"), row.names=FALSE)
}}, error = function(e) {{
    cat(sprintf("Steiger test failed: %s\\n", e$message))
}})

""" + _SKIP_TRACKING_BLOCK + """
# --- MR-PRESSO ---
tryCatch({{
    if (!requireNamespace("MRPRESSO", quietly = TRUE)) {{
        note_skip("mr_presso", "MRPRESSO package not installed")
    }} else {{
        presso <- MRPRESSO::mr_presso(
            BetaOutcome = "beta.outcome", BetaExposure = "beta.exposure",
            SdOutcome = "se.outcome", SdExposure = "se.exposure",
            OUTLIERtest = TRUE, DISTORTIONtest = TRUE,
            data = as.data.frame(dat), NbDistribution = 1000,
            SignifThreshold = 0.05)
        presso_main <- data.frame(
            exposure = "{exposure_id}", outcome = "{outcome_id}",
            global_p = presso$`MR-PRESSO results`$`Global Test`$Pvalue,
            n_outliers = sum(presso$`MR-PRESSO results`$`Outlier Test`$Pvalue < 0.05,
                na.rm = TRUE))
        write.csv(presso_main, file.path(output_dir, "mrpresso.csv"), row.names=FALSE)
    }}
}}, error = function(e) {{
    note_skip("mr_presso", e$message)
}})
""" + _SENSITIVITY_BLOCK + _PLOT_BLOCK + """
summary <- list(exposure_id="{exposure_id}", outcome_id="{outcome_id}",
    n_instruments=nrow(dat), mean_f_statistic=mean(exposure_dat$F_stat),
    pval_threshold=5e-08, status="success",
    skipped_analyses=I(sensitivity_skipped))
write(toJSON(summary, auto_unbox=TRUE), file.path(output_dir, "mr_summary.json"))
"""

# --- Shared downstream analysis block (reused by all local templates) ---

_MR_DOWNSTREAM_BLOCK = """
dat <- harmonise_data(exposure_dat, outcome_dat)
dat <- dat[dat$mr_keep == TRUE, ]
if (nrow(dat) < 3) {{
    result <- list(error = "Insufficient harmonized SNPs (< 3)")
    write(toJSON(result, auto_unbox=TRUE), file.path(output_dir, "mr_error.json"))
    quit(status = 0)
}}

mr_res <- mr(dat)
mr_res$or <- exp(mr_res$b)
mr_res$ci_lower <- exp(mr_res$b - 1.96 * mr_res$se)
mr_res$ci_upper <- exp(mr_res$b + 1.96 * mr_res$se)
write.csv(mr_res, file.path(output_dir, "mr_results.csv"), row.names=FALSE)

het <- mr_heterogeneity(dat)
write.csv(het, file.path(output_dir, "heterogeneity.csv"), row.names=FALSE)

plt <- mr_pleiotropy_test(dat)
write.csv(plt, file.path(output_dir, "pleiotropy.csv"), row.names=FALSE)

tryCatch({{
    steiger <- directionality_test(dat)
    write.csv(steiger, file.path(output_dir, "steiger.csv"), row.names=FALSE)
    cat(sprintf("Steiger: correct_causal_direction=%s, p=%.4e\\n",
        steiger$correct_causal_direction, steiger$steiger_pval))
}}, error = function(e) {{
    cat(sprintf("Steiger test failed: %s\\n", e$message))
}})

""" + _SKIP_TRACKING_BLOCK + """
tryCatch({{
    if (!requireNamespace("MRPRESSO", quietly = TRUE)) {{
        note_skip("mr_presso", "MRPRESSO package not installed")
    }} else {{
        presso <- MRPRESSO::mr_presso(
            BetaOutcome = "beta.outcome", BetaExposure = "beta.exposure",
            SdOutcome = "se.outcome", SdExposure = "se.exposure",
            OUTLIERtest = TRUE, DISTORTIONtest = TRUE,
            data = as.data.frame(dat), NbDistribution = 1000,
            SignifThreshold = 0.05)
        presso_main <- data.frame(
            exposure = "{exposure_label}", outcome = "{outcome_label}",
            global_p = presso$`MR-PRESSO results`$`Global Test`$Pvalue,
            n_outliers = sum(
                presso$`MR-PRESSO results`$`Outlier Test`$Pvalue < 0.05,
                na.rm = TRUE))
        write.csv(presso_main, file.path(output_dir, "mrpresso.csv"),
            row.names=FALSE)
    }}
}}, error = function(e) {{
    note_skip("mr_presso", e$message)
}})
""" + _SENSITIVITY_BLOCK + _PLOT_BLOCK + """
summary <- list(
    exposure_id="{exposure_label}", outcome_id="{outcome_label}",
    n_instruments=nrow(dat),
    mean_f_statistic=mean(exposure_dat$F_stat),
    pval_threshold={pval_threshold}, status="success",
    skipped_analyses=I(sensitivity_skipped))
write(toJSON(summary, auto_unbox=TRUE), file.path(output_dir, "mr_summary.json"))
cat("MR analysis completed successfully\\n")
"""

# --- Local exposure read block ---

_LOCAL_EXPOSURE_READ = """
# --- Read local exposure data ---
raw_exp <- read.csv("{exposure_file}", stringsAsFactors=FALSE)
cat(sprintf("Loaded exposure file: %d rows, %d columns\\n", nrow(raw_exp), ncol(raw_exp)))

exposure_dat <- format_data(
    raw_exp,
    type = "exposure",
    snp_col = "{col_snp}",
    beta_col = "{col_beta}",
    se_col = "{col_se}",
    effect_allele_col = "{col_effect_allele}",
    other_allele_col = "{col_other_allele}",
    eaf_col = "{col_eaf}",
    pvalue_col = "{col_pval}"
    {extra_format_args}
)

{zscore_block}
{log10p_block}

# Filter by p-value threshold
exposure_dat <- exposure_dat[exposure_dat$pval.exposure < {pval_threshold}, ]
if (nrow(exposure_dat) < 3) {{
    result <- list(error = "Insufficient IVs after p-value filtering (< 3)")
    write(toJSON(result, auto_unbox=TRUE), file.path(output_dir, "mr_error.json"))
    quit(status = 0)
}}

# Clump via LD reference (API-based)
tryCatch({{
    exposure_dat <- clump_data(exposure_dat, clump_r2 = 0.001, clump_kb = 10000)
}}, error = function(e) {{
    cat(sprintf("Clumping failed (using unclumped data): %s\\n", e$message))
}})

if (nrow(exposure_dat) < 3) {{
    result <- list(error = "Insufficient IVs after clumping (< 3)")
    write(toJSON(result, auto_unbox=TRUE), file.path(output_dir, "mr_error.json"))
    quit(status = 0)
}}

exposure_dat$F_stat <- (exposure_dat$beta.exposure / exposure_dat$se.exposure)^2
f_stats <- data.frame(
    snp=exposure_dat$SNP, f_statistic=exposure_dat$F_stat,
    beta=exposure_dat$beta.exposure, se=exposure_dat$se.exposure,
    pval=exposure_dat$pval.exposure)
write.csv(f_stats, file.path(output_dir, "f_statistics.csv"), row.names=FALSE)
cat(sprintf("Mean F-statistic: %.2f\\n", mean(exposure_dat$F_stat)))
"""

# --- Local outcome read block ---

_LOCAL_OUTCOME_READ = """
# --- Read local outcome data ---
raw_out <- read.csv("{outcome_file}", stringsAsFactors=FALSE)
cat(sprintf("Loaded outcome file: %d rows, %d columns\\n", nrow(raw_out), ncol(raw_out)))

outcome_dat <- format_data(
    raw_out,
    type = "outcome",
    snp_col = "{out_col_snp}",
    beta_col = "{out_col_beta}",
    se_col = "{out_col_se}",
    effect_allele_col = "{out_col_effect_allele}",
    other_allele_col = "{out_col_other_allele}",
    eaf_col = "{out_col_eaf}",
    pvalue_col = "{out_col_pval}"
    {out_extra_format_args}
)

{out_zscore_block}
{out_log10p_block}

# Filter outcome to exposure SNPs
outcome_dat <- outcome_dat[outcome_dat$SNP %in% exposure_dat$SNP, ]
if (nrow(outcome_dat) == 0) {{
    result <- list(error = "No overlapping SNPs between exposure and outcome")
    write(toJSON(result, auto_unbox=TRUE), file.path(output_dir, "mr_error.json"))
    quit(status = 0)
}}
"""

# --- Z-score derivation block ---

ZSCORE_DERIVE_BLOCK = """
# Derive beta from Z-score: beta = z * se (approximate)
if ("{z_col}" %in% colnames({data_var}) && !("{col_beta}" %in% colnames({data_var}))) {{
    {data_var}${col_beta} <- {data_var}${z_col} * {data_var}${col_se}
    cat("Derived beta from Z-score\\n")
}}
"""

# --- LOG10P derivation block ---

LOG10P_DERIVE_BLOCK = """
# Derive p-value from -log10(p)
if ("{log10p_col}" %in% colnames({data_var})) {{
    {data_var}${col_pval} <- 10^(-{data_var}${log10p_col})
    cat("Derived p-value from LOG10P\\n")
}}
"""


# --- Combined templates ---

MR_LOCAL_EXPOSURE_TEMPLATE = (
    """
library(TwoSampleMR)
library(ieugwasr)
library(jsonlite)

{token_line}

output_dir <- "{output_dir}"
"""
    + _LOCAL_EXPOSURE_READ
    + """
# --- Outcome from OpenGWAS ---
outcome_dat <- extract_outcome_data(
    snps = exposure_dat$SNP, outcomes = "{outcome_id}")
if (is.null(outcome_dat) || nrow(outcome_dat) == 0) {{
    result <- list(error = "No outcome data available from OpenGWAS")
    write(toJSON(result, auto_unbox=TRUE), file.path(output_dir, "mr_error.json"))
    quit(status = 0)
}}
"""
    + _MR_DOWNSTREAM_BLOCK
)

MR_LOCAL_OUTCOME_TEMPLATE = (
    """
library(TwoSampleMR)
library(ieugwasr)
library(jsonlite)

{token_line}

output_dir <- "{output_dir}"
thresholds <- c({thresholds})
exposure_dat <- NULL

for (thresh in thresholds) {{
    tryCatch({{
        exposure_dat <- extract_instruments(
            outcomes = "{exposure_id}", p1 = thresh,
            clump = TRUE, r2 = 0.001, kb = 10000)
        if (!is.null(exposure_dat) && nrow(exposure_dat) >= 3) {{
            cat(sprintf("Found %d IVs at p < %e\\n", nrow(exposure_dat), thresh))
            break
        }}
    }}, error = function(e) {{
        cat(sprintf("Threshold %e failed: %s\\n", thresh, e$message))
    }})
}}

if (is.null(exposure_dat) || nrow(exposure_dat) < 3) {{
    result <- list(error = "Insufficient IVs from OpenGWAS")
    write(toJSON(result, auto_unbox=TRUE), file.path(output_dir, "mr_error.json"))
    quit(status = 0)
}}

exposure_dat$F_stat <- (exposure_dat$beta.exposure / exposure_dat$se.exposure)^2
f_stats <- data.frame(
    snp=exposure_dat$SNP, f_statistic=exposure_dat$F_stat,
    beta=exposure_dat$beta.exposure, se=exposure_dat$se.exposure,
    pval=exposure_dat$pval.exposure)
write.csv(f_stats, file.path(output_dir, "f_statistics.csv"), row.names=FALSE)
"""
    + _LOCAL_OUTCOME_READ
    + _MR_DOWNSTREAM_BLOCK
)

MR_LOCAL_BOTH_TEMPLATE = (
    """
library(TwoSampleMR)
library(ieugwasr)
library(jsonlite)

{token_line}

output_dir <- "{output_dir}"
"""
    + _LOCAL_EXPOSURE_READ
    + _LOCAL_OUTCOME_READ
    + _MR_DOWNSTREAM_BLOCK
)

# --- MR-LAP template (sample overlap correction) ---

MR_MRLAP_TEMPLATE = """
library(TwoSampleMR)
library(ieugwasr)
library(jsonlite)
library(MRlap)

{token_line}

output_dir <- "{output_dir}"
thresholds <- c({thresholds})
exposure_dat <- NULL

for (thresh in thresholds) {{
    tryCatch({{
        exposure_dat <- extract_instruments(
            outcomes = "{exposure_id}", p1 = thresh,
            clump = TRUE, r2 = 0.001, kb = 10000)
        if (!is.null(exposure_dat) && nrow(exposure_dat) >= 3) {{
            cat(sprintf("Found %d IVs at p < %e\\n", nrow(exposure_dat), thresh))
            break
        }}
    }}, error = function(e) {{
        cat(sprintf("Threshold %e failed: %s\\n", thresh, e$message))
    }})
}}

if (is.null(exposure_dat) || nrow(exposure_dat) < 3) {{
    result <- list(error = "Insufficient IVs for MR-LAP")
    write(toJSON(result, auto_unbox=TRUE), file.path(output_dir, "mr_error.json"))
    quit(status = 0)
}}

exposure_dat$F_stat <- (exposure_dat$beta.exposure / exposure_dat$se.exposure)^2
f_stats <- data.frame(snp=exposure_dat$SNP, f_statistic=exposure_dat$F_stat,
    beta=exposure_dat$beta.exposure, se=exposure_dat$se.exposure,
    pval=exposure_dat$pval.exposure)
write.csv(f_stats, file.path(output_dir, "f_statistics.csv"), row.names=FALSE)

outcome_dat <- extract_outcome_data(snps=exposure_dat$SNP, outcomes="{outcome_id}")
if (is.null(outcome_dat) || nrow(outcome_dat) == 0) {{
    result <- list(error = "No outcome data for MR-LAP")
    write(toJSON(result, auto_unbox=TRUE), file.path(output_dir, "mr_error.json"))
    quit(status = 0)
}}

dat <- harmonise_data(exposure_dat, outcome_dat)
dat <- dat[dat$mr_keep == TRUE, ]

# Standard MR as baseline
mr_res <- mr(dat)
mr_res$or <- exp(mr_res$b)
mr_res$ci_lower <- exp(mr_res$b - 1.96 * mr_res$se)
mr_res$ci_upper <- exp(mr_res$b + 1.96 * mr_res$se)
write.csv(mr_res, file.path(output_dir, "mr_results.csv"), row.names=FALSE)

# MR-LAP correction
tryCatch({{
    mrlap_res <- MRlap::MRlap(
        exposure = "{exposure_id}", outcome = "{outcome_id}",
        exposure_data = exposure_dat, outcome_data = outcome_dat)
    mrlap_df <- data.frame(
        corrected_beta = mrlap_res$MRlap_corrected$b,
        corrected_se = mrlap_res$MRlap_corrected$se,
        corrected_pval = mrlap_res$MRlap_corrected$pval,
        overlap_est = mrlap_res$sample_overlap)
    write.csv(mrlap_df, file.path(output_dir, "mrlap.csv"), row.names=FALSE)
}}, error = function(e) {{
    cat(sprintf("MR-LAP failed: %s\\n", e$message))
}})

het <- mr_heterogeneity(dat)
write.csv(het, file.path(output_dir, "heterogeneity.csv"), row.names=FALSE)
plt <- mr_pleiotropy_test(dat)
write.csv(plt, file.path(output_dir, "pleiotropy.csv"), row.names=FALSE)

tryCatch({{
    steiger <- directionality_test(dat)
    write.csv(steiger, file.path(output_dir, "steiger.csv"), row.names=FALSE)
}}, error = function(e) {{
    cat(sprintf("Steiger test failed: %s\\n", e$message))
}})
""" + _PLOT_BLOCK + """
summary <- list(exposure_id="{exposure_id}", outcome_id="{outcome_id}",
    n_instruments=nrow(dat), mean_f_statistic=mean(exposure_dat$F_stat),
    pval_threshold=thresh, status="success")
write(toJSON(summary, auto_unbox=TRUE), file.path(output_dir, "mr_summary.json"))
cat("MR-LAP analysis completed\\n")
"""

# --- MVMR template ---

MR_MVMR_TEMPLATE = """
library(TwoSampleMR)
library(MVMR)
library(ieugwasr)
library(jsonlite)

{token_line}

output_dir <- "{output_dir}"
exposures <- c({exposure_ids})
outcome_id <- "{outcome_id}"

# Extract instruments for all exposures
mv_exposures <- mv_extract_exposures(exposures, clump_r2 = 0.001)
if (is.null(mv_exposures) || nrow(mv_exposures) < 3) {{
    result <- list(error = "Insufficient IVs for MVMR")
    write(toJSON(result, auto_unbox=TRUE), file.path(output_dir, "mr_error.json"))
    quit(status = 0)
}}

mv_outcome <- extract_outcome_data(snps=mv_exposures$SNP, outcomes=outcome_id)
mvdat <- mv_harmonise_data(mv_exposures, mv_outcome)

# MVMR-IVW
mvmr_res <- mv_multiple(mvdat)
mvmr_df <- as.data.frame(mvmr_res$result)
write.csv(mvmr_df, file.path(output_dir, "mr_results.csv"), row.names=FALSE)

# MVMR sensitivity via MVMR package
tryCatch({{
    F_dat <- MVMR::format_mvmr(
        BXGs = mvdat$exposure_beta,
        BYG = mvdat$outcome_beta,
        seBXGs = mvdat$exposure_se,
        seBYG = mvdat$outcome_se)
    mvmr_ivw <- MVMR::ivw_mvmr(F_dat)
    mvmr_q <- MVMR::qhet_mvmr(F_dat, pcrit = 0.05)
    write.csv(as.data.frame(mvmr_q), file.path(output_dir, "mvmr_qhet.csv"),
        row.names=FALSE)
    cond_f <- MVMR::strength_mvmr(F_dat, gencov = 0)
    write.csv(as.data.frame(cond_f), file.path(output_dir, "mvmr_cond_f.csv"),
        row.names=FALSE)
}}, error = function(e) {{
    cat(sprintf("MVMR sensitivity failed: %s\\n", e$message))
}})

summary <- list(outcome_id=outcome_id, exposures=exposures,
    n_instruments=nrow(mvdat$exposure_beta),
    status="success")
write(toJSON(summary, auto_unbox=TRUE), file.path(output_dir, "mr_summary.json"))
cat("MVMR analysis completed\\n")
"""

# --- Summary forest plot template ---

MR_FOREST_SUMMARY_TEMPLATE = """
library(ggplot2)
library(jsonlite)

output_dir <- "{output_dir}"
result_files <- c({result_csv_paths})
pair_labels <- c({pair_labels})

all_data <- data.frame()
for (i in seq_along(result_files)) {{
    tryCatch({{
        df <- read.csv(result_files[i])
        ivw <- df[grep("Inverse variance weighted", df$method), ]
        if (nrow(ivw) > 0) {{
            ivw$pair <- pair_labels[i]
            all_data <- rbind(all_data, ivw[1, ])
        }}
    }}, error = function(e) {{
        cat(sprintf("Skipping %s: %s\\n", result_files[i], e$message))
    }})
}}

if (nrow(all_data) > 0) {{
    all_data$or <- exp(all_data$b)
    all_data$ci_lo <- exp(all_data$b - 1.96 * all_data$se)
    all_data$ci_hi <- exp(all_data$b + 1.96 * all_data$se)
    p <- ggplot(all_data, aes(x=or, y=pair)) +
        geom_point(size=3) +
        geom_errorbarh(aes(xmin=ci_lo, xmax=ci_hi), height=0.2) +
        geom_vline(xintercept=1, linetype="dashed") +
        labs(x="Odds Ratio (95% CI)", y="", title="Summary Forest Plot") +
        theme_minimal()
    ggsave(file.path(output_dir, "summary_forest.pdf"), p, width=10, height=6)
    ggsave(file.path(output_dir, "summary_forest.png"), p,
        width=10, height=6, dpi=300)
    write.csv(all_data, file.path(output_dir, "summary_forest_data.csv"),
        row.names=FALSE)
    cat("Summary forest plot generated\\n")
}} else {{
    cat("No IVW results to plot\\n")
}}
"""
