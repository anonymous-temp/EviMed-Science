---
name: vcr-matching
description: Matching one patient to trials, or a protocol to many patients, for 「虚拟临床研究」 — the model judges each pair and each clause from the record and the eligibility text, what the record does not say is judged and labelled, and the result is read back from what was saved. Matching ends at assessment.
metadata:
  evimed-agent: vcr-matching
---

# Patient and trial matching

Two directions: trials for one person, or people for one protocol. Answer in the user's language. Matching ends at an assessment: no contact, referral, site work or enrolment.

Read [../vcr-protocol/references/operating-contract.md](../vcr-protocol/references/operating-contract.md) once; it holds the task scope and data requirements.

## Get the person and the trials

For one case, `mcp__evimed__vcr_read` what `patient_context` lists the person's messages and attachments, and `mcp__evimed__vcr_write` what `patient_context` saves the original, with `{messageSeq}`, `{sourceId, generation, sha256}` or `{sourceId}`. Use the `subjectKey` it returns in every call and never retype the record; to the person say the short name `subjectLabel` (for example `P-EE008D`), never the key. For a batch of files use `data_intake`. Then `mcp__evimed__vcr_read` what `candidates` searches the registries: `condition` and up to 32 `terms` ranked by importance (the person's problems, in English and Chinese both when the record is Chinese), a `summary` of their problems, stage and treatments so far in your own words (no name or ID number), and the age, sex and region you read in the record. The list comes back in the order it reads against the summary, with a `searchId`, and says which registries answered, failed or were not reached. A registry that failed is reported and the rest goes on.

For a protocol, save its eligibility once, from what was pasted or uploaded and nothing else: `mcp__evimed__vcr_write` what `protocol`, `data: { title, protocolText }` with that section as written; the platform numbers the clauses and says how many fell on each side and how many name no section. Or give `criteria` rows of `kind` and `sourceText`, the words as written. Read them back with what `matching` before judging. A saved rule (`requirement`) only matters for screening a table.

## Judge

More than a handful of pairs goes to the job: `mcp__evimed__vcr_simulate` action `start`, kind `match_judge`, with `selection`:

- one person: `{ "subjectKey": "…", "registryIds": ["NCT…"] }`, plus `collection` and `collectionRevision` from `candidates` when the search named a frozen set; or `{ "subjectKey": "…", "searchId": "…", "candidateLimit": 100 }` for the best 100 of a search, which the platform takes from the saved list;
- one protocol: `{ "protocolVersionId": "…", "subjectKeys": ["…"] }`, or neither for the latest version and the whole roster.

It judges every pair as a whole, then each person's best-ranked pairs clause by clause (`topK`; 0 none, `all` every pair). The answer says what it may cost and it has already started. Do other work meanwhile; its finish comes back to this conversation, and starting the same selection again judges only what is not done.

A handful of pairs may be judged here instead. Read the record with what `subject_document`, `filter: { subjectKey, kind: "sentences" }`, and the clauses from `mcp__evimed__trial_registry_record` (or what `matching` with `filter.protocolVersionId`), then save with `mcp__evimed__vcr_write` what `trial_judgment`: `subjectKey`, `registryId` or `protocolVersionId`, `fit` from 0 to 100, `confidence` from 0 to 1, `reasons`, `documentHash`, and `criteria` rows of `number`, `reason`, `sentenceIds`, `label`. Each item saves or comes back with its own notice; the rest are kept.

For each clause: does it apply to this person at all? Does the record state it? If it does not, ask whether a good record could leave this out if it were true. If it could not, take it as not so; if it could, say there is not enough information. Use clinical sense about the person: a 78-year-old is not pregnant, so that exclusion is `not excluded` or `not applicable`, not something to confirm. Evidence is sentence ids and nothing else; no sentence means the label reads as silence, which is honest. Labels are `included`, `not included`, `excluded`, `not excluded`, `not applicable`, `not enough information`.

## Report from what was saved

Read it back: what `candidate_trials` with `filter.subjectKey`, or what `matching` with `filter.protocolVersionId`. `ranking` holds each pair's `verdictLabel`, `fit`, `confidence`, `reasons` and clause rows with their `display` words and evidence; `failed` holds what did not finish, by code. Say how many of how many finished and what is left, copy the verdicts and labels, and for each trial say why it may suit and what is still to confirm. A `limited` result says what was done and why it stopped. Never report a pair the read does not hold. Do not repeat the record back or print internal fields.

## Structured cohort tables

A table with typed columns keeps its own rule evaluation: `mcp__evimed__vcr_read` what `contracts` gives the criteria grammar, what `matching` with `filter.kind` `contract` the fact contract, and `mcp__evimed__vcr_simulate` kind `match_criteria` runs the evaluator, where an unknown stays unknown. Use it for screening on columns and exact arithmetic, not for reading notes.
