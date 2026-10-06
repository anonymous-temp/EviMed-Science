# Evidence incidents

A ledger of published evidence cards that were corrected or withdrawn after publication, one incident per case. Corpus only: there is no harness here yet.

The learning loop (`OPEN_SCIENCE_LEARNING_EVIDENCE_OUTCOMES_ENABLED`) writes an `evidence-incident` document for each correction and withdrawal in the public change log, and
`scripts/evals/export-evidence-incidents.mjs` turns the pending ones into `cases/<id>.json`. Principle 6: every incident becomes an eval case, not a keyword — and a running
server cannot write repository files, so the export is a script an operator runs and commits. Only incidents of cards the platform produced, or whose author published them to
the internet, are exported; a card visible only inside the platform keeps its incident as a ledger row.

## Case shape

The shape of `../writing-incidents/cases/` (`id`, `genre`, `observedIn`, `verbatim`, `whyItIsWrong`, `caughtBy`, `note`) with the fields an evidence incident has beside it:
`cardId`, `zoneId`, `claimId`, `revisionBefore` / `revisionAfter`, `claimAfter`, `quoteBefore` / `quoteAfter` (the source sentence the claim stood on, before and after),
`sourceChanges`, `trigger`, `producerKind`, `capabilityId`, `runId`, `occurredAt`. `verbatim` is the claim as first published, copied, never paraphrased; for an incident with no
claim it is the card's title. `genre` is one of the five closed classes: `evidence-claim-amended`, `evidence-claim-withdrawn`, `evidence-card-withdrawn`,
`evidence-producer-correction`, `evidence-source-changed`. `caughtBy` is `reader`, `producer` or `source-change`.

A case holds nothing a published card does not already show; the run and capability that produced it are system identifiers.
