#!/usr/bin/env python3
"""The RSI lab's request broker. Python 3 standard library only; runs on the lab host as the user `rsi-broker`.

Two roles, fixed by the caller's authorized_keys line and never by the client:

  --role lane   a lane (a GitHub Actions job) reaching the broker over SSH with a forced command. The client's command line arrives
                in SSH_ORIGINAL_COMMAND and is parsed here, strictly:

                  claim <worker> <image> [maxTimeoutMin]   one request JSON on stdout, atomically, or nothing
                  heartbeat <worker> <rid>                 `ok`, or `lost` when the claim is no longer this worker's
                  done <rid>                               a tar.gz bundle on stdin (size-capped); moves the claim to results
                  fail <rid> <reason>                      an infrastructure failure: requeued, bounded, then a terminal marker
                  lane-status <lane> <json>                the lane's last report (at most 4 KB)

  --role admin  the operator, as `runuser -u rsi-broker -- broker.py --role admin <command>` (see brokerctl.py):
                submit | status | results | cat <rid> | purge <rid> | pause | resume | drain | requeue <rid>

State is plain files under RSI_BROKER_ROOT (default /srv/rsi-lab/h2):

  pending/<rid>.json            a request, waiting
  claimed/<rid>.json + .claim   a request in a worker's hands; the .claim file holds the worker, claim time and last heartbeat
  attempts/<rid>.json           how many times the request ran into an infrastructure failure, and why
  results/<rid>.tgz + .meta.json   a finished request's bundle
  results/<rid>.infra-failed.json   the terminal marker: the request never ran to an answer; it is never a score
  lanes/<lane>.json             each lane's last status report
  PAUSE                         while it exists, `claim` answers nothing

Every state change happens under one exclusive flock on <root>/.lock, so two claims can never take the same request. A claim with no
heartbeat for HEARTBEAT_TTL seconds returns to pending at the next call of any kind that sweeps (claim, admin status, admin drain).

A request is {"rid": str, "image": "base"|"<delta tag>", "item": <bench-driver queue line>, "probe": {"preamble": str|null,
"line": str|null}} plus an optional "data" list of public files the lane fetches (see lane.py). A request never carries a gold answer,
a rubric or a score: both `admin submit` and brokerctl refuse a key that names one, at any depth.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shlex
import shutil
import sys
import tarfile
import tempfile
import time

ROOT = pathlib.Path(os.environ.get("RSI_BROKER_ROOT", "/srv/rsi-lab/h2"))
HEARTBEAT_TTL = int(os.environ.get("RSI_BROKER_HEARTBEAT_TTL", "1200"))
MAX_ATTEMPTS = int(os.environ.get("RSI_BROKER_MAX_ATTEMPTS", "3"))
MAX_BUNDLE_BYTES = int(os.environ.get("RSI_BROKER_MAX_BUNDLE_BYTES", str(40 * 1024 * 1024)))
MIN_FREE_BYTES = int(os.environ.get("RSI_BROKER_MIN_FREE_BYTES", str(1024 * 1024 * 1024)))
MAX_RESULTS_BYTES = int(os.environ.get("RSI_BROKER_MAX_RESULTS_BYTES", str(2 * 1024 * 1024 * 1024)))
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_STATUS_BYTES = 4096

RID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._#=-]{0,119}$")
WORKER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
IMAGE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
REASON = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,63}$")

# Key names that would put an answer, a rubric or a score into a request. Compared after lower-casing and dropping every
# character that is not a letter or digit, so `gold_answer`, `goldAnswer` and `Gold-Answer` are one name.
FORBIDDEN_KEY_PARTS = ("gold", "rubric", "answerkey", "idealanswer", "groundtruth")
FORBIDDEN_KEYS_EXACT = ("ideal", "score", "scores", "scoring", "scorer", "answer")


def now():
    override = os.environ.get("RSI_BROKER_NOW")
    return float(override) if override else time.time()


def forbidden_key(value, path="$"):
    """The first path whose key names a gold answer, rubric or score, or None. Walks dicts and lists at any depth."""
    if isinstance(value, dict):
        for key, inner in value.items():
            norm = re.sub(r"[^a-z0-9]", "", str(key).lower())
            if norm in FORBIDDEN_KEYS_EXACT or any(part in norm for part in FORBIDDEN_KEY_PARTS):
                return f"{path}.{key}"
            found = forbidden_key(inner, f"{path}.{key}")
            if found:
                return found
    elif isinstance(value, list):
        for index, inner in enumerate(value):
            found = forbidden_key(inner, f"{path}[{index}]")
            if found:
                return found
    return None


def validate_request(request):
    """Raise ValueError with a short reason when a request is not one the broker holds."""
    if not isinstance(request, dict):
        raise ValueError("request is not an object")
    rid = request.get("rid")
    if not isinstance(rid, str) or not RID.match(rid):
        raise ValueError("rid is missing or malformed")
    image = request.get("image")
    if not isinstance(image, str) or not IMAGE.match(image):
        raise ValueError("image is missing or malformed")
    item = request.get("item")
    if not isinstance(item, dict) or not isinstance(item.get("key"), str) or not isinstance(item.get("prompt"), str) or not item["prompt"].strip():
        raise ValueError("item needs a key and a prompt")
    probe = request.get("probe")
    if probe is not None:
        if not isinstance(probe, dict):
            raise ValueError("probe is not an object")
        for name in ("preamble", "line"):
            if probe.get(name) is not None and not isinstance(probe[name], str):
                raise ValueError(f"probe.{name} is not a string")
    data = request.get("data")
    if data is not None and not isinstance(data, list):
        raise ValueError("data is not a list")
    where = forbidden_key(request)
    if where:
        raise ValueError(f"a request must not carry an answer, rubric or score ({where})")
    if len(json.dumps(request).encode("utf-8")) > MAX_REQUEST_BYTES:
        raise ValueError("request is over 2 MB")


class Broker:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        for name in ("pending", "claimed", "results", "attempts", "lanes"):
            (self.root / name).mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------------------------------------------ plumbing
    @contextlib.contextmanager
    def locked(self):
        fd = os.open(str(self.root / ".lock"), os.O_CREAT | os.O_RDWR, 0o660)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)  # closing releases the flock

    def path(self, kind, name):
        return self.root / kind / name

    @staticmethod
    def write_json(path, value):
        """Whole or not at all: written beside the target, then renamed."""
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")
        os.replace(temporary, path)

    @staticmethod
    def read_json(path):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def paused(self):
        return (self.root / "PAUSE").exists()

    def exists_anywhere(self, rid):
        return any(self.path(kind, f"{rid}.json").exists() for kind in ("pending", "claimed")) \
            or self.path("results", f"{rid}.meta.json").exists() or self.path("results", f"{rid}.infra-failed.json").exists()

    # ------------------------------------------------------------------------------------------------------ states
    def _fail_locked(self, rid, reason, at):
        """An infrastructure failure of one request: back to pending, or the terminal marker after MAX_ATTEMPTS."""
        attempts = self.read_json(self.path("attempts", f"{rid}.json")) or {"attempts": 0, "reasons": []}
        attempts["attempts"] += 1
        attempts["reasons"] = (attempts["reasons"] + [{"reason": reason, "at": int(at)}])[-10:]
        self.write_json(self.path("attempts", f"{rid}.json"), attempts)
        claimed_request = self.path("claimed", f"{rid}.json")
        claim_file = self.path("claimed", f"{rid}.claim")
        if attempts["attempts"] >= MAX_ATTEMPTS:
            self.write_json(self.path("results", f"{rid}.infra-failed.json"),
                            {"rid": rid, "attempts": attempts["attempts"], "reasons": attempts["reasons"], "at": int(at),
                             "request": self.read_json(claimed_request)})
            claimed_request.unlink(missing_ok=True)
            claim_file.unlink(missing_ok=True)
            return "terminal"
        if claimed_request.exists():
            os.replace(claimed_request, self.path("pending", f"{rid}.json"))
        claim_file.unlink(missing_ok=True)
        return "requeued"

    def _sweep_locked(self, at):
        swept = []
        for claim_file in sorted((self.root / "claimed").glob("*.claim")):
            claim = self.read_json(claim_file)
            rid = claim_file.name[: -len(".claim")]
            beat = claim.get("heartbeatAt") if isinstance(claim, dict) else None
            if not isinstance(beat, (int, float)) or beat < at - HEARTBEAT_TTL:
                swept.append((rid, self._fail_locked(rid, "lost_heartbeat", at)))
        return swept

    # ------------------------------------------------------------------------------------------------------ lane commands
    def claim(self, worker, image, max_timeout_min=None):
        at = now()
        with self.locked():
            self._sweep_locked(at)
            if self.paused():
                return None
            candidates = sorted((self.root / "pending").glob("*.json"), key=lambda p: (p.stat().st_mtime, p.name))
            for candidate in candidates:
                request = self.read_json(candidate)
                if not isinstance(request, dict) or request.get("image") != image:
                    continue
                timeout_min = request.get("item", {}).get("timeoutMin", 15)
                if max_timeout_min is not None and isinstance(timeout_min, (int, float)) and timeout_min > max_timeout_min:
                    continue
                rid = candidate.name[: -len(".json")]
                os.replace(candidate, self.path("claimed", f"{rid}.json"))
                attempt = (self.read_json(self.path("attempts", f"{rid}.json")) or {"attempts": 0})["attempts"] + 1
                self.write_json(self.path("claimed", f"{rid}.claim"),
                                {"rid": rid, "worker": worker, "image": image, "claimedAt": at, "heartbeatAt": at, "attempt": attempt})
                return {**request, "attempt": attempt}
        return None

    def heartbeat(self, worker, rid):
        at = now()
        with self.locked():
            claim_file = self.path("claimed", f"{rid}.claim")
            claim = self.read_json(claim_file)
            if not isinstance(claim, dict) or claim.get("worker") != worker:
                return "lost"
            claim["heartbeatAt"] = at
            self.write_json(claim_file, claim)
            return "ok"

    def done(self, rid, bundle_path):
        """Accept a finished request's bundle. Work that was done is kept even when its claim had meanwhile lapsed."""
        at = now()
        size = bundle_path.stat().st_size
        if size > MAX_BUNDLE_BYTES:
            raise ValueError("bundle_too_large")
        check_bundle(bundle_path)
        with self.locked():
            if self.path("results", f"{rid}.meta.json").exists():
                return "duplicate"
            claim = self.read_json(self.path("claimed", f"{rid}.claim")) or {}
            held = self.path("claimed", f"{rid}.json").exists() or self.path("pending", f"{rid}.json").exists()
            if not held:
                raise ValueError("unknown_rid")
            used = sum(f.stat().st_size for f in (self.root / "results").glob("*.tgz"))
            free = shutil.disk_usage(self.root).free
            if used + size > MAX_RESULTS_BYTES or free - size < MIN_FREE_BYTES:
                raise ValueError("no_space")
            digest = hashlib.sha256()
            with open(bundle_path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
            target = self.path("results", f"{rid}.tgz")
            shutil.move(str(bundle_path), str(target) + ".tmp")
            os.replace(str(target) + ".tmp", target)
            attempts = self.read_json(self.path("attempts", f"{rid}.json")) or {"attempts": 0}
            self.write_json(self.path("results", f"{rid}.meta.json"),
                            {"rid": rid, "worker": claim.get("worker"), "image": claim.get("image"), "bytes": size,
                             "sha256": digest.hexdigest(), "doneAt": at, "infraRetries": attempts["attempts"]})
            for kind in ("claimed", "pending"):
                self.path(kind, f"{rid}.json").unlink(missing_ok=True)
            self.path("claimed", f"{rid}.claim").unlink(missing_ok=True)
            return "ok"

    def fail(self, rid, reason):
        at = now()
        with self.locked():
            if not (self.path("claimed", f"{rid}.json").exists()):
                return "unknown"
            return self._fail_locked(rid, reason, at)

    def lane_status(self, lane, payload):
        with self.locked():
            self.write_json(self.path("lanes", f"{lane}.json"), {"receivedAt": int(now()), "status": payload})
        return "ok"

    # ------------------------------------------------------------------------------------------------------ admin commands
    def submit(self, requests):
        """Idempotent by rid. Returns {accepted, existing, refused: [(rid, why)]}."""
        outcome = {"accepted": [], "existing": [], "refused": []}
        with self.locked():
            for request in requests:
                try:
                    validate_request(request)
                except ValueError as error:
                    outcome["refused"].append((request.get("rid") if isinstance(request, dict) else None, str(error)))
                    continue
                rid = request["rid"]
                if self.exists_anywhere(rid):
                    outcome["existing"].append(rid)
                    continue
                self.write_json(self.path("pending", f"{rid}.json"), request)
                outcome["accepted"].append(rid)
        return outcome

    def status(self):
        at = now()
        with self.locked():
            swept = self._sweep_locked(at)
            pending = [self.read_json(p) or {} for p in (self.root / "pending").glob("*.json")]
            by_image = {}
            for request in pending:
                by_image[request.get("image")] = by_image.get(request.get("image"), 0) + 1
            claimed = []
            for claim_file in sorted((self.root / "claimed").glob("*.claim")):
                claim = self.read_json(claim_file) or {}
                claimed.append({"rid": claim.get("rid"), "worker": claim.get("worker"), "attempt": claim.get("attempt"),
                                "sinceHeartbeatS": int(at - claim.get("heartbeatAt", at))})
            results = sorted(p.name[: -len(".meta.json")] for p in (self.root / "results").glob("*.meta.json"))
            failed = sorted(p.name[: -len(".infra-failed.json")] for p in (self.root / "results").glob("*.infra-failed.json"))
            lanes = {}
            for lane_file in sorted((self.root / "lanes").glob("*.json")):
                record = self.read_json(lane_file) or {}
                lanes[lane_file.name[: -len(".json")]] = {"ageS": int(at - record.get("receivedAt", at)), "status": record.get("status")}
            usage = shutil.disk_usage(self.root)
            return {"paused": self.paused(), "pending": len(pending), "pendingByImage": by_image, "claimed": claimed, "resultsReady": results,
                    "infraFailed": failed, "sweptNow": swept, "lanes": lanes, "diskFreeBytes": usage.free}

    def result_metas(self):
        with self.locked():
            metas = [self.read_json(p) for p in sorted((self.root / "results").glob("*.meta.json"))]
            failed = [self.read_json(p) for p in sorted((self.root / "results").glob("*.infra-failed.json"))]
        return {"results": [m for m in metas if m], "infraFailed": [m for m in failed if m]}

    def purge(self, rid):
        """Delete a fetched result (bundle and meta) or terminal marker. Never touches pending or claimed work."""
        with self.locked():
            removed = []
            for name in (f"{rid}.tgz", f"{rid}.meta.json", f"{rid}.infra-failed.json"):
                target = self.path("results", name)
                if target.exists():
                    target.unlink()
                    removed.append(name)
            self.path("attempts", f"{rid}.json").unlink(missing_ok=True)
            return removed

    def set_paused(self, paused):
        flag = self.root / "PAUSE"
        with self.locked():
            if paused:
                flag.write_text(str(int(now())), encoding="utf-8")
            else:
                flag.unlink(missing_ok=True)

    def requeue(self, rid):
        """Operator override: a terminal infra-failed request goes back to pending with a fresh attempt count."""
        with self.locked():
            marker = self.path("results", f"{rid}.infra-failed.json")
            record = self.read_json(marker)
            if not isinstance(record, dict) or not isinstance(record.get("request"), dict):
                return "not_failed"
            self.write_json(self.path("pending", f"{rid}.json"), record["request"])
            marker.unlink()
            self.path("attempts", f"{rid}.json").unlink(missing_ok=True)
            return "requeued"


def check_bundle(path):
    """The bundle must be a readable tar.gz of plain files with safe relative names. Nothing is extracted here."""
    try:
        with tarfile.open(path, "r:gz") as archive:
            count = 0
            for member in archive:
                count += 1
                name = member.name
                if count > 20000:
                    raise ValueError("bundle_too_many_members")
                if name.startswith("/") or ".." in pathlib.PurePosixPath(name).parts:
                    raise ValueError("bundle_unsafe_name")
                if not (member.isfile() or member.isdir()):
                    raise ValueError("bundle_special_member")
            if count == 0:
                raise ValueError("bundle_empty")
    except (tarfile.TarError, OSError, EOFError) as error:
        raise ValueError("bundle_unreadable") from error


def read_stdin_to_tempfile(root, limit):
    """Stdin to a file under the broker root (same filesystem as results), refusing more than `limit` bytes."""
    handle = tempfile.NamedTemporaryFile(dir=str(root / "results"), prefix=".upload-", delete=False)
    total = 0
    try:
        source = sys.stdin.buffer
        while True:
            chunk = source.read(1 << 20)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise ValueError("bundle_too_large")
            handle.write(chunk)
        handle.close()
        return pathlib.Path(handle.name)
    except BaseException:
        handle.close()
        pathlib.Path(handle.name).unlink(missing_ok=True)
        raise


# ---------------------------------------------------------------------------------------------------------- entry points
def lane_command(broker, argv):
    if not argv:
        raise ValueError("no_command")
    command, rest = argv[0], argv[1:]
    if command == "claim":
        if len(rest) not in (2, 3) or not WORKER.match(rest[0]) or not IMAGE.match(rest[1]):
            raise ValueError("bad_arguments")
        limit = None
        if len(rest) == 3:
            limit = float(rest[2])
        request = broker.claim(rest[0], rest[1], limit)
        if request is not None:
            print(json.dumps(request, ensure_ascii=False))
        return 0
    if command == "heartbeat":
        if len(rest) != 2 or not WORKER.match(rest[0]) or not RID.match(rest[1]):
            raise ValueError("bad_arguments")
        print(broker.heartbeat(rest[0], rest[1]))
        return 0
    if command == "done":
        if len(rest) != 1 or not RID.match(rest[0]):
            raise ValueError("bad_arguments")
        upload = read_stdin_to_tempfile(broker.root, MAX_BUNDLE_BYTES)
        try:
            print(broker.done(rest[0], upload))
        finally:
            upload.unlink(missing_ok=True)
        return 0
    if command == "fail":
        if len(rest) != 2 or not RID.match(rest[0]) or not REASON.match(rest[1]):
            raise ValueError("bad_arguments")
        print(broker.fail(rest[0], rest[1]))
        return 0
    if command == "lane-status":
        if len(rest) != 2 or not WORKER.match(rest[0]) or len(rest[1].encode("utf-8")) > MAX_STATUS_BYTES:
            raise ValueError("bad_arguments")
        print(broker.lane_status(rest[0], json.loads(rest[1])))
        return 0
    raise ValueError("unknown_command")


def admin_command(broker, argv):
    parser = argparse.ArgumentParser(prog="broker.py --role admin")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("submit")
    sub.add_parser("status")
    sub.add_parser("results")
    for name in ("cat", "purge", "requeue"):
        sub.add_parser(name).add_argument("rid")
    sub.add_parser("pause")
    sub.add_parser("resume")
    sub.add_parser("drain")
    args = parser.parse_args(argv)
    if args.command == "submit":
        requests = [json.loads(line) for line in sys.stdin.read().splitlines() if line.strip()]
        print(json.dumps(broker.submit(requests)))
    elif args.command == "status":
        print(json.dumps(broker.status()))
    elif args.command == "results":
        print(json.dumps(broker.result_metas()))
    elif args.command == "cat":
        if not RID.match(args.rid):
            raise ValueError("bad_arguments")
        with open(broker.path("results", f"{args.rid}.tgz"), "rb") as handle:
            shutil.copyfileobj(handle, sys.stdout.buffer)
    elif args.command == "purge":
        print(json.dumps(broker.purge(args.rid)))
    elif args.command == "requeue":
        print(broker.requeue(args.rid))
    elif args.command == "pause":
        broker.set_paused(True)
        print("paused")
    elif args.command == "resume":
        broker.set_paused(False)
        print("resumed")
    elif args.command == "drain":
        broker.set_paused(True)
        status = broker.status()
        print(json.dumps({"paused": True, "claimed": len(status["claimed"]), "pending": status["pending"]}))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--role", choices=("lane", "admin"), required=True)
    known, rest = parser.parse_known_args(argv if argv is not None else sys.argv[1:])
    broker = Broker(ROOT)
    try:
        if known.role == "lane":
            original = os.environ.get("SSH_ORIGINAL_COMMAND", "")
            # A lane's words are the client's; they are parsed, never evaluated.
            return lane_command(broker, shlex.split(original))
        return admin_command(broker, rest)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 3
    except (OSError, json.JSONDecodeError) as error:
        print(f"error: {type(error).__name__}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())
