# Bounded real-model general-task comparison

This is a single-sample, VCR-disabled smoke comparison using real DeepSeek Flash and pinned DSH through the local control plane. A is the native composition control; B is the archived `d757ca09e` baseline; C is the PR working-tree snapshot. Six general cases (G01/G02/G05/G08/G13/G16) ran in each arm. M01 ran in B and C. The per-turn test budget was five minutes. This is not the full 29-case suite or a VCR-enabled-account qualification.

| Evidence | A | B | C |
|---|---:|---:|---:|
| General runs succeeded | 6/6 | 5/6 | 5/6 |
| General deterministic/artifact judgments passed | 5/6 | 4/6 | 3/6 |
| M01 run and deterministic judgment passed | not run | 1/1 | 1/1 |
| Unjudged completed case records | 0 | 0 | 0 |
| Test-account DELETE acknowledgements | 6/6 HTTP 200 | 7/7 HTTP 200 | 7/7 HTTP 200 |

Execution success is separate from artifact correctness. C's G02 run succeeded and delivered a Word file, but its required heading-style check failed. G13 exceeded its ceiling of three retrieval calls in all three arms; its other required checks passed. B and C's G16 were canceled at the test's five-minute limit and failed the completion/report checks; these are bounded-run outcomes, not evidence of a runtime crash. M01 is one medical control with deterministic checks, not broad clinical validation. No model quality judge was run.

For all seven paired B/C cases, the actual first-agent-request tool names and sizes were identical: 46 tools, 38,528 tool-schema characters and 7,190 system characters, with no VCR tool observed. This supports the scoped claim that the disabled-account catalogue did not gain VCR overhead in these samples. A's observed first catalogue varied: 15 tools / 12,138 schema characters for G01, and 60 tools / 79,458 schema characters for its later cases (system: 3,047 characters). Therefore A is not a matched catalogue-cost comparison.

The run used host-process runtimes with host network access and local library/judge constraints; the production container boundary and native chat-page journey were not exercised. One stochastic sample cannot establish general superiority, noninferiority or a causal quality regression. The enabled-account compact root catalogue, enabled native VCR workflow, load/recovery, full six medical controls and the full 29-case suite remain separate gaps. No additional model runs were started to close them in this round.

The [sanitized JSON](general-tasks-bounded-default-off.json) contains only case IDs, run/judge outcomes, request sizes, cleanup statuses and evidence hashes. It excludes raw prompts, model replies, transcripts, credentials and private account identifiers.
