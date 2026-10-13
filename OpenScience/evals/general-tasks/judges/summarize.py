#!/usr/bin/env python3
"""Write summary.md and summary.json for a run directory from its records, judged files and model-judged files.

    python3 -I judges/summarize.py --run <dir>
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def load(directory: Path) -> list[dict]:
    out = []
    for file in sorted(directory.glob("*.json")) if directory.is_dir() else []:
        try:
            out.append(json.loads(file.read_text(encoding="utf-8")))
        except ValueError:
            pass
    return out


def model_scores(entry: dict | None) -> str:
    if not entry or not entry.get("scores"):
        return "-"
    values = [v for v in entry["scores"].values() if isinstance(v, (int, float))]
    return f"{sum(values) / len(values):.1f}" if values else "-"


def rows_of(run: Path) -> list[dict]:
    judged = {j["name"]: j for j in load(run / "judged")}
    model = {m["name"]: m for m in load(run / "model-judged")}
    rows = []
    for record in load(run / "records"):
        name = record.get("name")
        j = judged.get(name)
        if j is None:
            rows.append({"name": name, "caseId": record.get("cell"), "status": "unjudged", "variant": record.get("variant"), "metrics": {}, "failedChecks": [], "model": "-", "routingCheck": False})
            continue
        for case_id, entry in j["entries"].items():
            row = dict(entry)
            row["name"] = name
            row["model"] = model_scores((model.get(name) or {}).get("entries", {}).get(case_id))
            rows.append(row)
    return rows


def summarize(run: Path) -> dict:
    rows = rows_of(run)
    manifest = {}
    try:
        manifest = json.loads((run / "run.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    tree = manifest.get("tree") or {}
    lines = [f"# General-task baseline: arm {manifest.get('arm', '?')}", "",
             f"Tree `{tree.get('path', '?')}` at `{str(tree.get('commit', '?'))[:9]}` ({tree.get('branch', '?')}{', dirty' if tree.get('dirty') else ''}). {len(rows)} case record(s).", "",
             "| case | variant | result | checks | model | route | tools | wall s | tokens in/out | files reg./new | marked 未核验 | failed checks |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for row in sorted(rows, key=lambda r: (r.get("caseId", ""), r.get("variant", ""))):
        m = row.get("metrics", {})
        routes = ",".join(sorted({x.split("/")[0] for x in m.get("routes", [])})) or "-"
        lines.append("| {case} | {variant} | {status} | {passed}/{required} | {model} | {route} | {tools} | {wall} | {tin}/{tout} | {reg}/{new} | {unv} | {failed} |".format(
            case=row.get("caseId"), variant=row.get("variant"), status=row.get("status"), passed=row.get("passed", "-"), required=row.get("required", "-"), model=row.get("model", "-"),
            route=routes, tools=m.get("toolCalls", "-"), wall=m.get("wallSeconds", "-"), tin=m.get("inputTokens", "-"), tout=m.get("outputTokens", "-"),
            reg=m.get("filesRegistered", "-"), new=len(m.get("filesNew", [])), unv="yes" if m.get("unverifiedMarked") else "no", failed=", ".join(row.get("failedChecks", [])) or ""))
    def rate(kind: str):
        pool = [r for r in rows if r.get("kind") == kind and r.get("status") in ("pass", "fail", "unjudged")]
        passed = sum(1 for r in pool if r["status"] == "pass")
        return {"pass": passed, "of": len(pool)}
    totals = {"general": rate("general"), "medical": rate("medical")}
    routing = [{"case": r["caseId"], "variant": r["variant"], "status": r["status"], "routes": r.get("metrics", {}).get("routes")} for r in rows if r.get("routingCheck")]
    lines += ["", f"General cases passed: {totals['general']['pass']}/{totals['general']['of']}. Medical controls passed: {totals['medical']['pass']}/{totals['medical']['of']}.", "",
              "Routing checks (deterministic, one miss is a miss): " + "; ".join(f"{r['case']}{'' if r['variant'] == 'normal' else '/' + r['variant']}={r['status']}" for r in routing), ""]
    (run / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    data = {"arm": manifest.get("arm"), "tree": tree, "totals": totals, "routing": routing, "rows": [{k: v for k, v in r.items() if k != "checks"} for r in rows]}
    (run / "summary.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return data


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True, type=Path)
    args = parser.parse_args()
    data = summarize(args.run)
    print(json.dumps(data["totals"]))


if __name__ == "__main__":
    main()
