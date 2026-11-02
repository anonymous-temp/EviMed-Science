#!/usr/bin/env python3
"""Dev-side control of the RSI lab's broker (broker.py on the lab host). Python 3 standard library only.

  brokerctl.py install --pubkey FILE      put broker.py on the host, make the user and the directories, authorize the lane key
  brokerctl.py submit [--fetch F]... REQUEST.json|.jsonl...   idempotent by rid; refuses a request that names an answer, rubric or score
  brokerctl.py status [--json]            pending / claimed / ready / infra-failed, the lanes' last reports, free disk
  brokerctl.py fetch DIR                  pull finished bundles into DIR (verified by size and sha256), then delete them remotely
  brokerctl.py pause | resume             stop / allow claims
  brokerctl.py drain [--wait SECONDS]     stop claims, then wait until nothing is in flight (or the wait ends)
  brokerctl.py requeue RID                a terminal infra-failed request goes back to pending with fresh attempts
  brokerctl.py release RID                a claimed request (its lane died) goes back to pending now, attempts cleared

The host is reached as root over ssh (`--host`, default `evimed-test`, or RSI_BROKER_SSH_HOST); admin commands run as the broker user
(`runuser -u rsi-broker`) so every file in the broker root belongs to it. Nothing here prints a prompt, an answer or a key.

`--fetch FILE` on submit attaches a request's public input files: FILE is a fetch manifest (a JSON list of {url, bytes, sha256, dest,
unzip}) and every entry whose `dest`, or whose `unzip.into`, is a parent of one of the item's `files[].src` (after /srv/evimed-science/
shared/benchmarks -> /bench) is copied into the request's `data` list with paths relative to /bench. lane.py fetches them in the job.
"""
import argparse
import hashlib
import json
import os
import pathlib
import shlex
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
REMOTE_DIR = "/usr/local/lib/rsi-broker"
REMOTE_ROOT = "/data/rsi-lab-h2"
BROKER_USER = "rsi-broker"
HOST_BENCH_PREFIX = "/srv/evimed-science/shared/benchmarks"

sys.path.insert(0, str(HERE))
import broker  # noqa: E402  (the same validation the host applies)


def host():
    return os.environ.get("RSI_BROKER_SSH_HOST", "evimed-test")


def ssh(command, stdin=None, check=True, timeout=600):
    result = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=30", host(), command], input=stdin, capture_output=True, timeout=timeout)
    if check and result.returncode != 0:
        raise SystemExit(f"remote command failed ({result.returncode}): {result.stderr.decode('utf-8', 'replace')[:400]}")
    return result


def admin(*words, stdin=None, check=True, timeout=600):
    inner = f"RSI_BROKER_ROOT={REMOTE_ROOT} python3 -I {REMOTE_DIR}/broker.py --role admin {' '.join(shlex.quote(w) for w in words)}"
    return ssh(f"runuser -u {BROKER_USER} -- sh -c {shlex.quote(inner)}", stdin=stdin, check=check, timeout=timeout)


# ---------------------------------------------------------------------------------------------------------------- install
INSTALL_SCRIPT = r"""
set -euo pipefail
id {user} >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/{user} --shell /bin/sh {user}
install -d -o {user} -g {user} -m 0750 {root}
install -d -m 0755 {lib}
install -m 0644 /tmp/rsi-broker.py {lib}/broker.py
rm -f /tmp/rsi-broker.py
install -d -o {user} -g {user} -m 0700 /var/lib/{user}/.ssh
line='restrict,command="/usr/bin/env RSI_BROKER_ROOT={root} /usr/bin/python3 -I {lib}/broker.py --role lane" '"$(cat /tmp/rsi-broker.pub)"
printf '%s\n' "$line" > /var/lib/{user}/.ssh/authorized_keys
chown {user}:{user} /var/lib/{user}/.ssh/authorized_keys
chmod 0600 /var/lib/{user}/.ssh/authorized_keys
rm -f /tmp/rsi-broker.pub
passwd -l {user} >/dev/null 2>&1 || true
runuser -u {user} -- sh -c 'RSI_BROKER_ROOT={root} python3 -I {lib}/broker.py --role admin status' | head -c 300; echo
"""


def install(pubkey):
    key = pathlib.Path(pubkey).read_text(encoding="utf-8").strip()
    if not key.startswith("ssh-ed25519 ") or "\n" in key:
        raise SystemExit("the public key must be one ssh-ed25519 line")
    for local, remote in ((HERE / "broker.py", "/tmp/rsi-broker.py"), (pathlib.Path(pubkey), "/tmp/rsi-broker.pub")):
        subprocess.run(["scp", "-q", "-o", "BatchMode=yes", str(local), f"{host()}:{remote}"], check=True)
    ssh("bash -s", stdin=INSTALL_SCRIPT.format(user=BROKER_USER, root=REMOTE_ROOT, lib=REMOTE_DIR).encode())
    print("broker installed")


# ---------------------------------------------------------------------------------------------------------------- submit
def read_requests(paths):
    requests = []
    for path in paths:
        text = pathlib.Path(path).read_text(encoding="utf-8")
        stripped = text.lstrip()
        if stripped.startswith("["):
            requests.extend(json.loads(text))
        elif stripped.startswith("{") and "\n{" not in stripped.strip():
            requests.append(json.loads(text))
        else:
            requests.extend(json.loads(line) for line in text.splitlines() if line.strip())
    return requests


def attach_data(requests, manifests):
    """Copy the fetch entries that cover an item's input files into request["data"] (paths relative to /bench)."""
    entries = []
    for manifest in manifests:
        entries.extend(json.loads(pathlib.Path(manifest).read_text(encoding="utf-8")))

    def relative(path):
        path = str(path)
        if path.startswith(HOST_BENCH_PREFIX + "/"):
            return "/bench/" + path[len(HOST_BENCH_PREFIX) + 1:]
        return path

    for request in requests:
        sources = [str(f.get("src", "")) for f in request.get("item", {}).get("files", [])]
        if not sources:
            continue
        chosen = []
        for entry in entries:
            targets = [relative(entry["dest"])]
            if entry.get("unzip"):
                targets.append(relative(entry["unzip"]["into"]))
            if any(src == t or src.startswith(t.rstrip("/") + "/") for src in sources for t in targets):
                unzip = entry.get("unzip")
                chosen.append({"url": entry["url"], "bytes": entry.get("bytes"), "sha256": entry.get("sha256"), "dest": relative(entry["dest"]),
                               "unzip": None if not unzip else {**unzip, "into": relative(unzip["into"])}})
        # A file the host kept gzipped (above the upload limit): the item names `x.csv.gz`, the public file is `x.csv`.
        for src in sources:
            if src.endswith(".gz") and not any(src == c["dest"] or src.startswith(c["dest"].rstrip("/") + "/") for c in chosen):
                for entry in entries:
                    if relative(entry["dest"]) == src[:-3]:
                        chosen.append({"url": entry["url"], "bytes": entry.get("bytes"), "sha256": entry.get("sha256"), "dest": relative(entry["dest"]),
                                       "unzip": None, "gzip": True})
        if chosen:
            request["data"] = chosen
    return requests


def submit(paths, fetch_manifests):
    requests = attach_data(read_requests(paths), fetch_manifests)
    refused = []
    for request in requests:
        try:
            broker.validate_request(request)
        except ValueError as error:
            refused.append((request.get("rid") if isinstance(request, dict) else None, str(error)))
    if refused:
        for rid, why in refused:
            print(f"refused {rid}: {why}", file=sys.stderr)
        raise SystemExit(2)
    answer = json.loads(admin("submit", stdin="\n".join(json.dumps(r, ensure_ascii=False) for r in requests).encode("utf-8")).stdout)
    print(f"submitted: {len(answer['accepted'])} accepted, {len(answer['existing'])} already there, {len(answer['refused'])} refused")
    for rid, why in answer["refused"]:
        print(f"refused {rid}: {why}", file=sys.stderr)
    return 0 if not answer["refused"] else 2


# ---------------------------------------------------------------------------------------------------------------- status / fetch
def status(as_json):
    state = json.loads(admin("status").stdout)
    if as_json:
        print(json.dumps(state, indent=2))
        return
    print(f"paused={state['paused']} pending={state['pending']} {state['pendingByImage']} claimed={len(state['claimed'])} "
          f"ready={len(state['resultsReady'])} infra-failed={len(state['infraFailed'])} diskFree={state['diskFreeBytes'] // 2**20} MiB")
    for claim in state["claimed"]:
        print(f"  claimed {claim['rid']} by {claim['worker']} attempt {claim['attempt']} (heartbeat {claim['sinceHeartbeatS']} s ago)")
    for lane, record in sorted(state["lanes"].items()):
        print(f"  lane {lane}: {record['ageS']} s ago {json.dumps(record['status'])[:160]}")


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(directory):
    out = pathlib.Path(directory)
    out.mkdir(parents=True, exist_ok=True)
    listing = json.loads(admin("results").stdout)
    got = 0
    for meta in listing["results"]:
        rid = meta["rid"]
        target = out / f"{rid}.tgz"
        part = out / f"{rid}.tgz.part"
        with open(part, "wb") as handle:
            result = subprocess.run(["ssh", "-o", "BatchMode=yes", host(), f"runuser -u {BROKER_USER} -- sh -c {shlex.quote(f'RSI_BROKER_ROOT={REMOTE_ROOT} python3 -I {REMOTE_DIR}/broker.py --role admin cat {shlex.quote(rid)}')}"],
                                    stdout=handle, stderr=subprocess.PIPE, timeout=1800)
        if result.returncode != 0 or part.stat().st_size != meta["bytes"] or sha256_file(part) != meta["sha256"]:
            part.unlink(missing_ok=True)
            print(f"not fetched {rid}: transfer or verification failed", file=sys.stderr)
            continue
        os.replace(part, target)
        (out / f"{rid}.meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        admin("purge", rid)
        got += 1
    marked = 0
    for marker in listing["infraFailed"]:
        rid = marker["rid"]
        (out / f"{rid}.infra-failed.json").write_text(json.dumps(marker, indent=2), encoding="utf-8")
        admin("purge", rid)
        marked += 1
    print(f"fetched {got} bundle(s) and {marked} infra-failed marker(s) into {out}")


def drain(wait):
    state = json.loads(admin("drain").stdout)
    deadline = time.time() + wait
    while state["claimed"] and time.time() < deadline:
        time.sleep(30)
        state = json.loads(admin("drain").stdout)
    print(f"drain: {state['claimed']} claimed, {state['pending']} pending (claims are paused)")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("install")
    s.add_argument("--pubkey", required=True)
    s = sub.add_parser("submit")
    s.add_argument("--fetch", action="append", default=[])
    s.add_argument("paths", nargs="+")
    s = sub.add_parser("status")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("fetch")
    s.add_argument("directory")
    sub.add_parser("pause")
    sub.add_parser("resume")
    s = sub.add_parser("drain")
    s.add_argument("--wait", type=int, default=0)
    s = sub.add_parser("requeue")
    s.add_argument("rid")
    s = sub.add_parser("release")
    s.add_argument("rid")
    args = parser.parse_args()
    if args.command == "install":
        install(args.pubkey)
    elif args.command == "submit":
        return submit(args.paths, args.fetch)
    elif args.command == "status":
        status(args.json)
    elif args.command == "fetch":
        fetch(args.directory)
    elif args.command in ("pause", "resume"):
        print(admin(args.command).stdout.decode().strip())
    elif args.command == "drain":
        drain(args.wait)
    elif args.command in ("requeue", "release"):
        print(admin(args.command, args.rid).stdout.decode().strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
