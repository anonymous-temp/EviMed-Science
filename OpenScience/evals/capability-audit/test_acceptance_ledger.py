#!/usr/bin/env python3
"""Unit tests for the per-capability acceptance ledger check.

Every negative case asserts the specific issue text, so a check that started
failing for an unrelated reason cannot be mistaken for the case passing. The
real-repository cases assert the capability scan found the whole tree, so a
broken walk cannot agree with an empty ledger.
"""

from __future__ import annotations

import inspect
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import verify_acceptance_ledger as checker  # noqa: E402
import verify_release_audit as release_audit  # noqa: E402

REPO = HERE.parents[1]


def entry(identifier, **overrides):
    row = {
        "id": identifier,
        "visibility": "public",
        "evalHarness": None,
        "briefCount": 0,
        "realDelivery": {"status": "not-run", "evidence": None, "at": None, "surface": None},
    }
    row.update(overrides)
    return row


def delivery(status, evidence, at, surface):
    return {"status": status, "evidence": evidence, "at": at, "surface": surface}


def build_fixture(root, entries, capability_ids, harnesses=None, progress_stamps=()):
    """Write a miniature checkout: capability manifests, harnesses, ledger, log."""
    for identifier in capability_ids:
        directory = root / "capabilities" / identifier
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "capability.yaml").write_text(
            "id: %s\nversion: 1.0.0\n" % identifier, encoding="utf-8"
        )
    for name, briefs in (harnesses or {}).items():
        harness = root / name
        harness.mkdir(parents=True, exist_ok=True)
        if briefs is not None:
            (harness / "briefs.json").write_text(
                json.dumps({"schemaVersion": "1.0.0", "briefs": briefs}), encoding="utf-8"
            )
    (root / "evals").mkdir(parents=True, exist_ok=True)
    (root / "evals" / "acceptance-ledger.json").write_text(
        json.dumps({"schemaVersion": 1, "capabilities": entries}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (root / "PROGRESS.md").write_text(
        "".join("%s · fixture entry\n" % stamp for stamp in progress_stamps), encoding="utf-8"
    )
    return root


class LedgerFixtureTests(unittest.TestCase):
    """The checker against hand-built checkouts, one defect at a time."""

    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        self.addCleanup(self._temporary.cleanup)

    def issues(self, **overrides):
        return checker.ledger_issues(self.root, minimum_capabilities=2, **overrides)

    def test_consistent_fixture_passes(self):
        build_fixture(
            self.root,
            [
                entry("alpha", evalHarness="evals/alpha-quality", briefCount=3),
                entry(
                    "beta",
                    visibility="internal",
                    realDelivery=delivery("accepted", "PROGRESS.md@2026-08-06 09:22", "2026-08-06T09:22:00", "http-api"),
                ),
            ],
            ["alpha", "beta"],
            harnesses={"evals/alpha-quality": [{"id": "a"}, {"id": "b"}, {"id": "c"}]},
            progress_stamps=["2026-08-06 09:22"],
        )
        (self.root / "capabilities" / "beta" / "capability.yaml").write_text(
            "id: beta\nvisibility: internal\n", encoding="utf-8"
        )
        self.assertEqual(self.issues(), [])

    def test_capability_without_a_ledger_entry_fails(self):
        build_fixture(self.root, [entry("alpha")], ["alpha", "beta"])
        self.assertIn("capability beta has no acceptance-ledger entry", self.issues())

    def test_entry_for_an_unknown_capability_fails(self):
        build_fixture(self.root, [entry("alpha"), entry("ghost")], ["alpha", "beta"])
        issues = self.issues()
        self.assertIn("ledger entry ghost names a capability that does not exist", issues)

    def test_wrong_brief_count_fails(self):
        build_fixture(
            self.root,
            [entry("alpha", evalHarness="evals/alpha-quality", briefCount=7), entry("beta")],
            ["alpha", "beta"],
            harnesses={"evals/alpha-quality": [{"id": "a"}, {"id": "b"}, {"id": "c"}]},
        )
        self.assertIn("alpha records briefCount 7 while evals/alpha-quality holds 3 briefs", self.issues())

    def test_missing_brief_file_must_be_counted_as_zero(self):
        build_fixture(
            self.root,
            [entry("alpha", evalHarness="evals/alpha-smoke", briefCount=2), entry("beta")],
            ["alpha", "beta"],
            harnesses={"evals/alpha-smoke": None},
        )
        self.assertIn("alpha records briefCount 2 while evals/alpha-smoke holds 0 briefs", self.issues())

    def test_accepted_without_evidence_fails(self):
        build_fixture(
            self.root,
            [entry("alpha", realDelivery=delivery("accepted", None, None, "harness")), entry("beta")],
            ["alpha", "beta"],
        )
        self.assertIn("alpha claims realDelivery accepted with no evidence", self.issues())

    def test_accepted_with_an_unresolvable_path_fails(self):
        build_fixture(
            self.root,
            [
                entry(
                    "alpha",
                    realDelivery=delivery("accepted", "evals/alpha-quality/results/never-ran", "2026-08-30", "harness"),
                ),
                entry("beta"),
            ],
            ["alpha", "beta"],
        )
        self.assertIn(
            "alpha realDelivery evidence points at a path that does not exist", self.issues()
        )

    def test_accepted_with_a_path_that_resolves_passes(self):
        # The other half of the case above. Without it, a checker that refused
        # every path-form evidence would pass the whole negative battery, and
        # "the path form works" would be an untested claim.
        build_fixture(
            self.root,
            [
                entry(
                    "alpha",
                    evalHarness="evals/alpha",
                    briefCount=1,
                    realDelivery=delivery("accepted", "evals/alpha/briefs.json", "2026-08-30", "harness"),
                ),
                entry("beta"),
            ],
            ["alpha", "beta"],
            harnesses={"evals/alpha": [{"id": "a"}]},
        )
        self.assertEqual(self.issues(), [])

    def test_accepted_with_an_undated_progress_line_fails(self):
        build_fixture(
            self.root,
            [
                entry(
                    "alpha",
                    realDelivery=delivery("accepted", "PROGRESS.md@2026-08-06 09:22", "2026-08-06T09:22:00", "http-api"),
                ),
                entry("beta"),
            ],
            ["alpha", "beta"],
            progress_stamps=["2026-08-07 09:05"],
        )
        self.assertIn(
            "alpha realDelivery evidence names a PROGRESS.md entry that is not there", self.issues()
        )

    def test_progress_evidence_must_agree_with_the_recorded_instant(self):
        build_fixture(
            self.root,
            [
                entry(
                    "alpha",
                    realDelivery=delivery("accepted", "PROGRESS.md@2026-08-06 09:22", "2026-09-01T00:00:00", "http-api"),
                ),
                entry("beta"),
            ],
            ["alpha", "beta"],
            progress_stamps=["2026-08-06 09:22"],
        )
        self.assertIn(
            "alpha realDelivery at 2026-09-01T00:00:00 disagrees with its PROGRESS.md stamp 2026-08-06 09:22",
            self.issues(),
        )

    def test_missing_eval_harness_directory_fails(self):
        build_fixture(
            self.root,
            [entry("alpha", evalHarness="evals/not-there", briefCount=0), entry("beta")],
            ["alpha", "beta"],
        )
        self.assertIn("alpha names evalHarness evals/not-there, which is not a directory", self.issues())

    def test_not_run_may_not_carry_a_surface(self):
        build_fixture(
            self.root,
            [entry("alpha", realDelivery=delivery("not-run", None, None, "native-ui")), entry("beta")],
            ["alpha", "beta"],
        )
        self.assertIn("alpha records realDelivery not-run but still names evidence, an instant or a surface", self.issues())

    def test_related_evidence_must_resolve(self):
        build_fixture(
            self.root,
            [entry("alpha", relatedEvidence=["evals/alpha-quality/results/gone"]), entry("beta")],
            ["alpha", "beta"],
        )
        self.assertIn(
            "alpha relatedEvidence[0] points at a path that does not exist", self.issues()
        )

    def test_duplicate_entries_fail(self):
        build_fixture(self.root, [entry("alpha"), entry("alpha"), entry("beta")], ["alpha", "beta"])
        self.assertIn("ledger lists capability alpha more than once", self.issues())

    def test_visibility_must_match_the_manifest(self):
        build_fixture(self.root, [entry("alpha", visibility="internal"), entry("beta")], ["alpha", "beta"])
        self.assertIn("alpha records visibility internal while its manifest says public", self.issues())

    def test_an_unadopted_per_capability_harness_is_a_notice_not_a_failure(self):
        build_fixture(
            self.root,
            [entry("alpha", evalHarness="evals/shared-smoke", briefCount=0), entry("beta")],
            ["alpha", "beta"],
            harnesses={"evals/shared-smoke": None, "evals/alpha": [{"id": "a"}]},
        )
        self.assertEqual(self.issues(), [])
        self.assertEqual(
            checker.harness_notices(self.root),
            [
                "notice: evals/alpha exists but alpha names evalHarness 'evals/shared-smoke'; "
                "repoint the row once that harness is final"
            ],
        )

    def test_an_adopted_per_capability_harness_raises_no_notice(self):
        build_fixture(
            self.root,
            [entry("alpha", evalHarness="evals/alpha", briefCount=1), entry("beta")],
            ["alpha", "beta"],
            harnesses={"evals/alpha": [{"id": "a"}]},
        )
        self.assertEqual(self.issues(), [])
        self.assertEqual(checker.harness_notices(self.root), [])

    def test_a_short_capability_scan_fails_instead_of_passing_vacuously(self):
        build_fixture(self.root, [entry("alpha")], ["alpha"])
        issues = checker.ledger_issues(self.root, minimum_capabilities=16)
        self.assertIn(
            "capability scan found 1 capability directories, fewer than the 16 expected; it is not reading the tree",
            issues,
        )


class RealLedgerTests(unittest.TestCase):
    """The ledger this repository actually ships."""

    def test_capability_scan_reads_the_real_tree(self):
        discovered = checker.discover_capabilities(REPO / "capabilities")
        self.assertGreaterEqual(
            len(discovered), 16, "the capability scan did not read %s" % (REPO / "capabilities")
        )
        self.assertIn("source-understanding", discovered)
        self.assertIn("adr-analysis", discovered)

    def test_repository_ledger_passes(self):
        self.assertEqual(checker.ledger_issues(), [])

    def test_repository_ledger_covers_every_capability(self):
        document = checker.load_ledger(REPO)
        recorded = {row["id"] for row in document["capabilities"]}
        self.assertEqual(recorded, set(checker.discover_capabilities(REPO / "capabilities")))
        self.assertGreaterEqual(len(recorded), 16)

    def test_harness_notices_are_advisory_only(self):
        # Whether this repository currently has unadopted per-capability harness
        # directories depends on what has landed, so the assertion is on the
        # shape and on the one property that matters: a notice never blocks.
        notices = checker.harness_notices()
        self.assertIsInstance(notices, list)
        for notice in notices:
            self.assertTrue(notice.startswith("notice: "), notice)
        self.assertEqual(checker.ledger_issues(), [])

    def test_coverage_notice_reports_the_real_counts(self):
        document = checker.load_ledger(REPO)
        statuses = [row["realDelivery"]["status"] for row in document["capabilities"]]
        # The ledger is a record, not a target: most rows are honestly "not-run"
        # today, and this test exists so a future edit that flips rows to
        # "accepted" has to change a number here on purpose.
        self.assertGreater(statuses.count("not-run"), len(statuses) // 2)
        self.assertIn("notice:", checker.coverage_notice())

    def test_the_accepted_rows_are_named_here_and_their_evidence_resolves(self):
        """Pin which capabilities claim acceptance, by name.

        `ledger_issues` proves an accepted row's evidence resolves; it cannot
        prove the row should have been accepted at all, because "a run of the
        capability package delivered this" is a judgement about what produced an
        artifact, not a property of the artifact. So the set is pinned here:
        adding a name costs an edit to this list, which is the moment somebody
        has to say out loud what run they are claiming.

        geo-content was on this list and is not any more. Its deliverable is
        real and passes the contract validator, but `measure.mjs` collected it
        and `build_pack.py` assembled it — the harness delivered, not the
        capability — so it moved to relatedEvidence, which is where this ledger
        already puts a succeeded managed engine job.
        """
        document = checker.load_ledger(REPO)
        accepted = sorted(
            row["id"] for row in document["capabilities"]
            if row["realDelivery"]["status"] == "accepted"
        )
        self.assertEqual(accepted, ["adr-analysis", "dataset-research-scoping"])
        progress = REPO / "PROGRESS.md"
        for row in document["capabilities"]:
            if row["realDelivery"]["status"] != "accepted":
                continue
            self.assertIsNone(
                checker._resolve_reference(row["realDelivery"]["evidence"], REPO, progress),
                "%s claims acceptance on evidence that does not resolve" % row["id"],
            )

    def test_a_capability_that_ships_its_own_briefs_names_that_harness(self):
        """The drift `harness_notices` reports, pinned once it stopped being a guess.

        The notice stays a notice: an `evals/<id>` directory can be an empty
        scaffold, and the checker is right not to block on one. But a directory
        that ships real briefs and is not the row's `evalHarness` means the
        recorded brief count is counting a different harness's briefs — seven
        rows read `briefCount: 0` for exactly that reason while twenty-eight
        real briefs sat unclaimed on disk. Twelve directories ship briefs today
        and all twelve are adopted, so this is an observed distribution rather
        than a rule invented ahead of one, and it is asserted here rather than
        in the checker so `audit:capabilities` keeps the same blocking surface.
        """
        document = checker.load_ledger(REPO)
        rows = {row["id"]: row for row in document["capabilities"]}
        adopted, unadopted = [], []
        for identifier, row in rows.items():
            harness = REPO / "evals" / identifier
            counted, problem = checker.briefs_on_disk(harness)
            if problem or not counted:
                continue
            expected = "evals/%s" % identifier
            (adopted if row.get("evalHarness") == expected else unadopted).append(
                "%s ships %d briefs in %s but the ledger names %r"
                % (identifier, counted, expected, row.get("evalHarness"))
            )
        self.assertEqual(unadopted, [], "repoint these rows and record the brief count on disk")
        # The walk assertion: with no directories found this would pass saying
        # nothing, which is how the seven stale rows survived in the first place.
        self.assertGreaterEqual(len(adopted), 12, "no capability brief directories were read at all")

    def test_geo_content_keeps_its_deliverable_as_related_evidence(self):
        # Downgrading a row must not throw the artifact away: the pack is still
        # the most advanced thing this capability has produced, and a row that
        # dropped it would read as if nothing had ever been built.
        row = next(
            item for item in checker.load_ledger(REPO)["capabilities"] if item["id"] == "geo-content"
        )
        self.assertEqual(row["realDelivery"]["status"], "not-run")
        self.assertIn(
            "evals/geo-content/results/2026-08-30-geo-001/deliverable", row["relatedEvidence"]
        )


class ExitCodeTests(unittest.TestCase):
    """What callers actually consume: the process exit code, not the printout.

    Nothing else here covers `main`. A checker that found every issue, printed
    every one of them and then returned 0 would satisfy all the cases above and
    would gate nothing.
    """

    def test_main_returns_zero_when_the_ledger_is_clean(self):
        with mock.patch.object(checker, "ledger_issues", return_value=[]):
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                code = checker.main()
        self.assertEqual(code, 0)
        self.assertIn("acceptance ledger is complete and consistent", buffer.getvalue())

    def test_main_returns_one_and_names_every_issue(self):
        with mock.patch.object(checker, "ledger_issues", return_value=["first thing", "second thing"]):
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                code = checker.main()
        self.assertEqual(code, 1)
        printed = buffer.getvalue()
        self.assertIn("acceptance ledger: first thing", printed)
        self.assertIn("acceptance ledger: second thing", printed)
        # A refusal must not also print the reassuring line.
        self.assertNotIn("complete and consistent", printed)


class ReleaseAuditWiringTests(unittest.TestCase):
    """The check has to be reachable from the release audit, and last in it.

    Two separate properties, and deleting either one is silent otherwise: that
    `main` calls this check at all, and that it calls it *after* the checks
    whose refusals predate it. The audit is a fail-fast wall, so inserting a new
    refusal ahead of `verify_tools` would change which failure an operator is
    shown on a checkout with a stale tool probe — the freshness refusal that is
    doing its job right now.
    """

    def test_verify_acceptance_refuses_when_the_ledger_is_inconsistent(self):
        with mock.patch.object(
            release_audit.acceptance_ledger, "ledger_issues", return_value=["alpha claims a delivery that is not there"]
        ):
            with self.assertRaises(SystemExit) as raised:
                with redirect_stdout(io.StringIO()):
                    release_audit.verify_acceptance()
        self.assertIn("alpha claims a delivery that is not there", str(raised.exception))

    def test_the_audit_runs_the_acceptance_check_after_the_freshness_refusals(self):
        called = []
        patches = {
            name: mock.patch.object(release_audit, name, side_effect=lambda name=name: called.append(name))
            for name in ("verify_tools", "verify_sources", "verify_connectors", "verify_skills", "verify_acceptance")
        }
        with patches["verify_tools"], patches["verify_sources"], patches["verify_connectors"], \
                patches["verify_skills"], patches["verify_acceptance"]:
            with redirect_stdout(io.StringIO()):
                release_audit.main()
        self.assertIn("verify_acceptance", called, "the release audit no longer runs the acceptance check")
        self.assertEqual(
            called,
            ["verify_tools", "verify_sources", "verify_connectors", "verify_skills", "verify_acceptance"],
        )

    def test_the_recorded_tool_probe_is_judged_by_the_audits_own_freshness_window(self):
        """The refusal this check was told not to disturb, asserted as a property.

        Asserting that the shipped probe *is* stale would encode today's
        verdict: the documented remedy for the red `audit:capabilities` is to
        refresh that probe, and refreshing it would turn this test — and, now
        that it runs on every pull request, CI — red for doing the right thing.

        So the property, in both directions. The receipt's age is computed here
        from its own timestamp rather than taken from the audit, and the audit's
        window is read off `parsed_fresh` itself, so the assertion is that the
        function refuses exactly when the receipt is older than its own window.
        A refreshed probe passes; a freshness rule that stopped refusing, or
        started refusing everything, fails at the boundary cases below whatever
        the receipt's date happens to be.
        """
        window = timedelta(
            days=inspect.signature(release_audit.parsed_fresh).parameters["max_age_days"].default
        )

        def refusal(value):
            """The audit's verdict on one timestamp: its message, or None."""
            try:
                release_audit.parsed_fresh(value, "tool audit")
            except SystemExit as exit_error:
                return str(exit_error)
            return None

        # The rule itself, at its own boundary, independent of any receipt.
        now = datetime.now(timezone.utc)
        self.assertIsNone(refusal((now - window + timedelta(minutes=1)).isoformat()),
                          "a receipt inside the window must be accepted")
        self.assertEqual(refusal((now - window - timedelta(minutes=1)).isoformat()),
                         "tool audit evidence is stale",
                         "a receipt past the window must be refused as stale")
        self.assertEqual(refusal((now + timedelta(hours=1)).isoformat()),
                         "tool audit timestamp is in the future",
                         "a receipt from ahead of this clock is not a fresh one")

        # And the receipt this checkout ships, judged by that same rule: stale
        # if and only if it is older than the window.
        probe = json.loads((HERE / "results" / "tool-probe-v3.json").read_text(encoding="utf-8"))
        probed_at = datetime.fromisoformat(str(probe["probedAt"]).replace("Z", "+00:00"))
        expected = "tool audit evidence is stale" if datetime.now(timezone.utc) - probed_at > window else None
        self.assertEqual(refusal(probe["probedAt"]), expected)


if __name__ == "__main__":
    unittest.main()
