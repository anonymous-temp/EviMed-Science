#!/usr/bin/env python3
"""Replay published Chinese drug-evaluation references against platform gates."""

import argparse
import importlib.util
import json
import pathlib
from datetime import datetime, timezone


ROOT = pathlib.Path(__file__).resolve().parents[2]
EVAL_DIR = pathlib.Path(__file__).resolve().parent
CASES_FILE = EVAL_DIR / "benchmark_cases.json"
COMPILER_FILE = ROOT / "runtime/mcp/evimed-research/drug_assessment.py"
OFF_LABEL_SKILL = ROOT / "runtime/skills/evimed/off-label-analysis/SKILL.md"
COMPREHENSIVE_SKILL = ROOT / "runtime/skills/evimed/comprehensive-drug-evaluation/SKILL.md"


def load_compiler():
    spec = importlib.util.spec_from_file_location("evimed_drug_quality_benchmark", COMPILER_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check(checks, check_id, passed, message, details=None, level="error"):
    status = "pass" if passed else "warning" if level == "warning" else "fail"
    checks.append({
        "id": check_id,
        "status": status,
        "message": message,
        **({"details": details} if details is not None else {}),
    })


def is_valid_date(value):
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def build_selection_rows(selection):
    rows = []
    for candidate, scores in selection["candidateScores"].items():
        for domain, value in scores.items():
            rows.append({
                "candidate": candidate,
                "domain": domain,
                "status": "favorable",
                "evidenceIds": ["jak-selection-paper"],
                "rationale": "Published Table 9 value replayed without reinterpretation.",
                "score": value,
                "scaleMin": 0,
                "scaleMax": selection["domains"][domain],
                "direction": "higher_is_better",
                "weight": selection["domains"][domain],
                "scoreOrigin": "institutional_rubric",
                "ruleVersion": selection["policyVersion"],
            })
    return rows


def run_benchmark(cases=None):
    compiler = load_compiler()
    cases = cases or json.loads(CASES_FILE.read_text(encoding="utf-8"))
    checks = []

    selection = cases["selectionCase"]
    domains = selection["domains"]
    candidates = selection["candidateScores"]
    missing_items = [
        "%s/%s" % (candidate, domain)
        for candidate, scores in candidates.items()
        for domain in domains
        if domain not in scores
    ]
    check(
        checks,
        "selection-item-coverage",
        not missing_items,
        "Every published candidate-domain score is represented.",
        {"expectedItems": len(candidates) * len(domains), "missingItems": missing_items},
    )

    computed_totals = {
        candidate: round(sum(scores.values()), 2)
        for candidate, scores in candidates.items()
    }
    total_deltas = {
        candidate: round(computed_totals[candidate] - reported, 8)
        for candidate, reported in selection["reportedTotals"].items()
    }
    check(
        checks,
        "selection-arithmetic",
        all(abs(delta) < 1e-8 for delta in total_deltas.values()),
        "Published domain scores reproduce every reported total.",
        {"computedTotals": computed_totals, "deltas": total_deltas},
    )

    computed_order = sorted(computed_totals, key=lambda candidate: (-computed_totals[candidate], candidate))
    check(
        checks,
        "selection-reference-order",
        computed_order == selection["reportedOrder"],
        "The controlled replay reproduces the article's reported order.",
        {"computedOrder": computed_order, "reportedOrder": selection["reportedOrder"]},
    )

    guarded_result = compiler.compile_assessment("evimed_drug_selection_evaluation", {
        "candidateDrugs": list(candidates),
        "indication": "atopic dermatitis",
        "selectionDomains": list(domains),
        "sourceInventory": [{
            "id": "jak-selection-paper",
            "title": "Published JAK inhibitor selection table",
            "url": next(item["url"] for item in cases["references"] if item["id"] == selection["referenceId"]),
            "source": "published-reference",
            "retrievedAt": "2026-07-20T00:00:00Z",
        }],
        "domainAssessments": build_selection_rows(selection),
    })
    guard_reasons = guarded_result["data"]["rankingWithheldReasons"]
    check(
        checks,
        "selection-live-context-guard",
        guarded_result["data"]["ranking"] is None and any("Economics is not comparable" in reason for reason in guard_reasons),
        "The platform reproduces published arithmetic but withholds a live ranking when economic context is incomplete.",
        {"withheldReasons": guard_reasons},
    )

    cutoff = selection["reportedSearchCutoff"]
    check(
        checks,
        "reference-search-cutoff-validity",
        is_valid_date(cutoff),
        "The reference reports an invalid calendar cutoff; the platform must not copy it as a valid evidence date.",
        {"reportedSearchCutoff": cutoff},
        level="warning",
    )
    check(
        checks,
        "reference-price-date",
        selection["priceDateReported"],
        "The extracted reference does not report a reproducible price date, so its economic score is context-bound.",
        level="warning",
    )

    cross_scores = selection["crossPublicationScores"]
    drift = {
        candidate: round(cross_scores[candidate] - selection["reportedTotals"][candidate], 2)
        for candidate in ("upadacitinib", "abrocitinib")
    }
    check(
        checks,
        "cross-publication-score-drift",
        not any(abs(value) > 0 for value in drift.values()),
        "The same medicines scored under related published methods produce different totals; one article cannot be a universal gold score.",
        {"scoreDeltas": drift, "comparisonReferenceId": cross_scores["referenceId"]},
        level="warning",
    )

    comprehensive = cases["comprehensiveCase"]
    mapped_domains = set(comprehensive["sourceToPlatformDomain"].values())
    unsupported_domains = sorted(mapped_domains - set(compiler.COMPREHENSIVE_DOMAINS))
    missing_core = sorted({"effectiveness", "safety", "applicability"} - mapped_domains)
    check(
        checks,
        "comprehensive-domain-coverage",
        not unsupported_domains and not missing_core,
        "The platform represents all six published comprehensive-evaluation dimensions and all mandatory core domains.",
        {"mappedDomains": sorted(mapped_domains), "unsupportedDomains": unsupported_domains, "missingCoreDomains": missing_core},
    )

    off_label = cases["offLabelCase"]
    missing_label_dimensions = sorted(set(off_label["labelDimensions"]) - set(compiler.LABEL_DIMENSIONS))
    missing_evidence_types = sorted(set(off_label["evidenceTypes"]) - set(compiler.OFF_LABEL_EVIDENCE_TYPES))
    missing_quality_tools = sorted(set(off_label["qualityAppraisalTools"]) - set(compiler.QUALITY_APPRAISAL_TOOLS))
    check(
        checks,
        "off-label-method-coverage",
        not missing_label_dimensions and not missing_evidence_types and not missing_quality_tools,
        "The off-label compiler covers the standard's label dimensions, evidence types, and named appraisal methods.",
        {
            "missingLabelDimensions": missing_label_dimensions,
            "missingEvidenceTypes": missing_evidence_types,
            "missingQualityTools": missing_quality_tools,
        },
    )

    off_label_skill = OFF_LABEL_SKILL.read_text(encoding="utf-8")
    comprehensive_skill = COMPREHENSIVE_SKILL.read_text(encoding="utf-8")
    skill_controls = {
        "offLabelEvidenceRows": "evidenceSupportAssessments" in off_label_skill,
        "licensedGapPrompt": "Micromedex" in off_label_skill and "user-provided" in off_label_skill,
        "missingIsNotZero": "missing evidence is never zero" in comprehensive_skill.lower(),
        "optionalQuantitativeScoring": "quantitativeScoringRequested" in comprehensive_skill,
    }
    check(
        checks,
        "agent-integration-controls",
        all(skill_controls.values()),
        "The Agent instructions route benchmark safeguards into runtime behavior.",
        skill_controls,
    )

    check(
        checks,
        "licensed-source-boundary",
        False,
        "Licensed evidence databases remain an explicit user-supplied or institution-supplied evidence gap.",
        {"gaps": off_label["licensedSourceGaps"]},
        level="warning",
    )

    summary = {
        "passed": sum(item["status"] == "pass" for item in checks),
        "failed": sum(item["status"] == "fail" for item in checks),
        "warnings": sum(item["status"] == "warning" for item in checks),
    }
    return {
        "schemaVersion": "1.0.0",
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": "pass" if summary["failed"] == 0 else "fail",
        "summary": summary,
        "referenceCount": len(cases["references"]),
        "checks": checks,
        "interpretation": "Passing means item-level compatibility and safety gates are reproducible. Warnings identify publication or access limitations and are not converted into zero scores.",
    }


def render_report(result):
    lines = [
        "# Drug Evidence Quality Benchmark",
        "",
        "Status: **%s**  " % result["status"].upper(),
        "Checks: %d passed, %d failed, %d warnings  " % (
            result["summary"]["passed"],
            result["summary"]["failed"],
            result["summary"]["warnings"],
        ),
        "References: %d" % result["referenceCount"],
        "",
        "| Check | Status | Result |",
        "|---|---|---|",
    ]
    for item in result["checks"]:
        lines.append("| %s | %s | %s |" % (
            item["id"],
            item["status"].upper(),
            item["message"].replace("|", "\\|"),
        ))
    lines.extend(["", result["interpretation"], ""])
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=pathlib.Path, default=EVAL_DIR / "results")
    parser.add_argument("--check", action="store_true", help="Run without writing result artifacts.")
    args = parser.parse_args()
    result = run_benchmark()
    if not args.check:
        args.output_dir.mkdir(parents=True, exist_ok=True)
        (args.output_dir / "latest-results.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (args.output_dir / "latest-report.md").write_text(render_report(result), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["status"] == "pass" else 1)


if __name__ == "__main__":
    main()
