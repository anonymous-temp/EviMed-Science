"""Evidence-ledger and compiled-method files for reproducibility packages."""
from __future__ import annotations

from pathlib import Path
from typing import Iterable


METHOD_PACKAGE_FILES = {
    "analysis": [
        "method_plan.json",
        "method_policy_snapshot.json",
        "method_validation_snapshot.json",
        "synthesis_route.json",
        "analysis_set_candidates.json",
        "analysis_set.json",
        "analysis_set_adjudications.json",
        "method_result.json",
        "method_input_audit.json",
        "synthesis_result.json",
        "method_delivery_status.json",
        "method_certainty.json",
        "method_certainty_adjudications.json",
    ],
    "evidence": [
        "review_identity.json",
        "ledger.jsonl",
        "ledger_migration.json",
    ],
}


def iter_method_package_files(project) -> Iterable[tuple[Path, str]]:
    for subdir, filenames in METHOD_PACKAGE_FILES.items():
        for filename in filenames:
            path = project.base_dir / subdir / filename
            if path.is_file() and path.stat().st_size > 0:
                yield path, f"{subdir}/{filename}"
