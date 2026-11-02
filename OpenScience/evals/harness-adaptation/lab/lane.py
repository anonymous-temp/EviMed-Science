#!/usr/bin/env python3
"""One RSI lab lane: a GitHub Actions job that has brought the stack up (stack.py) and now takes benchmark requests from the broker.

Python 3 standard library only. N worker threads (LANES) each loop: claim one request for this lane's image key, run
`bench-driver.mjs` on a one-item queue with a throwaway account against the local stack, pack what the driver left (the transcript, the
result JSON, report-like files; oversized files dropped and recorded), and hand the bundle to the broker (`done`). Infrastructure
trouble is `fail`, never a result: the broker requeues it a bounded number of times and then keeps a terminal marker, so an infra
failure can never be scored as a zero. A worker stops claiming when less than the item's timeout plus 15 minutes remains in the job.

Logs are public (this repository is). Every line this program prints is a counter, a request id or a bounded code: never an item key, a
prompt, an answer, a URL or any model output. The bundle that goes to the broker is where all of that lives.

Environment: LANE_ID, LANES, IMAGE_KEY, DEADLINE_EPOCH (when the job must be done), IDLE_EXIT_MIN, LAB_WORK, LAB_SRC, LAB_BUNDLE.
"""
import io
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import tarfile
import threading
import time
import urllib.parse
import urllib.request
import zlib
import zipfile

LANE_ID = os.environ.get("LANE_ID", "lane")
WORKERS = int(os.environ.get("LANES", "3"))
IMAGE_KEY = os.environ.get("IMAGE_KEY", "base")
DEADLINE = float(os.environ.get("DEADLINE_EPOCH") or (time.time() + 330 * 60))
IDLE_EXIT_S = float(os.environ.get("IDLE_EXIT_MIN", "30")) * 60
WORK = pathlib.Path(os.environ.get("LAB_WORK") or os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "lab"))
SRC = pathlib.Path(os.environ.get("LAB_SRC") or "OpenScience").resolve()
BUNDLE = pathlib.Path(os.environ.get("LAB_BUNDLE") or WORK / "bundle")
BENCH = WORK / "bench"
API = "http://127.0.0.1:8787"
MARGIN_MIN = 15
BUNDLE_CAP = 30 * 1024 * 1024
FILE_CAP = 12 * 1024 * 1024
HEARTBEAT_S = 240

# Result statuses and error codes that mean the platform or the lane failed, not the solver (re-queued, never scored).
INFRA_STATUS = {"dispatch_refused", "driver_error", "interrupted"}
INFRA_ERROR = re.compile(r"^runtime_(stopped|session_error|prompt_lost|monitor_timeout|unavailable|start_failed)$|gateway|controller")

# The benchmarks' own names: a URL in a run's tool calls or results that contains one is recorded (never acted on).
BENCHMARK_NAMES = ("medbrowsecomp", "medcalc-bench", "autoresearchbench", "deep_research_bench", "deepresearch-bench", "bixbench",
                   "researchclawbench", "bioxarena")
DATASET_HOST = re.compile(r"^(?:[a-z0-9-]+\.)*(?:huggingface\.co|hf\.co)$", re.I)
URL = re.compile(r"https?://[^\s\"'<>)\]\\]+", re.I)

PRINT_LOCK = threading.Lock()


def say(line):
    with PRINT_LOCK:
        print(f"{time.strftime('%H:%M:%S', time.gmtime())} {line}", flush=True)


def run(command, check=True, **kwargs):
    return subprocess.run(command, check=check, **kwargs)


# ------------------------------------------------------------------------------------------------------------------ broker
class Broker:
    def __init__(self):
        self.key = BUNDLE / "broker" / "id_ed25519"
        os.chmod(self.key, 0o600)
        self.known_hosts = BUNDLE / "broker" / "known_hosts"
        self.target = "rsi-broker@" + (BUNDLE / "broker" / "host").read_text().strip()

    def call(self, *words, stdin_path=None, timeout=180, tries=4):
        command = ["ssh", "-i", str(self.key), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", f"UserKnownHostsFile={self.known_hosts}",
                   "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
                   # One connection per job: the broker host is shared and small, and a handshake per call for 30 workers took it to a load of 40 (2026-11-02).
                   "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/rsi-broker-%C", "-o", "ControlPersist=300",
                   self.target, " ".join(shlex.quote(w) for w in words)]
        last = ""
        for attempt in range(tries):
            handle = open(stdin_path, "rb") if stdin_path else subprocess.DEVNULL
            try:
                result = subprocess.run(command, stdin=handle, capture_output=True, timeout=timeout)
            except subprocess.TimeoutExpired:
                result = None
            finally:
                if stdin_path:
                    handle.close()
            if result is not None and result.returncode == 0:
                return result.stdout.decode("utf-8", "replace").strip()
            if result is not None and result.returncode == 3:
                # The broker understood and refused (bad arguments, unreadable bundle): asking again cannot help.
                raise BrokerRefused(result.stderr.decode("utf-8", "replace").strip()[:120])
            last = "timeout" if result is None else f"exit {result.returncode}"
            time.sleep(min(60, 5 * 3 ** attempt))
        raise BrokerUnreachable(last)


class BrokerRefused(Exception):
    pass


class BrokerUnreachable(Exception):
    pass


# ------------------------------------------------------------------------------------------------------------------ memory
class Sampler(threading.Thread):
    """docker stats every 30 s: the peak memory of each container, runtimes numbered in the order they appear."""

    def __init__(self):
        super().__init__(daemon=True)
        self.peaks = {}
        self.runtime_names = {}
        self.stop_flag = threading.Event()
        self.lock = threading.Lock()
        self.host_peak_mb = 0

    @staticmethod
    def to_mb(text):
        match = re.match(r"([\d.]+)\s*([KMGT]?i?B)", text.strip())
        if not match:
            return 0.0
        scale = {"B": 1 / 1048576, "KiB": 1 / 1024, "MiB": 1, "GiB": 1024, "TiB": 1048576, "kB": 1 / 1000, "MB": 0.95367, "GB": 953.67}
        return float(match.group(1)) * scale.get(match.group(2), 1)

    def run(self):
        tick = 0
        while not self.stop_flag.wait(10):
            tick += 1
            self.sample_runtime_cgroups()
            if tick % 3 == 0:
                self.sample()

    def sample_runtime_cgroups(self):
        """The kernel's own high-water mark of each runtime container's memory cgroup (memory.peak): exact, whatever the sampling period."""
        try:
            ids = subprocess.run(["docker", "ps", "-q", "--no-trunc", "--filter", "label=open-science.web.runtime=true"], capture_output=True, timeout=20).stdout.decode().split()
        except (subprocess.TimeoutExpired, OSError):
            return
        with self.lock:
            for container in ids:
                for path in (f"/sys/fs/cgroup/system.slice/docker-{container}.scope/memory.peak", f"/sys/fs/cgroup/docker/{container}/memory.peak"):
                    try:
                        peak = int(pathlib.Path(path).read_text().strip()) / 1048576
                    except (OSError, ValueError):
                        continue
                    label = self.runtime_names.setdefault(container, f"runtime{len(self.runtime_names) + 1}")
                    self.peaks[label] = max(self.peaks.get(label, 0), round(peak))
                    break

    def sample(self):
        try:
            out = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}"], capture_output=True, timeout=60).stdout.decode()
            runtimes = set(subprocess.run(["docker", "ps", "--filter", "label=open-science.web.runtime=true", "--format", "{{.Names}}"],
                                          capture_output=True, timeout=30).stdout.decode().split())
        except (subprocess.TimeoutExpired, OSError):
            return
        total = 0.0
        with self.lock:
            for line in out.splitlines():
                name, _, usage = line.partition("\t")
                if not name:
                    continue
                megabytes = self.to_mb(usage.split("/")[0])
                total += megabytes
                # Runtime containers are named after their project (and so after the item); the numbers carry no name.
                if name in runtimes:
                    continue  # runtimes are read from their cgroups (sample_runtime_cgroups): exact, and numbered once
                elif name.startswith("rsi-driver"):
                    label = "driver"
                else:
                    label = re.sub(r"^web-|-\d+$", "", name)
                self.peaks[label] = max(self.peaks.get(label, 0), round(megabytes))
            self.host_peak_mb = max(self.host_peak_mb, round(total))

    def snapshot(self):
        with self.lock:
            runtime_peaks = [value for label, value in self.peaks.items() if label.startswith("runtime")]
            return {"peakMemMiB": dict(self.peaks), "containersPeakSumMiB": self.host_peak_mb,
                    "runtimePeakMaxMiB": max(runtime_peaks) if runtime_peaks else 0, "runtimesSeen": len(runtime_peaks)}


# ------------------------------------------------------------------------------------------------------------------ prompt tap
class PromptTap:
    """Reads back what a live session really sends: the runtime reaches the model gateway over plain HTTP on the internal Docker network, so
    a packet capture of that bridge holds every request a session makes, system prompt included. Only the number of times each marker
    appears is kept (the capture itself stays on the runner and is deleted); PROMPT_MARKERS is a comma-separated list. It is for batches that
    check a changed guidance text reached a live session, and it is off otherwise."""

    def __init__(self, markers):
        self.markers = [m for m in markers if m]
        self.pcap = WORK / "gateway.pcap"
        self.process = None

    def start(self):
        if not self.markers:
            return
        subprocess.run(["apt-get", "install", "-y", "-qq", "tcpdump"], capture_output=True, timeout=300)
        network = subprocess.run(["docker", "network", "inspect", "-f", "{{.Id}}", "open-science-runtime-internal"], capture_output=True, text=True).stdout.strip()
        if not network:
            say("prompt tap: the runtime network was not found")
            return
        self.process = subprocess.Popen(["tcpdump", "-i", f"br-{network[:12]}", "-s", "0", "-U", "-w", str(self.pcap), "tcp", "port", "8787"],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        say(f"prompt tap on bridge br-{network[:6]}..: {len(self.markers)} marker(s)")

    def stop(self):
        if self.process is None:
            return {}
        self.process.terminate()
        try:
            self.process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.process.kill()
        data = self.pcap.read_bytes() if self.pcap.exists() else b""
        counts = {marker: data.count(marker.encode("utf-8")) for marker in self.markers}
        say(f"prompt tap: capture {len(data) // 1024} KiB; marker occurrences {json.dumps(counts, ensure_ascii=False)}")
        self.pcap.unlink(missing_ok=True)
        return counts


# ------------------------------------------------------------------------------------------------------------------ data
def fetch_data(entries):
    """The public input files of a request into the lane's cache, as host_fetch.py lays them out under /bench/data."""
    fetched = 0
    for entry in entries or []:
        dest = BENCH / str(entry["dest"]).removeprefix("/bench/").lstrip("/")
        if BENCH.resolve() not in dest.resolve().parents:
            raise ValueError("data destination escapes the cache")
        url = str(entry["url"])
        if urllib.parse.urlsplit(url).scheme != "https":
            raise ValueError("data URL is not https")
        dest.parent.mkdir(parents=True, exist_ok=True)
        lock_path = dest.with_name(dest.name + ".lock")
        import fcntl
        with open(lock_path, "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            unzip = entry.get("unzip")
            marker = pathlib.Path(str(unzip["into"]).replace("/bench/", str(BENCH) + "/", 1)) / ".extracted" if unzip else None
            if marker is not None and marker.exists():
                continue
            packed = dest.with_name(dest.name + ".gz")
            if entry.get("gzip") and packed.exists() and packed.stat().st_size > 0:
                continue
            good = dest.exists() and (entry.get("bytes") is None or dest.stat().st_size == entry["bytes"])
            if good and entry.get("sha256"):
                good = sha256_file(dest) == entry["sha256"]
            if not good:
                download(url, dest, entry.get("bytes"), entry.get("sha256"))
                fetched += 1
            if unzip:
                extract(dest, unzip)
            if entry.get("gzip"):
                # The host kept a file above the upload limit gzipped (its item names the .gz); the same bytes, compressed without a clock.
                import gzip
                with open(dest, "rb") as source, open(packed, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as out:
                    for chunk in iter(lambda: source.read(1 << 20), b""):
                        out.write(chunk)
                dest.unlink()
    return fetched


def sha256_file(path):
    import hashlib
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, dest, size, digest):
    temporary = dest.with_name(dest.name + ".part")
    last = ""
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "evimed-rsi-lab"}), timeout=120) as response, open(temporary, "wb") as out:
                while True:
                    chunk = response.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
            if size is not None and temporary.stat().st_size != size:
                raise ValueError("size mismatch")
            if digest and sha256_file(temporary) != digest:
                raise ValueError("sha256 mismatch")
            os.replace(temporary, dest)
            return
        except (OSError, ValueError) as error:
            last = type(error).__name__
            time.sleep(5 * (attempt + 1))
    temporary.unlink(missing_ok=True)
    raise OSError(f"data download failed ({last})")


def extract(archive, unzip):
    into = pathlib.Path(str(unzip["into"]).replace("/bench/", str(BENCH) + "/", 1))
    into.mkdir(parents=True, exist_ok=True)
    prefix = unzip.get("only_prefix") or ""
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            name = info.filename
            if (prefix and not name.startswith(prefix)) or info.is_dir():
                continue
            relative = name[len(prefix):] if unzip.get("strip_prefix") else name
            target = (into / relative).resolve()
            if into.resolve() not in target.parents:
                raise ValueError("unsafe path in archive")
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(info) as source, open(target, "wb") as out:
                out.write(source.read())
    (into / ".extracted").write_text("ok\n")
    if unzip.get("delete_zip"):
        archive.unlink(missing_ok=True)


# ------------------------------------------------------------------------------------------------------------------ bundle
def item_folder(key):
    """The driver's own naming (bench-driver.mjs itemDir): `/` becomes `__`, anything outside [A-Za-z0-9_.-] becomes `_`."""
    return re.sub(r"[^\w.\-]", "_", key.replace("/", "__"))


def tool_parts(messages):
    for message in messages:
        for part in message.get("parts") or []:
            if isinstance(part, dict) and part.get("type") == "tool":
                yield part


def strings_of(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for inner in value.values():
            yield from strings_of(inner)
    elif isinstance(value, list):
        for inner in value:
            yield from strings_of(inner)


def contamination(transcript_path):
    """Every URL in the run's tool calls and results that names one of the benchmarks (record only, nothing is acted on)."""
    out = {"names": list(BENCHMARK_NAMES), "hits": [], "count": 0, "datasetHostUrls": 0, "scanned": False}
    try:
        data = json.loads(pathlib.Path(transcript_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return out
    messages = data.get("messages") or data.get("records") or []
    seen = set()
    out["scanned"] = True
    for part in tool_parts(messages):
        for where, value in (("call", part.get("input")), ("result", {k: v for k, v in part.items() if k not in ("input", "type", "tool")})):
            for text in strings_of(value):
                for match in URL.finditer(text):
                    url = match.group(0).rstrip(".,;")
                    host = urllib.parse.urlsplit(url).hostname or ""
                    lowered = url.lower()
                    if DATASET_HOST.match(host) and (where, url) not in seen:
                        out["datasetHostUrls"] += 1
                    names = [name for name in BENCHMARK_NAMES if name in lowered]
                    if names and (where, url) not in seen:
                        seen.add((where, url))
                        out["count"] += 1
                        if len(out["hits"]) < 100:
                            out["hits"].append({"where": where, "tool": str(part.get("tool"))[:40], "names": names, "url": url[:300]})
    return out


def pack(out_dir, folder, meta, target):
    """tar.gz of the item's output folder and the driver log, large files dropped by priority; returns what was dropped."""
    root = out_dir / folder
    entries = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            relative = path.relative_to(root).as_posix()
            if relative in ("result.json", "run.json", "answer.md"):
                tier = 0
            elif relative == "transcript.json":
                tier = 1
            elif re.search(r"\.(md|docx|pdf)$", relative, re.I) or re.search(r"(^|/)report/", relative, re.I):
                tier = 2
            else:
                tier = 3
            entries.append((tier, path.stat().st_size, relative, path))
    driver_log = out_dir / "driver.log"
    if driver_log.exists():
        entries.append((1, driver_log.stat().st_size, "driver.log", driver_log))
    entries.sort(key=lambda row: (row[0], row[1], row[2]))
    kept, dropped, budget = [], [], BUNDLE_CAP - 64 * 1024
    for tier, size, relative, path in entries:
        if size > FILE_CAP:
            dropped.append({"path": relative, "bytes": size, "reason": "over the per-file cap"})
            continue
        estimate = len(zlib.compress(path.read_bytes(), 3)) if size else 0
        if estimate > budget:
            dropped.append({"path": relative, "bytes": size, "reason": "bundle cap"})
            continue
        budget -= estimate
        kept.append((relative, path))
    meta = {**meta, "dropped": dropped, "kept": len(kept)}
    with tarfile.open(target, "w:gz", compresslevel=6) as archive:
        for relative, path in kept:
            archive.add(path, arcname=f"{meta['rid']}/{relative}")
        payload = json.dumps(meta, indent=2, sort_keys=True).encode("utf-8")
        info = tarfile.TarInfo(f"{meta['rid']}/lane.json")
        info.size = len(payload)
        info.mtime = int(time.time())
        archive.addfile(info, io.BytesIO(payload))
    return dropped


# ------------------------------------------------------------------------------------------------------------------ worker
class Lane:
    def __init__(self):
        self.broker = Broker()
        self.sampler = Sampler()
        self.images = json.loads((WORK / "images.json").read_text())
        self.web_image = self.images["roles"]["web"]
        self.tools = SRC / "evals" / "public-benchmarks" / "tools"
        self.stats = {"done": 0, "infraFailed": 0, "claimed": 0}
        self.state = {}
        self.lock = threading.Lock()
        self.last_work = time.time()
        self.started = time.time()
        self.stop = threading.Event()
        self.keyless = None
        self.tap = PromptTap([m.strip() for m in os.environ.get("PROMPT_MARKERS", "").split(",")])

    # -- the provider keys stay out of the runtime containers (checked once, on the first runtime that runs)
    def audit_keyless(self):
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
        import stack
        while not self.stop.wait(20) and self.keyless is None:
            if not subprocess.run(["docker", "ps", "-q", "--filter", "label=open-science.web.runtime=true"], capture_output=True).stdout.strip():
                continue
            failures = []
            stack.verify_runtime_keyless(failures)
            self.keyless = {"ok": not failures, "failures": failures}

    # -- the facts `stack.py verify` recorded at bring-up (the context engine, the document parser, the Tokyo edge), with the counters of what
    #    memory and learning did with the runs so far: every run of the lab is `automated` on a throwaway account, so those stay at zero.
    def stack_facts(self):
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
        import stack
        try:
            facts = json.loads(stack.FACTS_FILE.read_text())
        except (OSError, ValueError):
            facts = {}
        try:
            facts["metrics"] = stack.metrics_facts()
        except Exception:  # a metrics read is evidence, never a reason to lose a result
            facts["metrics"] = {"read": False}
        return facts

    # -- stack
    def healthy(self):
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
        import stack
        return stack.stack_healthy()

    # -- one request
    def process(self, worker, request):
        rid = request["rid"]
        folder_root = WORK / "runs" / re.sub(r"[^A-Za-z0-9_.-]", "_", f"{worker}-{rid}")
        out_dir = folder_root / "out"
        out_dir.mkdir(parents=True, exist_ok=True)
        item = dict(request["item"])
        probe = request.get("probe") or {}
        if probe.get("preamble"):
            item["prompt"] = f"<工作约定>\n{probe['preamble']}\n</工作约定>\n\n{item['prompt']}"
        if probe.get("line"):
            item["line"] = probe["line"]
        item.setdefault("deleteGroupAfter", True)
        beat = threading.Event()
        lost = threading.Event()

        def heartbeat():
            while not beat.wait(HEARTBEAT_S):
                try:
                    if self.broker.call("heartbeat", worker, rid, tries=2, timeout=60) == "lost":
                        lost.set()
                except (BrokerUnreachable, BrokerRefused):
                    pass

        threading.Thread(target=heartbeat, daemon=True).start()
        began = time.time()
        reason = None
        status = None
        try:
            fetched = fetch_data(request.get("data"))
            (folder_root / "queue.jsonl").write_text(json.dumps(item, ensure_ascii=False) + "\n", encoding="utf-8")
            timeout_s = (float(item.get("timeoutMin", 15)) + 15) * 60
            name = "rsi-driver-" + re.sub(r"[^A-Za-z0-9_.-]", "-", f"{worker}")
            command = ["docker", "run", "--rm", "--name", name, "--network", "host", "--user", "0:0", "--stop-timeout", "60",
                       "-v", f"{folder_root}:/work", "-v", f"{self.tools}:/bench/tools:ro", "-v", f"{BENCH / 'data'}:/bench/data:ro",
                       "--entrypoint", "node", self.web_image, "/bench/tools/bench-driver.mjs", "--queue", "/work/queue.jsonl", "--out", "/work/out",
                       "--base", API, "--poll-ms", "8000"]
            say(f"[{worker}] {rid}: driver start (data files fetched {fetched}, timeout {item.get('timeoutMin', 15)} min)")
            with open(folder_root / "driver.stdout", "wb") as sink:
                try:
                    code = subprocess.run(command, stdout=sink, stderr=subprocess.STDOUT, timeout=timeout_s).returncode
                except subprocess.TimeoutExpired:
                    run(["docker", "stop", "-t", "60", name], check=False, capture_output=True)
                    code = -9
            result = None
            try:
                result = json.loads((out_dir / item_folder(item["key"]) / "result.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
            status = result.get("status") if result else None
            healthy = self.healthy()
            if result is None:
                reason = "no_result"
                tail = ""
                try:
                    tail = (folder_root / "driver.stdout").read_text(encoding="utf-8", errors="replace")[-600:]
                except OSError:
                    pass
                # The driver's own last lines, with the item's key taken out; they name accounts and refusals, never a prompt.
                tail = tail.replace(item["key"], "<key>")
                say(f"[{worker}] {rid}: the driver left no result (exit {code}); its last lines: {' | '.join(tail.strip().splitlines()[-3:])[:360]}")
            elif status in INFRA_STATUS or result.get("infrastructureFailure"):
                reason = f"driver_{status}"
            elif status == "failed" and INFRA_ERROR.search(str(result.get("errorCode") or "")):
                reason = "run_infrastructure"
            elif not healthy:
                reason = "stack_unhealthy"
            if reason is None:
                transcript = out_dir / item_folder(item["key"]) / "transcript.json"
                self.sampler.sample()
                meta = {"rid": rid, "lane": LANE_ID, "worker": worker, "imageKey": IMAGE_KEY, "attempt": request.get("attempt"),
                        "driverExit": code, "status": status, "wallS": round(time.time() - began), "claimLost": lost.is_set(),
                        "contamination": contamination(transcript), "runtimeKeyless": self.keyless, **self.sampler.snapshot(),
                        "cost": result.get("cost"), "stack": self.stack_facts()}
                bundle_path = folder_root / "bundle.tgz"
                dropped = pack(out_dir, item_folder(item["key"]), meta, bundle_path)
                size = bundle_path.stat().st_size
                try:
                    answer = self.broker.call("done", rid, stdin_path=str(bundle_path), timeout=600)
                except BrokerRefused as error:
                    say(f"[{worker}] {rid}: broker refused the bundle ({error})")
                    answer = None
                if answer in ("ok", "duplicate"):
                    with self.lock:
                        self.stats["done"] += 1
                    say(f"[{worker}] {rid}: done status={status} wall={round(time.time() - began)}s bundle={size // 1024}KiB dropped={len(dropped)} "
                        f"contamination={meta['contamination']['count']} cost={(meta['cost'] or {}).get('cost') if isinstance(meta['cost'], dict) else None} ({answer})")
                    return True
                reason = "upload_failed"
        except BrokerUnreachable as error:
            reason = f"broker_unreachable"
            say(f"[{worker}] {rid}: broker unreachable ({error})")
        except Exception as error:  # a lane bug or a full disk is the lane's, never the item's
            reason = f"lane_{type(error).__name__.lower()}"[:60]
            say(f"[{worker}] {rid}: lane error {type(error).__name__}")
        finally:
            beat.set()
            shutil_rmtree(folder_root)
        try:
            self.broker.call("fail", rid, re.sub(r"[^a-z0-9_.:-]", "_", reason.lower())[:60], tries=3, timeout=60)
        except (BrokerUnreachable, BrokerRefused):
            pass
        with self.lock:
            self.stats["infraFailed"] += 1
        say(f"[{worker}] {rid}: infrastructure failure ({reason}); handed back")
        return False

    # -- the loop of one worker
    def worker_loop(self, index):
        worker = f"{LANE_ID}.w{index}"
        while not self.stop.is_set():
            remaining_min = (DEADLINE - time.time()) / 60 - MARGIN_MIN
            if remaining_min < 10:
                break
            self.state[worker] = "claiming"
            try:
                raw = self.broker.call("claim", worker, IMAGE_KEY, str(int(remaining_min)), tries=3, timeout=90)
            except (BrokerUnreachable, BrokerRefused) as error:
                say(f"[{worker}] claim failed ({error})")
                self.state[worker] = "idle"
                if self.stop.wait(60):
                    break
                continue
            if not raw:
                self.state[worker] = "idle"
                if self.stop.wait(45):
                    break
                continue
            request = json.loads(raw)
            with self.lock:
                self.stats["claimed"] += 1
                self.last_work = time.time()
            self.state[worker] = request["rid"]
            if not self.healthy():
                try:
                    self.broker.call("fail", request["rid"], "stack_unhealthy", tries=3, timeout=60)
                except (BrokerUnreachable, BrokerRefused):
                    pass
                say(f"[{worker}] stack unhealthy before {request['rid']}; the lane stops")
                self.stop.set()
                break
            self.process(worker, request)
            self.last_work = time.time()
        self.state[worker] = "stopped"

    def report_loop(self):
        while not self.stop.wait(120):
            payload = {"lane": LANE_ID, "upMin": round((time.time() - self.started) / 60), "workers": dict(self.state), **self.stats,
                       **self.sampler.snapshot()}
            try:
                self.broker.call("lane-status", LANE_ID, json.dumps(payload, separators=(",", ":")), tries=1, timeout=45)
            except (BrokerUnreachable, BrokerRefused):
                pass

    def main(self):
        BENCH.mkdir(parents=True, exist_ok=True)
        (BENCH / "data").mkdir(exist_ok=True)
        self.tap.start()
        self.sampler.start()
        threading.Thread(target=self.report_loop, daemon=True).start()
        threading.Thread(target=self.audit_keyless, daemon=True).start()
        threads = [threading.Thread(target=self.worker_loop, args=(index,)) for index in range(1, WORKERS + 1)]
        for thread in threads:
            thread.start()
        while any(thread.is_alive() for thread in threads):
            time.sleep(5)
            idle = all(self.state.get(f"{LANE_ID}.w{i}") in ("idle", "stopped", None) for i in range(1, WORKERS + 1))
            if idle and time.time() - self.last_work > IDLE_EXIT_S:
                say("no request for the idle limit; the lane ends")
                self.stop.set()
        self.stop.set()
        self.sampler.stop_flag.set()
        self.sampler.sample()
        markers = self.tap.stop()
        snapshot = self.sampler.snapshot()
        say(f"lane stack facts at the end: {json.dumps(self.stack_facts(), sort_keys=True)}")
        say(f"lane ended: claimed={self.stats['claimed']} done={self.stats['done']} infraFailed={self.stats['infraFailed']} "
            f"peakMemMiB={json.dumps(snapshot['peakMemMiB'], sort_keys=True)} containersPeakSumMiB={snapshot['containersPeakSumMiB']} "
            f"runtimePeakMaxMiB={snapshot['runtimePeakMaxMiB']} runtimesSeen={snapshot['runtimesSeen']}")
        try:
            self.broker.call("lane-status", LANE_ID, json.dumps({"lane": LANE_ID, "stage": "ended", **self.stats}, separators=(",", ":")), tries=1, timeout=45)
        except (BrokerUnreachable, BrokerRefused):
            pass


def shutil_rmtree(path):
    import shutil
    shutil.rmtree(path, ignore_errors=True)


if __name__ == "__main__":
    Lane().main()
