---
name: mendelian-randomization
description: Run EviMed's managed Mendelian-randomization specialist and preserve its GWAS, statistical, sensitivity-analysis, and STROBE-MR boundaries.
metadata:
  evimed-agent: mendelian-randomization
---

# Mendelian randomization

Use this skill to assess a causal exposure-outcome relationship using genetic
instruments. It is not a generic association analysis. Require an explicit
exposure and outcome, and distinguish forward from bidirectional analysis.

## Execute the managed analysis

1. Call `mcp__evimed__mendelian_randomization` with `action=capabilities`. Report missing R, model or Python runtime explicitly. Missing OpenGWAS credentials blocks OpenGWAS data, text-based GWAS selection and online LD clumping; it does not block open GWAS Catalog studies (below) or two supplied local files with declared preclumped instruments.
2. Start the job with the normalized exposure, outcome, language, direction and the explicit source objects below when using uploaded files.
   Record the job id and poll it with `waitSeconds=45` until terminal.
   The job alone can take most of this capability's 30–180 minutes. Keep polling while `updatedAt` advances (every 30 s); treat the job as failed only on a terminal failure or when `updatedAt` has not moved for 10 minutes, and record the state you observed either way.
3. Do not invent SNPs, instrument counts, F statistics, effect estimates,
   heterogeneity, pleiotropy, Steiger direction, or sensitivity results. Those
   values must come from the deterministic MR engines and their files.
4. Treat zero instruments, weak instruments, unresolved sample overlap,
   harmonization failure, and missing sensitivity checks as analysis limits or
   blockers. Statistical significance does not by itself establish a valid
   causal interpretation.

## Open GWAS Catalog sources (no OpenGWAS token)

When OpenGWAS is blocked, or the requested study is on the NHGRI-EBI GWAS
Catalog, give both sides as catalogue studies:
`{"type": "gwas_catalog", "accession": "GCST..."}`. Find the study from its
paper (`literature_search`), then pass that PubMed id as
`{"type": "gwas_catalog", "pubmedId": "..."}` or an accession a tool result
showed you; a paper with several studies is refused with the list to choose
from. Never write an accession or PubMed id you have not seen in a tool result.
One direction per job: for the reverse direction start a second forward job
with the roles swapped.

The engine reads the catalogue's harmonised files itself: exposure variants at
p < 5e-8, clumped by PLINK against an LD reference when the deployment has one,
otherwise one variant per 10,000 kb window (stricter than r² < 0.001 clumping,
but no LD was measured — say so), and the outcome's rows for the same variants;
a variant missing from the outcome is dropped, never proxied. Report both
accessions and PubMed ids, and the ancestry and sample size as the catalogue
states them (`mendelian-randomization-open-sources.json`), the selection method
and counts (`instrument-selection.json`), and the variants unavailable in the
outcome. On every path, `harmonisation.json` in the analysis data gives the
instruments retained, dropped as palindromic-ambiguous and missing from the
outcome: report those numbers, not your own count. The catalogue cannot tell whether two studies share participants:
name the cohorts the papers report and never claim independent samples.
Keep `inputs/open-*.csv` and the replay package: they are the rows analysed.

## Uploaded local GWAS inputs

Uploaded source objects require the configured isolated hosted MR adapter. If it
is absent, stop with the reported dependency error; do not switch to same-container
execution or silently replace the supplied data with a remote text search. The
legacy text-only fallback and the independent `run_mr_local` library remain separate.

Use the workspace-relative paths returned by upload, such as `data/bmi.csv`.
Inspect the actual headers and ask for any unresolved exposure/outcome roles or
column meanings. Never infer that instruments were clumped from a small row
count, a filename, or statistical significance.

For a local source, pass `type: "local_file"`, `path`, `columnMapping`, and a
JSON boolean `instrumentsPreclumped`. The mapping must explicitly name all seven
keys: `snp`, `beta`, `se`, `effect_allele`, `other_allele`, `eaf`, and `pval`, each
pointing to a distinct original header. Optional `sampleSize` and `population`
are provider declarations, not independently verified repository metadata.
`instrumentsPreclumped: true` requires `clumpingProvenance` identifying the source
and instrument-selection method. Do not invent this statement or change a false
flag merely to make a failed request pass.

Whenever a local source is used, specify both `exposureSource` and
`outcomeSource`. For forward analysis without an OpenGWAS credential, use
GWAS Catalog sources, or both must be local and the exposure instruments must be
declared preclumped with their provenance. For bidirectional analysis, each side becomes an exposure and must
independently satisfy that condition. The input manifest retains
`provided_local_data`, `supplied_not_independently_verified`, and
`ld_rechecked: false`; supplied selection is not an LD verification performed by
this run.

A mixed request may give the remote side as
`{"type": "opengwas", "gwasId": "<explicit source identifier>"}` only with the
existing configured OpenGWAS credential. A missing credential is a blocker, not
permission to claim an authenticated result. Omit both source objects for legacy
remote text selection; explicit remote-only source pairs are not supported here.

Only ordinary UTF-8 CSV/TSV files are accepted, up to 128 MiB and 2,000,000 rows
per file. Missing/duplicate headers or SNPs, nonfinite values, invalid SE,
frequency or p-value, unsafe paths, or changes after admission fail visibly.
The accepted request and file bindings are held in protected project metadata,
outside the customer workspace mount. Workspace notes or `.jobs` files cannot
replace that accepted queue record. Status is read from the same protected queue.

The worker preserves original uploads and stages standard columns under fixed
filenames in its isolated execution directory. Its in-memory provenance reaches
the fixed runner through an anonymous pipe; a workspace-editable manifest is
never the authority. Published input copies and the manifest remain relative,
reproducible artifacts; never rename, overwrite or replace those bound copies.

## Deliverables

Write `mendelian-randomization-report.md` with the question, instrument sources,
harmonization, primary and sensitivity estimates, diagnostics, interpretation,
limitations, and STROBE-MR-aligned discussion. Write
`mendelian-randomization-run.json` with the terminal job state and exact returned
artifacts. Every number must match the managed analysis output. For local inputs, also preserve `mendelian-randomization-inputs.json` and the returned standard input CSV artifacts. The manifest binds original relative paths, byte counts, SHA-256 digests, actual mappings and supplied clumping provenance; retain it without adding repository IDs, years, or absolute host paths.

For paired local inputs with a declared-preclumped exposure, preserve the
returned `analysis-data/<pair>/replay/` package in full: its complete manifest,
exact input CSVs, options and seed, observed R/package versions, `run.R` and
`analysis.R`. The original run uses that same entry and seed. In a clean copy,
`Rscript --vanilla run.R` replays the local statistical analysis into `results/`
with installed dependencies, without a model, JWT or network. Preserve the
supplied clumping declaration; this does not independently verify LD selection.
Remote and mixed-source runs do not deliver this replay package. Do not claim
reproducible code delivery unless the complete package is in returned artifacts,
or claim that the script regenerates the model-written manuscript.

## Method priors

The statistics are the engine's; the reading of them is yours, and two shipped
skills carry the method priors for it — load them before you write the results:
`statistical-analysis` (the estimand, assumptions and their diagnostics, effect
sizes with intervals, multiplicity, missing data, sensitivity analyses) and
`stats-integrity` (report the estimate and its uncertainty as the software
produced it; no causal reading the design does not support). The independent
review checks the report against the reporting checklist for this design and
traces every stated result to the job's own output files, so a number typed from
memory, or rounded differently from the output, comes back as a finding.

## Before delivering: two fixed steps

Both run on the finished deliverable, in this order, every time. They are steps
of this capability, not options the run weighs — a pass that happens only when
the model remembers it is a pass that happens on the easy runs and not the hard
ones.

1. **`traceability-review`** — every citation resolves, no number appears in
   prose without a source in the artifacts, and every figure or table matches
   the code that produced it. Findings are repaired before the next step, not
   after: humanizing prose around a citation that does not resolve only makes
   the defect read better.
2. **`manuscript-humanize`** — register cleanup over the prose, with every
   quotation, number, citation index and claim marker byte-identical. Load the
   language-matched upstream rules it names. It is the last thing that touches
   the document.

Write what changed and why to `revision-notes.md` in this deliverable's
directory. That file is the designated home for revision notes, replies to a
rejection, and process description; the report itself carries none of them, and
no check reads the notes as report prose.
