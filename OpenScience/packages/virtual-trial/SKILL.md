---
name: virtual-trial
description: Explore design alternatives, sample size, operating characteristics, dose-finding and sensitivity under stated assumptions.
---

# Virtual trial design

Example natural request: “How many events and participants might this design need?”

## What this can do

Explore design alternatives, sample size, operating characteristics, dose-finding and sensitivity under stated assumptions. The operations are composable: select only those relevant to the question, and do not impose a fixed sequence. Call the domain's describe tool without a method for its inventory, and with a method for the versioned scenario schema.

## Shared evidence operations

When the question needs evidence synthesis, the same plugin can discover and invoke the shared evidence methods: pooling, network meta-analysis, dose-response analysis, effect shrinkage and Kaplan–Meier curve reconstruction. Select a suitable method and inspect its schema; preserve the studies and assumptions, and do not treat methodological availability as proof that synthesis is appropriate.

## Inputs and provenance

A design, endpoint, effect, analysis assumptions and where relevant accrual and follow-up; use observed evidence only when available and authorized. Ask for essential missing inputs; do not fabricate them. Use existing web search, knowledge-base and file tools when sources or records are needed. Preserve the input's source, version, permission and explicit assumptions. A local source binding is an unverified model assertion, not proof of a quotation or clinical claim.

## Results and limits

Read the job result and use the report tool if a report is wanted. State the method, version, relevant inputs, measures, uncertainty, diagnostics and limitations. Operating characteristics are conditional on the specified model and assumptions. Simulations do not establish clinical efficacy or guarantee a real trial outcome.

## Example

See `examples/design.analytic.json` for a small reproducible method input. It demonstrates the API, not clinical validation.
