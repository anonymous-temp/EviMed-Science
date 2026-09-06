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

1. Call `mcp__evimed__mendelian_randomization` with `action=capabilities`. Report missing R, model or Python runtime explicitly. Missing OpenGWAS credentials blocks remote data and online LD clumping; it does not block two supplied local files with declared preclumped instruments.
2. Start the job with the normalized exposure, outcome, language, direction and the explicit source objects below when using uploaded files.
   Record the job id and poll it with `waitSeconds=45` until terminal.
3. Do not invent SNPs, instrument counts, F statistics, effect estimates,
   heterogeneity, pleiotropy, Steiger direction, or sensitivity results. Those
   values must come from the deterministic MR engines and their files.
4. Treat zero instruments, weak instruments, unresolved sample overlap,
   harmonization failure, and missing sensitivity checks as analysis limits or
   blockers. Statistical significance does not by itself establish a valid
   causal interpretation.

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
`outcomeSource`. For forward analysis without an OpenGWAS credential, both must
be local and the exposure instruments must be declared preclumped with their
provenance. For bidirectional analysis, each side becomes an exposure and must
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

The current fixed runner does not export `.R` scripts. Do not claim an exported
analysis script or a complete reproducible code bundle unless those files are
actually present in the returned artifacts. Input preservation alone does not
complete code delivery.

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
