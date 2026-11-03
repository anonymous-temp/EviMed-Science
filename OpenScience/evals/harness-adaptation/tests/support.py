"""Shared scaffolding: a miniature bench root, a fake lab, a fake CLI, and the arguments of a round pointed at them."""
from __future__ import annotations

import csv
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parent
sys.path.insert(0, str(PACKAGE))

from evimed_h2 import config, upstream  # noqa: E402

FAKE_BROKERCTL = HERE / "fake_brokerctl.py"
FAKE_CLAUDE = HERE / "fake_claude.py"
FAKE_KEY = "sk-fake-not-a-real-key-0000"


def ensure_upstream():
    """The patched upstream must exist. Tests do not fetch from the network: use setup.sh (H2_SOURCE=<local clone>) first."""
    try:
        upstream.verify()
    except RuntimeError as exc:
        raise unittest.SkipTest(f"{exc} (run evals/harness-adaptation/setup.sh)")


def make_bench(root: Path, n: int = 6) -> Path:
    (root / "pools").mkdir(parents=True)
    (root / "data/medcalc").mkdir(parents=True)
    dev = [str(i) for i in range(1, n + 1)]
    (root / "pools/medcalc.json").write_text(json.dumps({
        "digest": "fixture", "rule": "fixture", "pools": {"main": {"development": dev, "confirmation": ["900", "901"]}}}))
    with open(root / "data/medcalc/test_data.csv", "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["Row Number", "Calculator ID", "Calculator Name", "Category", "Note ID", "Note Type", "Patient Note",
                                                    "Question", "Ground Truth Answer", "Output Type"])
        writer.writeheader()
        for i in list(range(1, n + 1)) + [900, 901]:
            writer.writerow({
                "Row Number": i, "Calculator ID": 1, "Calculator Name": "Fixture index", "Category": "lab", "Note ID": f"n{i}", "Note Type": "x",
                "Patient Note": f"Patient {i} is a person with an unusual history number {i} of a long enough note to be distinctive in every way that matters here.",
                "Question": f"What is the fixture index for patient {i}?", "Ground Truth Answer": "SECRET-GOLD-VALUE", "Output Type": "decimal"})
    return root


def channels() -> dict:
    """The shipped roles (config/channels.json): Sonnet for the two editors, Opus for the composer, the selector and the reflector."""
    row = {"kind": "claude_cli", "effort": "high", "timeout": 120, "max_budget_usd": 1}
    return {
        "cli": str(FAKE_CLAUDE),
        "stages": {
            "inv": {**row, "model": "claude-sonnet-5-5"},
            "dom": {**row, "model": "claude-sonnet-5-5"},
            "agg": {**row, "model": "claude-opus-5-5"},
            "select": {**row, "model": "claude-opus-5-5"},
            "experience": {**row, "model": "claude-opus-5-5"},
        },
    }


class Sandbox:
    """One temporary world: bench root, runs root, out root, fake broker directory, fake CLI log."""

    def __init__(self, test: unittest.TestCase, n_tasks: int = 6):
        ensure_upstream()
        self.tmp = Path(tempfile.mkdtemp(prefix="h2-test-"))
        test.addCleanup(__import__("shutil").rmtree, self.tmp, True)
        self.bench = make_bench(self.tmp / "bench", n_tasks)
        self.runs = self.tmp / "runs"
        self.out = self.tmp / "out"
        self.broker_dir = self.tmp / "broker"
        self.broker_dir.mkdir()
        self.cli_log = self.tmp / "cli.jsonl"
        self.tasks_file = self.tmp / "ppc-tasks.json"
        self.channel_file = self.tmp / "channels.json"
        self.channel_file.write_text(json.dumps(channels()))
        os.environ["FAKE_CLAUDE_LOG"] = str(self.cli_log)
        os.environ["RSI_FAKE_BROKER_DIR"] = str(self.broker_dir)
        os.environ.pop("FAKE_CLAUDE_MODE", None)
        os.environ.pop("FAKE_CLAUDE_FAIL_MODEL", None)
        os.environ.pop("FAKE_CLAUDE_FAIL_DIM", None)
        test.addCleanup(lambda: [os.environ.pop(k, None) for k in ("FAKE_CLAUDE_LOG", "RSI_FAKE_BROKER_DIR", "FAKE_CLAUDE_MODE", "FAKE_CLAUDE_FAIL_MODEL",
                                                                   "FAKE_CLAUDE_FAIL_DIM")])
        self.write_tasks(["1", "2"])

    def write_tasks(self, ids):
        self.tasks_file.write_text(json.dumps({"domains": {"medcalc": {"ids": ids}}}))

    def scenario(self, **values):
        path = self.broker_dir / "scenario.json"
        current = json.loads(path.read_text()) if path.exists() else {}
        current.update(values)
        path.write_text(json.dumps(current))

    def broker_events(self, name=None):
        path = self.broker_dir / "log" / "events.jsonl"
        rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return [r for r in rows if name is None or r["event"] == name]

    def cli_calls(self):
        return [json.loads(line) for line in self.cli_log.read_text().splitlines()] if self.cli_log.exists() else []

    def client(self):
        from evimed_h2.broker import BrokerctlClient
        return BrokerctlClient([sys.executable, str(FAKE_BROKERCTL)], env=dict(os.environ))

    def args(self, *extra):
        import run_round
        return run_round.build_parser().parse_args([
            "--domains", "medcalc", "--runs-root", str(self.runs), "--out", str(self.out), "--ledger", str(self.out / "rsi1-ledger.jsonl"),
            "--tasks-file", str(self.tasks_file), "--bench-root", str(self.bench), "--channels", str(self.channel_file), "--poll-s", "0.01",
            "--max-wait-s", "20", "--offline", "--concurrency", "1", *extra])

    def round(self, *extra, balance=None):
        import run_round
        from evimed_h2.balance import BalanceGuard
        args = self.args(*extra)
        guard = balance or BalanceGuard(fetch=lambda: 1000.0, floor=500, min_interval=0, cap_cny=None)
        return run_round.Round(args, client=self.client(), balance=guard, sleep=lambda s: None)
