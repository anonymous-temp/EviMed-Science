"""Paths, pins and the few numbers the round fixes. Every default can be moved by an environment variable."""

from __future__ import annotations

import os
from pathlib import Path

PIN = "1cfe254e8d25b15f37048c3730134686abe60335"
UPSTREAM_URL = "https://github.com/google-research/harness2"

HERE = Path(__file__).resolve().parent
PACKAGE_ROOT = HERE.parent  # OpenScience/evals/harness-adaptation
OPENSCIENCE_ROOT = PACKAGE_ROOT.parent.parent

SCRATCH = Path(os.environ.get("RSI1_SCRATCH", "/tmp/rsi1-scratch"))
WORKDIR = Path(os.environ.get("H2_WORKDIR", SCRATCH / "harness2"))
RUNS_ROOT = Path(os.environ.get("H2_RUNS_ROOT", SCRATCH / "h2-runs"))
BENCH_ROOT = Path(os.environ.get("RSI1_BENCH_ROOT", "/home/coder/evimed-wt/bench"))
OUT_ROOT = Path(os.environ.get("RSI1_OUT_ROOT", BENCH_ROOT / "rsi" / "h2"))
PPC_TASKS_FILE = Path(os.environ.get("RSI1_PPC_TASKS", BENCH_ROOT / "rsi" / "ppc-tasks.json"))
PPC_FETCH_FILE = Path(os.environ.get("RSI1_PPC_FETCH", BENCH_ROOT / "rsi" / "ppc-fetch.json"))
LEDGER_FILE = Path(os.environ.get("RSI1_LEDGER", OUT_ROOT / "rsi1-ledger.jsonl"))

DEEPSEEK_KEY_FILE = Path(
    os.environ.get("RSI1_DEEPSEEK_KEY_FILE", "/home/coder/workspace/EviMedScience/.evimed-local/secrets/deepseek.api-key")
)
DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance"

PPC_SALT = "rsi1-ppc"
PPC_PER_DOMAIN = 4
DOMAINS = ("medcalc", "arb-deep", "arb-wide", "bixbench", "mbc", "drb", "rcb")

# Always-on text of a probe: the design's experimental ceiling (docs: evals section 14), counted on guidance.md alone.
ALWAYS_ON_MAX = 4000

BALANCE_FLOOR_CNY = float(os.environ.get("RSI_BALANCE_FLOOR_CNY", "500"))
BALANCE_MIN_INTERVAL_S = 60
ROUND_CAP_CNY = 800.0

CHANNELS_FILE = PACKAGE_ROOT / "config" / "channels.json"
GUIDANCE_SNAPSHOT = HERE / "data" / "current-guidance.md"
GUIDANCE_SOURCE = OPENSCIENCE_ROOT / "packages" / "socket" / "src" / "guidanceText.mjs"
