#!/usr/bin/env python3
"""Lab adapter for the unchanged eleven longitudinal scenarios and their native browser driver.

Only placement changes: read-only SQL targets the lab PG, and the same Chromium/browser
script runs on the lab host. No production container, deployment or account is contacted.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import signal
import time
import uuid
import sys
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
LONG = HERE.parent.parent / "capsule-longitudinal"
sys.path.insert(0, str(LONG))
import host as hosting
import scenarios
import scoring
import model_judge

spec = importlib.util.spec_from_file_location("longitudinal_run", LONG / "run.py")
long_run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(long_run)


class LabHost(hosting.Host):
    def __init__(self, config, database, pg_port):
        super().__init__(config)
        self.database, self.pg_port = database, pg_port
        self.test_users = []

    def register(self, label):
        account = super().register(label)
        self.test_users.append(account.username)
        return account

    def idle_learning(self):
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            request = {"id": uuid.uuid4().hex, "userIds": self.test_users}
            print("EG_CONTROL " + json.dumps(request), flush=True)
            response = Path(os.environ["EG_CONTROL_DIR"]) / f"{request['id']}.json"
            while not response.exists() and time.monotonic() < deadline:
                time.sleep(0.1)
            if not response.exists():
                raise RuntimeError("lab idle-runtime control timed out")
            value = json.loads(response.read_text())
            if value.get("error"):
                raise RuntimeError(value["error"])
            if not value["value"]["busy"]:
                return
            time.sleep(3)
        raise RuntimeError("learning work did not become idle before the next native conversation")

    def psql(self, query):
        result = self.sh(["docker", "exec", "-i", f"pgpp-{self.pg_port}", "psql", "-U", "coder", "-d", self.database, "-At", "-F", "|"], input=query)
        if result.returncode:
            raise RuntimeError(f"lab SQL failed: {result.stderr[:300]}")
        return result.stdout.strip()

    def capabilities(self):
        # Same capability probes as Host, read from the integration source rather than a serving container.
        source = Path(self.config.root)
        result = self.sh(["node", "--input-type=module", "-e", "import { LEARNING_EVIDENCE_VERDICTS as v } from '" + (source / "packages/domain/index.mjs").as_uri() + "'; process.stdout.write(JSON.stringify(v));"])
        try:
            adopt = "adopt" in json.loads(result.stdout)
        except ValueError:
            adopt = None
        imported = any("/api/memory/import" in p.read_text() for p in (source / "apps/server/src").glob("*.mjs"))
        return {"adoptVerdict": adopt, "importRoute": imported}

    def cost(self, account):
        rows = super().cost(account)
        tokens = self.rows("select coalesce(sum(cache_hit_tokens),0),coalesce(sum(cache_miss_tokens),0),coalesce(sum(output_tokens),0) "
                           f"from evimed_usage.model_requests where user_id='{account.username}' and status='settled';")
        out = Path(self.config.out_dir)
        out.mkdir(parents=True, exist_ok=True)
        if tokens:
            (out / f"usage-{account.username}.json").write_text(json.dumps({"account": {
                "cacheHitTokens": int(tokens[0][0]), "cacheMissTokens": int(tokens[0][1]), "completionTokens": int(tokens[0][2]),
                "actualCost": sum(float(r[2]) for r in rows)}}))
        return rows

    def browse(self, account, plan, name, timeout=3300):
        self.idle_learning()
        out = Path(self.config.out_dir)
        out.mkdir(parents=True, exist_ok=True)
        plan_file, result_file = out / f"{name}-plan.json", out / f"{name}-result.json"
        plan_file.write_text(json.dumps(plan, ensure_ascii=False))
        result_file.unlink(missing_ok=True)
        env = {**os.environ, "BASE": self.public_url, "USERNAME": account.username, "PASSWORD": account.password,
               "PLAN": str(plan_file), "RESULT": str(result_file),
               "OPEN_SCIENCE_PLAYWRIGHT_CORE": "/srv/evimed/pp/runtime-venv/lib/python3.13/site-packages/playwright/driver/package"}
        done = subprocess.run(["node", str(LONG / "composer-driver.mjs")], env=env, capture_output=True, text=True, timeout=timeout)
        result = json.loads(result_file.read_text()) if result_file.exists() else {"turns": [], "error": "native browser wrote no result"}
        result["log"] = done.stdout[-1500:]
        if done.returncode and not result.get("error"):
            result["error"] = f"native browser exited {done.returncode}: {done.stderr[-300:]}"
        return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--tree", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--port", required=True, type=int)
    p.add_argument("--pg-port", required=True, type=int)
    p.add_argument("--database", required=True)
    p.add_argument("--scenarios", default=",".join(s[0] for s in scenarios.SCENARIOS))
    p.add_argument("--repeats", default="1,2,3,4,5")
    args = p.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    out = Path(args.out)
    config = hosting.HostConfig(root=args.tree, public_url=f"http://127.0.0.1:{args.port}", out_dir=out / "browser")
    host = LabHost(config, args.database, args.pg_port)
    def metered_post(body, key):
        result = scoring.rf.post(body, key)
        model_judge.record_usage(result, body["model"])
        return result
    judge = scoring.Judge(long_run.read_key("/srv/evimed/secrets/deepseek.api-key"), "deepseek-flash", post=metered_post)
    caps = host.capabilities()
    (out / "scenario-capabilities.json").write_text(json.dumps(caps))
    for rep in map(int, args.repeats.split(",")):
        for scenario in scenarios.SCENARIOS:
            sid = scenario[0]
            if sid not in args.scenarios.split(","):
                continue
            result_file = out / "results" / f"{sid}-r{rep}.json"
            if result_file.exists():
                continue
            host.config.out_dir = out / "browser" / f"{sid}-r{rep}"
            result = long_run.run_scenario(scenario, host, judge, caps, log=lambda text: print(text, flush=True))
            result["rep"] = rep
            result_file.parent.mkdir(parents=True, exist_ok=True)
            result_file.write_text(json.dumps(result, ensure_ascii=False, indent=1))
            with (out / "STATUS").open("a") as handle:
                handle.write(f"{datetime.now(timezone.utc).isoformat()} EG DONE {sid}-r{rep} {result['status']}\n")


if __name__ == "__main__":
    main()
