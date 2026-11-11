#!/usr/bin/env python3
"""Wait for capacity before starting one lab product-path slot; never touches another lane's processes."""
import argparse
from datetime import datetime, timezone
import json
import fcntl
import os
from pathlib import Path
import subprocess
import time

p = argparse.ArgumentParser()
p.add_argument("--status", required=True)
p.add_argument("command", nargs=argparse.REMAINDER)
args = p.parse_args()
command = args.command[1:] if args.command[:1] == ["--"] else args.command


def status(message):
    with Path(args.status).open("a") as f:
        f.write(f"{datetime.now(timezone.utc).isoformat()} EG {message}\n")


status("queued for a product-path slot (host limit two)")
reservation = Path(f"/srv/evimed/pp/locks/eg-reservation-{os.getpid()}.json")
while True:
    budget = json.loads(Path("/srv/evimed/runs/eg-budget-20261111.json").read_text())
    balance = float(Path("/srv/evimed/runs/BUDGET-LAST").read_text().strip().split()[-1])
    elapsed = (datetime.now(timezone.utc) - datetime.fromisoformat(budget["startedAt"].replace("Z", "+00:00"))).total_seconds()
    meter_file = Path("/srv/evimed/runs/eg-spend-20261111.json")
    meter = json.loads(meter_file.read_text()) if meter_file.exists() else None
    fresh = meter and not meter["errors"] and not meter["missing"] and (datetime.now(timezone.utc) - datetime.fromisoformat(meter["at"].replace("Z", "+00:00"))).total_seconds() < 300
    exhausted = meter["estimatedUpperCny"] >= 330 if fresh else budget["balance"] - balance >= 340
    if balance < 400 or exhausted or elapsed > 12 * 3600:
        status(f"STOP budget/time guard while queued: balance={balance}")
        raise SystemExit(3)
    slots = set()
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            argv = (entry / "cmdline").read_bytes().split(b"\0")
            if len(argv) > 1 and b"node" in argv[0]:
                env = dict(s.split(b"=", 1) for s in (entry / "environ").read_bytes().split(b"\0") if b"=" in s)
                live = env.get(b"EVAL_LIVE_DIR", env.get(b"LIVE_DIR", b"")).decode(errors="replace")
                if live:
                    slots.add(live)
                elif argv[1].endswith(b"/general-tasks/runner/harness.mjs"):
                    slots.add(f"harness:{entry.name}")
        except (OSError, ProcessLookupError):
            pass
    available = int(next(line.split()[1] for line in Path("/proc/meminfo").read_text().splitlines() if line.startswith("MemAvailable:")))
    with Path("/srv/evimed/pp/locks/eg-capacity.lock").open("a") as gate:
        fcntl.flock(gate, fcntl.LOCK_EX)
        for held in Path("/srv/evimed/pp/locks").glob("eg-reservation-*.json"):
            r = json.loads(held.read_text())
            if Path(f"/proc/{r['pid']}").exists():
                slots.add(r["slot"])
            else:
                held.unlink(missing_ok=True)
        start = len(slots) < 2 and available > 1700 * 1024
        if start:
            reservation.write_text(json.dumps({"pid": os.getpid(), "slot": f"/srv/evimed/pp/live/p{os.environ['PORT']}"}))
    if start:
        status(f"starting slot: existingSlots={len(slots)} availableKiB={available}")
        try:
            raise SystemExit(subprocess.call(command))
        finally:
            reservation.unlink(missing_ok=True)
    time.sleep(30)
