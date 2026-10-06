---
name: gene-expression-analysis
description: Take a public NCBI GEO series (GSE...), preserve it, verify its identities, and compute a two-group differential expression (Welch t-test per probe, Benjamini-Hochberg; not limma) with the platform's tools, never by hand.
---

# Gene Expression Omnibus: series to differential expression

This is the public NCBI Gene Expression Omnibus (accession GSE..., platform GPL..., sample GSM...). It is not the 循证传播 pharma module: none of that module's tools or capabilities belong in this work.

**You never compute a statistic and never type a number into the report.** Retrieval and computation are two tools; their files carry every number. If a tool refuses or is unavailable, say which step was not done and why, keep everything else, and do not estimate the statistic yourself.

## Steps

1. **Preserve the series.** Call `mcp__evimed__gene_expression_series` with `accession` (and `platform` when the series has several; a matrix is one platform's file and platforms are never pooled). Read what it returns before anything else: the stated submission and last-update dates, the platform, and the identity checks (samples, platform, organism, genome build, value scale). `unknown` is a value, not a pass: GEO platforms rarely state a genome build, and then none is assumed. A `mismatch` means no statistic can be taken from that capture; say so. If the platform record could not be used, the matrix is still preserved but its probes carry no gene annotation (say so, and report probe identifiers). A series with no processed matrix (raw reads only) is outside this capability: say so and stop.
2. **Declare the groups from the annotations.** Read `samples.tsv` of the capture. Choose two groups that answer the researcher's question, by sample accession or by an exact annotation value (`where: {field, equals}`), at least three samples each and no sample in both. State the declaration and why. Designs with three or more groups, pairing, batches or covariates are not computed here: say what the tool does not adjust for. Do not choose groups from the p-values.
3. **Compute.** Call `mcp__evimed__gene_expression_differential` with the capture's `captureDir`, a new `outputDir` under `deliverables/`, the two groups and (optionally) which is the reference. It writes the results, the full table, a rendered top table, the analysed log2 matrix, the code and a receipt. An input over a limit (matrix or annotation size, samples, probes, memory, time) is refused for this computation with the limit named; say that and offer a smaller series if the question allows.
4. **Write the report with rendered numbers.** Write the report as a template whose numbers are `{{n:alias.key|format}}` references into the results (`top[0].logFC`, `top[0].adjPValue`, `diagnostics.probesTested`, `diagnostics.probesSignificantAtFdr05`, `diagnostics.groupSizes.reference` ...), then call `mcp__evimed__research_calculate` with `action=render` and `calculations: {alias: {resultsPath, receiptPath}}` to write `gene-expression-report.md`. Put the top table in as the tool wrote it (`gene-expression-top-table.md`, pasted byte for byte). A reference that resolves to nothing reads 未计算; fix the alias or key, never type the number.
5. **Optional second look.** `scripts/verify_result.py DIRECTORY` (beside this skill) recomputes every probe's statistics a second way and checks the receipt's hashes; its output is a label for the report, not a gate.

## What the report must say, in plain words

- **Method, and that it is not limma.** A Welch two-sample t-test per probe on log2 values with Benjamini-Hochberg adjustment over the probes tested. There is no empirical-Bayes moderation of the variances, so with small groups each probe's variance rests on a few arrays, the p-values are noisier, and the top table can differ from a limma analysis of the same series, in order as well as in p-values. Nothing is random, so there is no seed.
- **The data.** Series, platform, the dates GEO states (not "recent"), how many samples and probes, what the series states about its own processing, and the transformation the tool applied (`transformation.applied` and its reason). Say that the series is submitter-processed data, and cite the series and its publication.
- **Identities and limits of the unit.** Which checks passed, which were unknown (genome build usually), and that the unit is the probe: a probe mapped to several genes is one flagged row and is not copied to each gene; a gene with several probes has several rows; nothing is collapsed to a gene level.
- **Diagnostics that matter.** Group sizes, probes dropped for missing values or no variance, and the multiple-testing counts. With groups of three, state that few probes can reach a small adjusted p-value whatever the biology, and that agreement of the top table with other studies or an independent method is not established by this run.
- **Interpretation.** A differentially expressed probe is an association between the declared groups in this series. Do not turn a probe list into a pathway, mechanism or treatment claim; do not give practical clinical advice.

Keep the delivered files together in the output directory; do not create empty placeholders. Do not print credentials, environment dumps or raw process logs into the report.
