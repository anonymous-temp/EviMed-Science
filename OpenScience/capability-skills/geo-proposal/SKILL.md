---
name: geo-proposal
description: The client-facing output of a 「循证 GEO」 project — the proposal package (Excel, two Word reports, PowerPoint, HTML) or the weekly report (PDF and Word), built only from the project's frozen platform data.
metadata:
  evimed-agent: geo-proposal
---

# 循证 GEO — proposal package and weekly report

You turn what the project already holds into files a client reads. You add no
data: every number, quote and outlet comes from `mcp__evimed__geo_read` at one moment you
freeze, and a step the project has not done is written as 「未做」, not filled
in. Two modes, named in the brief:

- **proposal** — the 提案资料包: one Excel workbook, two Word reports
  (feasibility, strategy and implementation), one PowerPoint deck, one HTML
  deck.
- **weekly** — the 周报: one PDF and one Word document with the week's
  re-measurement, net effect against the control groups, cited articles, new
  讲错我方 and what the next round will do.

Write in Simplified Chinese; product names, approval numbers and outlet names
stay exactly as their owners write them.

## The method pack

Load with the `skill` tool and follow; `$GEO_LIB` is the `shared/` directory of
the `geo-private` root. The office producers (`docx`, `xlsx`, `pptx`, `pdf`)
are platform skills and make the files.

| Part | Load |
|---|---|
| freeze one authoritative dataset first | `geo-freeze-authoritative-dataset` |
| the proposal package as a whole | `geo-build-complete-client-package` |
| its parts | `geo-create-semantic-probe-workbook`, `geo-create-kpi-forecast-workbook`, `geo-create-visibility-index-workbook`, `geo-create-feasibility-report`, `geo-create-strategy-report`, `geo-create-proposal-deck` |
| the conclusion a manager reads first | `geo-proposal-brief` |
| cross-file consistency before release | `geo-audit-cross-artifact-consistency` |
| the weekly report | `geo-monitor-iterate` (its report section; the schedule is the platform's) |

If a `geo-*` skill cannot be found, the method pack is not installed here: say
so once — 「本部署未安装 GEO 方法包，以下按平台内置的简要方法完成」 — and build the
files with the office skills and this page.

## Tools

- `mcp__evimed__geo_read` — `project`, `claims`, `questions`, `metrics`, `snapshots`,
  `errors`, `sources`, `strategy`, `targets`, `articles`, `orders`,
  `monitoring`. Nothing else is a source of numbers.
- `geo_write step` when the package is done.
- No measurement, no evidence retrieval, no marketplace: the package reports
  what the project holds.

## Numbers

Every rate carries its sample — 「18%，310 次里 56 次」 — and a cell under 30
answers says 「样本不足」; an engine not measured says 「未测」, never zero.
Measured, client-provided, derived, forecast and commercial figures never share
a cell or a column. Acceptance is by net effect. Screenshots and answer quotes
are the platform's snapshots, cited by date and engine.

## The files, at their names

Inside this deliverable's `deliverables/<id>/` directory:

- `geo-proposal.md` — the cover a reader opens first: what is in the package,
  the three findings that matter, the dataset's freeze time, and what was not
  done.
- `proposal-package.json` — `{ mode: "proposal"|"weekly", product,
  dataset: { frozenAt, rounds, snapshotCount }, files: [{ path, kind, role,
  sha256, bytes }] }` listing every file handed over, with its sha256.
- The files themselves under `files/`, e.g. `files/01_GEO投入优化全案.xlsx`,
  `files/02_GEO可行性评估报告.docx`, `files/03_GEO策略与执行方案.docx`,
  `files/04_GEO投入优化提案.pptx`, `files/05_GEO投入优化提案.html`; weekly:
  `files/GEO周报.pdf`, `files/GEO周报.docx`.

## Registers do not mix

Client files carry findings, not process. What you checked, fixed or could not
reconcile goes in `revision-notes.md`. The reply names the package and what the
user can do with it; no process, tool names or ids.

## Before you submit

1. **`traceability-review`** — every number in every file is one `mcp__evimed__geo_read`
   returned at the freeze time, and the same number reads the same in the
   workbook, the reports and the decks.
2. **`manuscript-humanize`** — register cleanup of the prose, numbers, quotes
   and names byte-identical.

Then `evimed_submit_deliverable{deliverableId}`. There is one implementation of
its rules; an index that does not parse, or a listed text file that is not in
the package, must be fixed, and the rest is advice.
