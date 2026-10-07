"""Import preserved probes with their actual label provenance; never import keys."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def write(site, cases):
    directory = ROOT / "evals" / "judge-sites" / site
    directory.mkdir(exist_ok=True)
    (directory / "cases.json").write_text(json.dumps({
        "schemaVersion": 1, "site": site, "cases": cases,
    }, ensure_ascii=False, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--probe-root", type=Path, required=True)
    args = parser.parse_args()
    read = lambda name: json.loads((args.probe_root / name).read_text())
    cases = []
    for row in read("corpora/channel-intent.json"):
        expected = row["expected"]
        projects = row["projects"]
        # Exercise the production-size list without changing the labelled task.
        projects = projects + [{"id": f"control-{i}", "name": f"生物材料对照研究 {i}"}
                               for i in range(51 - len(projects))]
        cases.append({"id": row["id"], "source": "2026-09-21-curated-channel-intent",
                      "labelBasis": "curated", "group": row["id"],
                      "input": {"message": row["message"], "projects": projects,
                                "currentProjectId": row["currentProjectId"],
                                "currentTask": (row.get("runningTask") or {}).get("question")},
                      "expected": {"switch_to": expected["switchTo"], "has_request": expected["hasRequest"],
                                   "continues_running_task": expected["continuesRunningTask"]}})
    write("J2", cases)
    cases = [{"id": f"routing-{i+1}", "source": "2026-09-21-routing-regressions",
              "labelBasis": "curated", "input": {"question": row["query"]},
              "expected": {"agentId": row["expected"]}, "tag": row["tag"]}
             for i, row in enumerate(read("routing-jev.json")["rows"])]
    corpus = json.loads((ROOT / "evals/title-to-paper/corpus-v3/manifest.json").read_text())
    cases += [{"id": row["caseId"], "source": "title-to-paper/corpus-v3",
               "labelBasis": "owner-specified-routing", "input": {"question": row["prompt"]},
               "expected": {"agentId": "none"}, "tag": "title-to-paper"} for row in corpus["cases"]]
    write("J3", cases)
    write("J4", [{"id": f"register-{i+1}", "source": "2026-09-21-preserved-report-lines",
                  "labelBasis": "curated-injection" if row["planted"] else "preserved-report",
                  "group": row.get("file", f"injection-{i}"), "input": {"line": row["text"]},
                  "expected": {"leakage": row["planted"]}}
                 for i, row in enumerate(read("backstage.json")["rows"])])
    pairs = read("corpora/method-pairs.json")["pairs"]
    write("J1", [{"id": f"method-batch-{i//40}", "source": "2026-09-21-curated-method-pairs",
                  "labelBasis": "curated", "input": {"pairs": [
                      {"id": row["id"], "left": row["a"], "right": row["b"]} for row in pairs[i:i+40]]},
                  "expected": {"pairs": [{"id": row["id"], "relation": "related" if row["related"] else "unrelated"}
                                          for row in pairs[i:i+40]]}}
                 for i in range(0, len(pairs), 40)])
    traits = read("corpora/gwas-select.json")["traits"]
    pool = {c["id"]: c for trait in traits for c in trait["candidates"]}
    write("J9", [{"id": f"gwas-{i}", "source": "2026-09-21-curated-gwas-catalogue",
                  "labelBasis": "curated-approximate-catalogue", "releaseEligible": False,
                  "input": {"trait": row["trait"], "candidates": (row["candidates"] + [
                      c for c in pool.values() if c["id"] not in {v["id"] for v in row["candidates"]}])[:50]},
                  "acceptableIds": row["acceptable"]} for i, row in enumerate(traits)])


if __name__ == "__main__":
    main()
