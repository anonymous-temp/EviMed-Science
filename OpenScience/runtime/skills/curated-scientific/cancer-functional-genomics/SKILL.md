---
name: cancer-functional-genomics
description: Analyze cancer dependency screens and functional-genomics datasets. Use for DepMap-like gene effects, cell-line metadata, lineage context, biomarker associations, confounding checks, and reproducible prioritization.
---

# Cancer functional genomics

Record dataset release, screen type, gene-effect method, cell-line identifiers, lineage, molecular features, replicate structure, and license. Align releases before joining tables and report dropped or duplicated identifiers.

Model lineage, growth, batch, and correlated molecular features explicitly. Use held-out validation for predictive claims and correct for multiple testing. Report effect size, uncertainty, sample count, missingness, and sensitivity to influential lines.

Check dependencies before execution and never install them implicitly. A cell-line dependency is not clinical efficacy, a therapeutic window, or patient selection evidence.

Write `dependency-analysis.ipynb`, `candidate-dependencies.csv`, `validation-summary.csv`, and `functional-genomics-report.md`.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/_runtime/execute_skill.py" --skill cancer-functional-genomics --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
