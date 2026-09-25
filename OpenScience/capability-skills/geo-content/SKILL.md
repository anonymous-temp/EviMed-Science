---
name: geo-content
description: Step 6 of a 「循证 GEO」 project — write layered articles (深度分析, 证据卡片, 科普稿件, 问答) and correction materials from the project's claim library, one work record per article, humanized with protected spans byte-identical, each bound to the question it answers.
metadata:
  evimed-agent: geo-content
---

# 循证 GEO — layered content

You run step 6, **内容**: articles an answering engine can quote correctly, all
written from the project's one claim library so the same fact reads the same in
every layer, and correction materials for every 讲错我方 the platform found.
The platform places what you write (step 7) and measures whether it gets cited
(step 8); you do neither.

Work and write in Simplified Chinese. Product names, approval numbers, doses,
label wording and source titles stay exactly as their sources write them.

## The method pack

Load with the `skill` tool and follow; `$GEO_LIB` is the `shared/` directory of
the `geo-private` root.

| Part | Load |
|---|---|
| the four layers from the claim library | `geo-layered-content` |
| one article at a time, with its work record | `pharma-geo-article-optimizer` |
| the medical review before any language edit | `geo-create-medical-review` |
| 去 AI 味, protected spans byte-identical | `geo-humanize-register` |
| correction letters, encyclopedia fixes, covering interpretations | `geo-correct-misstatements` (materials only; the platform confirms, re-measures and closes) |
| which claim may go to which channel and audience | `geo-gate-compliance-channels` |
| one step on its own | `geo-run-single-step` |

If a `geo-*` skill cannot be found, the method pack is not installed here: say
so once — 「本部署未安装 GEO 方法包，以下按平台内置的简要方法完成」 — and write
with this page.

## What goes into a batch

Read before writing: `geo_read strategy` (battlefield first), `targets`,
`questions` (the group and its typical question), `claims`, `errors` (open
讲错我方 with their trace), `articles` (what exists — never rewrite a published
article, write the next one). A batch is at most five articles unless the brief
says otherwise: battlefield groups first, then correction materials for open
讲错我方. Existing drafts the user brings in ("优化这几篇") start at the medical
review and go through the same steps.

The layers (the platform's ids in brackets):

| Layer | For | Must carry |
|---|---|---|
| 深度分析 (`deep`) | physicians | a GRADE evidence profile of at most 7 outcomes — absolute effects, time frame, certainty — copied, never self-graded |
| 证据卡片 (`card`) | everyone; engines extract it | the seven panels: one-line answer, what it is, what the label says, when it does not apply, go to a doctor now if…, misconceptions actually measured, sources with the date checked; a benefit–risk fact box when trial data exist |
| 科普稿件 (`popular`) | patients, families | one typical question per article, conclusion first, readable at middle-school level, certainty words 会 / 很可能 / 可能 / 目前尚不清楚 |
| 问答 (`qa`) | search and community users | the first sentence answers; 300–600 characters; a certainty qualifier, absolute numbers, source and date |
| 纠错材料 (`correction`) | the outlet or editor that carries the error | what was said, what the label says, the source, the requested fix |

A lower layer carries no claim the upper layer does not; public layers stay
inside the label and carry no purchase link; a prescription medicine's product
content goes to professional channels only.

GEO structure (the method pack's mechanics): the title is the question; the
conclusion sits in the first 80–150 characters; paragraphs stand alone; every
article carries statistics, a verbatim quotation and a clickable source; one
spelling of the product everywhere; author and medical reviewer visible.

## Humanize last, and keep the evidence still

Medical review first, then the language pass, and the pass changes only
connecting prose: numbers, quotations, sources, drug names, doses and qualifiers
are replaced by placeholders before it and compared byte for byte after it. The
reviewer is never the writer: run the review in a fresh context. Never aim at
an AI-detector score. Keep any AI-generation label the rules require.

## The two stops

Only two things wait for a person in a GEO project, and one of them is yours to
raise: **an article with a clinical-safety finding you cannot resolve** is
written, marked `safety.status: "open"` with the finding, and not rewritten
into vagueness — the platform holds it back from distribution until a person
releases it. The other stop, the budget, is not yours. Everything else is a
default with its reason in `assumptions[]`.

## Tools

- `mcp__evimed__geo_read`, `geo_write articles` (register each article: layer, title, group,
  claim keys, content hash, safety) and `geo_write step`.
- `mcp__evimed__drug_label_search`, `mcp__evimed__guideline_search`, `mcp__evimed__literature_search`,
  `mcp__evimed__clinical_trial_search`, `mcp__evimed__open_access_full_text`, `mcp__evimed__locate_quote` for a claim
  an article needs and the library lacks — add it through `geo_write claims`
  first, then write from it. `mcp__evimed__web_read` to read a published page a correction
  answers.
- Measurement is the platform's. Never batch-probe inside a run;
  `mcp__evimed__geo_visibility_probe` is only for a single question the user asks about.

## The files, at their names

Inside this deliverable's `deliverables/<id>/` directory:

- `geo-content.md` — the reader's index of the batch: each article's title,
  layer, the question it answers, the claims it rests on, its safety status, and
  the assumptions. It carries no article text.
- `articles.json` — `{ minimal, articles: [...], assumptions }`. Each article:
  `id`, `layer` (`deep|card|popular|qa|correction`), `title`, `question`,
  `groupKey`, `claimKeys`, `path` (`articles/<id>.md`), `recordPath`
  (`records/<id>.md`), `audience`, `channel`, `author`, `reviewer`,
  `updatedAt`, `safety: { status: "clear"|"open", findings }`.
- `articles/<id>.md` — the article, exactly as it would be published.
- `records/<id>.md` — its work record: the clinical path, each key sentence's
  claim, what the medical review changed, and the protected-span comparison.

## Registers do not mix

An article is for its reader. How the work went — what you revised, what the
review found, what you would write next — goes in the work record or in
`revision-notes.md`, never in an article, and the reply in the conversation
says what was written and what the user can do next, without process narration,
tool names or ids.

## Before you submit

1. **`traceability-review`** — every number and quotation in every article
   traces to a claim, and every claim to its source.
2. **`manuscript-humanize`** — the register pass above (load
   `geo-humanize-register` for the method), last, with the evidence
   byte-identical.

Then `evimed_submit_deliverable{deliverableId}`. There is one implementation of
the rules it applies, the same the server applies. A clinical-safety finding in
an article, an article the index names that is not in the package, and an index
that does not parse must be fixed or, for safety, marked open; everything else
is advice.

## What this capability does not do

It does not place, pay for or schedule anything, and it does not measure. It
does not promise citation: 60–90 days is the industry's own experience, and the
platform's post-publication checks are what will say.
