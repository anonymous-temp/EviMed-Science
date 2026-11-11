# Review notes for the L7 pilot

Read `report.md` for the six arm tables, Wilson intervals, per-domain outcomes,
model tokens/CNY, learning/reuse counts and three diagnostic layers.
`summary.json` and `report.csv` retain individual task outcomes. These are
reference-harness measurements: **model + skills, not product execution scores**.

The original paired plan has eight SkillsBench tasks and six SkillLearnBench
families. Six SkillsBench domains and five SkillLearnBench categories receive
primary native grading. Azure and video were declared unavailable as whole
primary groups before any arm ran: 169.7 minutes remained, below the conservative
212-minute allocation for three one-hour agent windows, verification and
setup/report reserve. The NLP verifier declares 10 GiB; all three arms are unrun
under the 5,911,142,400-byte frozen scratch profile. Later physical free space does
not change that uniform allowance. The planned-denominator rate and scorer-only
rate are both reported; neither is a full-benchmark headline.

Pass means SkillsBench official reward equals 1, or SkillLearnBench official
`passed` is true. A native agent timeout with an intact verifier reward is a valid
failure. An unrun verifier, failed environment or unavailable admission is an
infrastructure outcome. These categories are not silently interchanged.
All eight SkillsBench oracle controls passed; earlier failed setup attempts remain
on the lab. Azure's oracle alone briefly used the second allowed container slot,
without model calls, while primary scored model trials remained serial.

The complete five-task pre-logging-fix phase was archived, including its PDDL
pass; the affected flat-permission phase was also archived in full. Fresh primary
qualification, or explicit unavailable admission, is separate from those records.
`calibration-results.json` preserves the earlier native grades. Calibration,
smokes, practice and diagnostic calls remain included in lane cost.

Five methods were distilled and approved by the product's own worker after
simulated attended practice and explicit requests to retain reusable workflows.
Approval here is a product status, not independent human review. Failed and
time-limited practice is retained; practice outputs were not graded in official
containers. The library combines both practice pools and stays frozen during
held-out scoring. This is transfer from practice, not the full continual-learning
curriculum or forgetting measurement. Extending to all 87 SkillsBench tasks needs
independent practice because the pilot's practice tasks are inside that corpus.

The exact five mounted `SKILL.md` files are under `learned/`, with their recorded
hashes in `learned-methods.json`. Product-export frontmatter values and method
bodies agree; mount serialization adds a terminal newline. The product's original
`license: internal` metadata and synthetic provenance identifiers are preserved.
No runtime installation or default product skill pack is changed by these files.

Open counts are conservative observations of completed read-tool calls on mounted
skills. Shell reads are not counted. BenchFlow's native ACP invocation counter
can remain zero despite preserved successful skill reads; `native-results.json`
retains that counter, while the report uses the trace observer described in the
runner. Catalog descriptions are visible before a body is opened, so zero
observed reads does not prove zero method influence. A body read does not prove
that its workflow was successfully applied.

Task outcomes use the pinned native verifiers. Diagnostic skill/trajectory scores
use pinned prompts/parsers with DeepSeek Flash, thinking off, instead of the
published GPT-5-mini judge. The solver and diagnostic judge share a model family;
no judge-agreement calibration was performed. Oracle-workflow alignment can
penalize a successful alternative workflow. Parser failures remain unknown;
valid diagnostic scores are not rerun to select a preferred answer.

`ledger-rows.json` contains one final row per arm. `run-configs.json`, the data and
upstream receipts, flat-copy hashes, resource/admission decisions, protocol
amendments, dependency freeze and test receipt make the configuration reviewable.
Pinned task sources, account credentials, complete private practice state and raw
conversations stay on the lab. Native container cleanup and space recovery can
remove rebuilt image/input caches; runtime-fetched external files and mutable
base-image/dependency resolutions were not separately archived as a complete
replay snapshot. A submission must retain those resolved snapshots as well. `SHA256SUMS` covers this small review bundle.
No leaderboard submission, product deployment or branch merge occurred.
