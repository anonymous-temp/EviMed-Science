---
name: synthetic-control
description: Explore comparator weighting, adjustment, bias analysis and sensitivity to unmeasured confounding.
---

# Synthetic and external controls

Example natural request: “How robust is a risk ratio of 3.9 to unmeasured confounding?”

## What this can do

Explore comparator weighting, adjustment, bias analysis and sensitivity to unmeasured confounding. The operations are composable: select only those relevant to the question, and do not impose a fixed sequence. Call the domain's describe tool without a method for its inventory, and with a method for the versioned scenario schema.

## Shared evidence operations

When the question needs evidence synthesis, the same plugin can discover and invoke the shared evidence methods: pooling, network meta-analysis, dose-response analysis, effect shrinkage and Kaplan–Meier curve reconstruction. Select a suitable method and inspect its schema; preserve the studies and assumptions, and do not treat methodological availability as proof that synthesis is appropriate.

## Inputs and provenance

Weighting and comparator estimation require authorized data, a target estimand, treatment and covariate definitions; the example E-value requires only a stated estimate and confidence limit. Ask for essential missing inputs; do not fabricate them. Use existing web search, knowledge-base and file tools when sources or records are needed. Preserve the input's source, version, permission and explicit assumptions. A local source binding is an unverified model assertion, not proof of a quotation or clinical claim.

For an explanation-only request, answer in the conversation; no computation, file or full research sequence is required. If essential inputs are absent, finish the reply by naming the missing inputs and why they matter. In an automated turn no person is waiting to answer: do not keep probing schemas, create substitute patient data, or invent numerical assumptions to avoid that final reply. Use assumed inputs only when the request authorizes them, and label them explicitly.

## Results and limits

Read the job result and use the report tool if a report is wanted. State the method, version, relevant inputs, measures, uncertainty, diagnostics and limitations. Balance or an E-value alone cannot establish exchangeability or eliminate bias. Inspect overlap, time zero, data quality, causal assumptions and method diagnostics.

## Example

See `examples/comparator.evalue.json` for a small reproducible method input. It demonstrates the API, not clinical validation.
