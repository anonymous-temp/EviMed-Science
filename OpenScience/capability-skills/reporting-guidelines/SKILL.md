---
name: reporting-guidelines
description: Complete the reporting checklist of the one study a deliverable reports or designs — every item of its reporting guideline, and where the deliverable reports it — as a journal asks its authors to submit. Applies when the plan declared the deliverable's study type and that type has a guideline.
---

# Reporting checklist

A journal asks the authors of a trial for the completed CONSORT checklist, of a
prediction model for TRIPOD+AI, of a systematic review for PRISMA: every item,
and where it is reported. A deliverable carries the same thing when its plan
declared the study type and that type has a guideline — `reporting-checklist.md`,
in the deliverable's own directory. The delegation message (or the plan's own
answer) names the guideline and its item table.

## The item tables

The guidelines' own published checklists, item numbers and wording as printed,
one file each in `checklists/` beside this skill:

| Study type | Guideline | Table |
| --- | --- | --- |
| rct | CONSORT 2025 | `checklists/consort-2025.md` |
| prediction-model | TRIPOD+AI | `checklists/tripod-ai.md` |
| systematic-review | PRISMA 2020 | `checklists/prisma-2020.md` |
| mendelian-randomization | STROBE-MR | `checklists/strobe-mr.md` |

Copy the whole table into `reporting-checklist.md`, under a first line naming
the guideline and its citation, and fill in 报告位置 for every row. Do not
translate, merge, renumber or drop a row: an item a reader cannot find by its
number is one they cannot check.

## Filling in 报告位置

- **Reported** — the heading the item is reported under, as it reads in the
  deliverable (资料与方法 › 随机化); where the package has several documents,
  which one as well (研究方案 › 样本量). Precise enough to be found without
  searching.
- **Not reported** — 「未报告：原因」, and the reason is the useful part:
  - one section reports only its own part — 「未报告：属于结果部分」;
  - a protocol or a proposal reports a design, not results — 「未报告：方案阶段，结果待试验完成后报告」;
  - the item does not apply to this study — 「未报告：不适用（单中心试验）」;
  - the sources do not have it — 「未报告：资料未提供，需补充……」.

## What the checklist may not do

- **Claim what the text does not say.** An item marked as reported has to be
  there, at the heading given. The independent reviewer reads the checklist
  against the text, and a row that points at nothing is a finding against the
  package.
- **Stand in for the text.** A row does not report an item. If the item belongs
  in this deliverable, write it into the deliverable and point the row at it.
- **Carry process.** No tool names, file paths or retrieval narrative — the same
  rule as the report itself.

Say in `delivery-summary.md`, in one line, which guideline the checklist
follows.
