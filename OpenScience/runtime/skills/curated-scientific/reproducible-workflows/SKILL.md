---
name: reproducible-workflows
description: Design and implement portable, traceable scientific workflows. Use for DAGs, Nextflow-style pipelines, environment locking, containers, caching, checkpoints, provenance, and local-to-HPC execution.
---

# Reproducible scientific workflows

Map inputs, schemas, transformations, outputs, dependencies, resources, and
failure semantics as a directed acyclic graph. Assign immutable sample or record
identifiers and validate inputs before expensive work. Keep raw data read-only.

Make each process deterministic where possible, with fixed parameters, seeds,
versioned reference data, pinned environments, and explicit CPU, memory, GPU,
and time requests. Use content-addressed caching only for pure steps. Make
retries bounded and distinguish transient failures from invalid science inputs.

Capture the command, code revision, container or environment digest, input and
output hashes, timestamps, warnings, and lineage for every process. Support
resume without treating partial outputs as complete. Test a small fixture,
failure recovery, and one clean rerun before scaling locally, remotely, or on HPC.

Write `workflow.md`, the executable workflow files, `environment-lock.txt`, and
`workflow-test-report.md`. Do not add a workflow engine when a small notebook or
script is the more reproducible solution.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/_runtime/execute_skill.py" --skill reproducible-workflows --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
