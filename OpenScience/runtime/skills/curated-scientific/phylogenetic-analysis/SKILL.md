---
name: phylogenetic-analysis
description: Run reproducible sequence-alignment and phylogenetic analyses. Use for tree inference, clade support, evolutionary relationships, molecular epidemiology, ancestral reconstruction, and phylogenetic quality control.
---

# Phylogenetic analysis

Define the taxon or sample set, sequence region, reference, inclusion rules,
outgroup, and scientific question. Validate identifiers, sequence lengths,
ambiguity, orientation, contamination, and duplicates before alignment.

Record the aligner, parameters, trimming, masked sites, recombination handling,
partitioning, substitution-model choice, clock assumptions, and tree method.
Evaluate alignment quality and model adequacy. Report bootstrap, posterior, or
other support without treating unsupported branches as established history.

Separate phylogenetic relatedness from direct transmission. Consider sampling
density, temporal signal, recombination, rate variation, and metadata uncertainty
before epidemiologic interpretation. Preserve alternative roots and sensitivity
trees when conclusions depend on analytical choices.

Write `phylogeny-analysis.ipynb`, `alignment.fasta`, `tree.nwk`, and
`phylogeny-report.md`. Record software and database versions, seeds, exclusions,
and branch support. Never invent sequences or sample metadata.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/_runtime/execute_skill.py" --skill phylogenetic-analysis --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
