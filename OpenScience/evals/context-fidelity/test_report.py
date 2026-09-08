"""Offline tests for the compaction measurement report. No server, no database."""

import importlib.util
import json
import pathlib
import tempfile
import unittest


REPORT_FILE = pathlib.Path(__file__).resolve().parent / "report.py"


def load_report_module():
    spec = importlib.util.spec_from_file_location("context_fidelity_report", REPORT_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


report = load_report_module()


def started(run_id, at, model="deepseek/deepseek-v4-pro"):
    return {"event": "started", "id": run_id, "mode": "open-domain", "model": model,
            "createdAt": at, "startedAt": at}


def finished(run_id, at, status="succeeded", error_code=None, duration=600_000):
    return {"event": "finished", "id": run_id, "status": status, "finishedAt": at,
            "durationMs": duration, "errorCode": error_code, "artifacts": []}


def learning(run_id, compaction=None, **fields):
    event = {"event": "learning", "id": run_id}
    if compaction is not None:
        event["compaction"] = compaction
    event.update(fields)
    return event


def compaction_record(seq, tokens, at="2026-09-01T10:00:00Z", replaced=6, policy="basic"):
    return {"at": at, "seq": seq, "replaced": replaced, "tokens": tokens, "policy": policy}


def write_ledger(directory, events):
    path = pathlib.Path(directory) / ".openscience" / "runs.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
    return path


class LedgerFoldTests(unittest.TestCase):
    def test_the_last_learning_row_wins_because_the_receipt_is_a_gauge(self):
        runs, _problems = report.fold_ledger([
            json.dumps(started("run_1", "2026-09-01T09:00:00Z")),
            json.dumps(learning("run_1", compaction=[compaction_record(10, 40_000)])),
            json.dumps(learning("run_1", compaction=[compaction_record(10, 40_000), compaction_record(20, 52_000)])),
            json.dumps(finished("run_1", "2026-09-01T10:00:00Z")),
        ])
        self.assertEqual(len(runs["run_1"]["compaction"]), 2)
        self.assertEqual(runs["run_1"]["status"], "succeeded")

    def test_a_half_written_tail_line_is_counted_and_skipped_not_fatal(self):
        runs, problems = report.fold_ledger([
            json.dumps(started("run_1", "2026-09-01T09:00:00Z")),
            json.dumps(finished("run_1", "2026-09-01T10:00:00Z")),
            '{"event":"learning","id":"run_1","compac',
        ])
        self.assertEqual(problems["unparsable"], 1)
        self.assertEqual(len(runs), 1)

    def test_an_event_for_a_run_this_file_never_started_is_counted_as_orphaned(self):
        _runs, problems = report.fold_ledger([json.dumps(finished("run_9", "2026-09-01T10:00:00Z"))])
        self.assertEqual(problems["orphaned"], 1)


class TokenTests(unittest.TestCase):
    def test_the_single_shipped_token_count_is_read_as_before_and_never_as_after(self):
        self.assertEqual(report.compaction_tokens(compaction_record(1, 48_000)), (48_000, None))

    def test_an_explicit_before_and_after_pair_is_used_as_written(self):
        self.assertEqual(
            report.compaction_tokens({"seq": 1, "tokensBefore": 90_000, "tokensAfter": 21_000}),
            (90_000, 21_000),
        )

    def test_the_after_column_says_it_is_unavailable_instead_of_repeating_before(self):
        runs = [{
            "id": "run_1", "status": "succeeded", "errorCode": None, "startedAt": "2026-09-01T09:00:00Z",
            "finishedAt": "2026-09-01T10:00:00Z", "compaction": [compaction_record(1, 48_000)],
        }]
        block = report.week_block(runs, {}, report.DEFAULT_SUMMARISER_MODEL, report.REFERENCE_PRICE_LIST)
        self.assertEqual(block["tokens"]["before"]["total"], 48_000)
        self.assertIs(block["tokens"]["after"]["available"], False)
        self.assertIn("one estimated token count", block["tokens"]["after"]["reason"])


class WeeklyReportTests(unittest.TestCase):
    def setUp(self):
        self.stack = tempfile.TemporaryDirectory()
        self.addCleanup(self.stack.cleanup)
        self.root = pathlib.Path(self.stack.name)

    def build(self, events, **kwargs):
        path = write_ledger(self.root / "project-a", events)
        return report.build_report([report.read_ledger(path)], {}, now=lambda: "2026-09-07T00:00:00Z", **kwargs)

    def test_runs_are_bucketed_into_the_iso_week_they_finished_in(self):
        built = self.build([
            started("run_1", "2026-08-31T09:00:00Z"), finished("run_1", "2026-08-31T10:00:00Z"),
            started("run_2", "2026-09-07T09:00:00Z"), finished("run_2", "2026-09-07T10:00:00Z"),
        ])
        self.assertEqual([week["week"] for week in built["weeks"]], ["2026-W36", "2026-W37"])

    def test_the_success_rate_of_compacted_runs_is_reported_apart_from_the_rest(self):
        built = self.build([
            started("run_1", "2026-09-01T09:00:00Z"),
            learning("run_1", compaction=[compaction_record(10, 50_000)]),
            finished("run_1", "2026-09-01T10:00:00Z", status="failed", error_code="runtime_session_error"),
            started("run_2", "2026-09-01T09:00:00Z"),
            learning("run_2", compaction=[compaction_record(10, 30_000), compaction_record(20, 30_000)]),
            finished("run_2", "2026-09-01T10:00:00Z"),
            started("run_3", "2026-09-01T09:00:00Z"),
            finished("run_3", "2026-09-01T10:00:00Z"),
        ])
        week = built["weeks"][0]
        self.assertEqual(week["compactions"]["runsCompacted"], 2)
        self.assertEqual(week["compactions"]["total"], 3)
        self.assertEqual(week["compactions"]["perRun"]["mean"], 1.0)
        self.assertEqual(week["successRate"]["compacted"], {"runs": 2, "succeeded": 1, "rate": 0.5})
        self.assertEqual(week["successRate"]["notCompacted"], {"runs": 1, "succeeded": 1, "rate": 1.0})
        self.assertEqual(week["successRate"]["delta"], -0.5)

    def test_a_session_error_is_counted_as_indistinguishable_and_never_as_an_overflow(self):
        built = self.build([
            started("run_1", "2026-09-01T09:00:00Z"),
            finished("run_1", "2026-09-01T10:00:00Z", status="failed", error_code="runtime_session_error"),
            started("run_2", "2026-09-01T09:00:00Z"),
            finished("run_2", "2026-09-01T10:00:00Z", status="failed", error_code="compaction_handle_lost"),
        ])
        overflow = built["weeks"][0]["contextOverflow"]
        self.assertEqual(overflow["attributable"], {"total": 1, "byCode": {"compaction_handle_lost": 1}})
        self.assertEqual(overflow["indistinguishable"]["total"], 1)
        self.assertIn("sub-code never reaches runs.jsonl", overflow["indistinguishable"]["reason"])

    def test_the_summariser_cost_names_the_price_list_it_used(self):
        built = self.build([
            started("run_1", "2026-09-01T09:00:00Z"),
            learning("run_1", compaction=[compaction_record(10, 1_000_000)]),
            finished("run_1", "2026-09-01T10:00:00Z"),
        ])
        summariser = built["weeks"][0]["summariser"]
        self.assertEqual(summariser["model"], "deepseek-v4-flash")
        self.assertEqual(summariser["cost"], 3.0)
        self.assertEqual(summariser["priceVersion"], "evimed-reference-2026-09-05")
        self.assertIn("no per-compaction usage row", summariser["assumption"])

    def test_an_unpriced_summariser_model_costs_nothing_and_says_so(self):
        built = self.build([
            started("run_1", "2026-09-01T09:00:00Z"),
            learning("run_1", compaction=[compaction_record(10, 1_000_000)]),
            finished("run_1", "2026-09-01T10:00:00Z"),
        ], model="some-future-model")
        summariser = built["weeks"][0]["summariser"]
        self.assertIsNone(summariser["cost"])
        self.assertIs(summariser["priced"], False)

    def test_the_ledger_receipt_is_content_addressed(self):
        path = write_ledger(self.root / "project-b", [
            started("run_1", "2026-09-01T09:00:00Z"), finished("run_1", "2026-09-01T10:00:00Z"),
        ])
        built = report.build_report([report.read_ledger(path)], {}, now=lambda: "2026-09-07T00:00:00Z")
        receipt = built["inputs"]["ledgers"][0]
        self.assertEqual(receipt["bytes"], path.stat().st_size)
        self.assertEqual(receipt["sha256"], report.sha256_bytes(path.read_bytes()))
        self.assertEqual(receipt["runs"], 1)


class PolicyFreezeTests(unittest.TestCase):
    def setUp(self):
        self.stack = tempfile.TemporaryDirectory()
        self.addCleanup(self.stack.cleanup)
        self.root = pathlib.Path(self.stack.name)

    def test_an_empty_measurement_refuses_to_call_the_distribution_sufficient(self):
        path = write_ledger(self.root / "p", [
            started("run_1", "2026-09-01T09:00:00Z"), finished("run_1", "2026-09-01T10:00:00Z"),
        ])
        built = report.build_report([report.read_ledger(path)], {}, now=lambda: "2026-09-07T00:00:00Z")
        self.assertIs(built["distribution"]["sufficient"], False)
        self.assertEqual(built["distribution"]["compactedRuns"], 0)
        self.assertIn("pressure compaction unreachable", built["distribution"]["reason"])

    def test_the_freeze_statement_travels_with_every_report(self):
        path = write_ledger(self.root / "p", [started("run_1", "2026-09-01T09:00:00Z")])
        built = report.build_report([report.read_ledger(path)], {}, now=lambda: "2026-09-07T00:00:00Z")
        self.assertIn("No compaction policy", built["policyFreeze"])
        self.assertIn("§6.5", built["policyFreeze"])

    def test_enough_compacted_runs_across_enough_weeks_opens_the_gate(self):
        events = []
        for stamp in ("2026-09-01T10:00:00Z", "2026-09-08T10:00:00Z"):  # ISO weeks 36 and 37
            for index in range(3):
                run_id = f"run_{stamp[8:10]}_{index}"
                events.append(started(run_id, stamp))
                events.append(learning(run_id, compaction=[compaction_record(10, 20_000)]))
                events.append(finished(run_id, stamp))
        path = write_ledger(self.root / "p", events)
        built = report.build_report(
            [report.read_ledger(path)], {}, now=lambda: "2026-09-07T00:00:00Z",
            min_compacted_runs=6, min_weeks=2,
        )
        self.assertEqual(built["distribution"]["weeksWithCompaction"], 2)
        self.assertIs(built["distribution"]["sufficient"], True)
        self.assertIsNone(built["distribution"]["reason"])


class UsageJoinTests(unittest.TestCase):
    def setUp(self):
        self.stack = tempfile.TemporaryDirectory()
        self.addCleanup(self.stack.cleanup)
        self.root = pathlib.Path(self.stack.name)

    def test_cache_hit_is_unavailable_rather_than_zero_without_a_usage_export(self):
        path = write_ledger(self.root / "p", [
            started("run_1", "2026-09-01T09:00:00Z"),
            learning("run_1", compaction=[compaction_record(10, 20_000)]),
            finished("run_1", "2026-09-01T10:00:00Z"),
        ])
        built = report.build_report([report.read_ledger(path)], {}, now=lambda: "2026-09-07T00:00:00Z")
        cache = built["weeks"][0]["cacheHit"]["compacted"]
        self.assertIs(cache["available"], False)
        self.assertIn("no HTTP surface", cache["reason"])

    def test_a_usage_export_gives_the_compacted_runs_their_own_cache_hit_ratio(self):
        export = self.root / "account.json"
        export.write_text(json.dumps({"tables": {"usage": [
            {"runId": "run_1", "status": "settled", "actualCost": "1.50", "cacheHitTokens": "30", "cacheMissTokens": "70", "outputTokens": "10"},
            {"runId": "run_2", "status": "settled", "actualCost": "0.50", "cacheHitTokens": "90", "cacheMissTokens": "10", "outputTokens": "5"},
            {"runId": "run_2", "status": "reserved", "actualCost": "9.00", "cacheHitTokens": "0", "cacheMissTokens": "0", "outputTokens": "0"},
        ]}}), encoding="utf-8")
        path = write_ledger(self.root / "p", [
            started("run_1", "2026-09-01T09:00:00Z"),
            learning("run_1", compaction=[compaction_record(10, 20_000)]),
            finished("run_1", "2026-09-01T10:00:00Z"),
            started("run_2", "2026-09-01T09:00:00Z"),
            finished("run_2", "2026-09-01T10:00:00Z"),
        ])
        usage = report.load_usage_rows(export)
        self.assertNotIn("9.0", str(usage["run_2"]["cost"]))  # a reserved row is not a settled cost
        built = report.build_report([report.read_ledger(path)], usage, now=lambda: "2026-09-07T00:00:00Z")
        cache = built["weeks"][0]["cacheHit"]
        self.assertEqual(cache["compacted"]["cacheHitRatio"], 0.3)
        self.assertEqual(cache["notCompacted"]["cacheHitRatio"], 0.9)
        self.assertEqual(cache["compacted"]["cost"], 1.5)


class LedgerDiscoveryTests(unittest.TestCase):
    def test_the_project_meta_directory_is_where_a_ledger_is_looked_for(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            wanted = write_ledger(root / "alpha", [started("run_1", "2026-09-01T09:00:00Z")])
            (root / "beta").mkdir()
            (root / "beta" / "runs.jsonl").write_text("{}\n", encoding="utf-8")
            found = report.find_ledgers(root, [])
            self.assertEqual(found, [wanted.resolve()])


if __name__ == "__main__":
    unittest.main()
