---
name: biosequence-analysis
description: Analyze local nucleotide or protein sequences and traceable public sequence records. Use for FASTA/GenBank parsing, validation, translation, motif or feature summaries, identifier lookup, and reproducible sequence reports.
---

# Biosequence analysis

Use `evimed_biomedical_source_search` for supported NCBI, ENA, InterPro, or UniProt lookups. Keep accession, version, organism, genome build, strand, coordinate convention, and retrieval time. Work on local copies and hash inputs.

Validate alphabet, ambiguity codes, length, duplicate IDs, feature coordinates, and translation frame before analysis. Check Biopython or other dependencies before execution and never install them implicitly. Record versions and deterministic parameters.

Do not infer function, pathogenicity, phenotype, or clinical action from sequence similarity alone. Do not design or optimize harmful biological agents.

Write `sequence-inventory.csv`, `sequence-analysis.ipynb`, and `sequence-report.md` with explicit limitations and source provenance.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/_runtime/execute_skill.py" --skill biosequence-analysis --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
