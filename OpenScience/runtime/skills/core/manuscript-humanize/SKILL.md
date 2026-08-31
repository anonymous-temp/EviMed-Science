---
name: manuscript-humanize
description: Use as the last step on a finished academic deliverable, when the prose reads as machine-written — uniform paragraph shapes, hedged attributions,列举式排比, inflated transitions. Applies the humanizer rules to the writing while holding every quotation, number, citation index, and claim marker byte-identical, so the delivery gate still passes. Never invoke it before the evidence work is complete.
license: MIT
---

# Manuscript humanize

Rewrite the prose of a finished deliverable so it reads as a person wrote it.
The rules for what makes writing sound machine-generated live in the vendored
`humanizer` (English) and `humanizer-zh` (Chinese) skills — load the one that
matches the document's language and follow it. This skill adds what those
skills cannot know: which parts of a scientific deliverable are **evidence**
rather than prose, and therefore must survive untouched.

Load `humanizer-zh` for a Chinese manuscript, `humanizer` for an English one.
Their patterns are the substance of this pass; everything below is the boundary
it runs inside.

## What must not change

A cited manuscript is not free text. These are load-bearing, and a rewrite that
touches them turns a deliverable that passed into one the gate rejects — or
worse, one that reads well and no longer matches its sources:

1. **Quoted material.** Any text inside quotation marks that carries a citation,
   and any string that appears in `clinical-evidence-matrix.json` as a
   `supportQuote`, is verbatim from a source. Not one character.
2. **Numbers.** Effect estimates, confidence intervals, sample sizes, doses,
   thresholds, dates, percentages, p-values. Do not round, reformat, convert
   units, or turn 0.3–0.6 mg into "about half a milligram".
3. **Citation indices** — `[7]`, `[3][4]`, `[2-5]` — and their positions
   relative to the sentence they support. Moving a citation to a different
   clause changes what it is claimed to support.
4. **Hidden claim markers** — `<!-- claim:CLM-014 -->`. They bind report prose
   to the evidence matrix. Keep each one attached to the sentence it marked.
5. **Derivation marks** — `〔推导〕` — and the assumptions, method, and
   sensitivity that accompany a derived result.
6. **Section headings**, their order, and the reference list.
7. **Hedging that reflects evidence strength.** "可能" in front of a claim
   supported by one low-quality trial is not weak writing; it is the finding.
   Sharpening it into a confident sentence is fabrication, not editing. This is
   the single most likely way to do harm here: the humanizer rules read hedges
   as a tell, and in an evidence report many of them are the result.

## What to change

Sentence rhythm, paragraph openings, transitions, word choice in the analyst's
own prose, and the shape of an argument that reads as a template rather than as
someone working through a problem. Merge paragraphs that were split to look
balanced. Cut the connective filler. Let paragraph lengths vary the way they do
when a person writes about something they understand.

Two register faults are specific to this platform and are worth naming, because
the humanizer rules do not cover them:

- **Acceptance-spec prose.** 「命题 A（……）成立，需……；判定为……」 is a
  reviewer's checklist, not a paper. Rewrite as a finding with its strength:
  「现有报告仅提供用药与症状的时间关联，缺少去激发/再激发观察与标准化因果关系
  评定，尚不足以支持因果归因」.
- **Commissioning vocabulary.** 题库、语义群、KPI、达标率、交付判据 belong to
  whoever ordered the work. A paper never mentions the task that produced it.

## Procedure

1. Read the whole document before editing anything. A pass that rewrites
   paragraph by paragraph produces uniform paragraphs, which is the defect.
2. Extract the protected set first: every `supportQuote` in the matrix, every
   number, every citation index, every claim marker. Keep it beside you.
3. Edit **in place with the edit tool**, one passage at a time. Do not rewrite
   the file with the write tool: a whole-file regeneration reconstructs the
   document from what you still hold in context, and measured across this
   project's repairs, every whole-file rewrite lost content — one shed 1,863
   characters and the next 4,125.
4. After each passage, re-read it against the protected set.
5. When the pass is done, verify mechanically before declaring it finished:

```bash
python "scripts/verify_preserved.py" \
  --before <original> --after <edited> --matrix clinical-evidence-matrix.json
```

   It compares the two files on exactly the protected set and prints what moved.
   A non-empty report means the rewrite broke something; fix it and rerun.
6. Then rerun the deliverable's own preflight, because prose edits can still
   break section-level rules.

## When not to run this

- Before the evidence work is finished. Humanizing a draft that will change is
  wasted, and it makes the later diff unreadable.
- On the reference list, the evidence matrix, the search log, or the citation
  ledger. Those are apparatus, not prose.
- On a document whose hedges you cannot check against the matrix. Without the
  matrix you cannot tell a weak sentence from a weak finding.
