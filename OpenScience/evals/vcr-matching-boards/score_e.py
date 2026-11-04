"""Board E scorer: the full-corpus TREC Clinical Trials runs (2021, 2022, 2023), scored against the official qrels.

Nothing here calls a model. It reads two kinds of file, both written by the runners of this directory, and the official qrels:

  retrieval   `retrieved-<arm>.jsonl` from `retrieve_e.mjs`: per topic the ids the feature's search returned, in order.
  end2end     `judgments.jsonl` from `dev_job.mjs`: per topic the saved judgments of the candidates it was handed, in saved rank order.

Formulas (trec_eval's, checked against a built `trec_eval` 10.0-rc3 when one is given with --trec-eval, and against a hand-worked fixture
in test_score_e.py):

  nDCG@10   gain = the qrels grade (0 not relevant, 1 excluded, 2 eligible), linear; DCG = sum gain_i / log2(i + 1) over ranks 1..10;
            the ideal is the grades of the topic's whole qrels sorted down; an id the qrels do not hold has gain 0.
  P@10      the share of the first ten that are eligible (grade 2): trec_eval `P.10` with `-l 2`, the TREC Clinical Trials convention.
  J@10      the share of the first ten that the qrels judged at all (any grade, 0 included). A list shorter than ten counts its missing places as
            unjudged, as P@10 counts them as not eligible.
  Recall@k  eligible: eligible ids in the first k over all eligible ids of the topic; graded: summed grades in the first k over the summed grades
            of the whole qrels. A topic with nothing eligible (nothing graded) has no recall and is left out of that mean, never counted as 0.
            The ceiling columns are what a perfect list of k ids reaches (a 2023 topic has several hundred eligible trials, so recall@100 cannot pass
            about 0.2 there): read recall beside its ceiling, never across years without it.

Retrieval order alone gives a baseline nDCG@10, so the retrieval command reports it for each arm; the end2end command can print the same
statistic for the retrieval order of the very candidates the judge was given (--retrieved), which is the figure the judging has to beat.

Means are over topics; the interval is a 95% percentile bootstrap by topic (10,000 resamples, a fixed seed). The all-year figure is the mean
of the cohort means (the convention of this directory's other scorer), and the pooled mean over topics is given beside it.

    python3 -I -B score_e.py retrieval --qrels-dir <dir> --run no-rerank=<file> rerank=<file> --out <dir> [--trec-eval <binary>]
    python3 -I -B score_e.py end2end --qrels-dir <dir> --judgments 2021=<file> 2022=<file> 2023=<file> --out <dir> [--retrieved <file>]
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import re
import statistics
import subprocess
import sys
import tempfile

QRELS_SHA = {
    2021: "ba7a2cddc90285e75cd76adcd483394a6c9bacf7017113222058ba6537e6d8ac",
    2022: "e569a531489e03f7b1fab03fe169c8ea66f4a59e8180fa9858b1a6e4bdcb0c5c",
    2023: "4f0cd4ad573e37d08002fb401bb7ab22a643537753880d9427c96119696582a3",
}
TOPIC = re.compile(r"^trec-(?:(2021|2022)(\d+)|(2023)-(\d+))$")
NCT = re.compile(r"^NCT[0-9]{8}$")
KS = (100, 500)


def topic_key(topic):
    """('trec-20211') -> (2021, 1); ('trec-2023-5') -> (2023, 5)."""
    found = TOPIC.match(topic)
    if not found:
        raise ValueError(f"not a TREC topic id: {topic!r}")
    return (int(found.group(1) or found.group(3)), int(found.group(2) or found.group(4)))


def read_qrels(path, year=None, check_hash=True):
    """{topic number: {nct id: grade}} from a TREC qrels file (`topic 0 id grade`); the file's hash is held to the pinned one when the year is known."""
    raw = Path(path).read_bytes()
    if check_hash and year in QRELS_SHA and hashlib.sha256(raw).hexdigest() != QRELS_SHA[year]:
        raise ValueError(f"the {year} qrels differ from the pinned file")
    qrels = {}
    for line in raw.decode().splitlines():
        if not line.strip():
            continue
        topic, _, ident, grade = line.split()
        grade = int(grade)
        if grade not in (0, 1, 2) or not NCT.match(ident) or ident in qrels.setdefault(int(topic), {}):
            raise ValueError("invalid or repeated qrels line")
        qrels[int(topic)][ident] = grade
    return qrels


def dcg(grades):
    return sum(grade / math.log2(rank + 1) for rank, grade in enumerate(grades[:10], 1))


def metrics(order, qrels):
    """The per-topic figures of one ranked list against one topic's qrels. `order` is a list of ids, best first, without repeats."""
    if len(set(order)) != len(order):
        raise ValueError("a ranking repeats an id")
    grades = [qrels.get(ident, 0) for ident in order]
    ideal = dcg(sorted(qrels.values(), reverse=True))
    eligible = {ident for ident, grade in qrels.items() if grade == 2}
    total = sum(qrels.values())
    top = order[:10]
    out = {
        "ndcg10": dcg(grades) / ideal if ideal else None,
        "p10": sum(qrels.get(ident, 0) == 2 for ident in top) / 10,
        "j10": sum(ident in qrels for ident in top) / 10,
        "listed": len(order),
    }
    ranked = sorted(qrels.values(), reverse=True)
    for k in KS:
        cut = order[:k]
        out[f"recall{k}"] = len(eligible.intersection(cut)) / len(eligible) if eligible else None
        out[f"graded{k}"] = sum(qrels.get(ident, 0) for ident in cut) / total if total else None
        # What a perfect list of k ids would reach: a topic with more than k eligible trials cannot have recall 1 at k.
        out[f"recall{k}Ceiling"] = min(k, len(eligible)) / len(eligible) if eligible else None
        out[f"graded{k}Ceiling"] = sum(ranked[:k]) / total if total else None
    return out


def bootstrap(values, resamples, seed):
    values = [v for v in values if v is not None]
    if not values:
        return {"mean": None, "low": None, "high": None, "n": 0}
    rng = random.Random(seed)
    means = sorted(statistics.fmean(rng.choices(values, k=len(values))) for _ in range(resamples))
    return {"mean": statistics.fmean(values), "low": means[int(0.025 * resamples)], "high": means[min(resamples - 1, int(0.975 * resamples))], "n": len(values)}


def load_qrels_dir(directory, years):
    return {year: read_qrels(Path(directory) / f"qrels{year}.txt", year) for year in years}


def jsonl(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def summarise(rows, keys, resamples, seed):
    """Per-year and all-year summaries of per-topic rows ({year, topic, metrics...}). All-year = mean of the year means, plus the pooled mean."""
    by_year = {}
    for year in sorted({row["year"] for row in rows}):
        part = [row for row in rows if row["year"] == year]
        by_year[year] = {key: bootstrap([row[key] for row in part], resamples, seed) for key in keys}
        by_year[year]["topics"] = len(part)
    pooled = {key: bootstrap([row[key] for row in rows], resamples, seed) for key in keys}
    macro = {}
    for key in keys:
        means = [by_year[year][key]["mean"] for year in by_year if by_year[year][key]["mean"] is not None]
        macro[key] = statistics.fmean(means) if means else None
    return {"byYear": by_year, "pooled": pooled, "meanOfYearMeans": macro, "topics": len(rows)}


def trec_eval_check(binary, qrels_by_year, rows_by_topic, level=2):
    """Run a built `trec_eval` over the same lists and return its ndcg_cut_10 and P_10 per topic, to compare with metrics()."""
    results = {}
    with tempfile.TemporaryDirectory(prefix="s8-treceval-") as scratch:
        for year, qrels in qrels_by_year.items():
            qfile, rfile = Path(scratch) / f"q{year}", Path(scratch) / f"r{year}"
            # trec_eval stops at a qrels topic the run does not have, so it is given the judgments of the run's topics only.
            asked = sorted(number for (y, number) in rows_by_topic if y == year)
            if not asked:
                continue
            qfile.write_text("".join(f"{number} 0 {ident} {grade}\n" for number in asked for ident, grade in qrels[number].items()))
            lines = []
            for number in asked:
                lines += [f"{number} Q0 {ident} {rank} {1_000_000 - rank} run\n" for rank, ident in enumerate(rows_by_topic[(year, number)], 1)]
            rfile.write_text("".join(lines))
            out = subprocess.run([binary, "-q", "-m", "ndcg_cut.10", "-m", "P.10", "-l", str(level), str(qfile), str(rfile)], capture_output=True, text=True, check=True).stdout
            for line in out.splitlines():
                name, topic, value = line.split()
                if topic != "all":
                    results[(year, int(topic), name)] = float(value)
    return results


# What the track itself published, read from NIST's own per-run files (2021 and 2022: the run PDFs under trec.nist.gov/pubs/trec30|31/appendices/trials/,
# "Mean NDCG@10" and "At 10 docs"; 2023: the `.ndcg` and `.treceval` files behind trec.nist.gov/pubs/trec32/appendices/trials/, averaged here over the 37 judged
# topics), parsed on 2026-11-04. All over the whole judged topic set of the year (75, 50, 37 topics), never over the ten-topic dev sets scored here.
OFFICIAL = {
    2021: {"topics": 75, "runs": 113, "top": {"run": "tdminerrun3 / tdminerrun4 (TDMiner, manual)", "ndcg10": 0.7150, "p10": 0.5707},
           "topP10": {"run": "f_t_mt5_2 (automatic)", "ndcg10": 0.7118, "p10": 0.5933}, "median": {"ndcg10": 0.3417, "p10": 0.2093}},
    2022: {"topics": 50, "runs": 41, "top": {"run": "frocchio_monot5_e (h2oloo, automatic)", "ndcg10": 0.6125, "p10": 0.5080}, "median": {"ndcg10": 0.4045, "p10": 0.2860}},
    2023: {"topics": 37, "runs": 33, "top": {"run": "gpt_weighted (patient2trial, automatic)", "ndcg10": 0.8109, "p10": 0.7351},
           "csiroUq": {"run": "GPT4 (CSIRO-UQ-ielab)", "ndcg10": 0.7363, "p10": 0.5108}, "csiroMed": {"run": "qe_prr_ft_rf (CSIROmed)", "ndcg10": 0.7378, "p10": 0.5270},
           "median": {"ndcg10": 0.6414, "p10": 0.4189},
           "sameNineDevTopics": {"top": 0.8228, "median": 0.5522, "csiroUq": 0.6554, "csiroMed": 0.7201}},
}
# Figures quoted by others before this check, and what the check found (all second-hand until confirmed here).
SECOND_HAND = {
    "2021 top nDCG@10 0.715 / P@10 0.576 (TDMiner)": "confirmed for nDCG@10 (tdminerrun3 and tdminerrun4: 0.7150); P@10 0.576 is tdminerrun4's, the track's best P@10 is 0.5933 (f_t_mt5_2)",
    "2021 top 0.84 (a survey)": "not the track's figure: no run reaches 0.84 on the 75 judged topics (the best is 0.715). A 0.84 for a TREC cohort exists in TrialGPT 2.0's figure of judged pairs only, with no retrieval, a different protocol; the survey's own source was not found",
    "2022 top nDCG@10 0.6125 / P@10 0.508 (h2oloo)": "confirmed (frocchio_monot5_e)",
    "2023 CSIRO-UQ 0.7363, CSIROmed 0.738, median 0.648": "CSIRO-UQ confirmed (GPT4 0.7363); CSIROmed 0.7378 (qe_prr_ft_rf); the median over the 33 runs is 0.6414, not 0.648; the best run is higher than both: gpt_weighted 0.8109",
}

KEYS = ["ndcg10", "p10", "j10", "recall100", "recall500", "graded100", "graded500", "recall100Ceiling", "recall500Ceiling"]


def score_retrieval(args):
    runs = dict(item.split("=", 1) for item in args.run)
    years = sorted({int(y) for y in args.years.split(",")})
    qrels = load_qrels_dir(args.qrels_dir, years)
    report = {"scope": "full official TREC collection; linear-gain nDCG; unjudged trials have zero gain; labels read only here", "arms": {}}
    check = {}
    for arm, path in runs.items():
        rows = []
        for record in jsonl(path):
            year, number = topic_key(record["topic"])
            if year not in qrels or number not in qrels[year]:
                continue
            row = {"topic": record["topic"], "year": year, "number": number, **metrics(record["retrieved"], qrels[year][number])}
            rows.append(row)
            check[(arm, year, number)] = record["retrieved"]
        report["arms"][arm] = {"summary": summarise(rows, KEYS, args.resamples, args.seed), "rows": rows}
    if args.trec_eval:
        bad = []
        for arm in runs:
            lists = {(y, n): order for (a, y, n), order in check.items() if a == arm}
            theirs = trec_eval_check(args.trec_eval, qrels, lists)
            for row in report["arms"][arm]["rows"]:
                for name, mine in (("ndcg_cut_10", row["ndcg10"]), ("P_10", row["p10"])):
                    value = theirs.get((row["year"], row["number"], name))
                    if mine is not None and (value is None or abs(value - mine) > 1e-4):
                        bad.append({"arm": arm, "topic": row["topic"], "measure": name, "mine": mine, "trec_eval": value})
        report["trecEvalCheck"] = {"binary": Path(args.trec_eval).name, "mismatches": bad, "agrees": not bad}
    return report


def score_end2end(args):
    judgments = dict(item.split("=", 1) for item in args.judgments)
    years = sorted(int(y) for y in judgments)
    qrels = load_qrels_dir(args.qrels_dir, years)
    retrieved = {record["topic"]: record["retrieved"] for record in jsonl(args.retrieved)} if args.retrieved else {}
    rows = []
    for year in years:
        for record in jsonl(judgments[str(year)]):
            y, number = topic_key(record["patientId"])
            if y != year or number not in qrels[year]:
                continue
            ranked = [entry["registryId"] for entry in record["ranking"]]
            judged_all = bool(record["ranking"]) and all(entry.get("fit") is not None for entry in record["ranking"])
            row = {"topic": record["patientId"], "year": year, "number": number, "status": record.get("status"), **metrics(ranked, qrels[year][number]),
                   "judged": sum(entry.get("fit") is not None for entry in record["ranking"]), "allJudged": judged_all}
            if record["patientId"] in retrieved:
                handed = set(ranked) | {item["registryId"] for item in record.get("failed", [])}
                baseline = [ident for ident in retrieved[record["patientId"]] if ident in handed]
                base = metrics(baseline, qrels[year][number])
                row["retrievalOrderNdcg10"], row["retrievalOrderP10"] = base["ndcg10"], base["p10"]
            usage = record.get("usage") or {}
            row["costCny"] = usage.get("costCny")
            rows.append(row)
    keys = ["ndcg10", "p10", "j10"] + (["retrievalOrderNdcg10", "retrievalOrderP10"] if retrieved else [])
    report = {"scope": "end to end: the judge's order over the candidates it was handed, against the full official qrels; unjudged trials have zero gain",
              "summary": summarise(rows, keys, args.resamples, args.seed), "rows": rows,
              "complete": {str(year): sum(row["allJudged"] for row in rows if row["year"] == year) for year in years}}
    if args.trec_eval:
        lists = {(row["year"], row["number"]): [e["registryId"] for rec in jsonl(judgments[str(row["year"])]) if rec["patientId"] == row["topic"] for e in rec["ranking"]] for row in rows}
        theirs = trec_eval_check(args.trec_eval, qrels, lists)
        bad = [{"topic": row["topic"], "measure": name, "mine": mine, "trec_eval": theirs.get((row["year"], row["number"], name))}
               for row in rows for name, mine in (("ndcg_cut_10", row["ndcg10"]), ("P_10", row["p10"]))
               if mine is not None and (theirs.get((row["year"], row["number"], name)) is None or abs(theirs[(row["year"], row["number"], name)] - mine) > 1e-4)]
        report["trecEvalCheck"] = {"binary": Path(args.trec_eval).name, "mismatches": bad, "agrees": not bad}
    return report


def fmt(item):
    return "n/a" if not item or item["mean"] is None else f"{item['mean']:.4f} [{item['low']:.4f}, {item['high']:.4f}]"


def reference_markdown(years):
    out = ["### What the track published (NIST's per-run files, whole judged topic sets; not the dev subsets above)", "",
           "| year | topics | runs | top run | nDCG@10 | P@10 | median run nDCG@10 | median run P@10 |", "|---|---|---|---|---|---|---|---|"]
    for year in sorted(set(years) & set(OFFICIAL)):
        row = OFFICIAL[year]
        out.append(f"| {year} | {row['topics']} | {row['runs']} | {row['top']['run']} | {row['top']['ndcg10']:.4f} | {row['top']['p10']:.4f} | {row['median']['ndcg10']:.4f} | {row['median']['p10']:.4f} |")
    out += ["", "Second-hand figures quoted before, as checked against those files:", ""] + [f"- {claim}: {verdict}" for claim, verdict in SECOND_HAND.items()] + [""]
    return "\n".join(out)


def markdown(report, keys):
    blocks = report["arms"].items() if "arms" in report else [("end to end", {"summary": report["summary"]})]
    out = []
    for name, part in blocks:
        summary = part["summary"]
        out += [f"### {name}", "", "| cohort | topics | " + " | ".join(keys) + " |", "|---|---|" + "---|" * len(keys)]
        for year, block in summary["byYear"].items():
            out.append(f"| {year} | {block['topics']} | " + " | ".join(fmt(block[key]) for key in keys) + " |")
        out.append(f"| pooled | {summary['topics']} | " + " | ".join(fmt(summary["pooled"][key]) for key in keys) + " |")
        out.append("| mean of cohort means | | " + " | ".join("n/a" if summary["meanOfYearMeans"][key] is None else f"{summary['meanOfYearMeans'][key]:.4f}" for key in keys) + " |")
        out.append("")
    return "\n".join(out)


def main(argv=None):
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("retrieval", "end2end"):
        p = sub.add_parser(name)
        p.add_argument("--qrels-dir", required=True)
        p.add_argument("--out", required=True)
        p.add_argument("--resamples", type=int, default=10000)
        p.add_argument("--seed", type=int, default=20261104)
        p.add_argument("--trec-eval")
        if name == "retrieval":
            p.add_argument("--run", nargs="+", required=True)
            p.add_argument("--years", default="2021,2022,2023")
        else:
            p.add_argument("--judgments", nargs="+", required=True)
            p.add_argument("--retrieved")
    args = parser.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    if args.command == "retrieval":
        report, keys = score_retrieval(args), KEYS
    else:
        report = score_end2end(args)
        keys = ["ndcg10", "p10", "j10"] + (["retrievalOrderNdcg10", "retrievalOrderP10"] if args.retrieved else [])
    (out / f"board-e-{args.command}.json").write_text(json.dumps(report, indent=2) + "\n")
    years = [int(y) for y in (args.years.split(",") if args.command == "retrieval" else [item.split("=", 1)[0] for item in args.judgments])]
    text = markdown(report, keys) + "\n" + reference_markdown(years)
    (out / f"board-e-{args.command}.md").write_text(text + "\n")
    print(text)
    if "trecEvalCheck" in report:
        print(f"trec_eval cross-check: {'agrees' if report['trecEvalCheck']['agrees'] else 'MISMATCH ' + str(report['trecEvalCheck']['mismatches'][:3])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
