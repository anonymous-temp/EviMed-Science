#!/usr/bin/env python3
"""The capsule, end to end, on the hosted path: eleven scenarios, each on its own throwaway account that is registered at the start and
deleted at the end (always, also on failure and on a signal; a leak is a FAIL line).

Run it ON THE SERVING HOST (it reads the deployment's .env, talks to its public address, drives a browser from its runtime image and reads
its PostgreSQL through docker), as root or a user who can use docker:

    python3 evals/capsule-longitudinal/run.py --key-file <deepseek key, for the model judge only> [--scenarios S1,S3] [--out results/<name>.json]
    python3 evals/capsule-longitudinal/run.py --list                      # the scenarios and what each needs
    python3 evals/capsule-longitudinal/run.py --sweep                     # delete `cl-*` accounts a crashed run left behind, then exit

Output: one JSON per run (`results/<date>-<release>.json`: every scenario's checks, the evidence they were read from, the cost from the
usage ledger) and a summary table. Statuses: pass, fail, inconclusive (a premise did not occur, or a check could not be decided),
not_available (the deployed tree lacks what the scenario tests: the `adopt` verdict, the import route) and error.

The key is read from --key-file (or DEEPSEEK_API_KEY) only to run the model judge; it is never printed or written, and without it the
checks that need a reading are undecided, not passed.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import signal
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import host as hosting  # noqa: E402
import scenarios as sce  # noqa: E402
import scoring as sc  # noqa: E402

NEEDS = {"S8": "the deployed follow-up judge knows the `adopt` verdict (package `evidence`)", "S9": "a memory import route (package `evidence`)", "S10": "two accounts"}


def read_key(key_file: str | None) -> str | None:
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key and key_file:
        key = Path(key_file).read_text(encoding="utf-8").strip()
    return key or None


def run_scenario(spec: tuple, host, judge: sc.Judge, caps: dict, log=print) -> dict:
    """One scenario on its own accounts. The accounts are deleted whatever happened, and one that cannot be deleted is a failing check."""
    sid, title, function = spec
    ctx = sce.Ctx(host, judge, caps, sid)
    result: dict = {"id": sid, "title": title, "startedAt": datetime.now(timezone.utc).isoformat(), "checks": [], "evidence": {}}
    try:
        outcome = function(ctx)
        result.update(checks=outcome.checks, evidence=outcome.evidence, reason=outcome.reason)
        result["status"] = outcome.status or sc.status_of(outcome.checks)
    except sce.ScenarioAsked as error:
        result.update(status=sc.INCONCLUSIVE, reason=str(error)[:600])
    except sce.ScenarioError as error:
        result.update(status=sc.ERROR, reason=str(error)[:600])
    except Exception as error:  # noqa: BLE001 - a scenario that blew up is an error line, never a crash of the run
        result.update(status=sc.ERROR, reason=f"{type(error).__name__}: {str(error)[:400]}")
    finally:
        spend: list[list[str]] = []
        for account in ctx.accounts:
            try:
                spend += host.cost(account)
            except Exception:  # noqa: BLE001
                pass
        result["cost"] = sc.cost_of(spend)
        leaked = [account.username for account in ctx.accounts if not host.delete(account)]
        result["accounts"] = [account.username for account in ctx.accounts]
        if leaked:
            result["checks"].append(sc.check("every throwaway account was deleted", False, f"LEAK: {leaked} still exist"))
            result["status"] = sc.FAIL
        elif ctx.accounts:
            result["checks"].append(sc.check("every throwaway account was deleted", True, f"{len(ctx.accounts)} deleted", required=False))
    log(f"{sid} {result['status']}: {title}")
    return result


def release_of(host) -> str:
    out = host.sh(["readlink", "-f", f"{host.config.root}/current"])
    name = Path(out.stdout.strip()).name if out.returncode == 0 and out.stdout.strip() else ""
    return name or "unknown"


def sweep(host, log=print) -> int:
    """Delete the accounts a crashed run left, older than an hour: their password was never kept, so it is replaced through the server's own
    hash first, as the reference run did. Only the exact names `Host.register` makes (`cl-<scenario><a|b>-<8 hex>`) and only local accounts:
    a person who registered a name that merely starts with `cl-` is never touched."""
    rows = host.rows("select id from evimed_control.users where id ~ '^cl-s[0-9]{1,2}[a-z]-[0-9a-f]{8}$' and auth_type='local' "
                     "and created_at < now() - interval '1 hour';")
    removed = 0
    for (username,) in rows:
        password = secrets.token_urlsafe(18)
        hashed = host.sh(["docker", "exec", "-e", f"P={password}", host.config.web_container, "node", "-e",
                          "import('/app/apps/server/src/security.mjs').then(m=>process.stdout.write(String(m.hashPassword(process.env.P))))"])
        if hashed.returncode != 0 or not hashed.stdout.strip():
            log(f"could not rehash the password of {username}")
            continue
        host.psql(f"update evimed_control.users set password_hash='{hashed.stdout.strip().replace(chr(39), chr(39) * 2)}' where id='{username}' and auth_type='local';")
        account = hosting.Account(host, username, password)
        if host.delete(account):
            removed += 1
    log(f"swept {removed} of {len(rows)} leftover account(s)")
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--scenarios", help="comma-separated ids, e.g. S1,S3 (default: all)")
    p.add_argument("--key-file", help="DeepSeek key for the model judge (never printed or written)")
    p.add_argument("--judge-model", default="deepseek-flash")
    p.add_argument("--out", help="result file (default results/<date>-<release>.json)")
    p.add_argument("--root", default="/srv/evimed-science")
    p.add_argument("--web-container", default="web-open-science-web-1")
    p.add_argument("--pg-container", default="web-evimed-postgres-1")
    p.add_argument("--public-url", help="default: OPEN_SCIENCE_PUBLIC_URL of the deployment's .env")
    p.add_argument("--runtime-image", help="default: what the web container is configured to launch")
    p.add_argument("--work-dir", default=str(HERE / "results" / "work"), help="where the browser's plans, results and screenshots go")
    p.add_argument("--secrets-dir", default=None, help="where the browser's short-lived env file is written (mode 0600, deleted at once; default: the system temp dir)")
    p.add_argument("--list", action="store_true")
    p.add_argument("--sweep", action="store_true")
    return p


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    if args.list:
        for sid, title, _ in sce.SCENARIOS:
            print(f"{sid:<4} {title}" + (f"   [needs: {NEEDS[sid]}]" if sid in NEEDS else ""))
        return 0
    host = hosting.host_from_args(args)
    if args.sweep:
        return sweep(host)
    wanted = [s.strip().upper() for s in args.scenarios.split(",")] if args.scenarios else [sid for sid, _, _ in sce.SCENARIOS]
    unknown = [w for w in wanted if w not in {sid for sid, _, _ in sce.SCENARIOS}]
    if unknown:
        raise SystemExit(f"no such scenario: {unknown}")
    # A terminated run still deletes its accounts: the signal becomes the exception `finally` blocks already handle.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    key = read_key(args.key_file)
    judge = sc.Judge(key, args.judge_model)
    caps = host.capabilities()
    release = release_of(host)
    print(f"release {release}; capabilities {json.dumps(caps)}; model judge {'on' if judge.available else 'OFF (no key: readings are undecided)'}", flush=True)
    results: list[dict] = []
    started = datetime.now(timezone.utc)
    try:
        for spec in [s for s in sce.SCENARIOS if s[0] in wanted]:
            results.append(run_scenario(spec, host, judge, caps, log=lambda text: print(text, flush=True)))
    finally:
        print()
        print(sc.summary_table(results))
        out = Path(args.out) if args.out else HERE / "results" / f"{started:%Y-%m-%d}-{release}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({"release": release, "startedAt": started.isoformat(), "capabilities": caps, "modelJudge": judge.available, "results": results,
                                   "costCny": round(sum(r.get("cost", {}).get("totalCny", 0) for r in results), 4)}, ensure_ascii=False, indent=1), encoding="utf-8")
        print("wrote", out)
    return 1 if any(r["status"] in (sc.FAIL, sc.ERROR) for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
