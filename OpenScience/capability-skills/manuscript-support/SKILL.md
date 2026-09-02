---
name: manuscript-support
description: Draft or revise one section of a research manuscript against a fixed source set, keeping every claim bound to the claim ledger, every citation resolvable in the citation ledger, and every note about the writing itself out of the section.
metadata:
  evimed-agent: manuscript-support
---

# Manuscript support

Use this when someone has their sources — their own results, an earlier run's
evidence package, a folder of PDFs — and needs **one section** of the manuscript
written or rewritten: 引言, 资料与方法, 结果, 讨论, 局限性, 结论.

Unless the user asks otherwise, write in Simplified Chinese. Keep source titles,
identifiers, statistical symbols, units, gene and drug names, and the reporting
guideline's own item names in their original form — a translated item name is
one a reviewer cannot look up.

---

## One section. The sources are already chosen

This is not a small evidence review. The retrieval happened before you: the
researcher supplied the sources, or an earlier run produced them. **Your job is
that the finished prose still points at them.**

That has three consequences worth stating before you write a sentence:

- **You do not go looking for a better source to make a paragraph work.** If the
  section needs a claim the sources do not carry, that is a gap, and a gap is
  written as a gap. The search tools are here for one thing — resolving a
  citation the researcher gave you incompletely (a title with no DOI, a PMID
  with no year). Not for filling an argument.
- **You write one section.** If the request names none, ask which one. 「写一下
  讨论」 and 「把方法学补完」 produce different documents, and a section nobody
  asked for is thrown away whole.
- **The other sections are context, not your output.** Read them if they were
  supplied, so the section you write does not contradict them or repeat them.
  Do not rewrite them.

## What each section is for, and what it must not do

The commonest failure is not bad prose. It is content in the wrong section,
which no amount of rewriting fixes because the reader is looking for it
somewhere else.

| Section | Carries | Never carries |
|---|---|---|
| 引言 | The problem, what is known, the specific gap, the objective — narrowing to it | Results. A summary of your own findings |
| 资料与方法 | Design, population, definitions, variables, statistics, ethics — reproducible from the text alone | Any number that is a result; justification of the finding |
| 结果 | What was observed, in the order the methods promised, with the estimates and their uncertainty | Interpretation, comparison with other studies, 「提示」 |
| 讨论 | What the findings mean, against what is already known, with the mechanisms and the alternatives | New results. Restating 结果 paragraph by paragraph |
| 局限性 | What could have produced the finding other than the effect, and in which direction it would bias | Defences that dissolve the limitation you just named |
| 结论 | What the study supports, at the strength it supports it | Anything the results did not measure |

Write to the reporting guideline the study needs (STROBE, CONSORT, PRISMA,
TRIPOD…) when one applies. Name it in `delivery-summary.md` and say which items
this section is responsible for — a guideline invoked and never mapped is a
citation, not a method.

## The gap stays a gap

A section that needs something the sources do not have is the ordinary case, not
a failure state. What you must not do is dissolve it: 「有待进一步研究」 costs
nothing to write and tells the reader nothing.

Write it as a gap the next study could close — the design, the population, the
comparator, the outcome, the order of magnitude of sample. And **absence of
evidence is never a finding**: 未检索到 supporting studies is insufficient
evidence to judge, never evidence of no effect, so it cannot carry 无效 or
不推荐.

## The two ledgers

They are what make the section checkable after it has been rewritten three
times. Both are deliverables, and the contract reads them.

### section-claims.json

Same claim shape as the evidence matrix everything else in this platform
writes, so the verifier can be pointed straight at it:

```json
{
  "schemaVersion": 1,
  "section": "discussion",
  "claims": [
    { "claimId": "CLM-001", "claimType": "direct", "claim": "……",
      "referenceNumber": 3, "sourceTitle": "……", "sourceUrl": "https://doi.org/……",
      "supportQuote": "verbatim from the source, not paraphrased",
      "applicability": "……", "uncertainty": "……" },
    { "claimId": "CLM-007", "claimType": "derived", "claim": "……",
      "derivedFrom": ["CLM-001", "CLM-004"],
      "method": "the arithmetic or the bound that takes those inputs to this result",
      "assumptions": "……", "sensitivity": "……",
      "applicability": "……", "uncertainty": "……" }
  ]
}
```

Three claim types, and the difference is who is speaking:

- **`direct`** — one source says it. A verbatim `supportQuote` bonds the
  sentence to that source.
- **`synthesized`** — you concluded it across sources. Name at least two, quote
  each, and say how confident you are.
- **`derived`** — *you* computed or estimated it. It has no quote to give, so it
  carries its inputs (`derivedFrom`), its `method`, its `assumptions` and its
  `sensitivity` instead.

Mark each claim in the section with a hidden marker on the sentence it belongs
to: `<!-- claim:CLM-001 -->`. That marker is what survives every later rewrite
and lets a reviewer ask "where did this sentence come from" a year from now.

**A derived result is labelled 〔推导〕 in the section itself, every time it
appears.** Not once at the top, not in a footnote — on the sentence. A reader
who takes an estimate for a measurement has been misled by the document, and
this is the only thing standing between them and that.

### citation-ledger.csv

Header naming `claimId`, `referenceNumber`, `supportQuote` (any order, extra
columns welcome — `sourceTitle`, `sourceUrl`, `identifier` are all useful):

```csv
claimId,referenceNumber,supportQuote,sourceTitle,sourceUrl
CLM-001,3,"verbatim passage","……","https://doi.org/……"
```

**Every `[n]` in the section must be a `referenceNumber` in this file**, and
every reference number here should be cited somewhere in the section. A derived
claim is not a row — it cites no source of its own; its inputs are the rows, and
they are what a reader traces.

**Write multiple citations as `[1,2]` or `[1，2]`, never as a range `[1-2]`.**
The gate that decides whether this package ships reads comma-separated lists
only; a range reads to it as no citation at all, and it then reports those
references as listed but never cited. Ranges are an ordinary convention and one
day the shared rule may take them, but until it does, writing one costs the run
a repair cycle for a formatting choice.

### Reference format: say which standard, then hold to it

Two are in scope, and which one applies is the journal's decision, not yours:

- **Vancouver / ICMJE** for the international journals — authors inverted, up to
  six then `et al.`, journal title abbreviated to its NLM form, year;volume(issue):pages.
- **GB/T 7714** for Chinese journals — the national standard, and the one whose
  detail is most often lost: every entry carries its document-type marker
  (`[J]` journal, `[M]` monograph, `[S]` standard, `[D]` dissertation, `[EB/OL]`
  online), and Chinese-language entries take `等` where the English take `et al.`

Name the standard you used in `delivery-summary.md`. A reference list in no
declared format cannot be checked by anyone, and the copy-editor who finds out
at proof stage rewrites all of it by hand.

### The reporting guideline is the section's checklist

If the brief names one — CONSORT for a trial, STROBE for an observational study,
PRISMA for a systematic review, SPIRIT for a protocol, and the rest of the
EQUATOR set — then it says what this section must contain, item by item. Say in
`delivery-summary.md` which of its items this section is responsible for and
where each is answered. Do not claim the checklist is satisfied as a whole: you
wrote one section, and the claim belongs to whoever assembles the manuscript.

## Backstage prose has a destination, so the section may refuse it

The section is the front of the house. Three genres belong elsewhere, and each
has one place to be:

| Genre | Where it goes |
|---|---|
| What you changed and why, what you cut, which source you rejected and on what grounds | `revision-notes.md` |
| Your own review findings on the draft, and any reply to a reviewer's comment | `revision-notes.md` |
| What was delivered, what is still open, which guideline items this section covers | `delivery-summary.md` |
| How the work was produced — tools called, gateways, files fetched, artifact paths, 「我先检索了……」 | Nowhere in the deliverable. The retrieval record is the citation ledger |

`revision-notes.md` is a required output, not a courtesy. It is the thing that
entitles the section to carry none of this: a prohibition with nowhere to put
the prohibited thing is one every run quietly works around by leaving the note
in the section where nobody asked for it.

The section also never mentions the manuscript as an object — 「本节旨在回应审稿
人第 2 条意见」, 「本文修改后删去了……」, 「以下内容供参考」. Say the scientific
thing plainly, or say it in the notes.

## Numbers are a sweep, not a replacement

Every number in the section is a rendered fact: it came from a result table, a
source, or a derivation you recorded. It was never typed from memory.

So **changing one number is a sweep, not an edit.** Before you declare it done:

1. Find *every* occurrence — the abstract line, the 结果 sentence, the table
   cell, the 讨论 paragraph that compares it with somebody else's, the figure
   caption.
2. Find every **dependent** claim: a percentage computed from it, a difference,
   a 「约为对照组的两倍」, an ordering ("the largest of the three"). Each of those
   is a derived claim and each has to be re-derived, not adjusted by eye.
3. Update `section-claims.json` and `citation-ledger.csv` to match.
4. Record the sweep in `revision-notes.md`: which number, from what to what, and
   every place it reached.

A number changed in one place and left standing in another is the single
hardest error for a reviewer to catch and the easiest for a reader to find.

## Revising a draft you were given

When `existingDraft` is present, you are editing, not regenerating.

**Edit in place with the edit tool.** Do not rewrite the file with the write
tool: a whole-file regeneration reconstructs the document from what you still
hold in context, and measured across this project's repairs, every whole-file
rewrite lost content — one shed 1,863 characters and the next 4,125.

Snapshot before you start (`cp manuscript-section.md manuscript-section.pre-edit.md`),
and delete the snapshot once the verification below is clean — it is not a
deliverable. That filename is fixed and the contract checks it: shipped, it
arrives as a second copy of the section that a reader cannot tell from the real
one, and you will be told so rather than left to remember.

---

## Before delivering: two fixed steps

Both run on the finished section, in this order, every time. They are steps of
this capability, not options you weigh — a pass that happens only when you
remember it is a pass that happens on the easy runs and not the hard ones.

1. **`traceability-review`** — every `[n]` resolves to a ledger row, every claim
   marker resolves to `section-claims.json`, every number in the prose has a
   source in the artifacts, and every `supportQuote` is verbatim in the source
   it names. Repair what it finds before the next step.

2. **`manuscript-humanize`** — register cleanup over the prose, and the last
   thing that touches the document. Load it and follow it; do not re-implement
   what it says. Its whole contract is that **quotations, numbers, citation
   indices, claim markers, 〔推导〕 marks and headings come out byte-identical**,
   so the section that passed still matches its sources afterwards.

   Read the section with fresh eyes before editing: **the reviewer is never the
   writer.** Read the whole document first — a pass that rewrites paragraph by
   paragraph produces uniform paragraphs, which is the defect it was there to
   remove. Then prove only prose moved:

```bash
python "manuscript-humanize/scripts/verify_preserved.py" \
  --before manuscript-section.pre-edit.md \
  --after manuscript-section.md \
  --matrix section-claims.json
```

   A non-empty report means an edit broke a quotation, a numeral, a citation
   index, a claim marker, `〔推导〕`, or a heading. Fix it and rerun.

Then write what changed and why to `revision-notes.md`.

## Then submit

```
evimed_submit_deliverable{deliverableId: "<your deliverable id>"}
```

It answers with the verdict, in place. A first submission that comes back with
issues is the normal case: fix everything listed as 必修, submit again, repeat
until `ok`. The rules it applies are the same ones the server applies afterwards.

Its advisory findings are about the bindings a reader cannot reconstruct for
themselves — a citation with no ledger row, a claim marker pointing at nothing,
a derived result that reads as a measurement, a revision note left standing in
the section. They do not decide the outcome. Shipping with one still open is
choosing to hand the reviewer the sentence you could not account for.

## What this capability does not do

- **It does not assemble a manuscript.** One section, one deliverable. Four
  sections are four runs, and they stay consistent because each reads the
  others as context.
- **It does not do the evidence review.** A question with no source set behind
  it belongs to `clinical-evidence-synthesis`, and the section is written from
  what that produced.
- **It does not decide the study.** Design, analysis and their defence come from
  the researcher; where the draft asserts something the sources do not support,
  say so in `revision-notes.md` rather than writing around it.
