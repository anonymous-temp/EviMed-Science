---
name: virtual-patient
description: Generate research scenarios and apply or train supported prognostic models where inputs and intended use permit.
---

# Patient trajectory prediction

Example natural request: “Generate binary outcome scenarios for two groups of 40 patients.”

## What this can do

Generate research scenarios and apply or train supported prognostic models where inputs and intended use permit. The operations are composable: select only those relevant to the question, and do not impose a fixed sequence. Call the domain's describe tool without a method for its inventory, and with a method for the versioned scenario schema.

## Shared evidence operations

When the question needs evidence synthesis, the same plugin can discover and invoke the shared evidence methods: pooling, network meta-analysis, dose-response analysis, effect shrinkage and Kaplan–Meier curve reconstruction. Select a suitable method and inspect its schema; preserve the studies and assumptions, and do not treat methodological availability as proof that synthesis is appropriate.

## Inputs and provenance

Scenario generation needs an explicit endpoint and model assumptions. Individual prediction requires compatible patient inputs and a model with an appropriate intended use and validation. Ask for essential missing inputs; do not fabricate them. Use existing web search, knowledge-base and file tools when sources or records are needed. Preserve the input's source, version, permission and explicit assumptions. A local source binding is an unverified model assertion, not proof of a quotation or clinical claim.

For an explanation-only request, answer in the conversation; no computation, file or full research sequence is required. If essential inputs are absent, finish the reply by naming the missing inputs and why they matter. In an automated turn no person is waiting to answer: do not keep probing schemas, create substitute patient data, or invent numerical assumptions to avoid that final reply. Use assumed inputs only when the request authorizes them, and label them explicitly.

## Batch trajectories

A forecast for a batch of patients is one job over the whole batch with stable subject keys. Name what the forecast is: `predictionMode` is `factual_forecast` (current care, no future actions), or `conditional_forecast` with the explicit schedule it depends on in `actions` (each `{code, at: {value, unit}, dose?: {value, unit}}`; times and doses convert only within one dimension, never guess a unit). Actions recorded after the prediction origin are never an input to a forecast: replaying them (`actionHistoryId` names the later history) tests the model given what really happened and the result says so. New observations make a new history and a new prediction version (`priorPredictionId`), compared with the old one and with what was observed. Report the denominator as the result gives it: submitted, completed, rejected, failed and not processed, each person with a reason; draws are futures of one person, not more people, and a model that gives no uncertainty has none shown.

## Results and limits

Read the job result and use the report tool if a report is wanted. State the method, version, relevant inputs, measures, uncertainty, diagnostics and limitations. Generated individuals and trajectories are synthetic, not observed clinical histories. Model output is not a validated digital twin or patient-specific clinical decision.

## Example

See `examples/patients.binary.json` for a small reproducible method input. It demonstrates the API, not clinical validation.
