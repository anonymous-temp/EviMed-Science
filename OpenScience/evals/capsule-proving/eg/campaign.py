#!/usr/bin/env python3
"""Resumable phase supervisor: finish G1, then G10, then G3 within the shared budget/time guard."""
from datetime import datetime, timezone, timedelta
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from slot_capacity import process_token

TREE = Path("/srv/evimed/wt/run/OpenScience")
EG = TREE / "evals/capsule-proving/eg"
RUNS = Path("/srv/evimed/runs")
REPORT = RUNS / "eg-report-20261111"
DATA = Path("/srv/evimed/data/memdata-data")
SAMPLE = RUNS / "g1pp-selection-20261111-v3.json"
STATUS = RUNS / "eg-STATUS"
COMMIT = "aba955293db897e4c09cc7d1702de89d17a7b138"
ENV = {**os.environ, "PATH": "/srv/evimed/pp/node24/bin:/srv/evimed/pp/runtime-venv/bin:/srv/evimed/pp/judge-bin:" + os.environ["PATH"], "EVAL_TREE_COMMIT": COMMIT}


def status(message):
    line = f"{datetime.now(timezone.utc).isoformat()} EG {message}\n"
    print(line, end="", flush=True)
    with STATUS.open("a") as f:
        f.write(line)


def check_budget():
    while True:
        b = json.loads((RUNS / "eg-budget-20261111.json").read_text())
        current = float((RUNS / "BUDGET-LAST").read_text().strip().split()[-1])
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(b["startedAt"].replace("Z", "+00:00"))).total_seconds()
        meter = read(RUNS / "eg-spend-20261111.json")
        fresh = meter and not meter["errors"] and not meter["missing"] and (datetime.now(timezone.utc) - datetime.fromisoformat(meter["at"].replace("Z", "+00:00"))).total_seconds() < 300
        if (meter and meter["estimatedUpperCny"] >= 330) or current < 150 or age > 12 * 3600:
            status(f"STOP budget/time guard: initial={b['balance']} current={current} elapsedSeconds={age:.0f}")
            raise SystemExit(3)
        if fresh:
            retain_owned_slots(b)
            return
        status("WAIT incomplete lane accounting; no new phase/slot admitted")
        time.sleep(30)


def run(argv, extra_env=None):
    check_budget()
    subprocess.run(argv, cwd=TREE, env={**ENV, **(extra_env or {})}, check=True)


def read(file):
    return json.loads(file.read_text()) if file.exists() else None


def retain_owned_slots(budget):
    # Adopt only a slot an EG batch has already won. A separate PID keeps the legacy reservation format intact.
    locks = Path('/srv/evimed/pp/locks')
    with (locks / 'eg-capacity.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        held = [read(p) for p in locks.glob('eg-reservation-*.json')]
        owned = {r['slot'] for r in held if r and r.get('campaignPid') == os.getpid() and process_token(r['pid'])}
        for r in held:
            if not r or r['slot'] in owned or not process_token(r['pid']):
                continue
            if r['slot'] not in ['/srv/evimed/pp/live/p48854', '/srv/evimed/pp/live/p48857']:
                continue
            try:
                argv = Path(f"/proc/{r['pid']}/cmdline").read_bytes().split(b'\0')
            except OSError:
                continue
            if str(EG / 'queue-slot.py').encode() not in argv:
                continue
            token = process_token(os.getpid())
            deadline = datetime.fromisoformat(budget['startedAt'].replace('Z', '+00:00')) + timedelta(hours=12)
            holder = subprocess.Popen(['python3', str(EG / 'hold_slot.py'), '--campaign-pid', str(os.getpid()), '--campaign-token', token,
                                       '--deadline', deadline.isoformat()], cwd=TREE, env=ENV, stdin=subprocess.DEVNULL,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            file = locks / f'eg-reservation-{holder.pid}.json'
            temporary = file.with_suffix('.json.tmp')
            temporary.write_text(json.dumps({'pid': holder.pid, 'slot': r['slot'], 'campaignPid': os.getpid(), 'campaignToken': token, 'expiresAt': deadline.isoformat()}))
            temporary.replace(file)
            owned.add(r['slot'])
            status(f"retained admitted slot {r['slot']} holder={holder.pid} until={deadline.isoformat()}")


def record_engine(directory):
    if (directory / "engine.json").exists():
        return
    mounts = json.loads(subprocess.check_output(["docker", "inspect", "ovlab-pp", "--format", "{{json .Mounts}}"], text=True))
    templates = Path(next(m["Source"] for m in mounts if m["Destination"] == "/app/memory-templates"))
    files = sorted(p for p in templates.iterdir() if p.is_file())
    digest = hashlib.sha256()
    for p in files:
        digest.update(f"{p.name}\0{hashlib.sha256(p.read_bytes()).hexdigest()}\n".encode())
    engine = {"version": "v0.5.3", "templatesDigest": digest.hexdigest(), "templatesFiles": len(files), "templatesDir": str(templates),
              "imageDigest": subprocess.check_output(["docker", "inspect", "ovlab-pp", "--format", "{{.Image}}"], text=True).strip(),
              "observedAt": datetime.now(timezone.utc).isoformat(), "observation": "post-run mounted-template audit"}
    (directory / "engine.json").write_text(json.dumps(engine, indent=1))
    manifest = read(directory / "run.json")
    manifest["engine"] = engine
    (directory / "run.json").write_text(json.dumps(manifest, indent=1))


def launch(suite, run_id, port, pg, bridge, extra):
    out = RUNS / run_id
    out.mkdir(exist_ok=True)
    env = {**ENV, "PORT": str(port), "PG_PORT": str(pg), "BRIDGE_PORT": str(bridge),
           "EVAL_EG_CAMPAIGN_PID": str(os.getpid()), "EVAL_EG_CAMPAIGN_TOKEN": process_token(os.getpid())}
    argv = ["python3", str(EG / "queue-slot.py"), "--status", str(out / "STATUS"), "--", "bash", str(EG / "lab.sh"), suite, "--out", str(out), *extra]
    log = (out / "launcher.log").open("a")
    child = subprocess.Popen(argv, env=env, cwd=TREE, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    status(f"START {run_id} pid={child.pid} port={port} pg={pg}")
    return child


def wait_children(children):
    while any(p.poll() is None for p in children):
        check_budget()
        time.sleep(30)
    if any(p.returncode for p in children):
        status(f"phase interrupted: exitCodes={[p.returncode for p in children]}; rerun supervisor to resume")
        raise SystemExit(1)


REPORT.mkdir(exist_ok=True)
status("supervisor active; phase order G1 -> G10 -> G3")
g1_dirs = [RUNS / "g1pp-eg-4", RUNS / "g1pp-eg-5"]
sample = read(SAMPLE)
desired = {u: sum(q["user"] == u for q in sample["questions"]) for u in sample["users"]}
if not read(REPORT / "g1.json") or not read(REPORT / "g1.json").get("complete"):
    # Existing detached G1 owners predate this supervisor. A spent shared-balance guard or a crash may leave a partial user;
    # retry under the current lane-specific guard, preserving ids and progress, at most three times.
    resumes = {}
    while True:
        check_budget()
        completed = []
        for directory, users in zip(g1_dirs, [["M01", "P01", "P02"], ["U03"]]):
            completed.extend((read(directory / "cases" / u / "progress.json") or {}).get("answered", []) for u in users)
        if sum(map(len, completed)) == 100 and all((d / "cases" / u / "answers.jsonl").exists() for d, users in zip(g1_dirs, [["M01", "P01", "P02"], ["U03"]]) for u in users):
            break
        for directory, users, port, pg, bridge in [(g1_dirs[0], ["M01", "P01", "P02"], 48854, 55684, 19374), (g1_dirs[1], ["U03"], 48857, 55685, 19377)]:
            if all(len((read(directory / "cases" / u / "progress.json") or {}).get("answered", [])) == desired[u] and (directory / "cases" / u / "answers.jsonl").exists() for u in users):
                continue
            active = False
            for proc in Path("/proc").iterdir():
                if not proc.name.isdigit():
                    continue
                try:
                    argv = (proc / "cmdline").read_bytes().split(b"\0")
                    active |= str(directory).encode() in argv and any(a.endswith((b"/eg/g1.mjs", b"/queue-slot.py")) for a in argv)
                except OSError:
                    pass
            if not active:
                n = resumes.get(str(directory), 0)
                if n >= 3:
                    status(f"STOP {directory.name}: three supervisor resumes failed")
                    raise SystemExit(1)
                resumes[str(directory)] = n + 1
                launch("g1", directory.name, port, pg, bridge, ["--selection", str(SAMPLE), "--users", ",".join(users)])
        time.sleep(30)
    # Wait for both run owners to close the harness before admitting the next phase.
    while any("DONE G1 product conversations" not in (d / "STATUS").read_text() for d in g1_dirs):
        check_budget()
        time.sleep(10)
    for directory in g1_dirs:
        record_engine(directory)
        run(["node", str(EG / "g1-score.mjs"), "--run", str(directory), "--data", str(DATA), "--selection", str(SAMPLE), "--judge-key-file", "/srv/evimed/secrets/dashscope.api-key"])
    run(["node", str(EG / "report.mjs"), "--suite", "g1", "--selection", str(SAMPLE), "--engine", str(RUNS / "v3-synthetic-users-dev-product-1"), "--runs", ",".join(map(str, g1_dirs)), "--out", str(REPORT), "--ledger", "/srv/evimed/results/ledger.jsonl", "--run-id", "g1pp-eg-paired-20261111"])
    if not read(REPORT / "g1.json").get("complete"):
        status("STOP G1 scoring incomplete; later phases remain pending")
        raise SystemExit(1)
    run(["python3", str(EG / "behavior.py"), "--selection", str(SAMPLE), "--engine", str(RUNS / "v3-synthetic-users-dev-product-1"), "--runs", ",".join(map(str, g1_dirs)), "--out", str(REPORT)])
    status("DONE G1 scored, paired and ledgered")

if not read(REPORT / "g10.json") or not read(REPORT / "g10.json").get("complete"):
    children = [launch("g10", "g10-eg-empty-1", 48854, 55684, 19374, ["--arm", "empty"]),
                launch("g10", "g10-eg-seeded-1", 48857, 55685, 19377, ["--arm", "seeded"])]
    wait_children(children)
    for directory in [RUNS / "g10-eg-empty-1", RUNS / "g10-eg-seeded-1"]:
        run(["python3", "evals/general-tasks/judges/model_judge.py", "--run", str(directory), "--model", "deepseek-flash", "--key-file", "/srv/evimed/secrets/deepseek.api-key"], {"EVAL_JUDGE_USAGE_LOG": str(directory / "judge-usage.jsonl")})
        run(["python3", "evals/general-tasks/judges/summarize.py", "--run", str(directory)])
    run(["node", str(EG / "report.mjs"), "--suite", "g10", "--empty", str(RUNS / "g10-eg-empty-1"), "--seeded", str(RUNS / "g10-eg-seeded-1"), "--out", str(REPORT), "--ledger", "/srv/evimed/results/ledger.jsonl", "--run-id", "g10-eg-paired-20261111"])
    if not read(REPORT / "g10.json").get("complete"):
        status("STOP G10 pairing incomplete; G3 remains pending")
        raise SystemExit(1)
    status("DONE G10 scored, paired and ledgered")

if not read(REPORT / "g3.json") or not read(REPORT / "g3.json").get("complete"):
    queue_args = ["--queue-dir", str(RUNS / "eg-g3-queue-20261111"), "--queue-runs", str(RUNS / "g3-eg-a-1") + "," + str(RUNS / "g3-eg-b-1")]
    children = [launch("g3", "g3-eg-a-1", 48854, 55684, 19374, queue_args),
                launch("g3", "g3-eg-b-1", 48857, 55685, 19377, queue_args)]
    wait_children(children)
    run(["node", str(EG / "report.mjs"), "--suite", "g3", "--runs", str(RUNS / "g3-eg-a-1") + "," + str(RUNS / "g3-eg-b-1"), "--out", str(REPORT), "--ledger", "/srv/evimed/results/ledger.jsonl", "--run-id", "g3-eg-five-20261111"])
    if not read(REPORT / "g3.json").get("complete"):
        status("STOP G3 incomplete; no full-suite result claimed")
        raise SystemExit(1)
    status("DONE G3 scored and ledgered")
status("DONE all three product-path evaluations")
