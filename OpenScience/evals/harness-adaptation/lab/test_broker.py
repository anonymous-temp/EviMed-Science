#!/usr/bin/env python3
"""Tests of broker.py against a temporary root: claim atomicity under concurrency, heartbeats, the stale sweep, bounded infrastructure
retries, bundle admission, pause, and the two roles being separate. Run: python3 -I -m unittest discover -s . -p "test_broker.py" (from this directory)."""
import io
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parent
BROKER = HERE / "broker.py"


def bundle(files):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, content in files.items():
            data = content.encode("utf-8")
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def request(rid, image="base", timeout=15, **extra):
    return {"rid": rid, "image": image, "item": {"key": f"bench/{rid}", "prompt": "What is 2+2?", "timeoutMin": timeout},
            "probe": {"preamble": None, "line": None}, **extra}


class BrokerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.env = {**os.environ, "RSI_BROKER_ROOT": self.root, "RSI_BROKER_MIN_FREE_BYTES": "1"}
        self.env.pop("RSI_BROKER_NOW", None)

    def tearDown(self):
        self.tmp.cleanup()

    def lane(self, command, stdin=b"", now=None, env=None):
        merged = {**self.env, "SSH_ORIGINAL_COMMAND": command, **(env or {})}
        if now is not None:
            merged["RSI_BROKER_NOW"] = str(now)
        return subprocess.run([sys.executable, "-I", str(BROKER), "--role", "lane"], input=stdin, capture_output=True, env=merged, timeout=60)

    def admin(self, *args, stdin=b"", now=None):
        merged = dict(self.env)
        if now is not None:
            merged["RSI_BROKER_NOW"] = str(now)
        return subprocess.run([sys.executable, "-I", str(BROKER), "--role", "admin", *args], input=stdin, capture_output=True, env=merged, timeout=60)

    def submit(self, *requests, now=None):
        done = self.admin("submit", stdin="\n".join(json.dumps(r) for r in requests).encode(), now=now)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def status(self, now=None):
        return json.loads(self.admin("status", now=now).stdout)

    def test_claim_returns_one_request_once_and_nothing_when_empty(self):
        self.assertEqual(self.lane("claim w1 base").stdout, b"")
        self.assertEqual(self.submit(request("r1"))["accepted"], ["r1"])
        first = self.lane("claim w1 base")
        self.assertEqual(first.returncode, 0)
        payload = json.loads(first.stdout)
        self.assertEqual((payload["rid"], payload["attempt"]), ("r1", 1))
        self.assertEqual(self.lane("claim w2 base").stdout, b"")

    def test_concurrent_claims_never_take_one_request_twice(self):
        rids = [f"r{index:02d}" for index in range(8)]
        self.submit(*[request(rid) for rid in rids])
        taken, lock = [], threading.Lock()

        def worker(index):
            answer = self.lane(f"claim w{index} base")
            if answer.stdout.strip():
                with lock:
                    taken.append(json.loads(answer.stdout)["rid"])

        threads = [threading.Thread(target=worker, args=(index,)) for index in range(24)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(taken), rids)
        self.assertEqual(len(self.status()["claimed"]), 8)

    def test_image_and_timeout_filters(self):
        self.submit(request("a", image="base", timeout=40), request("b", image="delta-1", timeout=10))
        self.assertEqual(self.lane("claim w base 20").stdout, b"")
        self.assertEqual(json.loads(self.lane("claim w delta-1 20").stdout)["rid"], "b")
        self.assertEqual(json.loads(self.lane("claim w base 45").stdout)["rid"], "a")

    def test_submit_is_idempotent_and_refuses_answers(self):
        self.assertEqual(self.submit(request("r1"))["accepted"], ["r1"])
        self.assertEqual(self.submit(request("r1"))["existing"], ["r1"])
        for key in ("gold", "rubric", "ideal", "answerKey", "score", "goldAnswer", "Gold-Answer"):
            outcome = self.submit(request("bad", item={"key": "k", "prompt": "p", "meta": [{key: "x"}]}))
            self.assertEqual(outcome["accepted"], [], key)
            self.assertEqual(len(outcome["refused"]), 1, key)
        # A request whose only offence is a key name deep inside the item.
        nested = request("deep")
        nested["item"]["files"] = [{"src": "a", "dest": "b", "extra": {"x": {"scores": 1}}}]
        self.assertEqual(self.submit(nested)["accepted"], [])
        self.assertEqual(self.status()["pending"], 1)

    def test_heartbeat_keeps_a_claim_and_a_silent_one_returns_after_the_ttl(self):
        self.submit(request("r1"), now=1000)
        self.assertEqual(json.loads(self.lane("claim w1 base", now=1000).stdout)["rid"], "r1")
        self.assertEqual(self.lane("heartbeat w1 r1", now=1900).stdout.strip(), b"ok")
        # 1900 + 1199 s: still held.
        self.assertEqual(self.lane("claim w2 base", now=3099).stdout, b"")
        # 1900 + 1201 s: swept back to pending and taken by w2, attempt 2.
        answer = json.loads(self.lane("claim w2 base", now=3101).stdout)
        self.assertEqual((answer["rid"], answer["attempt"]), ("r1", 2))
        self.assertEqual(self.lane("heartbeat w1 r1", now=3102).stdout.strip(), b"lost")
        self.assertEqual(self.lane("heartbeat w2 r1", now=3102).stdout.strip(), b"ok")

    def test_infrastructure_failures_are_bounded_and_end_in_a_marker_never_a_score(self):
        self.submit(request("r1"))
        for attempt in (1, 2):
            self.assertEqual(json.loads(self.lane("claim w1 base").stdout)["attempt"], attempt)
            self.assertEqual(self.lane("fail r1 stack_unhealthy").stdout.strip(), b"requeued")
        self.assertEqual(json.loads(self.lane("claim w1 base").stdout)["attempt"], 3)
        self.assertEqual(self.lane("fail r1 stack_unhealthy").stdout.strip(), b"terminal")
        self.assertEqual(self.lane("claim w1 base").stdout, b"")
        state = self.status()
        self.assertEqual(state["infraFailed"], ["r1"])
        self.assertEqual(state["resultsReady"], [])
        listing = json.loads(self.admin("results").stdout)
        self.assertEqual(listing["infraFailed"][0]["attempts"], 3)
        self.assertEqual(self.admin("requeue", "r1").stdout.strip(), b"requeued")
        self.assertEqual(json.loads(self.lane("claim w1 base").stdout)["attempt"], 1)

    def test_done_stores_the_bundle_and_fetch_round_trips_it(self):
        self.submit(request("r1"))
        self.lane("claim w1 base")
        data = bundle({"r1/result.json": '{"status": "succeeded"}', "r1/answer.md": "4"})
        answer = self.lane("done r1", stdin=data)
        self.assertEqual((answer.returncode, answer.stdout.strip()), (0, b"ok"), answer.stderr)
        self.assertEqual(self.lane("done r1", stdin=data).stdout.strip(), b"duplicate")
        listing = json.loads(self.admin("results").stdout)["results"]
        self.assertEqual([(m["rid"], m["bytes"]) for m in listing], [("r1", len(data))])
        fetched = self.admin("cat", "r1")
        self.assertEqual(fetched.stdout, data)
        self.assertEqual(self.status()["claimed"], [])
        self.assertEqual(json.loads(self.admin("purge", "r1").stdout), ["r1.tgz", "r1.meta.json"])
        self.assertEqual(json.loads(self.admin("results").stdout)["results"], [])

    def test_done_refuses_unreadable_unsafe_and_oversized_bundles_and_unknown_rids(self):
        self.submit(request("r1"))
        self.lane("claim w1 base")
        self.assertEqual(self.lane("done r1", stdin=b"not a tar").returncode, 3)
        evil = io.BytesIO()
        with tarfile.open(fileobj=evil, mode="w:gz") as archive:
            info = tarfile.TarInfo("../escape")
            info.size = 1
            archive.addfile(info, io.BytesIO(b"x"))
        self.assertEqual(self.lane("done r1", stdin=evil.getvalue()).returncode, 3)
        small = self.lane("done r1", stdin=bundle({"a": os.urandom(4000).hex()}), env={"RSI_BROKER_MAX_BUNDLE_BYTES": "100"})
        self.assertEqual(small.returncode, 3)
        self.assertIn(b"bundle_too_large", small.stderr)
        self.assertEqual(self.lane("done nope", stdin=bundle({"a": "x"})).returncode, 3)
        # Nothing of the refusals left a result behind, and the claim is still the worker's.
        self.assertEqual(self.status()["resultsReady"], [])
        self.assertEqual(self.lane("heartbeat w1 r1").stdout.strip(), b"ok")

    def test_work_finished_after_its_claim_lapsed_is_kept(self):
        self.submit(request("r1"), now=1000)
        self.lane("claim w1 base", now=1000)
        self.assertEqual(self.status(now=5000)["pending"], 1)  # swept back
        answer = self.lane("done r1", stdin=bundle({"a": "x"}), now=5001)
        self.assertEqual(answer.stdout.strip(), b"ok")
        self.assertEqual(self.status(now=5002)["pending"], 0)

    def test_pause_stops_claims_and_drain_reports_what_is_in_flight(self):
        self.submit(request("r1"), request("r2"))
        self.lane("claim w1 base")
        self.admin("pause")
        self.assertEqual(self.lane("claim w2 base").stdout, b"")
        drained = json.loads(self.admin("drain").stdout)
        self.assertEqual((drained["claimed"], drained["pending"]), (1, 1))
        self.admin("resume")
        self.assertEqual(json.loads(self.lane("claim w2 base").stdout)["rid"], "r2")

    def test_lane_role_cannot_reach_admin_commands_or_inject_arguments(self):
        self.submit(request("r1"))
        for command in ("submit", "status", "results", "cat r1", "purge r1", "pause", "drain", "claim w1 base; rm -rf /", "claim '../x' base",
                        "fail r1 'Bad Reason'", "heartbeat w1 ../../etc", ""):
            answer = self.lane(command)
            self.assertEqual(answer.returncode, 3, command)
        self.assertFalse(pathlib.Path(self.root, "PAUSE").exists())
        self.assertEqual(self.status()["pending"], 1)

    def test_release_returns_a_claim_to_pending_with_attempts_cleared(self):
        self.submit(request("r1"))
        self.lane("claim w1 base")
        self.lane("fail r1 x")
        self.lane("claim w1 base")
        self.assertEqual(self.admin("release", "r1").stdout.strip(), b"released")
        self.assertEqual(json.loads(self.lane("claim w2 base").stdout)["attempt"], 1)
        self.assertEqual(self.admin("release", "nope").stdout.strip(), b"not_claimed")

    def test_lane_status_is_stored_and_capped(self):
        self.assertEqual(self.lane('lane-status b001-1 \'{"workers": 3, "stage": "running"}\'').stdout.strip(), b"ok")
        self.assertEqual(self.status()["lanes"]["b001-1"]["status"]["workers"], 3)
        self.assertEqual(self.lane("lane-status b001-1 '" + json.dumps({"x": "y" * 5000}) + "'").returncode, 3)


if __name__ == "__main__":
    unittest.main()
