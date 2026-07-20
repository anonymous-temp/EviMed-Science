---
name: genome-variant-analysis
description: Build reproducible workflows for VCF, BCF, population variants, annotation, and genotype-derived analyses. Use when work involves genome builds, variant normalization, allele harmonization, cohort QC, annotation databases, or genomic interval operations.
---

# Genome variant analysis

Establish the reference assembly, contig naming, coordinate convention, sample scope,
consent boundary, and analysis objective before processing. Never combine variants from
different genome builds without a recorded liftover. Normalize alleles and multiallelic
records, retain stable source identifiers, and distinguish missing, filtered, and true
reference genotypes.

Preflight the required command-line or Python dependencies and the reference files they
need. Prefer indexed, streaming operations for large VCF or BCF files. Apply explicit
sample and variant QC, verify sex and relatedness assumptions when relevant, and report
the effect of filters. Record the database name, release, assembly, query, retrieval time,
and license for every annotation source.

Produce `variant-analysis.md`, machine-readable normalized results, a QC table, and a
provenance manifest containing hashes and tool versions. Fail closed on reference-build,
strand, REF/ALT, or sample-identity ambiguity. Do not turn research annotations into
clinical pathogenicity claims without an appropriate validated clinical workflow.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/_runtime/execute_skill.py" --skill genome-variant-analysis --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
