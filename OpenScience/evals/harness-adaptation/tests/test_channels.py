import json
import os
import sys
import unittest

from support import FAKE_CLAUDE, FAKE_KEY, Sandbox

from evimed_h2 import channels as C
from evimed_h2.errors import InfrastructureFailure, QuotaExhausted
from evimed_h2.ledger import Ledger, deepseek_cny


class ChannelsTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(self)
        self.ledger = Ledger(self.box.out / "ledger.jsonl")
        self.router = C.build_router(self.box.runs / "audit", domain="d", ledger=self.ledger, channels=json.loads(self.box.channel_file.read_text()))
        self.context = self.box.tmp / "ctx"
        (self.context / "harness").mkdir(parents=True)
        (self.context / "harness" / "guidance.md").write_text("")

    def call(self, label="inv1", mission="# YOUR DIMENSION: INVARIANT\nedit it", **kw):
        return self.router.call(mission, self.context, label, harvest="context/harness", **kw)

    def test_stage_is_chosen_from_the_label(self):
        self.assertEqual([C.stage_of(x) for x in ("inv1", "dom1.a2", "agg1", "select.agg1", "experience.agg1")], ["inv", "dom", "agg", "select", "experience"])
        with self.assertRaises(KeyError):
            C.stage_of("c1")  # sequential mode is not run

    def test_reply_comes_back_with_the_edited_harness_and_usage_is_recorded(self):
        reply = self.call()
        self.assertTrue(reply.ok)
        self.assertIn("Recompute", (reply.workspace / "guidance.md").read_text())
        rows = self.ledger.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["usage"]["output_tokens"], 300)
        self.assertEqual(rows[0]["usd_reported"], 0.05)
        self.assertEqual(rows[0]["model"], "claude-sonnet-5-5")

    def test_a_cached_reply_costs_nothing_and_starts_no_process(self):
        self.call()
        calls = len(self.box.cli_calls())
        again = self.call()
        self.assertTrue(again.cached)
        self.assertEqual(len(self.box.cli_calls()), calls)
        self.assertEqual(len([r for r in self.ledger.rows() if not r.get("cached")]), 1)

    def test_another_model_is_another_cache(self):
        self.call()
        document = json.loads(self.box.channel_file.read_text())
        document["stages"]["inv"]["model"] = "claude-sonnet-5-4"
        other = C.build_router(self.box.runs / "audit", domain="d", ledger=self.ledger, channels=document)
        reply = other.call("# YOUR DIMENSION: INVARIANT\nedit it", self.context, "inv1", harvest="context/harness")
        self.assertFalse(reply.cached)
        self.assertEqual(len(self.box.cli_calls()), 2)

    def test_deepseek_stage_gets_its_endpoint_and_key_and_the_key_is_not_stored(self):
        self.call("dom1", "# YOUR DIMENSION: DOMAIN\nedit it")
        call = self.box.cli_calls()[-1]
        self.assertEqual(call["model"], "deepseek-v4-pro[1m]")
        self.assertEqual(call["base_url"], "http://127.0.0.1:9/anthropic")
        import hashlib
        self.assertEqual(call["token_sha"], hashlib.sha256(FAKE_KEY.encode()).hexdigest()[:12])
        for path in self.box.runs.rglob("*"):
            if path.is_file():
                self.assertNotIn(FAKE_KEY, path.read_text(errors="replace"))
        row = self.ledger.rows()[-1]
        self.assertEqual(row["cny"], deepseek_cny("deepseek-v4-pro[1m]", row["usage"]))

    def test_quota_is_infrastructure_and_not_a_proposer_error(self):
        os.environ["FAKE_CLAUDE_MODE"] = "quota"
        with self.assertRaises(QuotaExhausted) as caught:
            self.call()
        self.assertFalse(isinstance(caught.exception, C.ProposerError))
        self.assertTrue(caught.exception.infrastructure)

    def test_a_crashed_cli_is_transport_infrastructure(self):
        os.environ["FAKE_CLAUDE_MODE"] = "transport"
        with self.assertRaises(InfrastructureFailure) as caught:
            self.call()
        self.assertEqual(caught.exception.kind, "transport")

    def test_a_session_past_the_timeout_is_infrastructure(self):
        os.environ["FAKE_CLAUDE_MODE"] = "hang"
        document = json.loads(self.box.channel_file.read_text())
        document["stages"]["inv"]["timeout"] = 1
        router = C.build_router(self.box.runs / "audit2", domain="d", ledger=self.ledger, channels=document)
        with self.assertRaises(InfrastructureFailure) as caught:
            router.call("# YOUR DIMENSION: INVARIANT\nedit it", self.context, "inv1", harvest="context/harness", max_attempts=1)
        self.assertEqual(caught.exception.kind, "timeout")

    def test_a_spent_session_budget_is_the_stages_own_failure(self):
        os.environ["FAKE_CLAUDE_MODE"] = "budget"
        with self.assertRaises(C.ProposerError) as caught:
            self.call(max_attempts=1)
        self.assertFalse(getattr(caught.exception, "infrastructure", False))

    def test_classification(self):
        self.assertEqual(C.classify({"api_error_status": 429}, "x", 1)[0], "quota")
        self.assertEqual(C.classify({}, "Claude usage limit reached", 1)[0], "quota")
        self.assertEqual(C.classify({"api_error_status": 529}, "overloaded", 1)[0], "quota")
        self.assertEqual(C.classify({"api_error_status": 503}, "bad gateway", 1)[0], "transport")
        self.assertEqual(C.classify({"api_error_status": 401}, "bad key", 1)[0], "auth")
        self.assertEqual(C.classify({"subtype": "error_max_budget_usd"}, "", 1)[0], "budget")
        self.assertEqual(C.classify({"subtype": "error_during_execution"}, "weird", 1)[0], "error")


class LedgerTest(unittest.TestCase):
    def test_a_key_is_written_once_and_a_torn_line_is_tolerated(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as d:
            ledger = Ledger(Path(d) / "l.jsonl")
            self.assertTrue(ledger.append("a", kind="rollout", cny=1.0))
            self.assertFalse(ledger.append("a", kind="rollout", cny=1.0))
            with open(ledger.path, "a") as handle:
                handle.write('{"key": "torn", "kind"')
            self.assertTrue(ledger.append("b", kind="improver", stage="dom", cny=0.25, usage={"output_tokens": 5}))
            totals = ledger.totals()
            self.assertEqual((totals["rollouts"], totals["improver_calls"], totals["round_cash_cny"]), (1, 1, 1.25))

    def test_deepseek_estimate_uses_the_platform_reference_rates(self):
        usage = {"input_tokens": 1_000_000, "cache_read_input_tokens": 1_000_000, "output_tokens": 1_000_000}
        self.assertAlmostEqual(deepseek_cny("deepseek-v4-pro", usage), 9 + 0.3 + 27)
        self.assertIsNone(deepseek_cny("claude-opus-5-5", usage))


class BalanceTest(unittest.TestCase):
    def test_balance_is_read_with_the_key_in_a_header_and_failures_do_not_echo_it(self):
        import http.server
        import threading
        import tempfile
        from pathlib import Path
        from evimed_h2 import balance
        seen = {}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen["auth"] = self.headers.get("Authorization")
                if self.path == "/boom":
                    self.send_response(500)
                    self.end_headers()
                    return
                body = json.dumps({"is_available": True, "balance_infos": [{"currency": "CNY", "total_balance": "1234.50"}]}).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory() as d:
            key = Path(d) / "k"
            key.write_text(FAKE_KEY + "\n")
            url = f"http://127.0.0.1:{server.server_port}"
            self.assertEqual(balance.read_balance_cny(key, url + "/ok"), 1234.5)
            self.assertEqual(seen["auth"], f"Bearer {FAKE_KEY}")
            with self.assertRaises(InfrastructureFailure) as caught:
                balance.read_balance_cny(key, url + "/boom")
            self.assertNotIn(FAKE_KEY, str(caught.exception))

    def test_reads_at_most_once_per_interval_and_pauses_under_the_floor(self):
        from evimed_h2.balance import BalanceGuard
        clock = {"t": 0.0}
        reads = []
        values = iter([300.0, 300.0, 700.0])

        def fetch():
            reads.append(clock["t"])
            return next(values)

        guard = BalanceGuard(fetch=fetch, floor=500, min_interval=60, cap_cny=None, clock=lambda: clock["t"],
                             sleep=lambda s: clock.__setitem__("t", clock["t"] + s), log=lambda s: None)
        self.assertEqual(guard.ensure("x"), 700.0)
        self.assertEqual(reads, [0.0, 60.0, 120.0])
        guard.ensure("y")
        guard.ensure("z")
        self.assertEqual(len(reads), 3)  # cached inside the interval

    def test_a_balance_that_stays_low_stops_the_round_after_the_longest_pause(self):
        from evimed_h2.balance import BalanceGuard
        from evimed_h2.errors import BudgetStop
        clock = {"t": 0.0}
        guard = BalanceGuard(fetch=lambda: 1.0, floor=500, min_interval=60, cap_cny=None, clock=lambda: clock["t"],
                             sleep=lambda s: clock.__setitem__("t", clock["t"] + s), log=lambda s: None, max_pause_s=300)
        with self.assertRaises(BudgetStop):
            guard.ensure("x")


if __name__ == "__main__":
    unittest.main()
