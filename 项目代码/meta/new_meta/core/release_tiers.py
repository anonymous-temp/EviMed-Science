"""Which release checks may block a package: the single tier table.

The platform's rule (2026-09-17) is that a verdict never withholds a delivery:
every package is delivered, and ``blocked`` only says that a check protecting
the reader failed - the package cannot be read as a finished review, or it
carries a defect its reader cannot see for themselves. Blocking points are a
budget (principle 4): a check not named in ``BLOCKING_GATES`` is advisory. An
advisory check that fails keeps its detail and locations, reads ``warn`` and
never sets ``blocked``; its own verdict stays in ``check_status`` so its
distribution can be measured before anyone proposes promoting it.

Measured on 27 real packages (2026-07-18 .. 2026-09-29; production ma-001
included), before this table: 26 blocked, 0 ready. The failures that blocked
them, and why each is advisory now:

- language/style heuristics over prose - ``manuscript_language`` (15: Chinese
  text with English study names and statistics reads "mixed"),
  ``readability`` (7; 6 were a single overlong sentence), ``publication_tone``,
  ``abstract_polish``, ``clinical_interpretation``, ``declarations`` - a
  reader sees the prose, and a regex never decides language (principles 1, 5);
- bookkeeping - ``project_submission_quality_gate`` (16: claim-map/citation-
  contract rows, a CI smoke manifest), ``compiled_method_release`` (ledger,
  analysis-set and certainty revisions; its integrity and numeric parts are
  ``calculation_audit`` and ``primary_result``), ``primary_source_trace``;
- completeness a reader can see - ``risk_of_bias_completeness`` (7),
  ``evidence_readiness`` (12, fires on legitimate evidence-gap reports),
  ``primary_source_context`` (10, "0/0 cards" on evidence-gap reports),
  figures, legends, footnotes, cross-references, PRISMA prose, length;
- ``claim_support`` (1 fire, a false positive: per-study risk ratios read as
  the pooled claim by the sentence-context regex).

The blocking set below never fired on a real manuscript except the 2026-09-28
validation stub, which had no reference list.
"""
from __future__ import annotations

from typing import Any

BLOCKING = "blocking"
ADVISORY = "advisory"

#: The only gates whose failure makes a package ``blocked``, each with what a
#: reader could not see. Every other gate id is advisory.
BLOCKING_GATES: dict[str, str] = {
    "calculation_audit": (
        "a pooled number rests on study inputs that are missing, are not the pooled rows, "
        "or were not verified against their source"
    ),
    "primary_result": "the manuscript does not state the pooled result the engine computed",
    "reference_resolution": (
        "a citation number in the text has no entry in the reference list, "
        "or a pooled review has no reference list"
    ),
}

#: Decision-level blocker: no manuscript was written, so nothing can be read.
NO_MANUSCRIPT_CODE = "missing_submission_readiness_review"


def gate_tier(gate_id: str) -> str:
    return BLOCKING if str(gate_id or "") in BLOCKING_GATES else ADVISORY


def apply_release_tiers(readiness: dict[str, Any] | None) -> dict[str, Any] | None:
    """Stamp every gate with its tier and derive the readiness status from them.

    Idempotent: ``check_status`` keeps the check's own verdict, so applying the
    table twice (the readiness builder, then the release decision) changes
    nothing, and a readiness review saved before this table is re-tiered. A
    blocking check that could not run because there is no manuscript text
    blocks: there is nothing for the reader to read.
    """
    if not isinstance(readiness, dict):
        return readiness
    gates = [gate for gate in (readiness.get("gates") or []) if isinstance(gate, dict)]
    for gate in gates:
        check_status = str(gate.get("check_status") or gate.get("status") or "").strip().lower()
        tier = gate_tier(str(gate.get("id") or gate.get("name") or ""))
        gate["tier"] = tier
        gate["check_status"] = check_status
        if tier == BLOCKING:
            status = "fail" if check_status in {"fail", "not_evaluated"} else check_status
        else:
            status = "warn" if check_status == "fail" else check_status
        gate["status"] = status
        gate["passed"] = status not in {"fail", "not_evaluated"}
    failed = sum(1 for gate in gates if gate["status"] == "fail")
    warnings = sum(1 for gate in gates if gate["status"] == "warn")
    readiness["passed"] = failed == 0
    readiness["status"] = "blocked" if failed else "ready_with_warnings" if warnings else "ready"
    readiness["summary"] = {
        **(readiness.get("summary") if isinstance(readiness.get("summary"), dict) else {}),
        "total_gates": len(gates),
        "passed_gates": sum(1 for gate in gates if gate["status"] == "pass"),
        "warning_gates": warnings,
        "failed_gates": failed,
        "advisory_failed_checks": sum(
            1 for gate in gates if gate["tier"] == ADVISORY and gate["check_status"] == "fail"
        ),
    }
    return readiness
