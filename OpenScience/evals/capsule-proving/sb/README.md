# SkillsBench / SkillLearnBench pilot (L7)

This lane measures **the reference agent plus skills, not the product**. The
scored containers do not use the EviMed control plane, DSH, capsule recall,
method ranker, or product tool policies. Product practice and distillation are
separate, observed stages; their exported approved methods become the reference
agent's skills. Never relabel these scores as product-path results.

## Pins and execution

| Component | Pin / source |
| --- | --- |
| SkillsBench | `benchflow-ai/skillsbench@f860ecf02ef53412a030f8661c83d644b739ff01` (Apache-2.0), 87 tasks / 8 domains |
| SkillLearnBench | `cxcscmu/SkillLearnBench@726e1f79b96b0cb3d729d0e55a1c847e0b5353ae` (MIT), 20 families / 100 variants |
| SkillsBench runner | BenchFlow 0.6.3, the version in the pinned repository's `uv.lock` |
| SkillLearnBench runner | The pinned `core/eval_runner.py`, with a registry entry for Pi CLI |
| Reference agent | `@earendil-works/pi-coding-agent@1.5.2`; SkillsBench uses `pi-acp@0.0.34` |
| Inference | `deepseek-flash`, thinking enabled, effort high, 32,768 output-token cap; provider response model and usage recorded |

BenchFlow's original Pi installer uses a retired package incompatible with its
floating ACP adapter. `bench_entry.py` pins the compatible renamed package and
declares the adapter's public `thought_level` configuration option. These are
agent registry adaptations; benchmark tasks, images and verifier scripts are
unchanged. SkillsBench uses the default non-root `agent` sandbox user: selecting
`root` makes the upstream pre-verifier user cleanup kill the container.

The existing product harness launches DSH on the lab host with workspace-only
access. It cannot execute directly inside these benchmarks' task containers and
absolute filesystem layouts without a new execution adapter. This lane therefore
uses the authorized reference-harness fallback. Its practice inputs are uploaded
to the real product; `/root/` and `/app/` paths are explained as workspace-relative.
Missing dependencies and practice timeouts are retained as limitations. Practice
outputs are not claimed to have passed the container verifiers.

## Frozen sampling and arms

`prepare.py` freezes the sample before scoring, using seed `20261111`. Its
Dockerfile/credential feasibility screen and every exclusion are in the manifest.
Eligible names are ordered by SHA256(`seed:name`). SkillsBench takes one test
task per domain and the next eligible task for practice when available.
SkillLearnBench takes one family per README category, reserves variant 1 for
practice, and chooses two remaining variants by the same hash. The pilot has
8 SkillsBench candidates, 12 SkillLearnBench candidates, and 13 practice tasks. It is
conditioned on build feasibility and is not a representative full-set estimate.

Before any SkillLearnBench scoring, capacity calibration (6.3 minutes for the
successful smoke, shared lab load above 50) reduced its primary run to the first
frozen held-out variant per family: **6 tests**, paired across all three arms.
The other six frozen variants remain unused reserves. This is a pre-score
capacity amendment, not selection by task results; each run records it.

- `none`: no benchmark or learned skills.
- `flat`: the benchmark's own task/family skills, copied without rewriting.
- `learned`: only methods actually learned and approved by the product from the
  separate practice tasks. An empty library stays empty; it never substitutes
  human-written or independently model-written skills.

Product practice uses one synthetic account with a fresh project per task,
`OPEN_SCIENCE_MEMORY_RUNTIME_LOCK_ISOLATION_ENABLED=true`, learning enabled and
official packs disabled. Dispatch omits `automated`; the second turn explicitly
asks to retain the reusable workflow, without asserting externally verified
success. This is simulated attended evidence, not real-user approval. The
product's own learning worker performs distillation and promotion. The runner
does not insert lessons, invent approval evidence or change method status.
Read-only IPC exports approved bodies, frontmatter values and script attachments.
The reference trials mount that library through their own skill discovery;
they do not reproduce the product's pyramid selection. A separate pyramid arm
would require additional paid trials and is omitted.
The library is frozen across both benchmark practice pools before learned-arm
scoring. This is a practice-to-held-out transfer pilot, not the full continual
curriculum, online adaptation or forgetting measurement. Wilson intervals describe
this selected pilot; they are not full-benchmark population estimates.

## Lab operation

All downloads, dependencies, containers, tests and model calls belong on
`evimed-lab`; never install or run this campaign on the development box. Data
already present at `/srv/evimed/data/memdata-data/public` is reused. The manifest
checks the selected files against `sources.json`; verifier digests are checked
before and after every trial. Download missing pinned public data with the
existing `fetch-public.mjs --large --only skillsbench,skilllearnbench` on the lab.
The reference runner code is fetched from the exact commits; the lab's upstream
receipt verifies git blob identities and records SHA256 digests.

SkillLearnBench's runner does not set container resource limits. This adapter
sets one CPU, 2 GiB memory and 3 GiB memory plus swap equally for every arm on
the shared lab, and stops Pi after 1,700 seconds before the upstream 1,800-second
watchdog so a timed-out agent cannot keep editing during verification. These
limits differ from the task manifests' usual 4 GiB and are a comparability limit.

The lab layout is `/srv/evimed/sb/{code,venv,upstream,manifest.json,practice,learned}`.
Install BenchFlow 0.6.3 and the pinned SkillLearnBench Python requirements into
this lane's private virtualenv. Record `pip freeze` and upstream receipts. The
agent npm versions are installed by the reference harness in each task container.
Use one reference container slot by default. Two streams were briefly used after
practice exited, but retained SkillLearnBench images exhausted the shared disk;
the runner now removes only its completed image tags and resumes serially.
`SB_REFERENCE_SLOTS=2` opts into two containers when capacity permits, with
per-request trial attribution. Each stream runs none, learned, then flat.
Serial scheduling interleaves benchmarks within each arm, so both methods
comparisons are reached before the final flat-skill arm.
Product practice uses port 48848, bridge 19368 and its own database on the existing
lab PostgreSQL port 55686. Do not stop other lanes' processes or containers.

```sh
# Product practice, resumable by task record and completed export:
setsid nohup bash /srv/evimed/wt/sb/OpenScience/evals/capsule-proving/sb/practice.sh \
  </dev/null >/srv/evimed/sb/practice.log 2>&1 &

# Reference inference proxy: only this process reads the real provider key file.
setsid nohup /srv/evimed/sb/venv/bin/python /srv/evimed/sb/code/gateway.py \
  </dev/null >/srv/evimed/sb/gateway.log 2>&1 &

# Six arms; the learned arms wait for the product's actual export:
setsid nohup bash /srv/evimed/sb/code/lab.sh campaign \
  </dev/null >/srv/evimed/sb/campaign.log 2>&1 &

# Resume one arm, or explicitly retry infrastructure records (old attempts kept):
bash /srv/evimed/sb/code/lab.sh arm sb flat
bash /srv/evimed/sb/code/lab.sh arm sb flat --retry-infra
```

`STATUS` is `/srv/evimed/runs/sb-STATUS`. Runs are `sb-<arm>-1` and
`slb-<arm>-1`, with per-task records, official results, traces, logs and summaries.
A frozen manifest digest prevents resuming under another sample. The reference
slot has an exclusive lock. Budget checks combine this lane's proxy usage and
product-account usage, leave CNY 10 for in-flight work, require the common
balance floor, and enforce the batch deadline. Shared balance changes are a
cross-check, not attribution to this lane. Rates are the product's reference
CNY peak prices (input 2, cached input 0.04, output 8 per million tokens). The
report reuses the product domain's dated price list and peak/off-peak schedule
for timestamp-adjusted cost, and retains the peak equivalent separately so a
night discount cannot be mistaken for a methods efficiency gain. Provider
billing and unpriced/incomplete usage remain distinct.

`report.mjs` uses `run/ledger.mjs` and Wilson intervals. Infrastructure failures
and missing tasks stay visible in the planned denominator; scorer-only rates
are separate. It appends a final ledger row only when every planned task has a
record and the final report is invoked with `--append`. Interim arm reports do
not append ledger rows. Do not silently drop a broken verifier or retry a legitimate failure.
An upstream oracle must pass before each SkillsBench task is scored. A failed
oracle is an infrastructure finding, not an agent failure or a replacement task.

`redaction_compat.py` bounds BenchFlow 0.6.3's generic credential-name scan
with a leading identifier boundary. A captured stack located a live stall in
trajectory redaction after native Pi completion. The shim retains credential
redaction and writes a compatibility receipt; it changes logging, not agent
inputs or task verification. The whole five-task pre-fix phase (including its
pass) is archived and repeated, with all original grades and paid usage retained.
`protocol-amendments.json` defines the primary cost boundary. No retry is selected
by reward. Native agent/verifier timeouts are read from the pinned task; the outer
watchdog adds build/install time. The video wrapper's one-time wait recovery is
recorded separately. Earlier wall times include logging stalls.

After every agent trial has finished, run the labelled diagnostic judge and final
reports on the lab (the judge owns the legacy single-trial attribution file):

```sh
python /srv/evimed/sb/code/judge.py
node evals/capsule-proving/sb/report.mjs /srv/evimed/sb /srv/evimed/runs /srv/evimed/results/ledger.jsonl --append
python /srv/evimed/sb/code/render_results.py
```

Mounted means deployed skill folders. Opened means a successful read-tool call
for a mounted `SKILL.md`, deduplicated by tool-call ID. Shell reads are not counted
by that conservative observer. Learned-method openings on held-out tasks are
reference-agent reuse, not product observer events.

## Comparability and submission

The [SkillsBench paper](https://arxiv.org/abs/2602.12670) reports a 16.6-point
average gain across 18 model/harness configurations, not a target gain for this
model. [Vals](https://www.vals.ai/benchmarks/skillsbench) reports DeepSeek V4.1
Flash **with OpenHands** at 69.80% (updated 2026-10-29). This pilot uses Pi,
an explicit repository pin, a feasibility-conditioned subset and a different
learning protocol. Neither absolute leaderboard rank nor a full-set score can
be inferred. The self-generated arm is product practice/distillation, not
BenchFlow's per-task self-generation recipe.

[SkillLearnBench](https://github.com/cxcscmu/SkillLearnBench) uses Claude Sonnet
4.6 for its reference solver and GPT-5-mini for judging. Its task-success
verifiers remain authoritative here. Skill quality and trajectory quality must
state their judge and transport; a substituted DeepSeek judge is a separate
measurement and cannot be called the published GPT-5-mini result.

What a leaderboard submission would need (five lines):

1. Freeze the product configuration, code/data/agent pins and learning boundary; do not tune a special leaderboard product.
2. Run the complete required sets/repeats with the unchanged official verifiers and retain every task result, error and trajectory.
3. Disclose the actual model, harness, skill sources, practice/test separation, generated methods, resource limits, tokens and spend.
4. For SkillLearnBench, include all three layers and the required solver/judge or obtain agreement to clearly labelled substitutions.
5. Package reproducible artifacts and ask the maintainers for the current submission route/acceptance; this pilot is not a submission.
