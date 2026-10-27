# Memory write quality

The classes of bad memory the platform's earlier extractor wrote on production, one case each, so
a change to the extraction instructions (today the engine's templates) can be tried and checked instead of
answered with another keyword (principles 5 and 6). Since 2026-10-12 the corpus
also holds sixteen synthetic replays of the other direction: what must be kept,
and what must never be kept whoever asks (the last two hold the
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

**A case held in a named project (2026-10-27).** Production writes one line of the platform's at the start of a conversation's memory
session when the conversation is held in a named project (`projectContextLine` in `@evimed/domain`: the engine was otherwise never told
which project it was in, and filed a rule for "this repository" as a preference that every conversation is handed). The native runner
replays that line for every case whose `replay.projectId` is not `default`, under the project's name (`replay.projectName`, else
`CASE_PROJECT_NAMES` in the runner); `--no-project-line` measures without it. Inside a named project a task line of 「最近在做」
(`recent_work`) is the feature, so a case of that context that keeps nothing else says `onlyKinds`, and `cardNoTextContains` reads the
project's card alone.

The decided checks, all over the records one replay wrote (`expect`):
`noTextContains` (a string appears in none), `noRecordOfKinds`, `atMostRecords`,
`requireKinds` (a map from a record kind to the least number of that kind —
the other direction: something worth keeping was kept), `requireTextContains`
(some record carries the string), `requireKeys` (some record is written under
each key) and `keyValues` (a closed key holds only the values listed),
`briefRefusedWhenTagged`, `onlyKinds` (every file written is of one of these kinds), `cardNoTextContains` (a string the project's card does not carry), and
`identifierShapes` (offline: the code that refuses identifiers by their shape
sees each kind in the researcher's message). A misspelt field is a shape error,
not a silent pass. (A case could also carry `incidentCandidates`, what a leaking model
could return, replayed through the deleted extractor's own validation; the field
is kept in the older case files as the record of the incident and nothing reads it.)

A `needs-judgement` verdict prints what was written beside the case's `judge`
question; it is read by a person or a model judge, never matched by a pattern.
`apps/server/test/memoryWriteQualityNativeArm.test.mjs` holds the corpus shape and
the code-decidable checks offline.

## History: the platform's own extractor (until 2026-10-25)

The corpus was first run through the platform's own extraction (`run_write_quality_eval.mjs`, the replay of each case through
`MemoryIntelligence`), which was deleted on 2026-10-25 with the rest of the legacy memory engine. Its measurements (the
2026-09-27 before/after of one instruction, the 2026-10-12 fourteen synthetic replays and the project card's keys, and the
R9 ruling on 「记住…」) are in this file's git history and `results/` of that date range; they describe an extractor that no
longer runs and are not a baseline for the engine. The cases themselves stay: they are what the engine's templates are held to
below. A case whose only subject was the old extractor (the cross-key conflict, `x01`) went with it.

## The native arm (2026-10-13)

Memory on OpenViking's engine is written by the engine's own extraction under the
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
| `results/2026-10-23-native-v0.5.1.1-shipped-templates.json` | OpenViking **v0.5.1.1**, the 2026-10-13 templates, the 41-case corpus | 41 | **41** | 3 |
| `results/2026-10-23-native-v0.5.1.1-new-corpus-shipped-templates.json` | v0.5.1.1, the 2026-10-13 templates, the corpus with the 27 cases of 2026-10-23 (work orders, everyday context, explicit-only, injection, recall echo) | 67 | 60 — the keep side of work orders fails as predicted (c01, c07, c09, c10, c12, c13) and the pasted CV is kept (c19) | 3 |
| `results/2026-10-23-native-v0.5.1.1-rewritten-templates.json` | v0.5.1.1, the rewritten never/decide blocks and templates of 2026-10-23 (after one tuning round: request conditions, health told to get help, a pasted CV and the assistant applying a memory write nothing; one deliverable is no project) | 67 | **67** | 3 |
| `results/2026-10-23-native-v0.5.1.1-rewritten-templates-repeat3.json` | the same, the sixteen cases closest to the line, three samples each | 51 | 47 — `c09` kept 两人份 as the household's (no longer judged), `c07` once wrote a project card for one deck (the card rule was tightened after it; three more samples then wrote no card, one of them also no profile line) | 0 |
| `results/2026-10-23-native-v0.5.1.1-final-templates.json` + `results/2026-10-24-native-v0.5.1.1-final-recheck.json` | v0.5.1.1, the templates as shipped on 2026-10-24 (after the request-condition, third-party-health and stated-inside-a-request rounds) | 67 | 65 — the two misses (a project card without its deadline line, one engine error) passed three of three on recheck | 3 |

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
variants), and the upgrade case, all synthetic (the phone number is a public test number).

| Group | Cases | What is asked |
|---|---|---|
| keep: work orders and everyday help | C01 form reshaping after a draft, C03 a convention declared for a named project, C04 a rule adopted from a proposal, C06 an approach confirmed by name, C07 role inside a brief, C08 tools in passing, C09 everyday context, C10 the fact without the reason, C11 a collaborator's convention | the durable part is written, the one-request part is not |
| refuse | C02 a bare imperative, C05 a bare approval, C12 a recurring task, C13 a dated reminder, C14 a child's details, C15 hard-never even when asked, C16 a link-prefilled recommendation, C18 an offer not taken up, C19 a pasted CV, C20 a stance, C21 a single-request implication, C23 a tool result narrated, C24a/b the platform's and the kernel's tags | nothing is written (or nothing of the named kind) |
| state to start from | C17 the recall echo (byte-identical), U01 the upgrade (only AMA remains), C22 and E3C (the repetition cases below) | `replay.seed`: a conversation the engine itself turns into the memory the case starts from |

A case asks only checks code can decide (`caseShape.mjs`): the older ones plus
`requireAnyKind` (a form complaint may land as a preference or a correction), `seedKeeps` and `unchangedSinceSeed`,
`droppedAtTheDoor` (platform text posing as the person's words). A reading is a `judge` question.

```bash
# offline, no engine and no model: shapes, the identifier shapes a case relies on, the messages the door must drop
node evals/memory-write-quality/run_native_eval.mjs --offline
# live: the baseline on the templates as shipped first, then after a change; three samples of every case
node evals/memory-write-quality/run_native_eval.mjs --url http://127.0.0.1:19330 --key-file <engine root key file> \
  --repeat 3 --out evals/memory-write-quality/results/$(date +%F)-native-baseline.json
node evals/memory-write-quality/run_native_eval.mjs --url ... --key-file ... --only c01,c06,c17 --repeat 3     # only the failures again
```

A change to the shared text (`packages/domain/src/memoryNeverKept.mjs`) is rendered into the eight templates with
`node deploy/web/openviking/memory-templates-src/build.mjs`. The shipped text states the never-kept block in every type
(about two thirds of all template text, as before). If the baseline shows the engine still keeping too little, the lab variant
says it once, in the profile, with a short reminder in the other seven (research G variant B, about 30% less text):
`node deploy/web/openviking/memory-templates-src/build.mjs --variant short-never --out <dir>`, mounted on the lab engine
instead of the deployed directory; it is never rendered over the deployed one. The lab engine must mount the rendered directory. Corrections are
written under `preferences/corrections/` since this change (the plugin lists `preferences/` at a session's start), and the
runner counts both places as the `correction` kind.

## The next-round families (2026-10-25, native arm only)

Eleven synthetic cases beside the 38 (49 in `cases-general/` with the one below), written for the instruments of the memory-capsule next round
(`evals/capsule-longitudinal` scenarios S9 and S11 read the same questions through the whole product):

| Family | Cases | What is asked |
|---|---|---|
| misconception | M01 a popular misbelief stated in passing (a tenth of the brain), M02 a belief the assistant corrected and the person keeps (sugar and hyperactivity), M03 a contested clinical claim agreed with while asking for reading notes | nothing is written: neither the belief nor the assistant's correction is a fact about the person or the world |
| symptom to trait | S01 a headache "these two days" and the assistant's softer echo, S02 one patient's presentation told to ask for talking points, S03 a few short nights before a deadline | no profile line, preference or project fact: a state of this week and a one-off case detail never become a standing trait |
| import | I01 a memory export the person pasted and asked to import, I02 the same with a password and an identity-card number inside, I03 a pasted document's instruction (always answer in French) | I01 keeps the lines as the person's own (owner decision 3, 2026-10-25); I02 keeps them except what is never kept; I03 keeps nothing: an import the person asked for is their statement, a pasted document's imperative never is |
| repetition across conversations | C22 (rewritten: it used to assert the opposite) the same choice in two conversations, E3B the same choice twice inside one conversation, E3C two different choices in two conversations | C22: kept as a preference after the second (owner decision 6, principle 18 amended); E3B and E3C: nothing kept |

`pendingTemplate` (C22, I01, I02) names the owner decision a case anticipates and what must change in the templates first. A pending
case still runs; while it fails the runner reports it as `pending-template`, never as a failure (the exit code stays 0), and when
it passes the summary lists it under "pending but passing, drop the marker". The shape E3 is written in is the memory templates'
to decide: C22 asks only that a preference be written and that it carry the choice.

### What the memory package's templates changed (2026-10-25), and how the runner replays it

- **The `observations` type** (E3: a choice made in a request, never called a rule, kept as a note) and **`recent_work`** (a project's last three
  tasks) are two more types of the ten. A note is not a memory: the runner scores no note (not as a kind, not in the text, not as an operation —
  `withoutObservations`) and prints how many there are beside each result (`observations: { files, lines, promoted }`), so noise in the notes
  is read there and never failed. `recent_work` bullets count as `recent_work` and as `project_fact`.
- **C22, E3B and E3C replay the control plane's counting.** The runner keeps the revisions of the notes as the overlay would
  (`nativeMemoryObservations.mjs`, run for real over the real engine); when two different conversations wrote one note it hands the note's words to
  the engine as `repeatedChoiceMessage` says, in a session of its own, awaits that extraction too, and then reads the files. So C22 passes
  only when the engine writes the second conversation's line into the first one's note (the template shape: one file per choice, one line per
  conversation, the same topic reused) **and** writes the explicit request as a preference. `apps/server/test/memoryWriteQualityRepeatedChoice.test.mjs` runs
  the runner against a stub engine that behaves as the template asks, so the harness is tested without a model.
- **I01 and I02** (the import) are answered by the shared deciding text ("Imported: …": each listed line is the person's own statement, under the
  same never-kept rules); the page's import sends the same sentence the cases do (`这是我在另一个 AI 助手里的记忆导出，请把它们导入到这里：`).
- **P01** (M8, S7 of the longitudinal harness): a rule given for "this project" in the same message as a small request must land under 约束 of the
  project's card (`requireKeys: ["project.constraints"]`, with 英文 in it) and not as a user-level preference.

Cases to replay in the lab after the template change (three samples each): `--only c22,e3b,e3c,i01,i02,i03,p01` for what changed; then the whole
corpus once (`--repeat 3`) for the never side: the new types and the longer shared text must not have moved any refusal (`c15`–`c21`, `c23`, `c24`,
`g06`–`g10`, `m01`–`m03`, `s01`–`s03` first). Remove `pendingTemplate` from every case that passes all three samples.

### Lab results of the round (2026-10-25, OpenViking v0.5.1.1, the ten templates, `--repeat 3`)

| Run | Result |
|---|---|
| `--only c22,e3b,e3c,i01,i02,i03,p01` (`results/2026-10-25-native-memory-package.json`) | 16/21: E3B, E3C, I02, I03, P01 in every sample; C22 1/3 (the promotion said only as a choice to keep landed in the profile twice); I01 0/3 because the case asked for the person's wording (「先看结论」) and the engine kept the gist (「回答先给结论，再展开细节」) |
| C22 again after the promotion names a preference (`results/2026-10-25-native-c22-preference-wording.json`) | 3/3, a preference after the second conversation |
| the whole corpus (`results/2026-10-25-native-next-round-full.json`) | 234/237 decidable samples, 9 need reading, no failure; the three not passing are I01 under the old wording of its check, which passes as rewritten (the files are in the result). Every refusal held (c15–c21, c23, c24, g06–g10, m01–m03, s01–s03); P01 put the project's rule under 约束 |

The `pendingTemplate` markers of C22, I01 and I02 are gone.

