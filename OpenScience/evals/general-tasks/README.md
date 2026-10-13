# General-task baseline (`evals/general-tasks`)

Twenty-two general tasks (G01–G22) and six medical controls (M01–M06), worded as in section 7 of the course-correction review
(`general-agent.md`, finding GA30), run against a **real DSH kernel and DeepSeek through the real control plane**, one case at a
time, unattended. It answers one question: what does a plain request (an email, a spreadsheet, a deck, a script, a lookup) get on
this platform today, and did a change make that better or worse, without making the medical work worse?

Until this suite existed `evals/` held 52 directories and no general task: principle 6 (every incident becomes an eval case) and
principle 11 (native is the control) held only for medical work.

## The one command

```bash
cd OpenScience
node evals/general-tasks/runner/run.mjs --tree <path to the OpenScience checkout under test> --arm C --out <result directory>
```

That is the whole of arm C: all 28 cases once, with the three fault variants (G16 with the routing classifier timing out, G14 with
web search unavailable and with the whole web unavailable), judged and summarised as it goes. It is resumable: a case that already has a record in `--out` is
skipped, so after an interruption run the same command again. Start it detached when it will outlive the shell:

```bash
setsid nohup node evals/general-tasks/runner/run.mjs --tree <tree> --arm C --out <dir> > <dir>/run.log 2>&1 &
```

Read `<dir>/summary.md` (one row per case) and `<dir>/summary.json`; do not read the transcripts.

| option | meaning |
|---|---|
| `--arm A\|B\|C` | a label for B and C (the tree is the tree); A is the native control (below) and runs the 22 general cases only |
| `--cases G01,G05` / `--set all\|general\|medical` | which cases (G07 continues G06's conversation: ask for `G06,G07` together, or G07 alone, which brings G06 along) |
| `--repeat N` | run the plan N times (records `…-r1`, `…-r2`); routing checks are deterministic, once is enough |
| `--timeout-min 15` | per turn; a case may ask for more (M02 25, M04 45, M05 30). A run that hits it is cancelled and recorded as timed out |
| `--port 48841` | harness port, in 48840–48859; check `ss -ltn` first |
| `--pg-port 55657` | PostgreSQL for the control plane; a throwaway one is initialised and started under `/tmp/eval-pg-<port>` if nothing listens |
| `--seed-from DIR` | a sealed DSH profile seed to copy instead of building one (see prerequisites) |
| `--data-dir DIR` | where this run's kernels, workspaces and logs live (default `/tmp/eval/live/data-<arm>`); give two runs of the same arm different ones |
| `--redo`, `--no-judge`, `--keep-data` | run again, skip the judges, keep each case's project directory |

A shorter run: `--cases G01,G05,M01` is the smoke test.

### Prerequisites on this box

* `/tmp/evimed-openmed-dsh` (the pinned `dsh` CLI), `~/.cache/evimed-pg/BIN` (a PostgreSQL), `python3` with `openpyxl`, `python-docx`,
  `pypdf`, `pandas`, `Pillow`, `numpy`, and `soffice` (LibreOffice) for the Office and PDF judges.
* A profile seed. `seed.sh` stages the tree's socket into a per-tree copy of a sealed DSH profile and seals it again, on every run,
  so an edited tree is what runs. The profile itself is **copied** from `--seed-from` or from any seed already staged under
  `/tmp/eval/live/trees/` (about 520 MB, `/tmp` only); only when there is none does it build one from the network (pnpm and the
  pinned kernel packages; needs `LOOPX_TGZ`). That last branch is adapted from the WP-PROMPT seed script and was not re-run for this suite.
* The control plane reads the DeepSeek key and the DashScope key (web search) from the files under
  `.evimed-local/secrets/` by **path** (`EVAL_SECRETS_DIR` moves it). Nothing here reads or prints a key.

## What a case is

`cases.json` holds, per case: its family, the input **exactly as worded** (multi-turn cases carry every turn), the fixture files to
upload, the deterministic checks, the rubric family for the model judge, and the sentence from the review saying what a pass looks
like. Fixtures are small, synthetic and invented (`fixtures/`, rebuilt by `fixtures/make_fixtures.py`; `ground_truth.json` records
what the judges compare with): a 5,000-row `sales.xlsx`, `orders.csv`, a three-page contract `.docx`, a 20-page PDF with a table
on page 5, a three-file project with one failing test, three company policies and a small TypeScript repo, a glucose-meter
validation report and six RCT effect sizes. No real person, company or customer.

For each case the runner registers a **throwaway local account**, creates a project, uploads the inputs through `POST
/api/files/upload` (the route the web app uses; knowledge-base files go to `knowledge-base/`), and dispatches each turn through `POST
/api/agent-runs/dispatch` with the route left to the platform. A file that is uploaded to the workspace is announced the way the
composer announces an attachment, by one line appended to the first message (`（附件已上传：sales.xlsx）`); this is the same in
every arm. Multi-turn cases send their follow-ups in the same conversation (G22's last turn opens a new one, in the same
project). Fault injection: G16 runs a second time with the routing classifier timing out (its model call never answers, so the classifier's own
deadline ends it; injected at the model-provider boundary of the harness, `EVAL_FAULT`), and G14 two more times: with the web search
provider switched off (`web-search-off`; a page can still be read) and with search and read both off (`web-off`, the honesty test proper). G20 also starts the created task once by hand (`run-now`) and reads the execution.

What is recorded per case (`records/<case>-r<n>.json`, with `<case>-r<n>.files/` beside it holding every file a turn left new or
changed, the transcripts, and the first model request): completion, route and route reason, tool calls (count and names), wall
time, tokens and cost, files registered in the run record, files left in the workspace, the verification mark (`未核验`) and
notices, the reply, and what the product shows (the outputs list, the inbox, the memory overview).

## Judging

1. **Deterministic judges first** (`judges/checks.py`): the file opens, page / slide / sheet counts, a cell is a formula, summary
   values equal an independent computation from the fixture, the test suite passes and the test file is unchanged, the script
   renames the fixture photos right and `--dry-run` changes nothing, numbers are preserved byte for byte, a number in a slide is
   in the source PDF, the pooled effect equals an independent inverse-variance computation, the route reason in the ledger, the
   file registered in the run record, forbidden content in the reply (a reference list, a medical disclaimer, “我们目前不做”, a
   tool name, an evidence-review framework). The prose detectors are closed lists that report what they matched; they run
   offline only, never inside the product. A check is `required` unless marked otherwise; a case **passes** when every required
   check is true. A check that could not be decided is `unjudged`, not failed.
2. **Routing checks** (G05, G10, G12, G16, G17; also M04) are deterministic: one miss is a miss, no averaging.
3. **Offline model judge** (`judges/model_judge.py`, rubrics per task family in `judges/rubrics.json`): tone, relevance, brevity,
   honesty and usefulness, 0–5, plus a satisfied / not satisfied verdict. It is told the scripts' results as facts, is **not** the
   evidence-based-medicine judge of `evals/open-domain-answer-quality`, and its report never reaches a run:

   ```bash
   python3 evals/general-tasks/judges/model_judge.py --run <result directory>     # then re-run summarize
   python3 evals/general-tasks/judges/summarize.py --run <result directory>
   ```

Re-judging saved records costs no model time on the agent side: `python3 judges/judge_case.py --cases cases.json --record
<records/X.json> --out <judged/X.json> --fixtures fixtures`.

## Arms

* **B / C**: the tree as it is. The harness composes the control plane (kernel mode, local auth, real launch plan and bootstrap,
  real gateways, real ledger) with a host-process runtime in place of the container; the kernel is the pinned DSH with the seeded
  profile (the socket of the tree under test). Evolution, learning, LoopX, Jev judge sites and run titles are off in every arm
  (LoopX needs image paths the host harness does not have; the others act on runs after the fact); memory extraction, the
  autopilot, source ingestion and the Bailian web search are on.
* **A, the native control**: `OPEN_SCIENCE_RUNTIME_DISABLED_SOCKET_PLUGINS` names all seven switchable first-party socket plugins
  (guidance, run-policy, evidence, capsule, screening, compaction, duplicate-lines), the citation tools are off (`EVIMED_CITE_ENABLED=0`
  in the kernel process), and the persona row of the preset is replaced by one neutral sentence in the runtime's own copy of the profile
  (`runner/persona.mjs`; the persona is a row of the kernel's own and no switch reaches it). The MCP server's tools are still mounted
  (they are not socket plugins). With run-policy off the control plane's dispatch brief is not injected either, so the first
  model request carries the kernel's own prompt and one neutral sentence; each record keeps that request's size and a flag for
  whether it still names the medical persona.
* Reading: the completion-rate gap B − A is the net effect of the platform's composition on general tasks; the target for C is
  general completion not below A and the six medical controls not below B.

## Known limits

* The web app's main chat path is the kernel's own page; this suite drives `POST /api/agent-runs/dispatch`, the path that carries the
  route decision and the run ledger (as the other course-correction packages did). On the native page the model is not told the route.
* Document parsing: the in-house parser is an external service with a key; on this box it is not configured, so G22's `.docx` / `.pdf`
  knowledge files are accepted and registered but not parsed (the record's `sources` ledger says so); the plain-text files are.
* The harness kernel runs as a host process **with network**; the production runtime container has none. With the web tools off
  (G14 `web-off`) a run can still fetch pages through its shell, so that variant cannot force “nothing can be looked up”; its judge
  accepts either an honest “I could not look this up” or an answer whose cited hosts appear in what the tools returned. The same
  holds for every web task: results show what the platform does where fetching is possible.
* The model judge is one DeepSeek flash call per case; run it twice (`--redo`) when a score decides something.
* Link and Node.js LTS checks read the public internet from the host running the judges; offline they report `unjudged`.
