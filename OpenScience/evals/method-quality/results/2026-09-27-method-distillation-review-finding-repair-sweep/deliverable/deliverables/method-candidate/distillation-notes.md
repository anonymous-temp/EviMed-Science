# distillation-notes — method-candidate

Job: one distillation from `distillation-input.json` (frozen).
Trigger: `repair_accepted`. Signal: `reviewer`. Capability: `clinical-evidence-synthesis`.
Run: `run_8fb04c2f0e1496227bb29bda6035ccd6`. Excerpts: 80 messages, seq 489–678.
`corrections`, `feedback` and `repairIssues` are empty; `peerRuns` is empty; `mountedTools` is empty.
Input read in full before drafting; `relatedMethods` (all three) read in full before the operation was chosen.

## Reflection (trigger `repair_accepted`, four required fields)

### error_identification

The round's own findings, quoted where the input carries them:

- Claim-level support defects, returned while the verdict already read `ok`:
  `"claims[12].claim numeric fact 1181 is not present in its direct support. Quote the passage that states it, or if the source does not state it, say so in the claim's uncertainty rather than dropping the figure."` (seq 543, the notice list of the first submission, where the class appears twelve times; the same class still appears eleven times in the second submission's list at seq 633 and ten times in the third at seq 669, and it reappears in the claim-registration results at seq 611).
- One document registered twice as a claim's support: `"CLM-039 now has a required issue: duplicate supporting source (same document twice). I need to fix: keep one entry per document."` (seq 615).
- Reference entries not identical to the claims' own recorded source titles: `"So the 3 mismatches are likely 5, 12, 13 (case-sensitive). Let me fix all three to match exactly."` (seq 496).
- Narrative wording diverging from the source's own term while the claim's matched caveat forms still carried the old term (seq 559).
- A sentence carrying a conclusion the span did not: the narrative read `随访超过 1 年的研究仍保留效应，提示获益不依赖随访时长` (seq 569) against a span that reports a subgroup result only.
- A finding that a quote did not exist in the source, which the run falsified by locating the passage verbatim: `"Both verified exact matches in the preserved full text. So F01/F02 are false positives"` (seq 554).
- The same repair missing a carrier: `"I only edited 摘要结论 and 结果 and 实践要点 and 讨论. Let me fix 结论第三 too."` (seq 608).

### root_cause_analysis

The run registered a claim's statement and its supporting span as two separately written
artefacts and let them drift: the statement was written first, at the strength the run
meant, and the span was chosen afterwards as the passage that carried the claim's subject
rather than the passage that carried every figure the statement uses. The same drift
appeared in the other direction when the narrative's term and the register's caveat forms
were edited in different passes. Two further causes compounded it. First, the repaired
statement and the register were treated as one carrier: a repair went into the narrative,
and the register kept the old statement until it was re-registered, which is why a claim
class the round believed it had closed reappeared in the next notice list. Second, the run
treated a claim as living in the sentence the finding named, although the same claim is
restated in the abstract, the results, the discussion, the conclusions, the practice points
and a derived delta file; the round edited the carriers it happened to be reading and left
the rest, so the next review re-raised the same wording. The run's own triage was otherwise
sound — it resolved each doubtful quote in the preserved source before acting, and answered
two findings as `declined` with the locating ground rather than deleting quotes that
resolved — which is what makes the missing step a step and not a defect of judgement.

### correct_approach

Resolve each finding against the preserved source first, at the tier the claim claims, and
let only a passage that cannot be located count as a defect. Then classify the finding: a
figure missing from its own span (extend the span to a contiguous run that carries every
numeral, or move the figure into the recorded uncertainty and say the source does not give
it); a scope wider than the span (narrow the sentence, keep the source's hedging); a term
that is not the source's (adopt the source's term and move the matched caveat forms with
it); a routing defect (one document, one entry; a wrong identifier repaired against the
record the claim names). Re-register the claim in the same pass, because the register and
the narrative are two carriers of one statement. Then sweep every carrier that restates the
repaired claim before moving to the next finding, reconcile the routing table character for
character once the wording has settled, re-run the non-mutating pre-submit check and read
its notice list as a list of defects, spend the submission, and answer every finding that
required a response.

### key_insight

A claim's statement and its supporting span are two artefacts that drift apart on their
own, and a repair written where a finding was raised rather than where the defect sits
leaves the same defect readable in every carrier that restates the claim.

## Operation choice

`create`. The three methods on file were read in full:

- `pre-submission-freeze-check` guards the bytes, the pointers and the tables of a deliverable
  about to freeze; it reads the notice list, but it repairs artefacts rather than findings, and
  it is explicitly out of scope once the pack is accepted.
- `reporting-checklist-addressability` places checklist rows and acceptance items where a
  reader can open them; it owns one finding class at most (a checklist item reported as not
  found) and is reused for it in step 7.
- `claim-verdict-audit` judges whether a pack's statements are carried by the sources it
  cites and never rewrites the pack; its constraint forbids exactly the repair this run's
  trigger is about, so folding this lesson into it would contradict it.

No method on file states how a returned finding is triaged, where each class is repaired, or
that the repair must reach every carrier of the claim. `depends_on` pins all three by the
digest each entry carries in `relatedMethods`; neither is the candidate itself.

## Anchor review (traceability, against the frozen input)

- Every `evidence` quote was located as an exact substring of the raw message text at its
  `seqRange` in `transcriptExcerpts`, in the run named by `runId` (8 entries). None was
  paraphrased, and no sequence number used in `seqRange` lacks a message in the input.
- Every `depends_on` digest was matched against a `relatedMethods` entry digest: all three
  resolve, all are 64 hex characters, none names the candidate.
- Every `testScenarios` entry is drawn from a situation that occurred in this input (title
  identity, a figure absent from its support, a document registered twice, term/caveat drift,
  a scope wider than its span, a doubtful quote that resolved). No scenario was invented.
- The body was read once more for claims that belong to one question rather than to a
  procedure: it names no drug, no population, no effect estimate, no threshold and no dose.
  The defect classes are described by their shape (a figure, a scope, a term, a support
  entry), never by their content.
- No tool name, absolute path, credential or patient identifier appears in the body.
  `allowed-tools` is empty because `mountedTools` is empty.

## Wording pass (humanize)

A pre-edit copy was saved before the pass (`SKILL.pre-humanize.md` for the method and
`method-candidate.pre-humanize.json` for the candidate). The pass touched the explanatory
prose only — the `## Purpose` paragraphs — replacing a list of em-dash appositions and two
inflated connectives (`is lost by treating them as if they were`, `which is what makes …`)
with shorter, unevenly sized sentences, and reordering the second paragraph so the
consequence precedes the rule. Checked afterwards against the protected set: frontmatter,
all seven section headings, every reuse reference, every `sha256` digest and every numeral
are byte-identical to the pre-edit copy; the diff contains no line outside `## Purpose`.
The candidate's `display` fields and the `method-candidate.json` fields were not touched.

## Observations rejected, and why

- **The twelve persisting numeric-support notices as an instruction to clear the notice list
  before submitting.** The notices are repeated advisories that the run judged not to require
  repair; `pre-submission-freeze-check` owns the notice-list reading and already states it.
  It is cited, not restated as a new rule.
- **The specific figures, terms and effect estimates the run aligned** (a trial's sample size,
  an odds ratio, a particular adverse-event term). These are facts of one question, not a
  procedure; none enters the method.
- **The access-tier argument used to answer two findings as `declined`** as a general rule that
  quotes doubted by a reviewer are usually false positives. The transferable part is the
  falsification step and the recorded ground; the direction of the error is not assumed.
- **A merged method folding all three related methods into one.** Their triggers, inputs and
  outputs differ (pre-freeze guards, checklist addressability, post-acceptance verdicts), so
  there is no near-duplicate to merge; the merge would delete boundaries the library keeps.
- **Amending `pre-submission-freeze-check`.** Its scope ends at the freeze; this lesson begins
  after the first submission returns findings.
- **A method for the derived delta file's own schema.** One reviewer finding touched a wording
  field in that file; the run's repair there is an instance of the sweep in step 4, not a
  procedure of its own.
- **Any statement of outcome quality.** Nothing here claims the round's repairs were correct
  or that the method passes; the three submissions returned `ok` and that value belongs to
  the run, not to this candidate, whose promotion is not this job's to record or request.
