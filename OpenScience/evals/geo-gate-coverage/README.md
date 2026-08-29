# geo-gate-coverage

Measures how many of the geo-skills BLOCK rules are actually proved by a test.

The package under measurement ships 88 rules, 78 of them BLOCK, and a suite of
309 tests that all pass. That last number says nothing about the first two. The
question this harness answers is different and harder: **switch a rule off
entirely — does anything go red?**

Today the answer is **59 of 78 yes, 19 no**.

A surviving rule is not necessarily wrong. It is unproved: it can be deleted,
inverted, or quietly broken by a refactor and every test still passes. For a
rule whose own text reads "把推演写成实测是本技能唯一不可接受的错误", being
unproved is worse than being absent, because absent rules do not create the
impression of a guard.

## Running it

```bash
python3 evals/geo-gate-coverage/run_gate_coverage.py --package /path/to/geo-skills-2.0.0
```

Needs `pytest` and `pyyaml`; about six minutes (one full suite run per rule).
`--record-baseline` rewrites `baseline.json`, `--json <file>` keeps the full
result. No network, no credentials, no probe host — the sweep is static.

`baseline.json` is a ratchet: survivors may shrink freely, and a rule that used
to be proved and now is not fails the run. That is the only way "we will add
the missing tests later" survives contact with a second refactor.

`provenance.json` records the archive this was measured against, because the
package is not vendored into this repository and a number that names no
artefact cannot be recomputed.

## Two ways this measurement lies, and what stops them

Both of these produced a wrong number before this file existed, so the harness
refuses to report anything until it has ruled them out.

**The count pin.** `test_readme_test_count_is_current` asserts the README's
stated test count matches reality. Every mutation changes the count, so that
one test goes red for *every* rule — and the sweep reports a perfect score.
The first run after adding adversarial tests printed **78/78 caught**, which was
false; the honest figure was 59/19. Deselecting the pin fixes it, but a stale
node id makes the deselect a silent no-op and restores the same lie, so the
harness collects the node id first and treats a miss as fatal.

**The silent injection.** The adversarial tests in `tests/` are copied into the
package tree for the run. A copy that fails means measuring the unpatched
suite, which again inflates the score. The collected test count is compared
before and after and a delta of zero is fatal.

The shape is the recurring one in this codebase: *a failure that looks exactly
like nothing having happened.*

## tests/test_uncovered_gates.py

Negative controls for rules that had none, written to the package's own
`GateTestCase` idiom: build violating data, assert the rule id appears in the
block list. Testing that compliant data passes is not enough — a check that
always returns `[]` passes that too.

Each one was verified to bite: switch its rule off and the test names it.
