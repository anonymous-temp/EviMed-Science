---
name: review-finding-repair-sweep
description: >-
  Triages the findings a review returns on a source-grounded evidence report and
  repairs each one in the carrier that owns the defect: the finding is first
  resolved against the preserved source, the repair is written where the defect
  actually sits, the claim register is re-registered in the same pass, and every
  other carrier that restates the repaired claim is swept before the next
  submission. Use when a submission came back with findings — required or
  advisory — and the report's sentences, its claim register and its reference
  list have to end the round agreeing with one another and with the sources.
whenToUse: >-
  When a reviewed submission returned findings and the report's sentences, its
  claim register and its reference list must end the round in agreement with the
  sources and with each other.
allowed-tools: ''
license: internal
metadata:
  role: functional
  applies_when: "A submission of a claim-bound report has been returned with findings, the report and its claim register are readable in the workspace, and the sources the claims cite are still preserved there."
  not_when: "No finding has been returned yet; or the report binds no claim register, so a sentence cannot be resolved to a support span; or the disputed support is a source the workspace no longer holds, in which case the finding is carried as unresolved rather than repaired."
  depends_on: "claim-verdict-audit@sha256:8bd4e4a2da0b5a92b4bfcaa8b68464bb4fffa542682848afafef1cd6d33f6e98, pre-submission-freeze-check@sha256:0659611bf7b6a2f6e7a2079c2760b29ded47afeb5af8d695d464153daaeabf38, reporting-checklist-addressability@sha256:67d7856648287eb0cfeedfbd04c067c88ade5e4e2ccc38ae079ae740a9f1e6ad"
  derived_from: "run:run_8fb04c2f0e1496227bb29bda6035ccd6, trigger:repair_accepted"
  evimed_schema: "method-skill/1"
---

## Purpose

A review returns findings against a report whose every sentence points at a
registered claim, and every claim at a support span inside a preserved source.
Those findings are not one kind of thing. One says that a claim's statement uses
a figure or a scope its own quoted span does not carry. Another says the
narrative outruns the source in wording or in strength. A third sits in the
routing: the reference entry is not the record the claim names, or one document
is listed twice under one claim. And some arrive simply mistaken, with the span
the reviewer doubted sitting in the preserved source verbatim. Treating them all
as one kind is how a round gets lost.

Each kind is repaired in a different place, and a repair in one place is never
enough on its own. One claim is restated across several carriers — abstract,
results, discussion, conclusions, practice points, and any summary or delta file
derived from the register — and each carrier holds its own copy of the wording.
Repair only the sentence the finding quoted, and the defect stays readable in the
carriers the round never reached, where the next review finds it. So the method
governs agreement. It never decides what a statement may say, because the span
decides that. It governs that the statement, its span, its register entry and
every carrier that restates it end the round saying the same thing.

## When to Use

Use it as soon as findings come back on a claim-bound report and before the next
submission, and use it again in every later round, because each round's repair is
what the next round is reviewed against. Use it as well when a repair to a
claim's own statement has to reach a derived file that restates it, and when a
finding names a term, a scope or a figure that appears in more than one section.

Do not use it before the first submission of a report, where the guards of the
freeze check belong. Do not use it to decide whether a statement is carried by
its source: that judgement is what step 1 borrows. Without a claim register a
sentence cannot be resolved to a support span, and a report with no preserved
sources has nothing to repair against.

## Inputs

- the returned findings, each with its kind, the claim or location it names, and
  the passage it quotes
- the narrative, and the carriers that restate it: abstract, results, discussion,
  conclusions, practice points, and every file derived from the register
- the claim register: per claim its statement, its supporting entries, each
  entry's quoted span, and the caveat forms the narrative is expected to use
- the reference list as the routing table, and each claim's own recorded source
  title and identifier
- the preserved sources, with the access tier actually reached for each claim
- the non-mutating pre-submit check and the notice list it returns
- the revision notes, where the round is recorded

## Workflow

1. **Resolve the finding against the preserved source before repairing anything.**
   The finding asserts that a sentence contradicts, misreads or overstates its
   source, and it may be wrong: a reviewer that resolved the mark to a different
   artefact, or read at a lower tier than the claim rests on, produces a
   contradiction that does not exist. Locate the passage the finding quotes in
   the preserved source for that claim, at the tier the claim claims, and let only
   a passage that cannot be located count as a defect. Where the pack must be
   judged instance by instance rather than finding by finding, take the verdict
   vocabulary from the audit rather than inventing one.
   [reuse method: claim-verdict-audit | when: a delivered pack must be re-checked instance by instance against the sources its own pointers name | provides: one verdict per claim instance, grounded in the record rather than in the pack's own confidence]

2. **Answer a finding you could not falsify as declined, with its ground; never
   delete a span that resolves.** A quote that is present verbatim in the
   preserved source is not evidence of fabrication, and removing it to close a
   finding destroys a correct citation. Say where it is, at which tier it was
   reached, and leave it in place. Reserve deletion for a span that truly is in
   no preserved source, and treat that as the serious defect it is.

3. **Classify the finding, then repair it in the carrier that owns the defect.**
   Four classes recur, and mixing them is what produces a repair in the wrong
   file:
   - *a figure in the claim's statement that its own span does not carry*: extend
     the supporting span to a contiguous run of the source that contains every
     numeral the statement uses; where the source states no such figure, move the
     figure into the claim's recorded uncertainty and say there that the source
     does not state it. A figure is never dropped in silence, and a span is never
     assembled from two places to make it fit.
   - *a sentence whose scope is wider than its span*: a subgroup result presented
     as the whole trial's, a hedged source phrase rendered as an assertion, a
     comparison the source makes only for one arm. Narrow the sentence to the
     scope the span has, keeping the source's own hedging words.
   - *a term in the narrative that is not the source's term*: adopt the source's
     term, and change it in every place it appears, including the caveat forms
     the register matches against the narrative. A term that is half-changed
     leaves the register and the narrative disagreeing.
   - *a support entry that names the wrong record, or lists one document twice*:
     one document, one entry. Where two facts come from one document, quote a
     single contiguous span that carries both, or attribute the second fact to a
     different record. The same document listed twice is not stronger support.

4. **Re-register the repaired claim in the same pass, then sweep its carriers.**
   The register and the narrative are two carriers of one statement, and a repair
   written into one of them leaves the check reading the other. Enumerate the
   repaired claim's markers across the narrative and across every derived file,
   and write the new wording into all of them before moving on; a carrier that
   legitimately keeps its own phrasing is named with the reason.

5. **Reconcile the routing table with the claims once the wording has settled.**
   Wording changes move entries, and an entry that no longer names the record its
   claim cites is a defect of its own. Compare each claim's recorded source title
   against the entry it routes to, character for character and including case;
   compare each entry's identifier against the record the claim names; and check
   in both directions that every in-text mark reaches exactly one entry and every
   entry is reached.

6. **Re-run the non-mutating pre-submit check and read its notice list, not only
   its verdict.** The list is where claim-level defects are reported while the
   verdict is already passing. A class this round repaired should no longer
   appear there; a class that persists is repaired rather than annotated, and one
   that is left standing is written into the revision notes with the reason.
   [reuse method: pre-submission-freeze-check | when: a finished deliverable is one step from submission and its bytes are about to be frozen | provides: the last guards on the artefacts that will freeze, including the notice list read as a list of defects]

7. **Where the finding is a checklist item reported as not found, address it
   where a reader can open it.**
   [reuse method: reporting-checklist-addressability | when: review findings report checklist items as not found or acceptance items as unmet | provides: every checklist row carrying an address inside the document under review]

8. **Spend the submission, then answer every finding that required one.** Record
   per finding whether it was repaired or declined and why, with the ground
   quoted from the source or from the preserved artefact. A round that repaired a
   finding but does not answer it leaves the next review raising it again.

9. **Record the round in the revision notes.** Name the classes repaired and
   where, the carriers swept, the findings answered as declined with their
   grounds, and the named defects left standing with their reason, so a later
   reader can tell a deliberate settlement from an oversight.

## Verification

- Every span the repair installed was located in the preserved source during this
  round, and the tier it was reached at is recorded; no span was written from a
  paraphrase, a summary or the report's own earlier wording.
- Every numeral a repaired statement uses is present inside its supporting span,
  checked by locating each numeral in the span rather than by reading the two
  side by side.
- No document appears twice as the support of one claim, and every support
  entry's identifier is the record its claim names.
- The markers of a repaired claim enumerated from the narrative plus those
  enumerated from each derived file equal the set that was swept; a carrier left
  unswept is named with its reason.
- The routing table reconciles in both directions: every in-text mark reaches one
  entry whose title matches the claim's recorded source title, and no entry is
  unreachable.
- The notice list returned by the last pre-submit check shows no occurrence of a
  class this round repaired; a class that persists appears in the revision notes
  with the reason it stands.
- Every finding that required a response has one, and each declined response
  quotes the passage that grounds it.
- Every caveat form the register expects appears verbatim in the sentences that
  restate the claim, in the forms the register now carries.

## Constraints

- No source is added, dropped or reclassified to make a finding go away, and no
  span is deleted while it still resolves in the preserved source.
- A figure is never silently removed from a statement: it is either carried by an
  extended span or moved into the recorded uncertainty with the statement that
  the source does not give it.
- A repair narrows a statement to its source's scope. A source is never widened
  to match a statement, and the source's hedging is never sharpened into an
  assertion.
- No clinical conclusion, threshold, dose, effect estimate or drug fact is
  written by this method. What a statement may say is decided by its span; the
  method governs only that the statement and the span agree, and it adds no
  boundary of its own.
- A finding whose support is not preserved is carried as unresolved with its
  reason. An unreachable source, an empty result and a source that does not carry
  the statement are three different facts and are never merged into one.
- Nothing about the round — no tool, no path, no narration of what was checked —
  enters the narrative; the round belongs in the revision notes.
- The delivered bytes are edited in place, bounded to the defect. No artefact is
  regenerated whole during a round.

## Output

The narrative, the claim register and the derived carriers in one state: each
repaired claim's statement carried by a span that holds every figure it uses, its
caveats present verbatim in the sentences that restate it, its support entries
one per document, and the routing table resolving to the records the claims name.
Beside them the revision notes for the round: the classes repaired and where,
the carriers swept, the findings answered as declined with their grounds, and the
defects left standing with their reason.
