---
name: vcr-matching
description: Matching one patient to trials, or a protocol to many patients, for 「虚拟临床研究」 — the model judges each pair and each clause from the record and the eligibility text, what the record does not say is judged and labelled, and the result is read back from what was saved. Matching ends at assessment.
metadata:
  evimed-agent: vcr-matching
---

# Patient and trial matching

Two directions: trials for one person, or people for one protocol. Answer in the user's language. Matching ends at an assessment: no contact, referral, site work or enrolment.

Read [../vcr-protocol/references/operating-contract.md](../vcr-protocol/references/operating-contract.md) once; it holds the task scope and data requirements.

## Admitted native matching tools

When `match_context` and `match_assess` are available, use this native workflow for every matching assessment. Stay in the current conversation. The host binds the task to its authenticated original message, owned source and current source permissions; a pasted `patientText` argument is not an original patient source.

1. Call `match_context` to inspect original inputs, then select a `messageSeq` or owned `sourceId`. Keep its `taskId`, `jobId` and `subjectKey`. For an existing record, retain that patient's `subjectKey` when joining a new authenticated message or attachment. A converting attachment remains pending until its existing document job finishes. For a protocol, supply `protocolText` as an exact passage of that selected original message or readable owned source. The host preserves its raw text, original section kinds and protocol version without creating a patient. Keep the returned `protocolVersionId`; a clause with no section remains unclassified.
2. Call `match_discover` with `taskId` and a focused clinical `query` to find trials. Keep the saved `searchId` and its order. Search failures and unavailable registry coverage are limitations, never negative clinical judgments.
3. Call `match_assess` with `taskId`, `subjectKey` and `registryIds` or `searchId`; for a protocol use `protocolVersionId` and `subjectKeys`. The host freezes sources and the authorized model profile; a managed native child performs clinical reasoning with DeepSeek Flash. It can call only `match_evidence` and `match_compute`. Do not select another reasoning model or score the pairs again in the parent. Neither a retrieval score nor recommendation priority determines clinical eligibility. Preserve the trial's original section identity; a clause with no known section is unclassified until the model interprets it.
4. The assessment response is the persisted result. Read it with `match_results`; use `match_job` to inspect, cancel or continue a durable task. A partial response states the assessed count and remaining pairs. Further bounded segments continue automatically in this same conversation; do not create another specialist conversation or start a replacement task for each segment. A failed segment preserves previously saved decisions and explicitly names its unfinished scope.
5. Use `match_correct` to associate a new authenticated user message with the affected patient; the model-written correction text grants no permission and never replaces original source evidence. Updated source or reasoning-profile identities make earlier judgments stale. Read current results before reusing them, and keep immutable history available.
6. Use `match_report` with a saved `resultId` for Markdown, CSV or JSON. It returns an authenticated report resource rendered from the same saved projection. An unavailable format or resource is unsupported, never a fabricated file. DOCX/PDF may be produced through available native office tools from that result, with current patient-source permissions.

For each clause, the model distinguishes stated, silent, inferred and computed bases, records exact evidence identities and visible assumptions, and keeps unresolved facts explicit. A missing fact is not zero and does not automatically satisfy or exclude. Clinical eligibility (`eligible`, `ineligible`, `uncertain`, `not-assessed`) is independent of priority and execution state. Explain those judgments in the user's language without exposing internal identifiers or repeating the record.

## Host compatibility

When native matching tools are unavailable, read [references/legacy-matching.md](references/legacy-matching.md) and use the existing host workflow. Its source, silence and saved-result requirements still apply.
