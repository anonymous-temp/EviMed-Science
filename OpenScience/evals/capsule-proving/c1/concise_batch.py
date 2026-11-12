"""P33: resumable concise C1 rebuild and three-arm evaluation, with an owned-process budget guard.

Run on the lab from the frozen lane tree. Lane receipts, charged at the peak tariff,
bound its cost independently of other lanes. A CNY 50 reserve covers unfinished episodes,
in-flight replies and embeddings. Only this batch's process groups are stopped.
No keys or vendor response bodies enter its logs.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request


def balance(key_file):
    request = urllib.request.Request("https://api.deepseek.com/user/balance", headers={
        "Authorization": "Bearer " + Path(key_file).read_text().strip()})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.load(response)
        return float(next(row["total_balance"] for row in payload["balance_infos"] if row["currency"] == "CNY"))
    except Exception:
        raise RuntimeError("Balance check unavailable; vendor details suppressed") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default="/srv/evimed/runs")
    parser.add_argument("--cap", type=float, default=300)
    parser.add_argument("--probe", action="store_true", help="One training-only ScienceWorld lesson before the full rebuild")
    parser.add_argument("--code", help="Frozen OpenScience tree; defaults to the tree containing this operator script")
    parser.add_argument("--workers", type=int, choices=(1, 2, 3), default=2)
    args = parser.parse_args()
    root = Path(args.root)
    queue = root / "c1c-batch"
    queue.mkdir(exist_ok=True)
    code = Path(args.code).resolve() if args.code else Path(__file__).resolve().parents[3]
    c1 = code / "evals/capsule-proving/c1"
    pool = code / "evals/capsule-proving/pools/c-samples-20261110.json"
    train_pool = code / "evals/capsule-proving/pools/c1-train-20261110.json"
    key = "/srv/evimed/secrets/deepseek.api-key"
    embed = "/srv/evimed/secrets/dashscope.api-key"
    libs = root / "c1c-lib"
    budget_file = queue / "budget.json"
    current = balance(key)
    if current < 400:
        raise RuntimeError("Shared brief forbids starting below CNY 400")
    budget = json.loads(budget_file.read_text()) if budget_file.exists() else {
        "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "balanceBefore": current, "cap": args.cap,
        "attribution": "Shared balance decrease plus lane-local peak-rate receipt ceiling"}
    if args.cap != budget["cap"]:
        raise RuntimeError("Resume cap changed")
    done_file = queue / "STATUS"
    done = set(done_file.read_text().splitlines()) if done_file.exists() else set()

    def status(line):
        with done_file.open("a") as stream:
            stream.write(line + "\n")
        print(line, flush=True)

    def checked_balance():
        remaining = balance(key)
        budget.update(balanceAfter=remaining, checkedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      sharedDecrease=round(budget["balanceBefore"] - remaining, 2))
        spend = json.loads(subprocess.check_output(["node", str(c1 / "spend.mjs"), str(root)], text=True))
        budget.update(laneReceipts=spend, reserveCny=50,
                      workers=args.workers, frozenCode=str(code),
                      attribution="Lane-local receipts at peak rates; shared balance decrease includes other lanes")
        budget_file.write_text(json.dumps(budget, indent=2) + "\n")
        if remaining < 150 or spend["peakCostUpperCny"] >= args.cap - 50:
            raise RuntimeError("Conservative lane budget stop")

    def run(label, command):
        if "DONE " + label in done:
            return
        checked_balance()
        status("START " + label)
        with (queue / (label + ".log")).open("a") as log:
            proc = subprocess.Popen(command, cwd=c1, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                    env={**os.environ, "OPEN_SCIENCE_METHOD_CONCISE_DISTILLATION_ENABLED": "true"})
            try:
                while proc.poll() is None:
                    time.sleep(30)
                    checked_balance()
                if proc.returncode:
                    raise RuntimeError(f"{label} exited {proc.returncode}; inspect its bounded log")
            except BaseException:
                if proc.poll() is None:
                    os.killpg(proc.pid, signal.SIGTERM)
                    try:
                        proc.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait()
                status("STOP " + label)
                raise
        status("DONE " + label)

    if args.probe:
        run("probe-scienceworld", ["node", "build_library.mjs", "build", "--lessons", "camp", "--env", "scienceworld",
            "--variant", "pyramid", "--train-dir", str(root / "c1-train-1"), "--pool", str(train_pool),
            "--out", str(root / "c1c-priority-probe"), "--sleep-every", "0", "--limit", "1",
            "--embed-key-file", embed, "--key-file", key, "--thinking", "disabled"])
        checked_balance()
        return
    for env in ("alfworld", "scienceworld"):
        run("build-" + env, ["node", "build_library.mjs", "build", "--lessons", "camp", "--env", env,
            "--variant", "pyramid", "--train-dir", str(root / "c1-train-1"), "--pool", str(train_pool),
            "--out", str(libs), "--sleep-every", "10", "--embed-key-file", embed, "--key-file", key,
            "--thinking", "disabled"])
    for env, fold in (("alfworld", "seen"), ("scienceworld", "seen"), ("alfworld", "unseen"), ("scienceworld", "unseen")):
        for arm in ("no-skill", "flat", "pyramid"):
            command = ["/srv/evimed/c1/venv/bin/python", "run_c1.py", "--env", env, "--fold", fold,
                       "--samples", str(pool), "--arm", arm, "--out", str(root / ("c1c-" + arm)),
                       "--workers", str(args.workers), "--key-file", key]
            if arm != "no-skill":
                command += ["--library", str(libs / (env + "-pyramid.json")), "--mode", arm,
                            "--selector", "product", "--embed-key-file", embed]
            run(f"{env}-{fold}-{arm}", command)
    checked_balance()
    status("COMPLETE")


if __name__ == "__main__":
    main()
