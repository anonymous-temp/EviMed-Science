#!/usr/bin/env python3
"""A stand-in for lab/brokerctl.py over a directory (RSI_FAKE_BROKER_DIR), same verbs and same output shapes, plus a lane that runs requests.

The lane acts on `status` (the way a real lane would have acted between two polls): each pending request becomes a finished bundle, an
infra-failed marker or a driver-error bundle, as `scenario.json` in the directory says:

  {"busy_polls": 2,                      the first N status calls return nothing ready
   "infra_fail": ["inv1"],               a rid containing one of these ends as a terminal infra-failed marker (once, then it works)
   "driver_error": ["dom1"],             a rid containing one of these returns a bundle whose result.json status is dispatch_refused (once)
   "grading_file": true,                 the bundle also holds a scores.json
   "route": "statistical-analysis"       effectiveAgentId of the run (default open-domain-answer)}

It validates every request with the real lab/broker.py, so the adapter is held to the lab's own refusal rules.
"""
import hashlib
import io
import json
import os
import pathlib
import sys
import tarfile
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lab"))
import broker as real_broker  # noqa: E402

ROOT = pathlib.Path(os.environ["RSI_FAKE_BROKER_DIR"])
for name in ("pending", "results", "log"):
    (ROOT / name).mkdir(parents=True, exist_ok=True)


def scenario():
    try:
        return json.loads((ROOT / "scenario.json").read_text())
    except (OSError, ValueError):
        return {}


def save_scenario(value):
    (ROOT / "scenario.json").write_text(json.dumps(value))


def log(event, **fields):
    with open(ROOT / "log" / "events.jsonl", "a") as handle:
        handle.write(json.dumps({"event": event, **fields}) + "\n")


def make_bundle(request, status="succeeded", extra_grading=False, route=None):
    item = request["item"]
    probe = request.get("probe") or {}
    prompt = item["prompt"]
    skill = item.get("groupSkill")
    improved = bool(probe.get("preamble") or skill)
    answer = "Final answer: 42" if improved else "Final answer: 41"
    story = scenario().get("story")
    messages = [
        {"role": "user", "source": "user", "turn": 1, "parts": [{"type": "text", "text": (probe.get("preamble") or "") + prompt}]},
        {"role": "user", "source": "runtime-context", "turn": 1, "parts": [{"type": "text", "text": "Current runtime context."}]},
        {"role": "assistant", "source": "system", "turn": 1, "step": 1, "parts": [
            {"type": "reasoning", "text": "I will compute the value with code."},
            {"type": "tool", "tool": "bash", "status": "completed", "input": {"command": "python3 -c 'print(6*7)'"}, "output": "42\n"}]},
        {"role": "assistant", "source": "system", "turn": 1, "step": 2, "parts": [{"type": "text", "text": answer}]},
    ]
    result = {
        "key": item["key"], "status": status, "line": item.get("line"), "effectiveAgentId": route or scenario().get("route", "open-domain-answer"),
        "effectiveRouteReason": "unrouted:open-domain", "errorCode": None, "answerChars": len(answer), "presentedFiles": [],
        "cost": {"cost": 0.0123, "openCost": 0, "currency": "CNY", "calls": 3, "uncertain": 0}, "capture": {"cost": "ok"},
    }
    if status == "dispatch_refused":
        result["infrastructureFailure"] = True
    files = {
        "result.json": json.dumps(result), "answer.md": answer if status == "succeeded" else "", "transcript.json": json.dumps({"messages": messages}),
        "run.json": json.dumps({"id": "run_x"}),
    }
    if story == "memory" and not improved:
        # a synthetic base run with a visible process defect: it answers from recall, never recomputes and gives no unit
        files["transcript.json"] = json.dumps({"messages": [
            messages[0], messages[1],
            {"role": "assistant", "source": "system", "turn": 1, "step": 1, "parts": [
                {"type": "reasoning", "text": "I remember this index is usually about forty. I will not run any tool; the note looks routine."},
                {"type": "text", "text": "The index is roughly 41.\n\nFinal answer: 41"}]}]})
        files["answer.md"] = "The index is roughly 41.\n\nFinal answer: 41"
    if extra_grading:
        files["scores.json"] = json.dumps({"passed_count": 3})
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, text in files.items():
            raw = text.encode()
            info = tarfile.TarInfo(f"{item['key'].replace('/', '__').replace('#', '_')}/{name}")
            info.size = len(raw)
            archive.addfile(info, io.BytesIO(raw))
    return buffer.getvalue()


def lane():
    state = scenario()
    state["polls"] = state.get("polls", 0) + 1
    save_scenario(state)
    if state["polls"] <= state.get("busy_polls", 0):
        return
    for path in sorted((ROOT / "pending").glob("*.json")):
        request = json.loads(path.read_text())
        rid = request["rid"]
        state = scenario()
        failing = [s for s in state.get("infra_fail", []) if s in rid]
        refusing = [s for s in state.get("driver_error", []) if s in rid]
        if failing:
            (ROOT / "results" / f"{rid}.infra-failed.json").write_text(json.dumps({"rid": rid, "attempts": 3, "reasons": [{"reason": "lost_heartbeat"}], "request": request}))
            state["infra_fail"] = [s for s in state["infra_fail"] if s not in failing]
        elif refusing:
            data = make_bundle(request, status="dispatch_refused")
            (ROOT / "results" / f"{rid}.tgz").write_bytes(data)
            (ROOT / "results" / f"{rid}.meta.json").write_text(json.dumps({"rid": rid, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}))
            state["driver_error"] = [s for s in state["driver_error"] if s not in refusing]
        else:
            data = make_bundle(request, extra_grading=bool(state.get("grading_file")))
            (ROOT / "results" / f"{rid}.tgz").write_bytes(data)
            (ROOT / "results" / f"{rid}.meta.json").write_text(json.dumps({"rid": rid, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}))
        save_scenario(state)
        path.unlink()
        log("ran", rid=rid)


def main(argv):
    command = argv[0]
    if command == "submit":
        accepted = existing = 0
        paths = [a for a in argv[1:] if not a.startswith("--") and not a.endswith("manifest.json")]
        for path in paths:
            request = json.loads(pathlib.Path(path).read_text())
            try:
                real_broker.validate_request(request)
            except ValueError as error:
                print(f"refused {request.get('rid')}: {error}", file=sys.stderr)
                return 2
            rid = request["rid"]
            if any((ROOT / kind / name).exists() for kind, name in (
                    ("pending", f"{rid}.json"), ("results", f"{rid}.meta.json"), ("results", f"{rid}.infra-failed.json"))):
                existing += 1
                log("submit-existing", rid=rid)
            else:
                (ROOT / "pending" / f"{rid}.json").write_text(json.dumps(request))
                accepted += 1
                log("submit", rid=rid, request=request)
        print(f"submitted: {accepted} accepted, {existing} already there, 0 refused")
        return 0
    if command == "status":
        lane()
        ready = sorted(p.name[: -len(".meta.json")] for p in (ROOT / "results").glob("*.meta.json"))
        failed = sorted(p.name[: -len(".infra-failed.json")] for p in (ROOT / "results").glob("*.infra-failed.json"))
        print(json.dumps({"paused": False, "pending": len(list((ROOT / "pending").glob("*.json"))), "pendingByImage": {}, "claimed": [], "resultsReady": ready,
                          "infraFailed": failed, "lanes": {}, "diskFreeBytes": 10 ** 10}))
        return 0
    if command == "fetch":
        out = pathlib.Path(argv[1])
        out.mkdir(parents=True, exist_ok=True)
        n = 0
        for meta in sorted((ROOT / "results").glob("*.meta.json")):
            rid = meta.name[: -len(".meta.json")]
            (out / f"{rid}.tgz").write_bytes((ROOT / "results" / f"{rid}.tgz").read_bytes())
            (out / f"{rid}.meta.json").write_text(meta.read_text())
            for name in (f"{rid}.tgz", f"{rid}.meta.json"):
                (ROOT / "results" / name).unlink()
            n += 1
        for marker in sorted((ROOT / "results").glob("*.infra-failed.json")):
            (out / marker.name).write_text(marker.read_text())
            marker.unlink()
        log("fetch", n=n)
        print(f"fetched {n} bundle(s)")
        return 0
    print("unknown command", file=sys.stderr)
    return 4


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
