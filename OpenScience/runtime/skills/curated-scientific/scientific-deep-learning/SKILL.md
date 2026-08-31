---
name: scientific-deep-learning
description: Develop and evaluate deep learning models for scientific data. Use for PyTorch, Lightning, transformers, graph neural networks, representation learning, GPU training, model fine-tuning, or scientific foundation models.
---

# Scientific deep learning

Define the scientific target, unit of analysis, dataset lineage, split unit, leakage risks,
baseline, metric, and intended use before training. Check dataset and model licenses and
preflight compute, memory, and dependency requirements. Keep patient, specimen, subject,
site, or temporal groups intact across splits as the domain requires.

Start with a transparent baseline. Record preprocessing, architecture, initialization,
seed, optimizer, schedule, batch size, precision, checkpoint rule, and hardware. Monitor
overfitting and failed runs; evaluate calibration, subgroup behavior, uncertainty, and
external or temporal generalization when relevant. Never use the test set for selection.

Deliver `model-card.md`, configuration, checkpoints only when permitted, metrics with
confidence intervals, error analysis, and a provenance manifest. Fail closed on data
leakage, incompatible checkpoints, non-finite training, or missing evaluation artifacts.
Do not present a research model as clinically deployable.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill scientific-deep-learning --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
