#!/usr/bin/env python3
"""Run the real improver channels (Claude on this box's login, the claude CLI) on one synthetic task, with a fake lab.

The base rollout is a synthetic trajectory served by the test suite's fake broker (a run that answers from recall and never recomputes). Two
real sessions then run through upstream's own `_run_stage`: the invariant editor and the domain editor. The point is the wiring: the CLI
flags, the sandbox, the harvested tree, the guard, the ledger. It spends some Claude quota and no DeepSeek money.

  tools/live_stage_check.py [--keep] [--effort low|medium|high]
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "tests"))
sys.path.insert(0, str(HERE.parent))

from support import FAKE_BROKERCTL, make_bench  # noqa: E402

from evimed_h2 import channels as C, config, families, upstream  # noqa: E402
from evimed_h2.adapter import DshAdapter  # noqa: E402
from evimed_h2.broker import BrokerctlClient  # noqa: E402
from evimed_h2.ledger import Ledger  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--effort", default="medium")
    parser.add_argument("--only", choices=("inv", "dom"), default=None)
    args = parser.parse_args()
    up = upstream.load()
    root = Path(tempfile.mkdtemp(prefix="h2-live-", dir=str(config.SCRATCH)))
    try:
        bench = make_bench(root / "bench", 3)
        broker_dir = root / "broker"
        broker_dir.mkdir()
        os.environ["RSI_FAKE_BROKER_DIR"] = str(broker_dir)
        (broker_dir / "scenario.json").write_text(json.dumps({"story": "memory"}))
        channels = C.load_channels()
        for row in channels["stages"].values():
            row["effort"], row["max_budget_usd"], row["timeout"] = args.effort, 1.5, 900
        channels["cli"] = "claude"
        ledger = Ledger(root / "ledger.jsonl")
        family = families.Family("medcalc", root=bench, fetcher=families.Fetcher(root / "cache", enabled=False))
        tasks = family.tasks(["1"])
        adapter = DshAdapter("medcalc", tasks, all_prompts=[t.prompt for t in family.tasks().values()], names=[], runs_root=root / "runs",
                             client=BrokerctlClient([sys.executable, str(FAKE_BROKERCTL)], env=dict(os.environ)), channels=channels, ledger=ledger,
                             poll_s=0.01, max_wait_s=30)
        router = C.build_router(root / "audit", domain="medcalc", ledger=ledger, channels=channels)
        surface = adapter.substrate.surface()
        base_dir = adapter.execute("1", None, "live/medcalc/1/base1")
        base = up.spec.RunView(label="base1", run_id="live/1/base1", run_dir=base_dir, ok=True, delivered=adapter.delivered(base_dir))
        base_tree = up.tree.read_tree(surface, adapter.base_harness())
        base_harness = up.tree.write_tree(surface, base_tree, root / "work" / "harnesses" / "base")
        bp = adapter.prompts_for("1")
        for label, dim in (("inv1", "INV"), ("dom1", "DOM")):
            if args.only and not label.startswith(args.only):
                continue
            job = up.prompts.propose(bp, dim, surface, k=1, index=1)
            stage = up.recursion._run_stage(label=label, dim=dim, job=job, fallback=base_tree, adapter=adapter, prop=router, ctx_dir=root / "work" / "context",
                                            task_id="1", rollouts=[base], harness_dir=base_harness, library_dir=None)
            p = router.stages[C.stage_of(label)]
            print(f"== {label} ({p.spec.model}) fell_back={stage.fell_back} kept_base={stage.kept_base} attempts={stage.attempts}")
            if stage.error:
                print("   error:", stage.error)
            for rel, text in sorted(stage.tree.items()):
                print(f"   -- {rel} ({len(text)} chars)\n" + "\n".join("      " + line for line in text.splitlines()))
            print("   notes:", (stage.notes or "")[:500].replace("\n", " | "))
            rejected = root / "work" / "context" / label / "harness" / "guidance.md"
            if stage.fell_back and rejected.is_file():
                print("   last rejected guidance.md:\n" + "\n".join("      " + l for l in rejected.read_text().splitlines()[:30]))
        print("== ledger")
        for row in ledger.rows():
            print("  ", json.dumps({k: row.get(k) for k in ("stage", "model", "outcome", "usage", "usd_reported", "cny", "wall_s", "turns", "denials")}))
        print(json.dumps(ledger.totals(), indent=1))
        first = "inv1" if args.only != "dom" else "dom1"
        print("context files seen by the editors:", sorted(p.name for p in (root / "work" / "context" / first).iterdir()))
        print("trajectory the editors read:\n" + (root / "work" / "context" / first / "rollouts" / "base1.md").read_text())
    finally:
        if args.keep:
            print("kept", root)
        else:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
