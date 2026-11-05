# Professional research plugins — implementation and acceptance

This record separates source implementation, installed behavior, numerical
execution, data quality and publication. The branch is
`codex/vcr-professional-plugins-20261105`, based on the reviewed algorithm
branch at `da2d191b4`. No production deployment, production database migration,
main merge or registry publication is part of this delivery.

## Implemented boundaries

- Four separately packaged DSH bundles: virtual cohort, virtual patient,
  synthetic/external controls and virtual trial design; an optional suite
  discovers the tools actually installed. Patient matching remains independent.
- Each bundle has its own manifest, skill, example, method discovery and
  asynchronous start/read/cancel/report surface. The shared runtime delegates
  to the existing method registry and engine, with no duplicate algorithms or
  universal workflow interpreter. Questions can use a subset or combine tools.
- Standalone installation uses the upstream DSH package manager and a trusted,
  operator-owned workspace. Hosted installation uses the existing catalogue,
  leased preparation and immutable project generations. Hosted execution never
  falls back to local filesystem execution.
- Source statements bind a particular parameter, original quotation, unit and
  context. Checking quotation membership does not verify the model's semantic
  interpretation. Historical parameter provenance and result versions remain
  readable; same-valued inputs from different sources are distinct jobs.
- A report reads the producing job's frozen inputs, source checks and result.
  Population quality failures and unavailable checks remain visible alongside
  computational success. A job's terminal observation prevents a second paid
  answer for a result already consumed in its initiating turn.

## Actual acceptance evidence — source and runtime checks

| Layer | Evidence and scope |
| --- | --- |
| Hosted lifecycle | Actual public registration, project installation, leased image/receipt inspection and actual DSH tool-definition proof passed for one bundle, all four plus suite, disable and re-enable. A damaged candidate was refused and the still-authorized last-good generation restored and proved. No fabricated runtime proof was used. |
| Runtime image | Built locally in the isolated Docker context. All five bundled receipts were inspected as UID 10001 with a read-only root and no network. Native tool registration is tied to the host's actual registry instance rather than another installed copy of the port module. |
| Parameter/result provenance | Original human-message scope, ambiguous repeated numbers, units, percentages, changed sources, historical read-back and in-flight deduplication have regression coverage. |
| Homepage | Built application inspected in the in-app browser at desktop and 390px widths; no horizontal overflow at 390px. Desktop uses a research list beside the task entry. These captures use an isolated account and mock conversation runtime, and do not prove live conversation execution. |
| Independent review | JavaScript/runtime review and scientific/Python review were performed separately. Reproducibility path, fresh mirror bootstrap, rare factor indicator and precision findings were fixed and rechecked. |

The reproducible hosted harness and its predeclared conversation cases are in
`OpenScience/evals/vcr-hosted-native/`. The full-input scientific scripts and
current hashes/results are in
`OpenScience/evals/vcr-professional-plugins/RUN-20261105.md`.

## Full-input scientific results

PhysioNet 2012 A/B/C cover 4,000 distinct ICU stay identifiers per split,
12,000 records in total. This does not establish 12,000 independent people,
different hospitals, or a prospective time split. The age-at-least-65 cohort
contains 6,557 records, independently reproduced.

The final frozen `population.synthpop` 1.4.0 execution generated five complete
4,000-row copies in 292.027 engine CPU seconds. Explicit source-validated
imputation rules and a versioned 17-digit CSV writer fixed cross-field and
serialization defects. Independent Python read-back checked all 38 declared
relationships across all 20,000 rows with zero violations. This is a measured
claim about those data, not a guarantee about every floating-point reader.

Quality is still limited: KS, TVD and pairwise fidelity have red bands;
propensity measures are unavailable for the oversized pairwise design, and
the engine's disclosure assessment lacks a holdout. Five synthetic-trained
models combined have B/C AUROC 0.8162/0.8140 versus 0.8409/0.8320 for the
real-A-trained model. Paired fixed-model AUROC differences are -0.0247
[-0.0382, -0.0118] and -0.0180 [-0.0330, -0.0030]. Previously inspected
challenge splits and stay bootstraps omit generator, model fitting and site
uncertainty. These results do not support a general high-fidelity or privacy
claim.

The HR prediction task applies the A-trained equation to 3,748/4,000 B and
3,758/4,000 C records. MAE is 11.184/10.941 bpm versus a persistence baseline
of 12.600/12.378 bpm. Missing required observations are excluded explicitly.
This is a scoped ICU prediction exercise, not treatment-response validation.

ACTG175 includes all 2,139 participants and 521 composite events. The
1,000-day unadjusted RMST difference is 85.8338 days; baseline-weighted
difference is 87.2654 days, ESS 524.34. The event is CD4 decline, AIDS
progression or death. Pooling randomized arms inside this trial does not
validate transportability of an external control.

## Real DSH and DeepSeek conversation acceptance

All model conversations used DeepSeek Flash through the control-plane gateway,
not direct-model stand-ins. They used synthetic questions, temporary accounts,
automated attribution, separate requested project/session scopes and disabled
memory/learning. No real patient record was sent by these conversations. Public
full-input clinical datasets were processed in the isolated numerical runtime.

| Campaign | Actual terminal evidence | Scope |
| --- | --- | --- |
| R10 frozen conversation set | 20/20 runs completed; all seven declared ordinary output files exported with length/SHA-256 checks | Run completion is not a correctness score. The cases include explanations, missing inputs, calculations, follow-ups, composition and cancellation |
| R10 native chains, multiple domains installed | 4/4 describe(method/schema) → start → terminal read → report | Real native tool definitions and hosted/R execution, not stubbed calls |
| R10 domain-exclusive projects | 4/4 chains; each project exposed only its target professional bundle | Other research bundles were absent; matching is not required |
| Independent R10 numerical replay | All 35 extracted start scenarios attempted; one invalid request rejected again; overlapping parseable completed values agreed within 1e-8 | Same recorded engine source and package versions, not clinical validation or recovery of historical table bytes |
| R11 targeted post-audit | Two corrected interpretation cases plus frozen trial-request read-back completed | Nonsignificance no longer establishes consistency; equal seeds no longer justify independent contrast intervals; actual database/request scenario, hash, seed and replicates agree |

The frozen R10 engine image was
`sha256:d66e31b64afcd38415de841a3f8130422fc9e915353f960a414c4df85dfd4773`.
Its 52 R-source files match frozen source manifest
`f740d8754096cd478d38c0faa3defb44c5c673106942a8932c864a8240cd22a8`;
all 70 installed library package versions match the independent replay, R 4.3.3
aarch64. Library binary bytes were not compared. The main R10 runtime image was
`sha256:6ac0424033f9e66681ee77e27cda8a703213331bcdc0ae4c7d034a152584b360`;
R11 was `sha256:c47119638d055344e294ab8f0507b511edb95a70cd73b9232f4f479994592940`.
Source snapshots, runner/case digests, complete outputs and budget ledgers are
kept privately under `.evimed-local/vcr-native-final-r10*` and
`.evimed-local/vcr-native-r11-post-audit*`.

R10 main plus domain-exclusive runs had 255 settled model requests and a
reference-price ledger of CNY 1.36034344. R11 had 31 settled requests and CNY
0.15928004. These are separate scoped campaigns, not the cost of every earlier
exploratory run and not provider invoices. Earlier incomplete exploratory
records and uncertain reservations are retained separately.

The [numerical review](../../../OpenScience/evals/vcr-hosted-native/NUMERICAL-REVIEW.md)
records all case-level findings. Important remaining behavior includes adding
hypothetical demonstrations before asking for absent design inputs and sometimes
asking for optional age bounds. Disclosed extra assumptions are still unnecessary
work; they are not scored as fully correct responses merely because a job ended.
The full paid campaign was not rerun after the later bookkeeping-only complete
population-scenario/version comparison; that change has real PostgreSQL
regressions and a separate actual two-turn UI check.

## Actual browser result check — 2026-11-06

A fresh isolated account, default project and one general conversation used only
virtual-cohort. Two backend runs were marked automated and ended succeeded. The
first requested 200 untruncated normal ages, mean 60, SD 9 and seed 12345; the
second changed only the mean to 65. Both immutable population/result versions
were retained in the same study, with no minimum/maximum invented.

In the built-in browser, the real research list opened the actual second result;
its setting remained mean 65/SD 9 and its generated mean/SD were 64.43/8.104.
The comparison selector offered both v1 and v2 and enabled the selected pair.
No additional browser prompt was sent. The downloaded CSV had 200 rows, mean
64.42537798863343 and sample SD 8.103625477679403, matching the page; SHA-256
`7bd2a9801f68b8ae886ab6e1b13884546136a93cf2705a12a301eca500e2c01e`.
At 390×844, document scroll width equaled viewport width 390. The normal browser
viewport was restored and the test tab closed. The setup used 25 settled model
requests, CNY 0.11449336 under the all-purpose 1 CNY guard. Credentials and raw
synthetic rows remain private; the environment was restricted to loopback.

This proves current result rendering, two-version selection, CSV download and
narrow layout for this cohort case. It does not claim a browser replay of every
comparison, failed job, limited simulation or old-result detail. Those states
have their separate backend/component tests.

- [Real research home](2026-11-05-vcr-plugin-acceptance-assets/real-study-home.png)
- [Real second result](2026-11-05-vcr-plugin-acceptance-assets/real-population-result.png)
- [Real saved-version selection](2026-11-05-vcr-plugin-acceptance-assets/real-population-versions.png)
- [Real 390px result](2026-11-05-vcr-plugin-acceptance-assets/real-population-390.png)

## Interrupted completion and preserved results

A real stop/start/cold-baseline-rebase experiment produced three succeeded
analytic jobs. The new turn was initially fenced while desired/effective runtime
extension identities differed. That authorization fence was retained. One started
continuation was canceled by the explicit runtime stop; all three completion
outbox entries eventually became delivered, two through saved-result disclosures.
There were not three successful automatic explanatory continuations. Results
were not lost, and the test does not establish exactly-once AI explanation after
an explicit stop. The continuation UX/observability remains an improvement area.
The retained completion test resources were cleaned after exporting evidence.

## Local regression and CI evidence

The integrated package test target includes the new offline export, budget,
snapshot and full-input path checks. Real Docker/model campaigns remain explicit
operations. Focused server/gateway/object checks, model-facing privacy projection,
all socket checks, harness-port checks, web types/lint/build and the relevant web
regressions passed locally; overlapping suite totals are not added into one score.
The port suite recorded 444 passed and 10 existing skips, with no failure.

The prior source candidate `77ea4a2d7` had numerical CI 497/499, a stale generated
scenario help file and an incompatible model-design source-scope seam. All four
findings were corrected: generated help refreshed; the explicit unverified
prognostic-equation scope accepted without inventing literature provenance;
N62 compatibility expectation corrected; N78 partial-imputation budget test made
deterministic after three actual imputations without removing the independent
real CPU-budget checks. The two affected numerical tests passed on R 4.3.3.
These focused passes do not substitute for the integrated revision's workflow.

The next candidate `0c5a7fea6` passed its real-engine control-plane seam. Its
web job exposed a Linux-only test-toolchain defect: older Corepack points the
lifecycle `npm_execpath` at a non-executable `pnpm.cjs`. Forcing that actual
0644 script reproduced the same three immediate `EACCES` installation failures.
The fixture now validates the pinned pnpm package and executes its declared
`bin.pnpm` instead. Normal Linux, the forced older entrypoint with direct pnpm
9.4 on PATH, and macOS each passed all five real-manager tests. Production
installation logic, timeouts and cancellation assertions were unchanged.

Final local archives were independently installed in clean DSH profiles. The
native ToolRuntime executed trial design, network synthesis, cohort generation,
binary patients and E-value calculations against the pinned R engine. This
outside-kernel probe explicitly linked SDK modules supplied by the CLI; it is
not a standalone live-model conversation. The suite alone exposed no domain
tools; adding trial made trial tools discoverable. Uninstalling each domain
preserved all its existing job/result/report files. The manifest records a
clean source revision, DSH pin, scientific method versions and every archive's
SHA-256. Public publication remains separate.

The real browser fixture's account, runtime, containers, private volume and
networks were removed after evidence export; temporary credentials were
removed, and port 59273 no longer listened. Only private evidence and the
non-sensitive screenshots remain.

Current source evidence is the revision-specific [web workflow receipt](https://github.com/anonymous-temp/EviMed-Science/actions/workflows/web.yml?query=branch%3Acodex%2Fvcr-professional-plugins-20261105).
Do not borrow the algorithm baseline's 492/492 as the new revision's result, or
interpret skipped production E2E as successful production qualification.

## Remaining scientific and release boundaries

- Synthetic fidelity and utility have the red/unavailable results stated above;
  generation completion is not a quality pass. No universally validated virtual
  patient, individual treatment counterfactual or replacement randomized control
  is claimed. Prospective independent disease/site validation is still needed.
- The historical twenty-paper parser benchmark did not measure the platform's
  configured parser successfully. No parser URL/token is configured here; another
  parser's published cell score is not used as the platform's score. Real-table
  selection, real publication KM and clinical precedent validity retain their
  earlier stated evidence limits.
- Matching/TrialGPT/TREC/n2c2 work belongs to the separately owned matching plugin
  release. Its evaluations are not rerun or relabeled as this four-plugin score.
- Standalone installation is for an operator-owned workspace. Hosted references
  carry no automatic cross-plugin data permission. Record-selection configuration
  is withheld from model-facing reproduction while safe numerical assumptions,
  result state and authorized source references remain available.
- Hosted report returns Markdown plus reproduction JSON in the tool response;
  ordinary file tools are required for a downloadable attachment. Standalone
  adapter writes the report and reproduction files. The shared wording does not
  promise an attachment that was not created.
- Local installable archives, hash-checking installer and compatibility receipts
  are generated with `OpenScience/packages/research-plugin-runtime/scripts/pack-release.mjs`.
  Public registry/GitHub release publication, production catalogue admission,
  main integration and deployment are separate release stages and were not done.
  The source branch is pushed for review; provider keys, private test databases,
  input clinical rows and generated patient rows are excluded from commits.
