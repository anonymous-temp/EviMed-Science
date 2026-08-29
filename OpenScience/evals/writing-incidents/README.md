# Writing incidents

A ledger of register and channel failures observed in real deliverables. One
incident, one case. Corpus only — there is no harness here yet, and adding one
before the corpus is large enough to argue with would be building the answer
before knowing the question.

## Why this exists rather than another pattern

Principle #5: no new open-vocabulary prose regex. Every register complaint that
used to become another word list in `clinicalEvidence.mjs` becomes a case here
instead. The file is frozen at 117 CJK-bearing patterns
(`packages/domain/test/vocabulary.test.mjs`), so this is the only place a new
observation can go.

Principle #6: every incident becomes an eval case, not a keyword. What makes a
general fix safe to attempt is a corpus that would catch it regressing.

## What counts as an incident

Three genres, from the text-output review:

- **Backstage prose in the front matter** — revision notes, replies to a
  rejection, retrieval diaries, version scars, or anything about the document
  rather than the evidence. These have a home now
  (`revision-notes.md`); an incident is one that reached the report anyway.
- **Register drift** — disclaimer voice, hedging that does not match the
  certainty grade, method tools named and never applied, addressing the reader.
- **Number–prose divergence** — a figure in prose with no source in the
  artifacts, or a number changed in one place and not in its dependents.

## Case shape

`cases/<id>.json`:

```json
{
  "id": "2026-08-27-rq03e-runtime-prose",
  "genre": "backstage-prose",
  "observedIn": "uploads/20260827-rq03e/deliverables/sxjw-longterm-evidence/clinical-evidence-report.md",
  "line": 172,
  "verbatim": "the offending sentence, copied exactly",
  "whyItIsWrong": "one sentence, in the terms a reviewer would use",
  "caughtBy": "gate | reviewer | nobody",
  "note": "what a fix would have to get right"
}
```

`verbatim` is copied, never paraphrased. A paraphrased case tests the
paraphrase. `caughtBy: "nobody"` is the most valuable kind — it is the reason
this ledger exists rather than a list of things the gate already reports.

## Adding one

Copy the sentence out of the artifact it appeared in, name the file after the
run and the genre, and stop there. No fix is required to file a case; a case
with no fix is an observation, and observations are what the corpus is for.
