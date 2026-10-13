#!/usr/bin/env python3
"""Run the deterministic judges over one cell record and write the judged file.

    python3 -I judges/judge_case.py --cases cases.json --record records/G05-r1.json --out judged/G05-r1.json --fixtures fixtures

A cell may carry more than one case (G06 and G07 share a conversation); each gets its own entry.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import checks  # noqa: E402


def metrics_of(ctx: "checks.Ctx") -> dict:
    turns = ctx.turns
    usage = [t.get("run", {}).get("usage") or {} for t in turns]
    notices = [n for t in turns for n in t.get("run", {}).get("qualityNotices", [])]
    return {
        "routes": [f"{t.get('run', {}).get('effectiveAgentId') or '-'}/{t.get('run', {}).get('effectiveRouteReason') or '-'}" for t in turns],
        "statuses": [t.get("run", {}).get("status") or t.get("error") for t in turns],
        "toolCalls": sum(int(t.get("run", {}).get("observedToolCalls") or 0) for t in turns),
        "toolCallsTranscript": sum(len(t.get("tools", [])) for t in turns),
        "toolNames": sorted({tool["name"] for t in turns for tool in t.get("tools", [])}),
        "wallSeconds": round(sum(t.get("wallMs", 0) for t in turns) / 1000),
        "inputTokens": sum(int(u.get("inputTokens") or 0) for u in usage),
        "outputTokens": sum(int(u.get("outputTokens") or 0) for u in usage),
        "cachedInputTokens": sum(int(u.get("cachedInputTokens") or 0) for u in usage),
        "costCny": round(sum(float(u.get("costCny") or 0) for u in usage), 4),
        "filesRegistered": len(checks._registered_paths(ctx)),
        "filesNew": [rel for rel, _ in ctx.new_files()],
        "verification": [t.get("run", {}).get("verification") for t in turns],
        "unverifiedMarked": any(t.get("run", {}).get("verification") == "unverified" for t in turns),
        "qualityNotices": len(notices),
        "replyChars": [len(t.get("reply", "")) for t in turns],
    }


def judge_record(cases: dict, record: dict, record_file: Path, fixtures: Path) -> dict:
    truth = json.loads((fixtures / "ground_truth.json").read_text(encoding="utf-8"))
    files_dir = record_file.with_name(record_file.stem + ".files")
    tree = (record.get("tree") or {}).get("path")
    entries = {}
    for case_id in record.get("caseIds") or [record.get("cell")]:
        case = cases[case_id]
        ctx = checks.Ctx(case, record, files_dir, fixtures, truth, tree)
        if record.get("infra"):
            entries[case_id] = {"caseId": case_id, "variant": record.get("variant"), "status": "infra_error", "checks": [], "error": record.get("error")}
            continue
        results = checks.run_case(case, record.get("variant", "normal"), ctx)
        required = [r for r in results if r["required"]]
        failed = [r for r in required if r["ok"] is False]
        unknown = [r for r in required if r["ok"] is None]
        status = "fail" if failed else ("unjudged" if unknown else "pass")
        entries[case_id] = {
            "caseId": case_id, "variant": record.get("variant", "normal"), "family": case["family"], "kind": case["kind"], "arm": record.get("arm"),
            "routingCheck": bool(case.get("routing_check")), "status": status, "required": len(required), "passed": sum(1 for r in required if r["ok"]),
            "failedChecks": [r["id"] for r in failed], "checks": results, "metrics": metrics_of(ctx),
        }
    return {"name": record.get("name"), "arm": record.get("arm"), "tree": record.get("tree"), "entries": entries}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", required=True, type=Path)
    parser.add_argument("--record", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--fixtures", required=True, type=Path)
    args = parser.parse_args()
    cases = {c["id"]: c for c in json.loads(args.cases.read_text(encoding="utf-8"))["cases"]}
    record = json.loads(args.record.read_text(encoding="utf-8"))
    judged = judge_record(cases, record, args.record, args.fixtures)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(judged, ensure_ascii=False, indent=1), encoding="utf-8")
    for case_id, entry in judged["entries"].items():
        print(f"{case_id}: {entry['status']} {entry.get('passed', 0)}/{entry.get('required', 0)} failed={entry.get('failedChecks', [])}")


if __name__ == "__main__":
    main()
