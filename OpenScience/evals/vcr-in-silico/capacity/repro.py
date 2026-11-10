#!/usr/bin/env python3
"""R17 follow-up: why does the driver's `canonical` digest differ while `outputHash` matches?

Runs each of the eight job classes once in a fresh engine (one slot) and once with
two engines running pairs concurrently, same body and seed (jobId aside), keeps the
full results and prints every path that differs, with the manifest's `outputHash`.
Usage: taskset -c 2,3 python3 -I repro.py SCRATCH
"""
import json, os, secrets, signal, subprocess, sys, time, threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import capacity as C

def walk(a, b, path=""):
    if type(a) != type(b):
        yield path; return
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b: yield f"{path}/{k}"
            else: yield from walk(a[k], b[k], f"{path}/{k}")
    elif isinstance(a, list):
        if len(a) != len(b): yield path
        else:
            for i, (x, y) in enumerate(zip(a, b)): yield from walk(x, y, f"{path}[{i}]")
    elif a != b: yield path

def run(scratch, n, tag):
    token = secrets.token_urlsafe(48); (scratch / "token").write_text(token); os.chmod(scratch / "token", 0o600)
    procs = []
    for i in range(n):
        w = scratch / f"{tag}{i}"; w.mkdir()
        env = {**os.environ, "VCR_ENGINE_TOKEN_FILE": str(scratch / "token"), "VCR_ENGINE_WORK_DIR": str(w),
               "VCR_ENGINE_ROOT": str(C.ENGINE), "VCR_ENGINE_CORES": "1", "VCR_ENGINE_DATA_ROOT": str(scratch / "data")}
        procs.append(subprocess.Popen([sys.executable, "-m", "uvicorn", "service.app:app", "--port", str(C.PORTS[i]), "--log-level", "warning"],
                                      cwd=str(C.ENGINE), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT))
    out = {}
    try:
        for i in range(n):
            for _ in range(120):
                try: C.api(C.PORTS[i], token, "GET", "/health"); break
                except Exception: time.sleep(0.5)
        classes = list(C.CLASSES)
        def one(cls, slot):
            job = json.loads(json.dumps(C.fixture_job(C.CLASSES[cls][0]))); job["jobId"] = f"rp_{tag}_{cls}"; job["seed"] = 777
            if C.CLASSES[cls][1]: job["replicates"] = 5000
            C.api(C.PORTS[slot], token, "POST", "/jobs", job)
            while C.api(C.PORTS[slot], token, "GET", f"/jobs/{job['jobId']}")["state"] in ("queued", "running", "canceling"): time.sleep(0.1)
            out[cls] = C.api(C.PORTS[slot], token, "GET", f"/jobs/{job['jobId']}/result")
        for j in range(0, len(classes), n):
            ts = [threading.Thread(target=one, args=(c, s)) for s, c in enumerate(classes[j:j + n])]
            [t.start() for t in ts]; [t.join() for t in ts]
    finally:
        for p in procs: p.send_signal(signal.SIGTERM)
        for p in procs: p.wait(timeout=20)
    return out

scratch = Path(sys.argv[1]); scratch.mkdir(parents=True, exist_ok=True)
r1, r2 = run(scratch, 1, "a"), run(scratch, 2, "b")
for cls in C.CLASSES:
    diff = list(walk(r1[cls], r2[cls]))
    print(cls, "outputHash equal:", r1[cls]["manifest"]["outputHash"] == r2[cls]["manifest"]["outputHash"], "| differing paths:", diff)
