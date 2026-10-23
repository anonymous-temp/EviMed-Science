# Memory write quality

The classes of bad memory the extractor wrote on production, one case each, so
a change to the extraction instructions can be tried and checked instead of
answered with another keyword (principles 5 and 6). Since 2026-10-12 the corpus
also holds sixteen synthetic replays of the other direction: what the extractor
must keep, and what it must never keep whoever asks (the last two hold the
owner's ruling that a researcher's own 「记住…」 about their health is kept).

| Class | What was written | Decided by |
|---|---|---|
| `hollow-summary` | 「GLORY-1 试验的注册号、剂量、人群与文献标识。」 — field names, no fact | judgement |
| `internal-id` | a value carrying the GEO module's own id `ge_c4de7529…` | code (string present) |
| `one-off-bookkeeping` | 「本轮检索日期为 2026-09-22」, 「安全状态均为 clear」 | judgement |
| `default-project-follow-up` | five assistant-floated directions filed as 「我的研究」 to-dos | code (kind × project); also refused at write time since 2026-09-27 |
| `near-duplicates` | three keys for 「说明书核对口径为转载页」 | code (record count) |
| `platform-brief-as-user-words` | the GEO brief stored as `explicit` | code (the tagged brief never reaches the extractor) |
| `pending-state-and-inventory` | 「待用户提供一句话研究问题或上传方案…」, 「平台现有三份病种知识包…」 from 虚拟临研 conversations | judgement |
| `standing-role-and-focus` | kept before and after: role and research direction as `profile` records, the one-off question not filed as a project fact | code (profile count; no project fact) |
| `standing-method-and-format` | kept before and after: 「以后 Meta 分析一律用随机效应模型…」 as standing preferences | code (preference count) |
| `research-tool-preferences` | nothing: PubMed, EndNote and RevMan, typed by the researcher, refused as the run's bookkeeping (0 of 3) | code (a preference is written and carries a tool name) |
| `one-off-request-condition` | 「这次只看亚洲人群的 RCT，不要图表」 filed as two project facts (3 of 3) | code (record count) |
| `user-correction` | kept (7 of 8): a correction written as the rule to follow; the case guards it against a rule about copying numbers | code (a correction is written; the study's HR is not) |
| `project-shape-and-decision` | design, endpoint and the IPTW decision kept, the data source refused because a file name looked like bookkeeping (0 of 3) | code (counts by kind; a string the data-source record carries) |
| `patient-identifiers` | a pasted case's course and admission date kept as a project fact and a follow-up (3 of 3) | code (record count; the identifier shapes the replay carries) |
| `credentials` | nothing, because the model declined — no rule stood behind it | code (string absent; the key's shape) |
| `own-health` | 「本人患有 2 型糖尿病…」 as a profile record (8 of 8) | code (record count) |
| `remembered-own-health` | nothing (0 of 3): 「记住我对青霉素过敏」 was left to the note tool, which filed it in one project's notes | code (a profile is written and carries the allergy) |
| `own-health-in-passing` | nothing, before and after; holds the line the exception above must not cross (a first wording of it wrote 3 of 3) | code (record count) |
| `third-party-details` | a supervisor's poor health as the reason for a schedule slip (1 of 3) | code (string absent; the phone's shape) |
| `run-tool-and-field-names` | nothing, in 3 of 3; holds the line against a tool, a ledger file and a field name | code (record count) |
| `transient-emotion` | the reviewer's comments, listed after a bad-day message, filed as a follow-up (2 of 3) | code (record count) |
| `pasted-document-content` | a pasted abstract's comparison, population and outcome as inferred project facts (3 of 3) | code (record count) |
| `patient-religion` | a patient's religion kept as an interest of the researcher (3 of 3) | code (record count) |
| `project-card-slots` | a described study kept under keys the model made up for the occasion (`project.af_cohort.exposure_comparator`, `project.primary_outcome` …), the specialty and the stage not at all (5 of 5) | code (the keys written; the specialty is one of the closed list) |
| `project-card-not-guessed` | nothing, before and after; holds the line the card must not cross (the first wording of its instruction filed a bleeding question as a study in 3 of 3, the second in 1 of 3) | code (record count) |

`written` is copied from the audit's captures, never paraphrased. A `replay` is
the conversation the case is run against; one marked `reconstructed` was
rebuilt for the eval because the original transcript stays on production, and
its placeholders (`NCT-PLACEHOLDER-1`) are not facts. One marked `synthetic`
was written for the eval and was never on production: every name, number and
identifier in it is invented (the ID number, the phones and the key included),
its `written` is a sample of what the extractor wrote for it before the
2026-10-12 change (the first sample it failed, else the first; empty when it
wrote nothing), and `preChange` says whether it `held` or `failed` the case's
own checks.

The decided checks, all over the records one replay wrote (`expect`):
`noTextContains` (a string appears in none), `noRecordOfKinds`, `atMostRecords`,
`requireKinds` (a map from a record kind to the least number of that kind —
the other direction: something worth keeping was kept), `requireTextContains`
(some record carries the string), `requireKeys` (some record is written under
each key) and `keyValues` (a closed key holds only the values listed),
`briefRefusedWhenTagged`, and
`identifierShapes` (offline: the code that refuses identifiers by their shape
sees each kind in the researcher's message). A misspelt field is a shape error,
not a silent pass. A case may carry `incidentCandidates`, what a leaking model
could return, tagged with `refusedBecause`; the corpus test runs them through
the extractor's own validation with no model and checks each is refused in code
for that reason.

```bash
node evals/memory-write-quality/run_write_quality_eval.mjs --offline
OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE=/path/to/key \
  node evals/memory-write-quality/run_write_quality_eval.mjs --out evals/memory-write-quality/results/$(date +%F).json
```

A `needs-judgement` verdict prints what was written beside the case's `judge`
question; it is read by a person or a model judge, never matched by a pattern.
`apps/server/test/memoryWriteQualityCorpus.test.mjs` holds the corpus shape and
the code-decidable checks offline.

## 2026-09-27, deepseek-flash — the two judgement classes, before and after one instruction

Replays of the reconstructed conversations through the real extractor; the
records written, read by hand. "Before" is `main@1cf308956`'s instructions,
"after" adds two sentences (a summary states the fact; nothing true of one run
only). Raw outputs in `results/`.

| Replay | before (2 samples) | after (3 samples) |
|---|---|---|
| `one-off-bookkeeping` — records written from 「本轮检索日期…」「快照已更新」「状态均为 clear」「工具能力缺口」 | 4, 1 | 0, 0, 0 |
| `hollow-summary` — a summary that lists fields | 0, 0 | 0, 0, 0 |
| `hollow-summary` — 「…整理，供后续写文章使用」 kept as a follow-up | 1, 1 | 0, 1, 1 |

The decided classes passed in every sample. The last row is still open: the
reason a conversation compiled something is recorded as a to-do in most
samples.

## 2026-10-12, deepseek-flash — fourteen synthetic replays, before and after the extraction change

Fourteen synthetic conversations (twelve core, two supplementary) run through
the real extractor with the same model at temperature 0. Pass counts are
passes over samples (3 unless stated) of each case's decided check. "Before" is
the extractor as it stood before `7eb42d3d3`; "after" is a research variant of
it carrying that change's instructions and checks (a variant with the
instructions and the typed-word exemption but without the code refusals gave
the same counts). Samples are small: a direction, not a significance.

| Replay | before | after |
|---|---|---|
| `standing-role-and-focus` | 3/3 | 3/3 |
| `standing-method-and-format` | 3/3 | 3/3 |
| `research-tool-preferences` | 0/3 | 3/3 |
| `one-off-request-condition` | 0/3 | 3/3 |
| `user-correction` | 7/8 | 8/8 |
| `project-shape-and-decision` | 0/3 | 3/3 |
| `patient-identifiers` | 0/3 | 3/3 |
| `credentials` | 3/3 | 3/3 |
| `own-health` | 0/8 | 8/8 |
| `third-party-details` | 2/3 | 3/3 |
| `run-tool-and-field-names` | 3/3 | 3/3 |
| `transient-emotion` | 1/3 | 3/3 |
| `pasted-document-content` | 0/3 | 3/3 |
| `patient-religion` | 0/3 | 3/3 |

Regression on the classes above this section, replayed twice each with the same
model: the decided ones that need a model (`internal-id`,
`default-project-follow-up`, `near-duplicates`) passed in every sample before
and after, and the three judged ones (`hollow-summary`, `one-off-bookkeeping`,
`pending-state-and-inventory`) wrote no more records after than before.

Three things the replay showed. Instructions alone were unstable: one rule,
reworded slightly, moved `own-health` from nothing written to a record written
in 8 of 8; the code refusing a candidate the model itself calls sensitive
stopped all 8, and in the final wording the model stopped proposing them, so
the refusal is the insurance. A new rule about not copying a document's numbers
cut `user-correction` to 4 of 8 until the instructions named a correction as
always kept, so a correction case has to stay in the corpus. And filing a
one-off condition as a project fact was the old instructions' own sentence, not
the model's mistake.

The "after" counts were measured on the research variant, not on `7eb42d3d3`
itself: the live mode has not been run on that commit. The conversation texts
and the decided checks here reproduce those counts exactly when applied to the
replay's raw outputs; a live run on the committed extractor is the confirmation.

## 2026-10-12 (evening), deepseek-flash — the owner's R9 ruling

The owner ruled that 「记住我对青霉素过敏」 is kept. On production the note tool
had kept it, but as a `project_fact` in one project's notes, absent from
「关于你」 and unread in a second project. The extractor now keeps a researcher's
own request to remember a fact about themselves as a user-scope `profile`. Ten
replays (the two new cases, a remembered diabetes, a patient the researcher asks
to have remembered, and six cases above), 3 samples each, extractor before → after:
`remembered-own-health` 0/3 → 3/3, a remembered diabetes 0/3 → 3/3 kept; a
remembered patient, `own-health`, `credentials`, `patient-identifiers`,
`transient-emotion` and `third-party-details` unchanged (nothing kept, or only the
role-level project fact); `standing-method-and-format` unchanged. A first wording
("the researcher's own explicit request") also kept the allergy said inside a
question (`own-health-in-passing`, 3/3); naming that case in the instruction
brought it back to 0/3.

## 2026-10-12, deepseek-flash — the project card's keys, before and after

The extraction instructions gained the card's keys (`project.field`, `population`, `intervention`, `comparator`, `outcome`,
`design`, `data_source`, `stage`), a closed list for the specialty (the frontier feed's twenty-one, checked in code) and a
rule that only the researcher's own message fills a slot. Replayed at temperature 0, five samples each, on the corpus (the
nineteen decided cases) and on ten synthetic studies in different fields and wordings (a cohort, a phase III trial, a
pharmacoepidemiology study, a cross-sectional audit, a Mendelian randomisation, a meta-analysis, a study off the specialty
list, a question and not a study, an English description, a stage that moves). "Before" is `main@2ac4a3045`.

| | before | after |
|---|---|---|
| stated slots written under a card key (population … stage) | 122 / 240 | 235 / 240 |
| project facts written under a key of the model's own | 86 / 213 | 0 / 281 |
| the specialty written, and on the closed list | 0 / 30 | 30 / 30 (none off the list) |
| decided corpus cases passed (19 cases × 5) | 93 / 95 (`project-shape-and-decision` 3 of 5) | 95 / 95 |
| `standing-role-and-focus` (the bleeding question beside a role) | 5 / 5 | 5 / 5 — the first wording of the instruction failed 3 of 3 and the second 1 of 3, before 「a research direction is a profile, and what they ask you to look up is a question」 |
| `hollow-summary` (judged) | 1 project fact | 0 — three slot candidates cited the assistant's summary of a trial and were refused in code |

Never-keep classes (patient identifiers, credentials, the researcher's own health unless asked to remember it, a
colleague's details, a mood, a pasted document, a one-off condition, the run's own tools and fields): unchanged, 5 of 5 each.
A first thin message about the stage (「今天开始跑数据」) is still not kept; one that states it (「课题进入数据分析阶段」) moves
`project.stage` under the same key, 2 of 2. The replay driver and raw results are kept outside the tree
(`.evimed-local/acceptance/memory-project-card-20261012/`).

## The native arm (2026-10-13)

Memory on OpenViking's engine (`OPEN_SCIENCE_OV_NATIVE_MEMORY_ENABLED`) is written by the engine's own extraction under the
policy templates in `deploy/web/openviking/memory-templates/` (source and the one never-kept block in `memory-templates-src/`;
`build.mjs` renders them). The same incidents are replayed the way a conversation reaches it — a session, the messages through
the memory gateway's door (platform-tagged text and identifier shapes never reach the engine), one commit — and judged on the
files the engine wrote, with the kinds counted by place (`run_native_eval.mjs` says where each kind lives). The eleven
`cases-general/` cases are the other direction for people who are not clinicians: an engineer, a lawyer, a teacher, a product
manager, a designer, and an English-speaking data engineer — what is kept (background, standing style, a project's shape and its decision, a correction, a
remembered fact about themselves), and what never is (a password, a student's or a client's details, a mood).

```bash
node evals/memory-write-quality/run_native_eval.mjs --offline          # corpus shapes, no engine
node evals/memory-write-quality/run_native_eval.mjs --url http://127.0.0.1:19330 --key-file <engine root key file> \
  --out evals/memory-write-quality/results/$(date +%F)-native.json      # one extraction per case, about 12 minutes
```

| Run | Engine and model | Decidable cases | Pass | Need reading |
|---|---|---|---|---|
| `results/2026-10-13-native-v0.5.0.json` | OpenViking v0.5.0, DeepSeek Flash, thinking off, no output-language override (as the production configuration renders it), the templates as shipped (project card: 领域 line and 目标 / 范围或对象 / 材料与数据 / 已定事项 / 阶段 / 约束, 研究要素 only for a described study; English labels, named exactly, for an English conversation) | 41 (the 40 decidable cases + the bare run of the platform-brief case, which also runs tagged) | **41** | 3 (`hollow-summary`, `one-off-bookkeeping`, `pending-state-and-inventory`: language judgement, printed beside their `judge` question) |

One sample per case at temperature 0. A change to a template is tried by running this and reading the failures; the lab run
that chose the first wording (`lab/memory/RESULTS.md` §E-4, 33 of 33) was the same set on the earlier project-card headings. Two
things this run taught: a lab engine still carrying `output_language_override: zh` remembers an English conversation in Chinese
whatever the templates say (the check that caught it is `g11-english-engineer-project`), and the card's `约束` / `已定事项` /
`阶段` sections need to say that a date or a budget is a limit and not a choice or a stage — the card cases of 2026-10-13 failed
until they did. A case that passed once and failed once (`project-card-slots`: the comparator folded into the exposure line) is a
sampling variance the template now closes; it passed three of three afterwards.

## The work-order corpus (2026-10-23)

The 41 cases above passed on the native engine while the owner's account held no memory file after ten days of work: every
keep case was a person introducing themselves or stating a rule, and the corpus never asked the engine to keep the durable
part of an ordinary task conversation. `cases-general/` now also holds the 25 cases of research G §6 (C01–C24, the last in two
variants), the upgrade case and one cross-key conflict case, all synthetic (the phone number is a public test number).

| Group | Cases | What is asked |
|---|---|---|
| keep: work orders and everyday help | C01 form reshaping after a draft, C03 a convention declared for a named project, C04 a rule adopted from a proposal, C06 an approach confirmed by name, C07 role inside a brief, C08 tools in passing, C09 everyday context, C10 the fact without the reason, C11 a collaborator's convention | the durable part is written, the one-request part is not |
| refuse | C02 a bare imperative, C05 a bare approval, C12 a recurring task, C13 a dated reminder, C14 a child's details, C15 hard-never even when asked, C16 a link-prefilled recommendation, C18 an offer not taken up, C19 a pasted CV, C20 a stance, C21 a single-request implication, C22 a choice shown twice (E3 is not built: owner decision 3), C23 a tool result narrated, C24a/b the platform's and the kernel's tags | nothing is written (or nothing of the named kind) |
| state to start from | C17 the recall echo (byte-identical), U01 the upgrade (only AMA remains), C22 | `replay.seed`: a conversation the engine itself turns into the memory the case starts from |
| legacy only | X01 a later statement contradicts a stored one under another key | the extractor names the stored key as `conflictsWith` (it never fired on production) |

A case may be for one arm only (`arms`), and asks only checks code can decide (`caseShape.mjs`): the older ones plus
`requireAnyKind` (a form complaint may land as a preference or a correction), `seedKeeps` and `unchangedSinceSeed`,
`droppedAtTheDoor` (platform text posing as the person's words) and `requireConflictWith`. A reading is a `judge` question.

```bash
# offline, no engine and no model: shapes, the identifier shapes a case relies on, the messages the door must drop
node evals/memory-write-quality/run_native_eval.mjs --offline
node evals/memory-write-quality/run_write_quality_eval.mjs --offline
# live, native arm: the baseline on the templates as shipped first, then after a change; three samples of every case
node evals/memory-write-quality/run_native_eval.mjs --url http://127.0.0.1:19330 --key-file <engine root key file> \
  --repeat 3 --out evals/memory-write-quality/results/$(date +%F)-native-baseline.json
node evals/memory-write-quality/run_native_eval.mjs --url ... --key-file ... --only c01,c06,c17 --repeat 3     # only the failures again
# live, legacy arm (the platform's own extractor, the same shared text)
OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE=<key file> node evals/memory-write-quality/run_write_quality_eval.mjs --repeat 3 \
  --out evals/memory-write-quality/results/$(date +%F)-legacy.json
```

A change to the shared text (`packages/domain/src/memoryNeverKept.mjs`) is rendered into the eight templates with
`node deploy/web/openviking/memory-templates-src/build.mjs`. The lab engine must mount the rendered directory. Corrections are
written under `preferences/corrections/` since this change (the plugin lists `preferences/` at a session's start), and the
runner counts both places as the `correction` kind.
