---
name: cheminformatics
description: Normalize and analyze chemical structures and compound tables. Use for PubChem/ChEBI records, SMILES or InChI processing, descriptors, fingerprints, similarity, substructures, and structure-quality checks.
---

# Cheminformatics

Retrieve public identifiers through `biomedical_source_search` when appropriate. Preserve the submitted structure and source identifiers before normalization. Record salt/solvent handling, charge, isotope, tautomer, stereochemistry, aromaticity, and sanitization decisions; never collapse stereoisomers silently.

Check RDKit or other required dependencies before execution and never install them implicitly. Report invalid structures and calculation failures rather than coercing them. Fix random seeds and record descriptor/fingerprint definitions and software versions.

Treat similarity, alerts, and in-silico properties as hypotheses, not proof of efficacy, safety, bioavailability, or clinical interchangeability. Do not provide synthesis instructions for harmful compounds.

Write `compound-inventory.csv`, `cheminformatics.ipynb`, and `structure-quality-report.md`.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill cheminformatics --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
