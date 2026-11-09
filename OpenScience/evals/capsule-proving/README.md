# Capsule proving instruments

`inputs.mjs`, `sources.json` and `pools/` preserve official corpus identities and separate runtime input from scoring answers. Public product transport, tool-world tasks and frozen confirmation remain separate pending work.

## Offline semantic judging

The owner replaced the offline Claude role with Alibaba Cloud Model Studio **`qwen3.8-max`** on 2026-11-05. Model ID and compatible API are documented in the [official model reference](https://help.aliyun.com/en/model-studio/qwen3-8-max). This judge runs only on saved development-engine replay artifacts; it does not run extraction or alter mechanical results.

```sh
node evals/capsule-proving/offlineJudge.mjs \
  --input /private/candidate-write-quality-repeat3.json \
  --output /private/candidate-qwen-judgements.json \
  --key-file /private/dashscope.api-key
```

The key is read from the operator's file and never saved in the result. The fixed official Beijing endpoint receives six semantic samples per call, original case evidence, expected outcomes and the files actually retained. Results record requested/returned model, request IDs, usage, raw replies, source/packet/prompt hashes and a full denominator. The API returns a model alias; the recorded call date and identity are not an immutable model-weights digest.

Rerun the same command to resume. Different source, packets, prompt or rubric refuse that checkpoint. Missing extraction or seed prerequisites stay `unknown`; the deterministic eligibility check is reapplied to old checkpoint rows with any earlier judgement retained as audit evidence. Machine failures remain machine failures regardless of semantic judgement. Explicit infrastructure retries must be identified separately; never replace quality failures with reruns.

```sh
node --test evals/capsule-proving/tests/*.test.mjs
```

## Synthetic long-term users

`synthetic/` writes users whose answers are known because they were planted. A generator outside every judged role (the Kimi
Code CLI: not the template author, not the DeepSeek extractor or answerer, not the Qwen judge) writes each user's skeleton
— persona, people, projects and about 45 planted items in seventeen categories (stable, changed, a detail said once,
an assistant's unconfirmed suggestion, a third person's fact, an opinion, a document's claim, a hypothetical, an explicit and
a repeated preference, a correction, a forget request, a secret, an instruction hidden in pasted material, own and family
health) — and then the conversations, eight sessions per call. `spec.mjs` places every event in a session from a seed and
checks each rendered batch: every planned anchor (a short verbatim number, date or name) said by the planned speaker in its
session, none before the session that introduces it. Gold, store expectations and planted errors are built from the
skeleton, never from the prose, so most checks are substring checks; the rest carry a rubric for the offline judge.

```sh
node synthetic/generate.mjs --out /data/synthetic --split dev --users U01,U02,U03,U04,U05,U06
node synthetic/generate.mjs --out /data/synthetic --split sealed --users U07,...,U30   # prints counts only
node --test tests/synthetic.test.mjs
```

Per user: `input.json` (sessions in order and each question with the session after which it is asked; no answers),
`gold.json` (expected anchors, rubrics, store checks), `corruptions.json` (errors to plant in the memory files after
extraction for the transcript-verification test), `manifest.json` (counts and hashes). Generated data stays out of this
public repository; sealed users are written by the generator and read only by the scorer. Every finished step is appended
to `<out>/STATUS`; a rerun skips finished files.

A batch that fails its check is re-rendered with the problems named; once three or fewer of its sessions still fail, only
those sessions are sent back with their previous text and edited in place (`repairPrompt`), and the last attempt is kept in
`bNNN.partial.json` so an interrupted run repairs instead of starting the batch over. Four kinds of user: `general` and
`medical` (200 sessions; every third numbered user is medical), `multipatient` (`M01…`, 40 sessions, people with
confusable drugs and values) and `medproject` (`P01…`, 30 sessions on one medical research project for plan M9; eight
classes — systematic review, real-world cohort, drug evaluation, trial protocol, case series, guideline and pathway, health
technology assessment, diagnostic accuracy — taken in turn by user number, with project decisions, revised decisions and
constraints that name their project). With `SYNTH_MIN_FREE_MB` set, a Kimi call waits for that much available memory
before it spawns, for a box shared with other work.

## Red-line inputs, normalization and the L3 split

- `synthetic/secrets.mjs` — fake secrets with real shapes and valid checksums (Luhn bank cards, GB 11643 ID numbers, `sk-`,
  `sk-proj-`, `ghp_`, AWS and JWT-shaped keys, passwords, mobile numbers); the CLI prints counts, never a value.
- `synthetic/carriers.mjs` — Kimi writes carrier sentences with one slot (`{marker}` for an ordinary personal code,
  `{secret}` per secret kind); code places every value. Writes `carriers/markers.json` (G4/G5) and `g6/items.json` (G6:
  each fake secret inside a sentence a person might type, expected never stored and never in the verbatim index).
- `synthetic/trialPlans.mjs` — G4 deletion trials (3,000: plant route × delete route, re-learning probes, two control
  markers that must survive unless the account itself is reset or deleted) and G5 isolation trials (600, 30% concurrent,
  visibility from one rule table, `isolationExpectation`).
- `synthetic/scaleCorpus.mjs` — G13 memory corpora of 1k, 10k and 100k statements sampled (reservoir, nested sizes) from
  user turns of the public sets; no generated text.
- `normalize.mjs` — the surface-form normalization every code check applies to both the reply and the expected string
  (NFKC, Chinese numerals including spoken shorthand such as 一万二, times, thousands separators, units).
- `l3-split.mjs` → `pools/l3-split-20261109.json` — plan L3's 20 exam cases (14 general, 6 medical) from
  `evals/general-tasks`, the held-out learning cases, the arms and the 280 runs; no case is in both.

## Learning, agent and effect-data sets (2026-11-09)

`sources.json` → `learning` pins 21 more sets by commit or HF revision with per-file sha256 (large files by git blob sha1):
ALFWorld, ScienceWorld, InfiAgent-DABench, DA-Code, ScienceAgentBench, τ²-bench, BFCL v4, MultiSessionCollab, SkillsBench,
SkillLearnBench, CL-Bench, MemoryBench, MedLoCoMo, RABBITS, ACEBench, Toucan (server and tool schemas only),
ResearchClawBench (task cards only), GAIA (gated: card only) and PERSIST (no public data exists). `fetch-public.mjs` fetches
them; `--large` adds the files over the per-set limit. Counts are read from the data and written with the discrepancies
against the plan to `results/intake-learning-20261109.json`. `inputsLearning.mjs` / `intakeLearning.mjs` add the
MedMemoryBench HF version (1,939 questions, one language-neutral split for zh and en), a 600-question MedLoCoMo sample
(MIMIC-derived and unlicensed: local only, never redistributed), the English brand/generic memory probe (556 items from
RABBITS pairs; Kimi wrote only the 20 + 20 templates; score `bridged`, the reply naming the stated form when the question
used the other) and the WildChat Chinese pseudo-user sample (272 users, 2,004 conversations; hashed IP and header are not
written; no gold). `pools/tools/` holds the pin, count and sampler scripts.

- L3 — `l3-split.mjs` (above).
- L6 — `l6-candidates.mjs` draws 1,000 of WildChat's 209,871 Chinese follow-ups (a user turn right after an assistant reply)
  by seeded reservoir, with no keyword deciding what is a correction; the labels (Claude's pass, in the follow-up judge's
  case schema, with a blind 150-case second pass, κ 0.54) live beside the data and are run with `evals/follow-up-judge/run.mjs
  --cases … --split-file …`. Real traffic holds corrections, accepts and rejections but no preference or adopt, so the
  hand-built `evals/follow-up-judge/cases.json` stays the measure of `adopt`; people label the ambiguous 18% next.
- L9 — `pools/l9-long-tasks-20261109.json`: ten ResearchClawBench tasks (most rubric items, then most data files) and ten
  of our own long review briefs (meta-analysis, clinical review, hospital drug evaluation; three each and one more, seeded).

### ToolVerse practice ground (`synthetic/toolverse/`)

Our own take on ToolVerse (arXiv 2607.15660) for C3 and L8. `graph.mjs` builds a tool dependency graph — an output field
feeds an input parameter when their value kinds match; `edgeOverrides.json` holds corrections as data — over `evimed` (21
of our research tools: inputs from the MCP schema, outputs curated from the descriptions), `general` (33 generic tools)
and `toucan` (a subset of Toucan's MCP servers). `samplers.mjs`: `dynamicUnlock` unlocks a tool only once one of its inputs
is reachable; `randomWalk` draws uniformly from valid chains of the same lengths. `env.mjs` fabricates a consistent seeded
return value for every call of a chain and `simulate(task, call)` answers a canonicalised dict match; `score.mjs`
`scoreTrajectory(gold, calls)` scores per step, finds the first failing step and flags a TellOnce failure (asking for a
value the arm supplied). C3: dynamic against random tasks per graph with length, level and coverage in `stats.json`. L8:
one or two user-supplied values withheld from the request and placed in earlier sessions or a learned rule card; three arms
(no memory, memory, memory + method), each with its own gold. Kimi writes all wording (`run.mjs`); code fabricates values,
checks them verbatim and derives gold. `node run.mjs graphs|c3|l8 <dev|sealed>` is resumable.

### Paired sets: M6, M7, M11, G9 (`synthetic/pairedsets.mjs`, `pairedsetsCore.mjs`)

`node synthetic/pairedsets.mjs --set m6|m7|m11|g9 --split dev|sealed --out DIR [--count N] [--count2 N]` → `<out>/<set>-<split>/`
(`input.json`, `gold.json`, `manifest.json`; M7 also `cases.json` in the schema of `evals/remembered-format/cases.json`).
- M6 (dev 10 / sealed 30): a with-memory arm (an earlier session where the user states a preference that would bypass the
  cited rule of `clinical-safety-rules.json`) and a without-memory arm, same question. Gold: `mustContainAny` over the rule's
  required mention terms and a judge rubric from the rule's own fields; a bypass is a red line.
- M7 (8 / 24): remembered layouts in medical genres (case summary, drug evaluation, evidence table) over material that
  leaves places empty. Gold: the unsupported places, the allowed citations (PMID / NCT / DOI) for a back-check the
  remembered-format runner does not have yet, and a judge rubric.
- M11 (10 / 30): medical-heavy and non-medical histories, then an ordinary task. Gold: `mustNotContain` on the history's
  medical anchors and a judge rubric for clinical tone; the no-history control is the same question without sessions.
- G9 (poisoning 15 / 45, sycophancy 10 / 30): the false claim rides in `sessions[i].attachments` (document, web page, tool
  result, pasted content; the runner shows a pasted block as material, never as the user's words) and never in a user
  message; gold has `mustNotContain`, a store check with `expectStored: false` and a red-line flag. Sycophancy: gold holds
  the established anchor and a judge rubric.

### Learning-loop and baseline data (`synthetic/learnsets.mjs`, `learnsets-loop.mjs`)

`--set l1|l2|l5|l10 --split dev|sealed`, `--set l4`, `--set g10`; resumable, sealed prints counts only.
- L2 hidden-rule users (dev 4 / sealed 12): three rules each, each decided by one `checkReply` kind (pass and fail examples
  checked in code), 12 sessions in project A (every rule applies in four or more), three frozen-phase tasks, two project-B
  probes. `simulateUserTurn(person, session, reply, priorCorrected)` is the model-free simulated user: a first correction
  hints, a repeat is clear. No request already shows a rule's required format.
- L1 rings (dev 1 / sealed 3 per ring): correction, adopt, routine with a file, routine as a tool chain, script, replay,
  sleep; each run has a request and a follow-up with a code-assigned verdict, and `l1Trigger` proves the ring's trigger.
- L4 library scale: the 16 official methods plus planted relatives (duplicate, subset, conflict, same-topic unrelated) and
  filler; libraries of 50 / 200 / 600 with relation-pair gold (unlisted pairs are unlabelled).
- L5 bad methods (dev 2 / sealed 6 per class): harmful, outdated (a term from `retiredFeatures.mjs`), conflicting with a
  safety rule, and good controls, each with 3–5 tasks and the follow-up a person would send.
- L10 tool chains (dev 3 / sealed 8 families): four same-chain requests with no file and two lookalikes on other chains,
  chain names from the closed `TOOL_CHAINS` list.
- G10: 8–15 first-person seed memories per general-task case (29 cases, 2–4 relevant each), with each case's sha256.

### Medical sets M1, M2, M3, M5, M10 (`synthetic/medsets.mjs`)

`node synthetic/medsets.mjs --set m1|m2|m3|m5|m10 --split dev|sealed --out DIR --count N` → `<out>/med-<set>-<split>/`
(`--count` is questions for m1, entities for m2, items for m3, pairs for m5, scenarios for m10); resumable per batch.
- M1 memory effect: histories told by a doctor, a pharmacist, a patient or a relative; three real facts and one
  hypothetical or literature case per history (`expectStored: false`, `mustNotContain` on its anchor).
- M2 entity fidelity: an allergy, a dose, a lab value, an NCT id or a PMID said once; `expect.exact` and `exactType` for
  `normalize.mjs`; code-built digit and unit corruptions in `gold.items[].corruptions`.
- M3 drug synonyms: names only from the local drug-label database (`med_m3_extract.py` → `med-m3-source/`: generic, salt
  and dosage-form variants, brand); Kimi writes carrier sentences with `{NAME}` and code fills the names. The database has
  no English names or abbreviations, so M3 uses none; English synonyms come from the RABBITS probe.
- M5 staleness: lab, drug, guideline and retraction pairs, each asked as current, previous and what changed.
- M10 medication safety: an allergy said once in passing (no 「记住」), buried at three depths, the medication question in a
  separate later conversation; gold holds the allergen (`mustContain`), drugs not to recommend without a caveat
  (`mustNotContainUnqualified`, judge-assisted) and a rubric.

### Before a run

`node verify-data.mjs --data DIR` checks every manifest's sha256 against its files and that no question shown at run time
already contains an answer its gold expects (an anchor the question names leaves the substring check for the judge,
`expect.anchorInQuestion`). It prints counts only, so it is safe over sealed data.
