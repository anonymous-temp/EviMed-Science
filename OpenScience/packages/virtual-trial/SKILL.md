---
name: virtual-trial
description: Explore design alternatives, sample size, operating characteristics, dose-finding and sensitivity under stated assumptions.
---

# Virtual laboratory: design simulation

Example natural request: “How many events and participants might this design need?”

## What this can do

Explore design alternatives, sample size, operating characteristics, dose-finding and sensitivity under stated assumptions. The operations are composable: select only those relevant to the question, and do not impose a fixed sequence. Call the domain's describe tool without a method for its inventory, and with a method for the versioned scenario schema.

## Shared evidence operations

When the question needs evidence synthesis, the same plugin can discover and invoke the shared evidence methods: pooling, network meta-analysis, dose-response analysis, effect shrinkage and Kaplan–Meier curve reconstruction. Select a suitable method and inspect its schema; preserve the studies and assumptions, and do not treat methodological availability as proof that synthesis is appropriate.

## Inputs and provenance

A design, endpoint, effect, analysis assumptions and where relevant accrual and follow-up; use observed evidence only when available and authorized. Ask for essential missing inputs; do not fabricate them. Use existing web search, knowledge-base and file tools when sources or records are needed. Preserve the input's source, version, permission and explicit assumptions. A local source binding is an unverified model assertion, not proof of a quotation or clinical claim.

For an explanation-only request, answer in the conversation; no computation, file or full research sequence is required. If essential inputs are absent, finish the reply by naming the missing inputs and why they matter. In an automated turn no person is waiting to answer: do not keep probing schemas, create substitute patient data, or invent numerical assumptions to avoid that final reply. Use assumed inputs only when the request authorizes them, and label them explicitly.

## Comparing designs and searching for one (virtual lab)

To compare named design alternatives without new assumptions, use `virtual_trial_compare` with `{experiment: {question, arms, comparison}}`: each arm is either an existing saved result (`{name, resultId}`, never rerun) or a design method with its scenario (`{name, method, scenario}`); all arms share one endpoint and analysis; `comparison` names the measures and the reference arm. Read it back with `{experimentId}`.

To search for a design that meets stated requirements ("keep simulating until a design works"), use `virtual_trial_search` with a frozen `{manifest}`, stated before anything runs: `objective` {measure, direction, truth}; `constraints` [{measure, op, bound, kind: error_control | design | safety, truth}]; `space` {method, scenario, truths [{name, truth}], and either `variables` [{path, values}] or `candidates` [{set}]}; `stages` {screening {replicates}, final {count}}; `budget` {maxCandidates, cpuSeconds}. Only design paths may vary: the truth, endpoint, nominal alpha, sidedness and what is measured are the evaluator and are refused. An error-control bound can never exceed the stated alpha, and a dose-finding design is judged by toxicity and selection constraints, not by a superiority alpha. Read progress with `{campaignId}`; stop with `{campaignId, cancel: true}`. A changed manifest is a new campaign.

The platform evaluates every candidate: screening numbers only rank candidates and are never results; finalists are re-run at the method's normal precision on new random streams, and a constraint counts as met only when its conservative bound meets it ("inconclusive" near the bound is not met). Report the stop reason, the best design with its final numbers and their error, which constraints were met, inconclusive or not, and the budget used. Never recompute or round a number yourself, never relax a constraint to make a candidate win, and say plainly when nothing feasible was found.

### Drug-effect hypotheses in a disease model

The lab also compares what different drug hypotheses do in a disease model. Make each arm a `patients.progression` run of the same trial (today the Alzheimer ADAS-cog 11 family `beta_logit`, in weeks; see the patient plugin's describe for its scenario). The arms differ only in `treatment`: none (placebo against placebo, which shows the analysis's type I error), `symptomatic` or `diseaseModifying`; they must share people, model, visits, design and analysis, and a design arm and a disease arm are never one experiment. For a search, state the drug worlds as `space.truths` whose `truth` is a `treatment` block (an empty block means no effect) and move only the design: `design.nTreat` and `design.nControl` together (use `candidates`), or `visits` with `analysis.visit`. There is no screening stage here: every candidate runs at the engine's own number of trials. `total_sample_size` and `last_visit_weeks` are calculated from the scenario and may be the objective; a type I error at the analysis's own 5% is "inconclusive", not met. The drug effects are the researcher's hypotheses, never a prediction for a compound; the parameters are the published CAMD posterior and no FDA or EMA status comes with them; the model describes mild to moderate Alzheimer disease for up to two years. A population imported or built elsewhere is not needed to start: the trial states its own people.

## Results and limits

Read the job result and use the report tool if a report is wanted. State the method, version, relevant inputs, measures, uncertainty, diagnostics and limitations. Operating characteristics are conditional on the specified model and assumptions. Simulations do not establish clinical efficacy or guarantee a real trial outcome.

## Example

See `examples/design.analytic.json` for a small reproducible method input. It demonstrates the API, not clinical validation.
