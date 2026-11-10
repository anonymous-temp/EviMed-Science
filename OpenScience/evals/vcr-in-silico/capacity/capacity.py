#!/usr/bin/env python3
"""R17 capacity driver: N engine services, a FIFO dispatcher with N slots, a fixed schedule.

Protocol: PROTOCOL.md (frozen before the first measured run). No product code is
touched: the engine has one worker thread, so N concurrent jobs means N engine
processes, each with its own work directory.

Hidden knowledge: run the whole thing under `taskset -c 2,3` so the services and
their R children inherit the affinity. Secrets are made fresh in the scratch
directory and deleted with it. Memory is the sum over the service process and its
descendants of RSS and of PSS (smaps_rollup), sampled twice a second.

Usage: taskset -c 2,3 python3 capacity.py --setting n1|n2 --scratch DIR --out FILE.json [--cycles 5]
"""
import argparse, hashlib, json, os, secrets, signal, subprocess, sys, threading, time, urllib.request, urllib.error
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
FIXTURE = REPO / "OpenScience/packages/domain/test/fixtures/vcr-engine-jobs.json"
ENGINE = REPO / "项目代码/vcr-engine"
PORTS = [48891, 48892]
CYCLE_S = 120

# class label -> (fixture name regex-free exact or prefix, replicates override)
CLASSES = {
    "I1": ("design_analytic #20", None), "I2": ("analytic: a non-inferiority margin on a mean", None),
    "I3": ("generate_progression #2", None), "I4": ("generate_progression #5", None),
    "I5": ("a campaign screening run of a two-arm survival design", None),
    "B1": ("design_simulation #25", 40000), "B2": ("modestly weighted: a grid of designs", None),
    "B3": ("design_grid #30", None),
}
INTERACTIVE = ["I1", "I2", "I3", "I4", "I5"]


def fixture_job(prefix):
    for item in json.load(open(FIXTURE))["valid"]:
        if item["name"].startswith(prefix):
            return item["job"]
    raise SystemExit(f"fixture job not found: {prefix}")


def schedule(cycles):
    out = []
    for c in range(cycles):
        base = c * CYCLE_S
        out += [(base + 0, "B1"), (base + 10, "B2"), (base + 60, "B3")]
        for k in range(12):
            out.append((base + 5 + 10 * k, None))
    out.sort(key=lambda x: x[0])
    inter = 0
    final = []
    for t, cls in out:
        if cls is None:
            cls = INTERACTIVE[inter % 5]
            inter += 1
        final.append((t, cls))
    return final


def api(port, token, method, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def children(tree_root):
    ps = subprocess.run(["ps", "-eo", "pid=,ppid=,rss="], capture_output=True, text=True).stdout.split()
    rows = [(int(ps[i]), int(ps[i + 1]), int(ps[i + 2])) for i in range(0, len(ps), 3)]
    kids = {}
    for pid, ppid, rss in rows:
        kids.setdefault(ppid, []).append((pid, rss))
    seen, stack, total = set(), [tree_root], []
    rss_of = {pid: rss for pid, _, rss in rows}
    while stack:
        p = stack.pop()
        if p in seen:
            continue
        seen.add(p)
        if p in rss_of:
            total.append(p)
        stack += [k for k, _ in kids.get(p, [])]
    return total, rss_of


def pss_kb(pid):
    try:
        for line in open(f"/proc/{pid}/smaps_rollup"):
            if line.startswith("Pss:"):
                return int(line.split()[1])
    except OSError:
        pass
    return 0


def mem_available_kb():
    for line in open("/proc/meminfo"):
        if line.startswith("MemAvailable:"):
            return int(line.split()[1])


class Sampler(threading.Thread):
    def __init__(self, roots):
        super().__init__(daemon=True)
        self.roots, self.stop_flag, self.samples = roots, threading.Event(), []

    def run(self):
        while not self.stop_flag.is_set():
            rss = pss = nproc = 0
            for root in self.roots:
                pids, rss_of = children(root)
                nproc += len(pids)
                rss += sum(rss_of[p] for p in pids)
                pss += sum(pss_kb(p) for p in pids)
            self.samples.append((time.time(), rss, pss, nproc, mem_available_kb()))
            self.stop_flag.wait(0.5)


def pct(values, q):
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return round(s[lo] + (s[hi] - s[lo]) * (k - lo), 3)


def canonical_hash(result):
    r = json.loads(json.dumps(result))
    m = r.get("manifest", {})
    for key in ("startedAt", "finishedAt", "cpuSeconds", "cores", "platform", "signature"):
        m.pop(key, None)
    r.pop("jobId", None)
    for key in ("cpuSeconds", "elapsedSeconds"):  # wall-clock diagnostics, outside outputHash
        r.get("diagnostics", {}).pop(key, None)
    return hashlib.sha256(json.dumps(r, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--setting", choices=["n1", "n2"], required=True)
    ap.add_argument("--scratch", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cycles", type=int, default=5)
    a = ap.parse_args()
    slots_n = 1 if a.setting == "n1" else 2
    scratch = Path(a.scratch)
    scratch.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(48)
    (scratch / "token").write_text(token)
    (scratch / "receipt").write_text(secrets.token_urlsafe(48))
    for f in ("token", "receipt"):
        os.chmod(scratch / f, 0o600)
    procs = []
    for i in range(slots_n):
        work = scratch / f"work{i}"
        work.mkdir(exist_ok=True)
        env = {**os.environ, "VCR_ENGINE_TOKEN_FILE": str(scratch / "token"),
               "VCR_ENGINE_RECEIPT_KEY_FILE": str(scratch / "receipt"), "VCR_ENGINE_WORK_DIR": str(work),
               "VCR_ENGINE_ROOT": str(ENGINE), "VCR_R_LIBS": os.environ.get("VCR_R_LIBS", "/home/coder/R/vcr-4.3"),
               "VCR_ENGINE_CORES": "1", "VCR_ENGINE_CPU_SECONDS": "600", "VCR_ENGINE_DATA_ROOT": str(scratch / "data")}
        log = open(scratch / f"engine{i}.log", "w")
        procs.append(subprocess.Popen([sys.executable, "-m", "uvicorn", "service.app:app", "--host", "127.0.0.1",
                                       "--port", str(PORTS[i]), "--log-level", "warning"],
                                      cwd=str(ENGINE), env=env, stdout=log, stderr=subprocess.STDOUT))
    sampler = None
    try:
        for i in range(slots_n):
            for _ in range(120):
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{PORTS[i]}/livez", timeout=2).read()
                    break
                except Exception:
                    time.sleep(0.5)
            else:
                raise SystemExit("engine did not start")
            health = api(PORTS[i], token, "GET", "/health")  # warms the self-check
            assert health.get("ok"), health
        sampler = Sampler([p.pid for p in procs])
        sampler.start()
        time.sleep(1.0)
        base_mem = sampler.samples[-1]
        sched = schedule(a.cycles)
        bodies = {c: fixture_job(CLASSES[c][0]) for c in CLASSES}
        lock = threading.Lock()
        queue, records = [], {}
        idle = list(range(slots_n))
        done_count = [0]
        t0 = time.time()

        def worker(idx, slot, job, rec):
            port = PORTS[slot]
            try:
                api(port, token, "POST", "/jobs", job)
                while True:
                    st = api(port, token, "GET", f"/jobs/{job['jobId']}")
                    now = time.time() - t0
                    if rec["start"] is None and st["state"] != "queued":
                        rec["start"] = now
                    if st["state"] in ("succeeded", "failed", "canceled", "not_estimable"):
                        rec["end"], rec["state"], rec["cpu"], rec["error"] = now, st["state"], st.get("cpuSeconds"), st.get("error")
                        break
                    time.sleep(0.05)
                res = api(port, token, "GET", f"/jobs/{job['jobId']}/result")
                rec["outputHash"] = (res.get("manifest") or {}).get("outputHash")
                rec["canonical"] = canonical_hash(res)
                rec["status"] = res.get("status")
                try:
                    api(port, token, "DELETE", f"/jobs/{job['jobId']}")
                except Exception:
                    pass
            except Exception as exc:  # noqa: BLE001
                rec["end"], rec["state"], rec["error"] = time.time() - t0, "driver_error", repr(exc)
            with lock:
                idle.append(slot)
                done_count[0] += 1

        def dispatcher():
            while True:
                with lock:
                    while idle and queue:
                        slot = idle.pop(0)
                        idx = queue.pop(0)
                        rec = records[idx]
                        job = rec.pop("job")
                        threading.Thread(target=worker, args=(idx, slot, job, rec), daemon=True).start()
                    if done_count[0] == len(sched):
                        return
                time.sleep(0.02)

        threading.Thread(target=dispatcher, daemon=True).start()
        for idx, (t, cls) in enumerate(sched):
            delay = t - (time.time() - t0)
            if delay > 0:
                time.sleep(delay)
            job = json.loads(json.dumps(bodies[cls]))
            job["jobId"] = f"r17_{a.setting}_{idx:03d}"
            job["seed"] = 20260929 + idx
            if CLASSES[cls][1]:
                job["replicates"] = CLASSES[cls][1]
            with lock:
                records[idx] = {"idx": idx, "cls": cls, "arrival": t, "submit": time.time() - t0, "start": None,
                                "end": None, "state": None, "job": job}
                queue.append(idx)
        while True:
            with lock:
                if done_count[0] == len(sched):
                    break
            time.sleep(0.2)
        wall = max(r["end"] for r in records.values())
    finally:
        if sampler:
            sampler.stop_flag.set()
            sampler.join(timeout=3)
        for p in procs:
            p.send_signal(signal.SIGTERM)
        for p in procs:
            try:
                p.wait(timeout=15)
            except subprocess.TimeoutExpired:
                p.kill()

    recs = [records[i] for i in sorted(records)]
    for r in recs:
        r["queueWait"] = round((r["start"] if r["start"] is not None else r["end"]) - r["submit"], 3)
        r["latency"] = round(r["end"] - r["submit"], 3)
    by = {}
    for grp, test in (("interactive", lambda c: c.startswith("I")), ("batch", lambda c: c.startswith("B")),
                      *[(c, (lambda c: lambda x: x == c)(c)) for c in CLASSES]):
        sel = [r for r in recs if test(r["cls"])]
        by[grp] = {"n": len(sel),
                   "latency": {q: pct([r["latency"] for r in sel], v) for q, v in (("p50", .5), ("p95", .95), ("max", 1.0))},
                   "queueWait": {q: pct([r["queueWait"] for r in sel], v) for q, v in (("p50", .5), ("p95", .95), ("max", 1.0))}}
    s = sampler.samples
    cpu_total = sum(r.get("cpu") or 0 for r in recs)
    summary = {
        "setting": a.setting, "slots": slots_n, "jobs": len(recs), "wallSeconds": round(wall, 2),
        "arrivalSpanSeconds": recs[-1]["submit"], "throughputJobsPerMin": round(len(recs) / wall * 60, 3),
        "engineCpuSeconds": round(cpu_total, 2), "engineCpuPerWallSecond": round(cpu_total / wall, 3),
        "failures": [r["idx"] for r in recs if r["state"] != "succeeded"],
        "classes": by,
        "memory": {"baselineRssMB": round(base_mem[1] / 1024, 1), "baselinePssMB": round(base_mem[2] / 1024, 1),
                   "peakRssMB": round(max(x[1] for x in s) / 1024, 1), "peakPssMB": round(max(x[2] for x in s) / 1024, 1),
                   "meanRssMB": round(sum(x[1] for x in s) / len(s) / 1024, 1),
                   "peakProcesses": max(x[3] for x in s),
                   "hostMemAvailableMinMB": round(min(x[4] for x in s) / 1024, 1),
                   "hostMemAvailableStartMB": round(s[0][4] / 1024, 1), "samples": len(s)},
    }
    json.dump({"summary": summary, "jobs": [{k: v for k, v in r.items() if k != "job"} for r in recs]},
              open(a.out, "w"), indent=1)
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
