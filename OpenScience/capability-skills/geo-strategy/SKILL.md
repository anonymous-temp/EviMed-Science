---
name: geo-strategy
description: Step 5 of a “循证 GEO” project — read the platform's measured answers into a source table, the seven answer-gap classes, what each engine can be expected to do this cycle, the battlefield, the source layout and three tiers of targets.
metadata:
  evimed-agent: geo-strategy
---

# 循证 GEO — sources, expectations, targets

You run step 5, **信源**: the platform has measured how five AI engines answer
the locked question set; you interpret it. What each engine cites, what a
correct answer should have said and did not, what this cycle can realistically
move on each engine, where to fight, which layer of sources each engine needs,
and three tiers of targets. You do not measure and you do not compute metrics:
every rate comes from `geo_read metrics` with its numerator, denominator and
snapshots; you read it, you never retype it into a new number.

Factual accuracy (M-06) is a hard line, not a tier: every tier's accuracy
target is 98 %, and traced 讲错我方 goes to zero; the tiers differ in mention,
share and placements. The platform refuses an accuracy target below 98 %.

First read `geo_read project` and `geo_read metrics`. If the project has no
finished baseline yet, do not invent measured performance or forecast tiers.
Continue supported clinical positioning and opportunity analysis in `geo_write
value`; the platform measures first before accepting a calibrated strategy or
targets. Existing qualitative work remains usable when measurements are absent.

Work and write in Simplified Chinese; keep product names, approval numbers and
outlet names exactly as their owners write them.

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
| sources, the three conditions, impostors, expected points and the seven gap classes, per-engine expectations | `geo-source-expectation` |
| battlefield and secondary opportunities | `geo-select-battlefield` |
| three tiers of targets against baseline, noise and cycle | `geo-calibrate-targets` |
| which metric is a target and how it is accepted | `geo-define-kpi-contract` |
| the numbers' definitions | `geo-visibility-forecast` (read its metric rules; do not run its probe steps) |
| one step on its own | `geo-run-single-step` |

If a `geo-*` skill cannot be found, the method pack is not installed here: say
so once — “本部署未安装 GEO 方法包，以下按平台内置的简要方法完成” — and continue
with this page.

## Tools

- `mcp__evimed__geo_read` — `project`, `claims`, `questions`, `metrics`, `snapshots`
  (answer text is truncated per item; ask by engine, pool or group), `errors`,
  `sources`, `targets`, `strategy`, `clusters` (each question group with what it is
  measured at, as k of n) and `actions` (what is being done for each gap, and what
  came of it). This is the only source of measured numbers.
- `mcp__evimed__geo_write` — `strategy` (battlefield, expectations, gaps, layout, and the
  source table as `sources`), `actions` (what to do for each gap, below), `targets`
  (three tiers; a target is a forecast or a commercial figure, never "measured"),
  `step`. A strategy write keeps every field it does not carry, so a later write of
  one field never empties the rest.
  Write in the platform's field names (the method's snake-case names are read
  too, but these are the ones the page shows):
  - each source: `domain`, `name`, `kind` (`news`, `vertical`, `wemedia`,
    `brand`, `government`, `encyclopedia`, `academic`, `qa`, `video`,
    `ecommerce`, `other`), `layer` (`anchor`, `coverage`, `owned`),
    `icpMatches`, `newsIndexed`, `medicalVertical` (true, false, or null when it
    could not be checked), `checkedAt` (the day you checked), `impostor`,
    `blacklistReason`;
  - each engine's expectation: `engine`, `promise` (what this cycle can
    promise, in a sentence), `layers` (which layers to place into),
    `leverage`;
  - `battlefield`: `{ id, name, why[], action, groups, secondary }`; `gaps`:
    `{ gapId, class, groupId, judgment, rank, consequence: { band, basis },
    evidence: { metric, errors[] }, expectedPoints: [{ pointId, kind,
    statement, refs: [{ type: "claim_id", id }] }], handoff, safetyPinned }` —
    `judgment` is what the answers should have said and did not, `rank` orders
    the gaps by consequence × question weight, `handoff` is where it goes next
    (`content`: an article answers it; `EC`: a correction of a traced 讲错我方
    error; `monitor_only`: nothing to write, the platform goes on measuring);
    `layout`: the method's `{ layers, byEngine, constraints, clientActions }`
    (`clientActions`: what the client has to do themselves, one sentence each);
    `noGo`: `[{ item, reason }]`.
  - targets: every tier carries a project-wide (`pool: "all"`) target for
    `M-19` (the index) and `M-01S` (mention over P2 and P3) — the two numbers
    the page states a target beside — besides the per-pool ones.
- The three conditions decide placement: the market only ever places into a
  site whose `icpMatches`, `newsIndexed` and `medicalVertical` are all true.
  Check **every** coverage-layer candidate (usually 10–20 sites), not a sample —
  a site left unchecked is never placed — and every site an 讲错我方 is traced
  to; the long tail may stop at its kind.
- `mcp__evimed__web_read`, `mcp__evimed__web_search` to check an outlet: who holds the ICP record, whether
  it is indexed as news, whether it is a medical vertical. An outlet displaying
  one name while hosted on another's domain is an impostor and goes on the
  blacklist with the date checked.
- `mcp__evimed__drug_label_search`, `mcp__evimed__guideline_search`, `mcp__evimed__literature_search` when an expected
  point needs a source the claim library does not yet hold.
- Measurement is the platform's. Never batch-probe inside a run.
  `mcp__evimed__geo_visibility_probe` is only for one question the user asks about in the
  conversation.

## What to do for each gap

Write `actions[]` with the strategy: one entry for each gap, or, where nothing is
to be written for it, `{ gapId, reason }` — a gap with neither is a gap nobody
answered, and the write says so. An action is `{ gapId, what: { layer, title,
channel }, engines[], sources: [{ domain, why }], promise, basis, reason,
metricId }`:

- `what.layer` is the article layer, `what.channel` where it is to be published:
  an owned platform's id (`wechat_mp`, `zhihu`, `xiaohongshu`, `toutiao`,
  `bilibili`, …) when the brand publishes it itself, `media_market` when it is
  to be placed in a professional outlet.
- `engines` are the engines the promise holds on; an engine that rarely
  searches the web is not one for a mention.
- `sources[].why` says why this source for this group — what the engines cite
  for it, or which layer of the layout it is.
- `promise` is one of `enter_mention`, `raise_mention`, `accuracy_to_target`,
  `coverage_complete`, `hold`; `basis` says what it rests on, in a sentence — a
  measured rate with its sample, a prior marked as a prior, or the method.
- `metricId` is one of the group's pool's metrics: P1 `M-06`, `M-03`; P2 `M-01`,
  `M-02`, `M-06`, `M-08`; P3 `M-01`, `M-08`; P4 `M-15`. The platform shows the
  measured baseline and the chosen tier's target for that pool itself: never
  type a target number into an action.

## What you decide without asking

The budget is the user's, and only the budget: the three tiers each carry a
placement count and a suggested budget, the default tier is 2, and the user sets
money once on the distribution page. Everything else is a default with a reason
in `assumptions[]` (`field`, `value`, `basis`, `reason`, `howToChange`).

Say what is promised honestly: an engine that rarely searches the web can be
promised accuracy, not mention; a group nobody mentions can be promised entry
into mention, not a rank; within twelve weeks only retrieval can move, and a
model's own knowledge moves with its training cycle. Accuracy ≥ 98% and zero
traceable 讲错我方 are hard lines in every tier. Acceptance is by net effect
(placed groups' change minus control groups' change).

**Single-step, minimal mode.** When the brief asks for this step alone and the
project has no measured question set, the platform first measures the available
useful questions. State the actual measured scope and set `"minimal": true`.
Write numeric targets only where supported; a useful strategy does not require
all tiers or a forecast for every metric.

## The files, at their names

Inside this deliverable's `deliverables/<id>/` directory:

- `geo-strategy.md` — the reader's report: the source table's main finding, the
  gaps that matter most (consequence × question weight), each engine's
  expectation and promise ceiling, the battlefield and why, the layout, and the
  three tiers with what each buys. Every rate carries its sample, “18%，310 次里
  56 次”; fewer than 30 answers is “样本不足”, an engine not measured is “未测”.
- `strategy.json` — `{ minimal, sources, gaps, actions, expectations,
  battlefield, secondary, layout, tiers, chosenTier, assumptions, noGo }`.
  `gaps[].class` is one of 缺证据、丢条件、过时、信源弱、只讲获益不讲安全、讲错、受众看不懂.
  `expectations[].retrieval` is a number cell (`value`, `numerator`,
  `denominator`, `dataType`) copied from `geo_read metrics`; a prior from
  published research is `dataType: "prior"` and never "measured". `tiers` are
  exactly `1`, `2`, `3`, each with `targets` (`metricId`, `pool`, `baseline`,
  `target`, `dataType: "forecast"`), `placements` and `budgetCny`.
  The platform reads this file again when the run ends, through the same checks as
  `mcp__evimed__geo_write`: give `gaps`, `actions`, `battlefield`, `sources` and `layout` the
  field names `mcp__evimed__geo_write` takes (above) — a name of your own is a field
  the page does not show. Numbers it holds itself — a cited-domain tally,
  retrieval cells, sample sizes, counts per source — stay in the report and the
  file; they are not stored a second time.

## Registers do not mix

What you revised and what you could not check goes in `revision-notes.md`. The
reply says what was decided and what the user can do next; no process, no tool
names, no ids.

## Before you submit

1. **`traceability-review`** — every rate in the report is one `geo_read
   metrics` returned, with its sample; every outlet verdict has its check date.
2. **`manuscript-humanize`** — register cleanup of `geo-strategy.md`, numbers,
   outlet names and quotes byte-identical.

Then `evimed_submit_deliverable{deliverableId}`. There is one implementation of
its rules. A number labelled measured without its denominator, or a target not
labelled forecast, must be fixed; the rest is advice.
