#!/usr/bin/env python3
"""Generalization baseline harness for MetaAgent.

Purpose: measure the *real* water level of the pipeline on topics it has never
been hand-tuned for, and turn that into a repeatable regression gate. The two
existing benchmark topics (COVID corticosteroids, SGLT2 HFpEF) have dedicated
hardcoded rendering paths in ``writing_agent.py`` and a forced known-source
anchor; their quality is therefore NOT evidence that an arbitrary new topic
will come out publishable. This harness runs unseen topics end to end and
scores every draft with the deterministic, no-LLM scorer in
``new_meta.core.draft_quality_audit``.

Two modes
---------
1. Audit existing drafts (no LLM, no network) — verify the scorer and snapshot
   the current "seen" benchmarks::

       python scripts/generalization_baseline.py audit \
           output/benchmark_runs/20260530_en_covid_quality_gate_v2 \
           output/benchmark_runs/20260527_en_sglt2_hfpef_no_polish_final_candidate

2. Run unseen topics live, then score them (needs LLM_API_KEY + network)::

       python scripts/generalization_baseline.py run \
           --topics docs/benchmarks/generalization_topics.json \
           --out output/generalization_runs

   Each topic is run with manuscript polish OFF (MANUSCRIPT_POLISH_ENABLED=0) and
   without user-supplied PDFs, so it exercises the fully automated path.

Both modes print a comparison table and write a Markdown report.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from new_meta.core.draft_quality_audit import audit_project_dir  # noqa: E402


# ─────────────────────────── reporting ───────────────────────────

_COLUMNS = [
    ("label", "Topic", 30),
    ("score", "Score", 6),
    ("gate", "Gate", 13),
    ("report_type", "Type", 12),
    ("main_word_count", "Words", 6),
    ("reference_entries", "Refs", 5),
    ("unused_references", "Unused", 7),
    ("dangling_citations", "Dangle", 7),
    ("exact_duplicate_sentences", "ExDup", 6),
    ("near_duplicate_sentences", "NrDup", 6),
    ("fact_mismatches", "FactX", 6),
    ("hard_errors", "HardE", 6),
]


def _row_values(label: str, result: dict) -> dict:
    summary = result.get("summary", {})
    score = result.get("score", "ERR")
    return {
        "label": label[:30],
        "score": "n/a" if score is None else score,
        "gate": result.get("gate", "error"),
        "report_type": summary.get("report_type", "-"),
        **{k: summary.get(k, "-") for k in (
            "main_word_count", "reference_entries", "unused_references",
            "dangling_citations", "exact_duplicate_sentences",
            "near_duplicate_sentences", "fact_mismatches", "hard_errors",
        )},
    }


def _print_table(rows: list[dict]) -> None:
    header = "  ".join(f"{title:<{width}}" for _, title, width in _COLUMNS)
    print(header)
    print("-" * len(header))
    for row in rows:
        print("  ".join(f"{str(row.get(key, '-')):<{width}}" for key, _, width in _COLUMNS))


def _markdown_report(rows: list[dict], findings: list[dict]) -> str:
    lines = ["# MetaAgent generalization baseline report", ""]
    head = "| " + " | ".join(title for _, title, _ in _COLUMNS) + " |"
    sep = "|" + "|".join("---" for _ in _COLUMNS) + "|"
    lines += [head, sep]
    for row in rows:
        lines.append("| " + " | ".join(str(row.get(key, "-")) for key, _, _ in _COLUMNS) + " |")
    lines.append("")
    lines.append("## Top defects per draft")
    lines.append("")
    for finding in findings:
        lines.append(f"### {finding['label']}  (score {finding['score']}, gate {finding['gate']})")
        if finding["dups"]:
            lines.append("- Duplicate/near-duplicate sentences:")
            for dup in finding["dups"][:5]:
                lines.append(f"  - [{dup['type']} r={dup['ratio']}] {dup['a'][:120]}")
        if finding["errors"]:
            lines.append("- Hard errors:")
            for err in finding["errors"][:5]:
                lines.append(f"  - {err.get('code')}: {err.get('message')}")
        if finding["fact"]:
            lines.append("- Fact mismatches (prose vs facts):")
            for mismatch in finding["fact"][:5]:
                lines.append(f"  - {mismatch['field']}: prose={mismatch['prose']} facts={mismatch['facts']}")
        if not (finding["dups"] or finding["errors"] or finding["fact"]):
            lines.append("- No blocking defects detected by the deterministic scorer.")
        lines.append("")
    return "\n".join(lines)


def _collect(label: str, project_dir: str) -> tuple[dict, dict]:
    result = audit_project_dir(project_dir)
    if "error" in result:
        result = {"score": "ERR", "gate": "error", "summary": {}, "_error": result["error"]}
    row = _row_values(label, result)
    finding = {
        "label": label,
        "score": result.get("score"),
        "gate": result.get("gate"),
        "dups": result.get("duplicate_sentences", []),
        "errors": [i for i in result.get("quality_gate_issues", []) if i.get("severity") == "error"],
        "fact": result.get("fact_consistency", {}).get("mismatches", []),
    }
    return row, finding


def _emit(rows: list[dict], findings: list[dict], report_path: Path | None) -> None:
    print()
    _print_table(rows)
    print()
    if report_path:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(_markdown_report(rows, findings), encoding="utf-8")
        print(f"Report written: {report_path}")


# ─────────────────────────── audit mode ───────────────────────────

def cmd_audit(args: argparse.Namespace) -> int:
    rows, findings = [], []
    for project_dir in args.dirs:
        label = Path(project_dir).name
        row, finding = _collect(label, project_dir)
        rows.append(row)
        findings.append(finding)
    _emit(rows, findings, Path(args.report) if args.report else None)
    return 0


# ─────────────────────────── run mode ───────────────────────────

def _newest_run_dir(out_dir: Path) -> Path | None:
    candidates = sorted(out_dir.glob("*/manuscript/draft.md"), key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0].parent.parent if candidates else None


def _run_one_topic(topic: str, topic_out: Path, model: str | None, max_papers: int | None, timeout: int) -> tuple[bool, str]:
    topic_out.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-m", "new_meta.main", "--topic", topic, "--skip-confirm",
           "--output-dir", str(topic_out)]
    if model:
        cmd += ["--model", model]
    if max_papers:
        cmd += ["--max-papers", str(max_papers)]
    env = dict(os.environ)
    env["MANUSCRIPT_POLISH_ENABLED"] = "0"  # isolate the raw engine, matching no-polish benchmarks
    log_path = topic_out / "run.log"
    try:
        with log_path.open("w", encoding="utf-8") as log:
            proc = subprocess.run(cmd, cwd=str(REPO_ROOT), env=env, stdout=log,
                                  stderr=subprocess.STDOUT, timeout=timeout, check=False)
        return proc.returncode == 0, str(log_path)
    except subprocess.TimeoutExpired:
        return False, f"timeout after {timeout}s (see {log_path})"


def cmd_run(args: argparse.Namespace) -> int:
    topics = json.loads(Path(args.topics).read_text(encoding="utf-8"))
    if isinstance(topics, dict):
        topics = topics.get("topics", [])
    out_root = Path(args.out)
    rows, findings = [], []
    for entry in topics:
        topic_id = entry.get("id") or entry["topic"][:40]
        topic = entry["topic"]
        print(f"\n=== Running [{topic_id}] {topic[:80]} ===")
        topic_out = out_root / topic_id
        ok, info = _run_one_topic(topic, topic_out, args.model, args.max_papers, args.timeout)
        if not ok:
            print(f"  pipeline did not complete: {info}")
        run_dir = _newest_run_dir(topic_out)
        if run_dir is None:
            rows.append({"label": topic_id[:30], "score": "NO-DRAFT", "gate": "error"})
            findings.append({"label": topic_id, "score": "NO-DRAFT", "gate": "error",
                             "dups": [], "errors": [{"code": "no_draft", "message": info}], "fact": []})
            continue
        row, finding = _collect(topic_id, str(run_dir))
        rows.append(row)
        findings.append(finding)
        print(f"  draft: {run_dir}/manuscript/draft.md  score={row.get('score')} gate={row.get('gate')}")
    report = Path(args.report) if args.report else out_root / "generalization_report.md"
    _emit(rows, findings, report)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="MetaAgent generalization baseline harness")
    sub = parser.add_subparsers(dest="command", required=True)

    audit = sub.add_parser("audit", help="Audit existing draft directories (no LLM/network)")
    audit.add_argument("dirs", nargs="+", help="Output run directories containing manuscript/draft.md")
    audit.add_argument("--report", default=None, help="Write a Markdown report to this path")
    audit.set_defaults(func=cmd_audit)

    run = sub.add_parser("run", help="Run unseen topics live, then score (needs LLM_API_KEY)")
    run.add_argument("--topics", required=True, help="JSON file with topics to run")
    run.add_argument("--out", default="output/generalization_runs", help="Output root")
    run.add_argument("--model", default=None, help="Override LLM model")
    run.add_argument("--max-papers", type=int, default=None, help="Override max search results")
    run.add_argument("--timeout", type=int, default=3600, help="Per-topic timeout in seconds")
    run.add_argument("--report", default=None, help="Write a Markdown report to this path")
    run.set_defaults(func=cmd_run)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
