"""Report of a product-path check: one line per arm and patient from the per-case summaries, and the three judgment files scored with the unchanged
official evaluator on the same patients: the job arm, the native arm and a dev-loop arm's rows for those patients. Operational check, not an accuracy estimate.

  python -I check_report.py --summary-dir <dir> --run-dir <dir> --dev-judgments <file> --boards <inputs> --tg2 <clone> --tg1 <clone> --work <dir> [--python <interp>]

Aggregates and tool names only; the replies are in the summary files.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
PUBLIC = lambda name: name.replace("mcp__evimed__", "")


def compress(names):
    out, last, count = [], None, 0
    for name in map(PUBLIC, names):
        if name == last:
            count += 1
            continue
        if last:
            out.append(f"{last}x{count}" if count > 1 else last)
        last, count = name, 1
    if last:
        out.append(f"{last}x{count}" if count > 1 else last)
    return out


def lines(summary_dir):
    rows = []
    for file in sorted(Path(summary_dir).glob("*.json")):
        rows.append(json.loads(file.read_text(encoding="utf-8")))
    return rows


def per_case(rows):
    table = []
    for r in rows:
        counts = Counter(PUBLIC(t) for t in r["tools"])
        a = r.get("agreement") or {}
        table.append({
            "arm": r["arm"], "patient": r["caseId"], "status": r["status"], "saved": f"{r['pairsSaved']}/{r['pairsAsked']}", "failedPairs": r["pairsFailed"],
            "wallMin": r["wallMinutes"], "modelCalls": r["modelCalls"], "costCny": r["costCny"], "byPurpose": {k: v["calls"] for k, v in (r.get("byPurpose") or {}).items()},
            "tools": dict(counts), "toolSequence": compress(r["tools"]), "toolErrors": r["toolErrors"], "replyChars": r["replyChars"],
            "verdictsReported": a.get("reported"), "verdictsAgree": a.get("agree"), "verdictsDisagree": a.get("disagree"), "noVerdictStated": a.get("noVerdictStated"), "unknownIds": a.get("unknownIds"),
            "jobs": r.get("jobs"), "unsettledCalls": r.get("unsettledCalls"), "error": (r.get("error") or {}).get("code") or (r.get("error") or {}).get("message"),
        })
    return table


def restricted(source, patients, target):
    rows = [json.loads(line) for line in Path(source).read_text(encoding="utf-8").splitlines() if line.strip()]
    keep = [row for row in rows if row["patientId"] in patients]
    Path(target).write_text("".join(json.dumps(row) + "\n" for row in keep), encoding="utf-8")
    return len(keep)


def score(label, file, args, work):
    out = Path(work) / label
    ran = subprocess.run([args.python, "-I", "-B", str(HERE / "score.py"), "a", "--boards", args.boards, "--tg2", args.tg2, "--tg1", args.tg1, "--python", args.python,
                          "--work", str(out / "work"), "--out", str(out / "out"), "--judgments", f"sigir={file}", "--resamples", "2000"], capture_output=True, text=True)
    if ran.returncode != 0:
        return {"error": ran.stderr[-300:]}
    result = json.loads((out / "out" / "board-a.json").read_text(encoding="utf-8"))
    cohort = result["cohorts"]["sigir"]
    finished = cohort["variants"].get("finished") or {}
    official = finished.get("official") or {}
    point = lambda name: (finished.get("bootstrap", {}).get(name) or {}).get("point")
    return {"patients": finished.get("patients"), "ndcg10": point("ndcg@10"), "p10": point("p@10"), "mrr": point("mrr"), "map": point("map"), "official": official,
            "pairsJudged": cohort.get("completion", {}).get("pairsJudged"), "pairsFailedByCode": cohort.get("completion", {}).get("pairsFailedByCode")}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    for name in ("summary-dir", "run-dir", "dev-judgments", "boards", "tg2", "tg1", "work"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--patients", help="comma list: restrict the table and the scores to these patients")
    args = parser.parse_args()
    rows = lines(args.summary_dir)
    if args.patients:
        rows = [r for r in rows if r["caseId"] in args.patients.split(",")]
    table = per_case(rows)
    patients = sorted({r["patient"] for r in table})
    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)
    scores = {}
    for arm in sorted({r["arm"] for r in table}):
        source = Path(args.run_dir) / arm / "judgments.jsonl"
        if source.exists():
            target = work / f"{arm}.jsonl"
            scores[arm] = {"rows": restricted(source, patients, target), **score(arm, target, args, work)}
    target = work / "dev-reference.jsonl"
    scores["dev:sigir-fit-off"] = {"rows": restricted(args.dev_judgments, patients, target), **score("dev", target, args, work)}
    report = {"cases": table, "scores": scores, "patients": patients,
              "totals": {arm: {"costCny": round(sum(r["costCny"] for r in table if r["arm"] == arm), 4), "wallMin": round(sum(r["wallMin"] for r in table if r["arm"] == arm), 2), "modelCalls": sum(r["modelCalls"] or 0 for r in table if r["arm"] == arm)} for arm in sorted({r["arm"] for r in table})}}
    (work / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
