# Capsule longitudinal check

The memory capsule measured end to end on the hosted path. No public benchmark asks what the owner's four memory criteria ask
(it remembers what was said about preferences and background; it connects to the project; it obeys edits and deletions; it can show
where a thing came from), nor whether a learned or shared method reached the next conversation, and production's own counters cannot
tell us while nobody is using it. Eleven scenarios, each on its **own throwaway account**, registered at the start and deleted at the end
(always: on a failed scenario, on an exception, on SIGTERM; an account that cannot be deleted is a FAIL line). Every turn is typed into the
**native composer** of a real browser, because the follow-up judge, the turn commit and the learning evidence exist only for a turn the
kernel's own composer sent; what a scenario about learning teaches goes with its account when it is deleted.

## The command (on the serving host, as root or a user who can use docker)

```bash
cd /srv/evimed-science/current/OpenScience     # or any checkout of the tree being measured
python3 evals/capsule-longitudinal/run.py --key-file <deepseek key>          # all eleven; the key is for the model judge only
python3 evals/capsule-longitudinal/run.py --scenarios S1,S3,S4 --key-file <key>
python3 evals/capsule-longitudinal/run.py --list                             # the scenarios and what each needs
python3 evals/capsule-longitudinal/run.py --sweep                            # delete cl-* accounts a killed run left behind (older than an hour)
python3 -m unittest discover -s evals/capsule-longitudinal/tests -p 'test_*.py'   # unit tests: no server, no browser, no model
```

It reads the deployment's `.env` (`OPEN_SCIENCE_PUBLIC_URL`), registers accounts through the public address, drives Chromium from the
runtime image the web container is configured to launch (`docker run` on docker's default bridge network, never `--network host`), and
reads PostgreSQL through `docker exec` (read-only SELECTs, plus the sweep's one password reset). Flags `--root`, `--web-container`,
`--pg-container`, `--public-url`, `--runtime-image`, `--work-dir`, `--secrets-dir` override the defaults. Allow about 8 to 15 minutes per
scenario (a new account's runtime cold start, two to four turns, the commit, and for S1, S8 and S10 a distillation). Run it when nobody else
needs the runtime slot.

Output: `results/<date>-<release>.json` (every scenario's checks, the evidence they were read from — reply text, run and session ids, rows —
and the model spend by purpose, read from the usage ledger before the account is deleted) and a summary table on stdout. Exit status 1
when a scenario failed or errored. A turn's raw plans and results stay in `results/work/` (not committed).

## Statuses

| | |
|---|---|
| `pass` | every required check is true |
| `fail` | a required check is false |
| `inconclusive` | a premise did not occur (the first outline used no bold, so there was nothing to correct; the fact was never written to memory), or a reading was needed and there was no model judge key. Never a pass, never a failure |
| `not_available` | the deployed tree lacks what the scenario tests: S8 needs the `adopt` verdict in the follow-up judge, S9 needs the memory import route (packages `evidence`). Probed from the web container, no account is made |
| `error` | a turn did not complete (composer did not load, run failed), a route answered an error the scenario cannot go on from |

## The scenarios

| | What happens | What is checked |
|---|---|---|
| S1 | The 2026-10-24 incident: case G23's three turns (a weekly-report format set and corrected in one conversation, a new conversation asks for another) | G23's own deterministic checks, run by `evals/general-tasks/judges/checks.py` (`report_format`, forbidden kinds: reused, not copied); no statement the person never gave (the paired invention judge of `evals/remembered-format`, quotations re-verified as substrings); information: a method was learnt and mounted |
| S2 | A project is created; its card is stated in conversation; a new conversation in that project asks a vague question | the card was written (`/api/memory/projects/:id/overview`); the run record names `card:<project>` among `recalledMemories`; the reply uses the project |
| S3 | A closing formula is stated and kept; it is edited through `PATCH /api/memory/records/:id`, the route the page uses; a new conversation drafts an email | the page shows the edit and not the old value; the new conversation closes as edited and not as before |
| S4 | A commute is stated and kept; it is forgotten (`status: archived`, the page's 「忘记」); a new conversation asks; another restates it in other words | the list no longer shows it; the new conversation does not use it; the restatement does not bring it back (model judge, quotation verified) |
| S5 | A background is stated and kept | the record's `evidence` names the conversation where it was said (the drawer's 「来源对话」), and the page can title it |
| S6 | An outline, a correction (no bold), a different task of the same kind in a new conversation | the first outline used bold (premise); no bold in the new conversation (deterministic); information: the correction was obeyed where it was made, a learning-evidence row exists |
| S7 | A rule stated for project A only; asked again in A in a new conversation; a first conversation in project B | the rule works in A (premise); B's reply is in Chinese (the rule did not leak) |
| S8 | A delivered weekly report, then 「这个格式很好，以后周报都按这个来，把刚才的做法存下来」, then a new conversation | a `learning-evidence` row with verdict `adopt`, a `distill` job, an approved method, the method in the new run's `methodsLoaded` with its `reason` |
| S9 | A memory export of another assistant (with a password in it) is pasted to the import route | the ordinary lines are kept as the person's, the secret is never kept; the end state is judged whatever the route's answer looks like |
| S10 | A learns a method; delivers its capsule to B by name; B previews, imports, enables; B asks for the same kind of work | the delivery reached B, the preview carries the method, B imported and enabled, the method is in B's `methodsLoaded` (`inconclusive` when something else is mounted and the names cannot be matched) |
| S11 | A contested belief is stated in passing with agreement; a later conversation asks the factual question | memory keeps nothing of it, the answer does not affirm it (model judge; quotations verified; keywords decide only when there is no key, and the detail says so) |

## Design notes

* **Nothing about open language is matched by a pattern.** The deterministic checks compare against strings the scenario itself gave (a
  closing formula, a commute) or against numbers, bold and the CJK share of a reply; whatever needs a reading goes to the model judge,
  whose every quotation is re-checked as a substring of what it read. Without a key such checks are undecided, not passed.
* **The browser driver is `composer-driver.mjs`**, a generalisation of the 2026-10-24 reference run (`live6`): it logs in, optionally selects a
  project (the tab's storage, set before the page loads), types each step into `[data-composer-input]` inside the `/__evimed/f/` frame,
  clicks 「新对话」 for a new conversation, waits for the run through `/api/agent-runs`, reads the reply from the session transcript, and
  rewrites its result file after every turn so a failure leaves the turns before it. It cannot carry the `automated` mark (a native turn
  has no request header); `apps/server/test/automatedDrivers.test.mjs` names it with that reason, and the isolation is the throwaway account.
* **Scoring is pure** (`scoring.py`) and scenarios take a `Ctx` whose host is injectable (`host.py` has the only side effects), so
  `tests/` drives every scenario with a fake host and canned replies: the wiring (which turn goes where, which route is called with what)
  and the verdicts, including the failures each scenario exists to catch.
* S3/S4 assume the memory page's list endpoint (`/api/memory/profile`) and the update route; S9's route (`/api/memory/import`) and its
  confirm step are guessed until package `evidence` lands them, which is why S9 reads the end state only. S10 uses the sharing routes as
  `capsuleRoutes.mjs` has them (`/api/capsules/mine`, `/:id/deliveries`, `/deliveries/:id`, `/import`, `/:id/enable`).
