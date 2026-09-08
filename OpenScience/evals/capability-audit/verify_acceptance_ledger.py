#!/usr/bin/env python3
"""Keep the per-capability acceptance ledger honest against the tree.

There was no per-capability record of which capabilities have ever produced a
real, accepted delivery: the hosted e2e drives one of them, everything else was
scattered across PROGRESS.md prose, STATUS lines and `evals/*/results`
directories. `evals/acceptance-ledger.json` is that record.

This check verifies the ledger is **complete and consistent**, never that a
capability is accepted. Acceptance is what the ledger reports; a capability with
no delivery on record is supposed to read "not-run", and today most of them do.
The blocking half is entirely deterministic — a directory exists or it does not,
a brief file holds N briefs or it does not, an evidence path resolves or it does
not. The coverage number is printed as a notice and never blocks, because
"three of fifteen public capabilities have an accepted delivery" is a fact to
watch, not a rule to enforce.

Run directly, or through `verify_release_audit.py`.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]

LEDGER_RELATIVE = Path("evals") / "acceptance-ledger.json"
# Every capability directory is expected to carry a ledger row. The floor is the
# walk assertion: a scan that stopped reading the tree would otherwise agree
# with a ledger that had also stopped listing capabilities, and both would pass.
MINIMUM_CAPABILITIES = 16

DELIVERY_STATUSES = ("accepted", "failed", "not-run")
DELIVERY_SURFACES = ("native-ui", "http-api", "harness")
VISIBILITIES = ("public", "internal")
EVIDENCED_STATUSES = ("accepted", "failed")

# Format checks over closed vocabularies, not language: a manifest field, a log
# timestamp, a repository-relative path.
VISIBILITY_LINE = re.compile(r"^visibility:\s*(\S+)\s*$")
PROGRESS_PREFIX = "PROGRESS.md@"
PROGRESS_STAMP = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")


def load_ledger(repo_root=REPO):
    return json.loads((Path(repo_root) / LEDGER_RELATIVE).read_text(encoding="utf-8"))


def discover_capabilities(capabilities_root):
    """Return the capability ids on disk — a directory holding a manifest."""
    root = Path(capabilities_root)
    if not root.is_dir():
        return []
    return sorted(
        directory.name
        for directory in root.iterdir()
        if directory.is_dir() and (directory / "capability.yaml").is_file()
    )


def manifest_visibility(capability_dir):
    """Read `visibility` out of a capability manifest; absent means public."""
    manifest = Path(capability_dir) / "capability.yaml"
    if not manifest.is_file():
        return None
    for line in manifest.read_text(encoding="utf-8").splitlines():
        match = VISIBILITY_LINE.match(line)
        if match:
            return match.group(1)
    return "public"


def briefs_on_disk(harness_dir):
    """Count the briefs a harness actually ships, or explain why it cannot.

    A harness without `briefs.json` holds zero briefs. That is the honest
    answer, and it is the signal this ledger exists to surface: several
    capabilities are covered by a smoke or a benchmark-case harness and have
    never had the three real briefs a capability package is supposed to carry.
    """
    brief_file = Path(harness_dir) / "briefs.json"
    if not brief_file.is_file():
        return 0, None
    try:
        document = json.loads(brief_file.read_text(encoding="utf-8"))
    except ValueError as error:
        return None, "is not readable JSON (%s)" % error
    if not isinstance(document, dict) or not isinstance(document.get("briefs"), list):
        return None, "does not carry a briefs list"
    return len(document["briefs"]), None


def _resolve_reference(reference, repo_root, progress_file):
    """Return why a ledger reference does not resolve, or None when it does.

    Two forms, both decidable: a repository-relative path that must exist, and
    `PROGRESS.md@YYYY-MM-DD HH:MM`, which must name a log entry that is there.
    Line numbers are deliberately not a form — PROGRESS.md is written newest
    first, so every new milestone would invalidate every anchor below it.
    """
    if not isinstance(reference, str) or not reference.strip():
        return "is not a non-empty string"
    if reference.startswith(PROGRESS_PREFIX):
        stamp = reference[len(PROGRESS_PREFIX):]
        if not PROGRESS_STAMP.match(stamp):
            return "does not carry a YYYY-MM-DD HH:MM PROGRESS.md stamp"
        if not progress_file.is_file():
            return "cannot be checked because PROGRESS.md is missing"
        for line in progress_file.read_text(encoding="utf-8").splitlines():
            if line.startswith(stamp + " ·"):
                return None
        return "names a PROGRESS.md entry that is not there"
    root = Path(repo_root).resolve()
    target = (root / reference).resolve()
    if not target.is_relative_to(root):
        return "points outside the repository"
    if not target.exists():
        return "points at a path that does not exist"
    return None


def _check_delivery(identifier, delivery, repo_root, progress_file, issues):
    if not isinstance(delivery, dict):
        issues.append("%s has no realDelivery record" % identifier)
        return
    status = delivery.get("status")
    evidence = delivery.get("evidence")
    at = delivery.get("at")
    surface = delivery.get("surface")
    if status not in DELIVERY_STATUSES:
        issues.append(
            "%s records realDelivery status %r, which is not one of %s"
            % (identifier, status, ", ".join(DELIVERY_STATUSES))
        )
        return
    if status == "not-run":
        if evidence is not None or at is not None or surface is not None:
            issues.append(
                "%s records realDelivery not-run but still names evidence, an instant or a surface"
                % identifier
            )
        return
    if evidence is None:
        issues.append("%s claims realDelivery %s with no evidence" % (identifier, status))
    else:
        problem = _resolve_reference(evidence, repo_root, progress_file)
        if problem:
            issues.append("%s realDelivery evidence %s" % (identifier, problem))
    if at is None:
        issues.append("%s claims realDelivery %s with no instant" % (identifier, status))
    else:
        try:
            datetime.fromisoformat(str(at).replace("Z", "+00:00"))
        except ValueError:
            issues.append("%s realDelivery at %r is not an ISO 8601 instant" % (identifier, at))
        else:
            if isinstance(evidence, str) and evidence.startswith(PROGRESS_PREFIX):
                stamp = evidence[len(PROGRESS_PREFIX):]
                if str(at).replace("T", " ")[:16] != stamp:
                    issues.append(
                        "%s realDelivery at %s disagrees with its PROGRESS.md stamp %s"
                        % (identifier, at, stamp)
                    )
    if surface not in DELIVERY_SURFACES:
        issues.append(
            "%s records realDelivery surface %r, which is not one of %s"
            % (identifier, surface, ", ".join(DELIVERY_SURFACES))
        )


def ledger_issues(repo_root=REPO, minimum_capabilities=MINIMUM_CAPABILITIES):
    """Return every way the ledger disagrees with the tree, most specific first.

    A verdict is a return value: each issue names the row and what to change.
    """
    root = Path(repo_root)
    ledger_file = root / LEDGER_RELATIVE
    capabilities_root = root / "capabilities"
    progress_file = root / "PROGRESS.md"
    issues = []

    if not ledger_file.is_file():
        return ["acceptance ledger %s is missing" % LEDGER_RELATIVE.as_posix()]
    try:
        document = json.loads(ledger_file.read_text(encoding="utf-8"))
    except ValueError as error:
        return ["acceptance ledger is not readable JSON (%s)" % error]
    if not isinstance(document, dict) or not isinstance(document.get("capabilities"), list):
        return ["acceptance ledger does not carry a capabilities list"]
    if document.get("schemaVersion") != 1:
        issues.append("acceptance ledger schemaVersion is not 1")

    discovered = discover_capabilities(capabilities_root)
    if len(discovered) < minimum_capabilities:
        issues.append(
            "capability scan found %d capability directories, fewer than the %d expected; "
            "it is not reading the tree" % (len(discovered), minimum_capabilities)
        )

    seen = []
    for index, row in enumerate(document["capabilities"]):
        if not isinstance(row, dict):
            issues.append("acceptance ledger row %d is not an object" % index)
            continue
        identifier = row.get("id")
        if not isinstance(identifier, str) or not identifier:
            issues.append("acceptance ledger row %d has no id" % index)
            continue
        if identifier in seen:
            issues.append("ledger lists capability %s more than once" % identifier)
            continue
        seen.append(identifier)

        capability_dir = capabilities_root / identifier
        if identifier not in discovered:
            issues.append("ledger entry %s names a capability that does not exist" % identifier)
            continue

        recorded_visibility = row.get("visibility")
        actual_visibility = manifest_visibility(capability_dir)
        if recorded_visibility not in VISIBILITIES:
            issues.append(
                "%s records visibility %r, which is not one of %s"
                % (identifier, recorded_visibility, ", ".join(VISIBILITIES))
            )
        elif recorded_visibility != actual_visibility:
            issues.append(
                "%s records visibility %s while its manifest says %s"
                % (identifier, recorded_visibility, actual_visibility)
            )

        harness = row.get("evalHarness")
        recorded_briefs = row.get("briefCount")
        if not isinstance(recorded_briefs, int) or isinstance(recorded_briefs, bool) or recorded_briefs < 0:
            issues.append("%s records briefCount %r, which is not a count" % (identifier, recorded_briefs))
            recorded_briefs = None
        if harness is None:
            if recorded_briefs not in (None, 0):
                issues.append(
                    "%s names no evalHarness but records briefCount %d" % (identifier, recorded_briefs)
                )
        elif not isinstance(harness, str) or not harness.startswith("evals/"):
            issues.append("%s records evalHarness %r, which is not a path under evals/" % (identifier, harness))
        elif not (root / harness).is_dir():
            issues.append("%s names evalHarness %s, which is not a directory" % (identifier, harness))
        else:
            counted, problem = briefs_on_disk(root / harness)
            if problem:
                issues.append("%s harness %s/briefs.json %s" % (identifier, harness, problem))
            elif recorded_briefs is not None and counted != recorded_briefs:
                issues.append(
                    "%s records briefCount %d while %s holds %d briefs"
                    % (identifier, recorded_briefs, harness, counted)
                )
            declared = _harness_capability(root / harness)
            if declared is not None and declared != identifier:
                issues.append(
                    "%s names evalHarness %s, whose briefs declare capability %s"
                    % (identifier, harness, declared)
                )

        _check_delivery(identifier, row.get("realDelivery"), root, progress_file, issues)

        related = row.get("relatedEvidence", [])
        if not isinstance(related, list):
            issues.append("%s records relatedEvidence that is not a list" % identifier)
        else:
            for position, reference in enumerate(related):
                problem = _resolve_reference(reference, root, progress_file)
                if problem:
                    issues.append("%s relatedEvidence[%d] %s" % (identifier, position, problem))

        note = row.get("note")
        if note is not None and (not isinstance(note, str) or not note.strip()):
            issues.append("%s records an empty note" % identifier)

    for identifier in discovered:
        if identifier not in seen:
            issues.append("capability %s has no acceptance-ledger entry" % identifier)

    return issues


def _harness_capability(harness_dir):
    brief_file = Path(harness_dir) / "briefs.json"
    if not brief_file.is_file():
        return None
    try:
        document = json.loads(brief_file.read_text(encoding="utf-8"))
    except ValueError:
        return None
    declared = document.get("capability") if isinstance(document, dict) else None
    return declared if isinstance(declared, str) and declared else None


def harness_notices(repo_root=REPO):
    """Report per-capability harness directories the ledger does not name.

    Advisory, never blocking. `evals/<capability-id>/` is the convention new
    brief packs follow, so a directory the ledger has not adopted is drift worth
    seeing — but a row that points at a shared harness instead (several
    capabilities share `specialist-smoke` and `drug-evidence-quality`) is a
    legitimate state, not a defect, and this is a new check with no observed
    distribution behind it yet.
    """
    root = Path(repo_root)
    try:
        document = load_ledger(root)
    except (OSError, ValueError):
        return []
    notices = []
    for row in document.get("capabilities", []):
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            continue
        candidate = (Path("evals") / row["id"]).as_posix()
        if (root / candidate).is_dir() and row.get("evalHarness") != candidate:
            named = row.get("evalHarness")
            notices.append(
                "notice: %s exists but %s names evalHarness %s; repoint the row once that harness is final"
                % (candidate, row["id"], "no harness" if named is None else repr(named))
            )
    return notices


def coverage_notice(repo_root=REPO):
    """Report the acceptance distribution. A metric, never a gate."""
    rows = load_ledger(repo_root).get("capabilities", [])
    public = [row for row in rows if row.get("visibility") != "internal"]
    counts = {status: 0 for status in DELIVERY_STATUSES}
    for row in public:
        status = (row.get("realDelivery") or {}).get("status")
        if status in counts:
            counts[status] += 1
    return (
        "notice: acceptance ledger records %d of %d public capabilities with an accepted delivery "
        "(%d failed, %d never run); this is a metric, not a gate"
        % (counts["accepted"], len(public), counts["failed"], counts["not-run"])
    )


def main():
    issues = ledger_issues()
    for issue in issues:
        print("acceptance ledger: %s" % issue)
    if issues:
        return 1
    for notice in harness_notices():
        print(notice)
    print(coverage_notice())
    print("acceptance ledger is complete and consistent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
