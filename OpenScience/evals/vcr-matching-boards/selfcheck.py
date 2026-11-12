"""Prove the scoring path on prepared boards with synthetic judgments. No model is called.

For one real ranking cohort it writes a perfect ranking (best label first) and its
reverse, pushes both through to_official.py and the unchanged official evaluator,
and requires the perfect ranking to reach nDCG 1.0 and the reverse to score lower on every
metric. For NIH-TrialBench it puts the target first, then last. For the criterion board it answers with the
expert labels, with the GPT-4 column (the paired difference must be exactly zero and
GPT-4 must reproduce at 886/1015), and with nothing at all (every row wrong).
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))  # python -I does not add the script directory

from common import CRITERION, NIH, read_json, read_jsonl
from prepare import read_qrels

HERE = Path(__file__).resolve().parent


def ranking_record(pid, ordered, status="complete"):
    return {"patientId": pid, "status": status, "failed": [],
            "ranking": [{"registryId": trial, "fit": 100 - index, "confidence": 0.9, "verdict": "synthetic", "rank": index + 1}
                        for index, trial in enumerate(ordered)]}


def write_lines(path, rows):
    Path(path).write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


def run_score(board, extra, python):
    done = subprocess.run([python, "-I", "-B", str(HERE / "score.py"), board, *map(str, extra)], capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError(f"score.py {board} failed: {done.stderr.strip()[-800:]}")


def check(results, name, condition, detail):
    results.append((name, bool(condition), detail))
    print(("PASS " if condition else "FAIL ") + f"{name}: {detail}")


def board_a(args, work, results, cohort):
    qrels, _ = read_qrels(Path(args.tg2) / "data" / cohort / "qrels" / "test.tsv")
    cases = read_jsonl(Path(args.boards) / f"A-{cohort.replace('_', '')}" / "cases.jsonl")
    perfect, reverse = [], []
    for case in cases:
        labels = qrels[case["patientId"]]
        best = sorted(case["candidateIds"], key=lambda trial: (-labels[trial], trial))
        perfect.append(ranking_record(case["patientId"], best))
        reverse.append(ranking_record(case["patientId"], best[::-1]))
    outcome = {}
    for name, rows in (("perfect", perfect), ("reversed", reverse)):
        judgments = work / f"{cohort}-{name}.jsonl"
        write_lines(judgments, rows)
        out = work / f"results-a-{name}"
        run_score("a", ["--boards", args.boards, "--tg2", args.tg2, "--tg1", args.tg1, "--work", work / f"work-a-{name}",
                        "--out", out, "--judgments", f"{cohort}={judgments}", "--python", args.python, "--resamples", 200], args.python)
        record = read_json(out / "board-a.json")["cohorts"][cohort]["variants"]["all"]["official"]
        outcome[name] = record
        check(results, f"A {cohort} {name}", True, json.dumps(record, sort_keys=True))
    check(results, f"A {cohort} perfect ranking scores nDCG@10 = 1.0", outcome["perfect"]["ndcg@10"] == 1.0, outcome["perfect"]["ndcg@10"])
    # Independent expectation for a perfect ranking: MRR counts only label-2 trials, P@10 is the graded share of the top ten.
    patients = [qrels[case["patientId"]] for case in cases]
    expect_mrr = sum(2 in labels.values() for labels in patients) / len(patients)
    expect_p = sum(sum(sorted(labels.values(), reverse=True)[:10]) / 20 for labels in patients) / len(patients)
    check(results, f"A {cohort} perfect ranking reproduces the expected MRR", abs(outcome["perfect"]["mrr"] - expect_mrr) < 5.1e-5,
          f"{outcome['perfect']['mrr']} vs {expect_mrr:.6f}")
    check(results, f"A {cohort} perfect ranking reproduces the expected P@10", abs(outcome["perfect"]["p@10"] - expect_p) < 5.1e-5,
          f"{outcome['perfect']['p@10']} vs {expect_p:.6f}")
    check(results, f"A {cohort} reversed ranking scores lower on every metric",
          all(outcome["reversed"][key] < outcome["perfect"][key] for key in outcome["perfect"]), json.dumps(outcome["reversed"], sort_keys=True))


def board_b(args, work, results):
    cases = read_jsonl(Path(args.boards) / "B-nih" / "cases.jsonl")
    targets = {row["patientId"]: row["targetTrialId"] for row in read_jsonl(Path(args.labels) / "B-nih" / "targets.jsonl")}
    first, last = [], []
    for case in cases:
        rest = [trial for trial in case["candidateIds"] if trial != targets[case["patientId"]]]
        first.append(ranking_record(case["patientId"], [targets[case["patientId"]], *rest]))
        last.append(ranking_record(case["patientId"], [*rest, targets[case["patientId"]]]))
    found = {}
    for name, rows in (("target-first", first), ("target-last", last)):
        judgments = work / f"nih-{name}.jsonl"
        write_lines(judgments, rows)
        out = work / f"results-b-{name}"
        run_score("b", ["--boards", args.boards, "--tg2", args.tg2, "--work", work / f"work-b-{name}", "--out", out,
                        "--judgments", judgments, "--python", args.python, "--resamples", 200], args.python)
        found[name] = read_json(out / "board-b.json")["official"]["hit_count_at_10"]
    check(results, "B target first gives recall@10 = 126/126", found["target-first"] == NIH["cases"], found["target-first"])
    check(results, "B target last gives recall@10 = 0", found["target-last"] == 0, found["target-last"])


def board_c(args, work, results):
    cases = read_jsonl(Path(args.boards) / "C-criterion" / "cases.jsonl")
    labels = read_jsonl(Path(args.labels) / "C-criterion" / "labels.jsonl")
    by_key = {(row["patientId"], row["registryId"], row["kind"], row["number"]): row for row in labels}

    def records(column):
        out = []
        for case in cases:
            ranking = []
            for index, trial in enumerate(case["trials"]):
                criteria = [] if column is None else [
                    {"number": clause["number"], "kind": clause["kind"], "label": by_key[(case["patientId"], trial["registryId"], clause["kind"], clause["number"])][column],
                     "sentenceIds": [], "basis": "synthetic", "text": clause["text"]} for clause in trial["clauses"]]
                ranking.append({"registryId": trial["registryId"], "fit": 50, "confidence": 0.5, "verdict": "synthetic",
                                "rank": index + 1, "criteria": criteria})
            out.append({"patientId": case["patientId"], "status": "complete", "failed": [], "ranking": ranking})
        return out

    scored = {}
    for name, column in (("expert", "expert"), ("gpt4", "gpt4"), ("silent", None)):
        judgments = work / f"criterion-{name}.jsonl"
        write_lines(judgments, records(column))
        out = work / f"results-c-{name}"
        run_score("c", ["--boards", args.boards, "--labels", args.labels, "--work", work / f"work-c-{name}", "--out", out,
                        "--judgments", judgments, "--resamples", 200], args.python)
        scored[name] = read_json(out / "board-c.json")
    n = CRITERION["rows"]
    check(results, "C expert labels agree on all rows", scored["expert"]["agreement"]["ours"]["correct"] == n, scored["expert"]["agreement"]["ours"]["correct"])
    check(results, "C GPT-4 column reproduces 886/1015", scored["gpt4"]["agreement"]["ours"]["correct"] == CRITERION["gpt4_agree"],
          scored["gpt4"]["agreement"]["ours"]["correct"])
    difference = scored["gpt4"]["agreement"]["difference"]
    check(results, "C GPT-4 against itself: paired difference exactly zero", difference["value"] == 0 and difference["ci"] == [0, 0], difference)
    check(results, "C no answers: every row counted wrong", scored["silent"]["agreement"]["ours"]["correct"] == 0
          and scored["silent"]["answers"]["missing"] == n, scored["silent"]["answers"])
    # No aggregate file may carry a patient id.
    leaks = [pid for case in cases for pid in [case["patientId"]] if pid in json.dumps(scored["expert"])]
    check(results, "C aggregate results carry no patient id", not leaks, leaks[:1])


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--boards", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True)
    parser.add_argument("--tg2", type=Path, required=True)
    parser.add_argument("--tg1", type=Path, required=True)
    parser.add_argument("--cohort", default="sigir", choices=("sigir", "trec_2021", "trec_2022"))
    parser.add_argument("--python", default=sys.executable, help="interpreter with tqdm, for the official evaluators")
    parser.add_argument("--work", type=Path, help="private scratch directory (default: a temporary one)")
    args = parser.parse_args()
    results = []
    with tempfile.TemporaryDirectory(prefix="boards-selfcheck-") as scratch:
        work = args.work or Path(scratch)
        work.mkdir(parents=True, exist_ok=True)
        board_a(args, work, results, args.cohort)
        board_b(args, work, results)
        board_c(args, work, results)
    failed = [name for name, ok, _ in results if not ok]
    print(f"{len(results) - len(failed)} passed, {len(failed)} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
