---
name: biomedical-database-search
description: Search audited biomedical literature, terminology, regulatory, genomics, proteomics, pathway, and public-health sources. Use for cross-database record discovery, identifier resolution, or source selection when traceability and access constraints matter.
---

# Biomedical database search

1. Call `data_source_catalog` to select the smallest relevant source set. Respect `blocked_*`, `ready_credentials`, and license fields; never scrape a blocked website as a substitute.
2. Call `biomedical_source_search` once per selected active source. Use specific identifiers and organism qualifiers when known.
3. Keep every source ID, URL, retrieval time, query, and database name. Deduplicate only after preserving the original identifiers.
4. Treat returned titles and selected fields as metadata. Do not infer study design, effect, causality, approval, or clinical utility without reviewing the primary record.
5. Stop after one retry for a retryable source error. Record the gap rather than replacing it with model memory.

Write `source-inventory.csv` and `retrieval-notes.md`. Separate observed source fields from interpretation, and state access or coverage limitations.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/_runtime/execute_skill.py" --skill biomedical-database-search --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
