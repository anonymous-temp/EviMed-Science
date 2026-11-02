#!/usr/bin/env python3
"""Audit baseline result folders for grading material: keys, file names, and verbatim overlap between what the editors would read and the gold.

Reads gold on the dev box (the baseline items' references and rubrics) only to measure overlap with the rendered trajectories and deliverables; it
prints counts, never gold text. A non-zero overlap is not proof of a leak (a run may legitimately retrieve a public page that quotes the
reference), so it is reported for a human to look at; a grading KEY or FILE in a result folder is a finding.

  tools/audit_results.py [--bench-root DIR]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from evimed_h2 import config, trajectory as T  # noqa: E402
from evimed_h2.guard import squash  # noqa: E402

WINDOW = 60
GRADING_KEYS = ("gold", "rubric", "criteria", "checklist", "ideal", "scorer", "score", "verdict", "passed")


def shingles(text: str) -> set[int]:
    squashed, _ = squash(text)
    return {hash(squashed[i:i + WINDOW]) for i in range(0, max(0, len(squashed) - WINDOW + 1))}


def overlap(gold_text: str, seen_text: str) -> int:
    return len(shingles(gold_text) & shingles(seen_text))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bench-root", default=str(config.BENCH_ROOT))
    root = Path(parser.parse_args().bench_root)
    findings = 0
    per_family = {}
    for folder in sorted((root / "results").iterdir()):
        if not folder.is_dir():
            continue
        runs = [p for p in folder.iterdir() if (p / "result.json").is_file()]
        keys, files = set(), set()
        for run in runs:
            result = T.result_of(run)
            keys |= {k for k in result if any(g in k.lower() for g in GRADING_KEYS)}
            files |= {p.name for p in run.iterdir() if any(g in p.name.lower() for g in ("score", "gold", "rubric", "judge", "criteria"))}
        per_family[folder.name] = (len(runs), sorted(keys), sorted(files))
        findings += bool(keys or files)
    for name, (n, keys, files) in per_family.items():
        print(f"{name:22} runs {n:>4}  grading-like keys {keys or '-'}  grading-like files {files or '-'}")

    # verbatim overlap with the references and rubrics that exist on this box
    for name, reader in (("v1-drb", lambda d: Path(root / "data/drb/reference" / f"{d}.md")),):
        folder = root / "results" / name
        if not folder.is_dir():
            continue
        total = hits = 0
        for run in sorted(folder.iterdir()):
            rid = run.name.split("__")[-1]
            ref = reader(rid)
            if not (run / "result.json").is_file() or not ref.is_file():
                continue
            seen = T.render_trajectory(run) + "\n" + T.deliverable_text(run)
            n = overlap(ref.read_text(encoding="utf-8"), seen)
            total += 1
            hits += n > 0
            if n:
                print(f"  {name}/{run.name}: {n} reference shingles of {WINDOW} characters also appear in what the editors would read")
        print(f"{name}: {hits}/{total} runs share at least one {WINDOW}-character stretch with the reference article")
    folder = root / "results" / "v1-rcb"
    if folder.is_dir():
        total = hits = 0
        for run in sorted(folder.iterdir()):
            task = run.name.split("__")[-1]
            checklist = root / "data/rcb_judge" / task / "checklist.json"
            if not (run / "result.json").is_file() or not checklist.is_file():
                continue
            text = " ".join(str(c.get("content", "")) for c in json.loads(checklist.read_text(encoding="utf-8")))
            seen = T.render_trajectory(run) + "\n" + T.deliverable_text(run)
            n = overlap(text, seen)
            total += 1
            hits += n > 0
            if n:
                print(f"  v1-rcb/{run.name}: {n} rubric shingles also appear")
        print(f"v1-rcb: {hits}/{total} runs share a {WINDOW}-character stretch with the rubric text")
    print("findings:", findings)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
