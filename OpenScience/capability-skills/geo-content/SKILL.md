---
name: geo-content
description: Step 6 of a “循证 GEO” project — write layered articles (深度分析, 证据卡片, 科普稿件, 问答) and correction materials from the project's claim library, one work record per article, humanized with protected spans byte-identical, each bound to the question it answers.
metadata:
  evimed-agent: geo-content
---

# 循证 GEO — layered content

You run step 6, **内容**: articles an answering engine can quote correctly, all
written from the project's shared drug-value analysis, research and verified evidence
cards so the same finding keeps its meaning and limitations in every selected
format. Corrections address substantiated errors relevant to the batch.
The platform places what you write (step 7) and measures whether it gets cited
(step 8); you do neither.

Work and write in Simplified Chinese. Product names, approval numbers, doses,
label wording and source titles stay exactly as their sources write them.

## Drug value informs this work

Load `geo-drug-value` before planning this task. Read `geo_read value` and
`geo_read research`; use the shared analysis to choose questions, research,
strategy, content and interpretation. Preserve partial findings. Its guidance
replaces fixed clinical-field, stage, length and sample quotas in older methods.

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
so once — “本部署未安装 GEO 方法包，以下按平台内置的简要方法完成” — and write
with this page.

## The three layers, one evidence chain

The project's evidence is a chain of three layers, each only saying what the one
above says. The **academic** layer is the research the claim library came from.
The **clinical** layer is the project's evidence cards in its product zone — one
per key clinical question on the patient journey, every claim with its verbatim
quotation and a ✓ or ⚠ against its source; differences from a comparator belong
here, labelled by how they are known (head to head, anchored indirect, or only for
reference). The **popular** layer is yours: it explains the disease, the
treatment choices and the evidence to patients and families. It preserves the
source, scope and certainty of the finding it explains.

`geo_read cards` gives the cards: each claim with its id, its quotation, its mark
and `reference`, the text to write after a sentence that stands on that claim. Cite
only claims marked ✓ as verified card claims. When a popular, question-and-answer
or correction sentence rests on such a claim, end it with that exact `reference`
(the platform removes markers before publication and checks the named revision). A number in a
sentence is that claim's number; benefit and risk are absolute figures over one
common denominator, never only 「明显」 or 「大幅」; no patient story stands as
evidence. The 证据卡片 layer is not written by you: the platform renders it from
the card. `mcp__evimed__frontier_search` shows what has been said about the product lately; a
retraction or correction of a source is a reason to read it again before you cite.

A missing card, claim-library entry or question group is not a reason to stop the
batch. Continue a useful draft from the preserved research or source text that is
available, naming its origin and uncertainty; keep an unresolved subgroup or
calculation as a local limitation. Qualitative observations can be explained
without a fabricated number, quotation or verified-card marker. A summary is not
its source's verbatim quotation. If registration needs a question group, create a
minimal group for the actual question, without presenting an inferred question as
observed demand. Write the article before registering its path. Existing source,
safety and publication checks still apply to the resulting draft; a partial draft
does not become verified or authorized for distribution by being written.
For example, low-certainty effectiveness findings without cards still support an
explicitly uncertain draft now, rather than waiting for cards to arrive. If file
tools are unavailable, put that useful draft in the answer and do not register a
file path: a registration tool cannot create the article bytes.

## What goes into a batch

Read before writing: `geo_read cards` first, then `strategy` (battlefield first), `targets`,
`questions` (the group and its typical question), `claims`, `errors` (open
讲错我方 with their trace), `articles` (what exists — never rewrite a published
article, write the next one). A batch is at most five articles unless the brief
says otherwise: battlefield groups first, then correction materials for open
讲错我方. Existing drafts the user brings in ("优化这几篇") start at the medical
review and go through the same steps.

The layers (the platform's ids in brackets):

| Layer | For | Must carry |
|---|---|---|
| 深度分析 (`deep`) | physicians | a comparison with relevant outcomes, timeframe and limitations; a GRADE profile only when available |
| 证据卡片 (`card`) | everyone; engines extract it | made by the platform from the product-zone card (the seven panels and a fact box computed from the card's events and denominators); you do not write or register it |
| 科普稿件 (`popular`) | patients, families | one typical question per article, conclusion first, readable at middle-school level, certainty words 会 / 很可能 / 可能 / 目前尚不清楚 |
| 问答 (`qa`) | search and community users | the first sentence answers; length suited to the question; certainty and sources, absolute numbers only when supported |
| 纠错材料 (`correction`) | the outlet or editor that carries the error | what was said, what the label says, the source, the requested fix |

Choose formats for the audience; an article does not require another layer to
exist first. Keep shared findings consistent across formats. Public layers stay
inside the label and carry no purchase link; a prescription medicine's product
content goes to professional channels only.

A correction corrects only what a source you read states differently. A figure
you cannot find in the source you could read — often only the abstract — is
「本项目可核验来源查不到」, not wrong: call an engine's statement wrong only when
the source states a different value for the same estimand, time point, dose and
population, and name the estimand (treatment-policy or efficacy) whenever a
trial reports both. A correction never says 「不是 X」 on abstract-level evidence.

GEO structure (the method pack's mechanics): the title is the question; the
conclusion sits in the first 80–150 characters; paragraphs stand alone; use statistics and direct quotations only when they help answer the question;
source-backed qualitative explanations are useful too; one
spelling of the product everywhere; actual authors and medical reviewers visible when provided; never invent identities.

## Channel formats

An article whose `channel` is an owned platform takes that platform's shape
(the ids are the project's owned-link platform ids). The evidence rules above do
not move with the channel: the title is still the question, the conclusion and its
certainty word still come first, and every number keeps its source. The title and
length limits are the platforms' own; the rest is how their readers read.

| Channel | Title and length | Structure | Images |
|---|---|---|---|
| `wechat_mp` 微信公众号 | title ≤ 64 字, 摘要 ≤ 120 字 stating the conclusion; deep 2,000–5,000 字, popular 1,500–2,500 字 | H2/H3 headings; bold only the conclusion and key numbers; references with links at the end | cover 900×383 (2.35:1); body figures 900 px wide, each captioned with its source |
| `zhihu` 知乎 | answer or article; deep 2,000–5,000 字, a popular answer 800–2,000 字 | the first paragraph answers; plain headings and numbered lists, no emoji; numbers cited where they stand | figures only where they carry data |
| `xiaohongshu` 小红书 | title ≤ 20 字; body ≤ 1,000 字 (300–800 reads best); at most 10 topic tags | one point per line, paragraphs of two or three lines | 3–6 cards at 3:4 (1080×1440): the question and the conclusion first, then one claim per card with its number and source |
| `toutiao` 头条号 | title ≤ 30 字; article 1,500–3,000 字, or a 微头条 under 300 字 for one question | the answer in the first three lines; paragraphs of two or three sentences | 16:9 cover, 1–3 figures |
| `bilibili` 专栏 | 2,000–5,000 字 | Markdown headings, tables and formulas; formal citations | data figures |

A title is the reader's question, never a hook formula: no 最 / 第一 / 唯一, no
exclamation or emoji bait, no promise of effect, no 种草 of a medicine, no
purchase or contact guidance on any platform. Publishing stays a person's act in
the platform's own backend, and the AI-generated label the 标识办法 requires is
kept wherever the platform shows it.

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

- `mcp__evimed__geo_read`, `geo_write articles` and `geo_write step`. Register each article
  with `deliverableId` (this deliverable's id — the name of its `deliverables/<id>/` folder; the
  platform finds the file and its verdict by it), `path` (`articles/<id>.md`), `layer`, `title`,
  `groupId` (the id of the question group it
  answers, from `geo_read questions` — required for every layer but `correction`), `claimIds`
  (ids from `geo_read claims`), `contentSha256` (of the file as written) and `safety`
  (`clear` or `open`). A correction also carries `errorIds`: the ids (from
  `geo_read errors`) of the 讲错我方 it corrects — registering it attaches it to
  them and moves them to 处置中; the platform closes them only when a later
  measurement no longer hears them. Do not send a gate verdict: the platform takes it from this
  deliverable's own submission, and only a person clears an `open` safety finding.
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
   traces to its preserved source. Sentences based on a verified card retain its
   exact `reference` and numbers. A draft based on other available research names
   that origin and its uncertainty without inventing a card, source or quotation.
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
