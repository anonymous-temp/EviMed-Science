---
name: research-grant-development
description: Turn a funding call and a research direction into specific aims, a proposal outline, a milestone table and a reviewer-oriented audit, with every stated call requirement quoted from the call itself.
metadata:
  evimed-agent: research-grant-development
---

# Research grant development

Use this when someone has a funding call and a direction, and needs the
proposal's skeleton: aims, approach, milestones, and an honest self-audit
against the review criteria.

Unless asked otherwise, work and write in Simplified Chinese. Keep the funder's
own terms, mechanism codes, deadlines and criterion names in their original
form — a translated criterion name is one a reviewer cannot find.

---

## Read the call before writing anything

**The first deliverable is the requirement list, not the aims.** Extract from
the call itself: funder, mechanism, scope, eligibility, page limits, review
criteria, deadline, budget rules, required attachments.

Each entry in `call-requirements.json` carries an `id`, what it requires, and a
`sourceQuote` — the words from the call it was read out of:

```json
{
  "requirements": [
    { "id": "R-01", "kind": "review-criterion", "requires": "创新性单独评分，占 30%",
      "sourceQuote": "评审指标：科学价值 30%、创新性 30%、可行性 25%、团队 15%" }
  ]
}
```

The quote is not bureaucracy. **A rule invented, half-remembered, or carried
over from a different call has no quote to give** — and that is the single most
common way a proposal is built against requirements the funder never stated.
If you cannot find the words, say the call is silent on it and proceed on a
stated assumption. Do not supply the rule from another programme.

## Then the aims

One sentence for the problem. An evidence-backed gap. A central premise. An
overall objective. Two to four aims, each with:

hypothesis or objective · rationale · design · measurable outcome · success
criterion · alternative strategy · contribution

**Each aim must still be worth doing if another aim fails**, unless the
mechanism explicitly funds a sequential programme. An aim that only makes sense
after Aim 1 succeeds turns one risk into the whole proposal's risk, and a
reviewer will say so.

## Approach, and the three things not to invent

Population, data, methods, sample-size rationale, reproducibility, ethics,
personnel, dependencies, risk controls. Budget and timeline follow the actual
work.

Three things are never invented, and each is what an experienced reviewer probes
first:

- **Preliminary results you do not have.** State what is preliminary, what is
  published, and what is proposed.
- **Institutional resources you have not confirmed.** A core facility, a cohort,
  a device, a collaborator's commitment.
- **A funding rule from another call.** See above.

Where one of these is genuinely unknown, write the assumption into the audit and
carry it as an open risk. **An unresolved feasibility risk that survives into
the audit is worth more than one that quietly disappears** — the second is the
version that surfaces during review instead.

## milestones.csv

Columns `milestone,date,outcome,owner`, one row per milestone. A milestone with
no date is a plan item; one with no measurable outcome is a wish. Both are
rejected.

## grant-audit.md

Map **every** requirement id from `call-requirements.json` to where the proposal
answers it. Name the id literally — the contract checks coverage by id, and it
checks it because an audit that covers the three easy criteria reads exactly
like one that covers all nine.

Where a requirement is unmet, say so and say what would meet it. An audit is
useful in proportion to what it admits.

---

## Before delivering: two fixed steps

Both run on the finished package, in this order, every time. They are steps of
this capability, not options the run weighs — a pass that happens only when the
model remembers it is a pass that happens on the easy runs and not the hard ones.

1. **`traceability-review`** — every citation resolves, every number in prose has
   a source in the artifacts, and every requirement quote matches the call text.
   Repair findings before the next step.
2. **`manuscript-humanize`** — register cleanup over the prose, with every
   quotation, number, citation index and claim marker byte-identical. It is the
   last thing that touches the document.

Write what changed and why to `revision-notes.md` in this deliverable's
directory — revision notes, replies to a rejection, and process description all
live there, and the proposal itself carries none of them.

## Then submit

```
evimed_submit_deliverable{deliverableId: "<your deliverable id>"}
```

It answers with the verdict, in place. A first submission that comes back with
issues is the normal case: fix everything listed as 必修, submit again, repeat
until `ok`. The rules it applies are the same ones the server applies afterwards.

The advisory issues are about the two things a reviewer cannot recover for
themselves: a requirement with no quote, and a requirement the audit skipped.
They do not decide the outcome. Shipping with either still standing is choosing
not to defend the part of the proposal that gets read first.
