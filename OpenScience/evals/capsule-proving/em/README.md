# Engine-layer evaluation debts (EM), 2026-11-11

Branch: `cc/capsule-eval-debts-20261111`, based on integration head
`1e4c750aa349729140de743bac70a7b3d30ee699`. The lab source copy is
`/srv/evimed/wt/em/OpenScience`. No production service is changed.

- `halumem.py keyword no-memory` resumes the concise variants on the original
  eight-user runs, scores with the official prompt, and appends ledger rows.
  `halumem.py product` preserves the stale-checkpoint guard: 50 historical
  questions cannot be replayed against the advanced live engine. See the
  15-failure manual review in `halumem-review.md`.
- `patient-counts.py FILE` captures all 15 score outputs' patient-mixing counts
  and flagged evidence. The before capture is `/srv/evimed/runs/em-patient-before.json`.
  The nine prior flags have been read manually; see `patient-review.md`.
- `l2-ledger.py` backfills four existing-verdict rows per missing L2 run. It
  corrects the copied run id using the evidence directory, preserves the
  original rows, and is idempotent. It never starts a product-path conversation.
- `continue.py SCORE_ALL_PID` waits for the owned score-all process, retries
  incomplete judgments, captures the final counts, makes the idempotent L2
  backfill, and starts the write-side matrix. Progress is in
  `/srv/evimed/runs/EM-STATUS`; its log is `logs/em-continue.log`.
- `write-loo.py --start` runs the full 36-ingest matrix. An explicitly requested
  narrower comparison can use `--matched-only` (18 ingests). It uses fresh
  namespaces, the full histories of the 17 planted-instruction dev users, and
  only injection-category questions on those users. The other sets are M10
  and G6. No sealed split is read.

The EM-owned engines are `ovem1` on port 19360 (a frozen copy of the candidate
memory templates in `/srv/evimed/wt/em/templates/candidate`) and `ovem2` on
19361 (shipped templates). Only the safety ablation uses the shipped templates
and disables its matching switch. Every other ablation disables exactly one
write-side switch and retains the candidate templates and round-3 flags.

Item 4 has its own CNY 150 cap. The launcher counts observed extraction,
answer and deduplicated Qwen judge usage at the platform's pinned reference
rates, reserves CNY 5 for unsettled calls, and stops only its own child when
that reserve is reached. It records the estimate in `EM-BUDGET.json`. Missing
usage from failed provider requests is a limitation of that estimate. The cap
is not presented as an exact vendor invoice. Prior HaluMem and historical
re-scoring costs are separate and must be reported too. In particular, an
initial global judge-prompt edit invalidated caches and caused an unnecessary
re-grade; its cancelled pass's usage is not fully retained. The final rubric
is packet-specific and reuses unrelated cached judgments.

The process waits before a new ingest if the one-minute load exceeds 48 or
available memory is below approximately 1 GB. It never stops or reconfigures
another lane's engines or processes. Completed cases, score packets and ledger
rows resume through the existing runner conventions. A cap stop or an
incomplete judge pass is not successful completion of the experiment.

Validation at the final code revision: 169 Node tests passed, one skipped;
4/4 live attribution-pilot verdicts matched expectations, and two budget-rate
checks passed. Bulk score outputs from `/7` are intermediate: only `/8`
outputs satisfy the continuation's completion check. Ledger CLI rows now use
the summary's scoring schema rather than the run's old commit as the scorer
identity, so a correction back to an earlier numeric result is appended.
