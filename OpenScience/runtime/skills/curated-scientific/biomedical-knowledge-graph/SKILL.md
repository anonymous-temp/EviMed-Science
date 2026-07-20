---
name: biomedical-knowledge-graph
description: Construct and analyze provenance-preserving biomedical knowledge graphs. Use for entity normalization, evidence edges, ontology mappings, network analysis, PrimeKG-like datasets, and traceable graph exports.
---

# Biomedical knowledge graph

Define node and edge schemas before ingestion. Give every entity a namespace-qualified identifier and every evidence edge a source, retrieval time, relation type, direction, and confidence basis. Preserve contradictory edges instead of overwriting them.

Use `evimed_data_source_catalog` and `evimed_biomedical_source_search` for supported public records. Check graph-library dependencies before execution and never install them implicitly. Record source dataset versions and licenses; do not redistribute restricted graph data.

Distinguish database assertions, computed associations, and model hypotheses. Network proximity, centrality, or path existence does not establish mechanism, causality, efficacy, or safety.

Write `graph-schema.json`, `nodes.csv`, `edges.csv`, `knowledge-graph.ipynb`, and `graph-report.md`.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/_runtime/execute_skill.py" --skill biomedical-knowledge-graph --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
