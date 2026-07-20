#!/usr/bin/env python3
"""Apply the EviMed compatibility patch to the pinned AI4S integrity auditor."""

from pathlib import Path
import sys


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch-ai4s-integrity-auditor.py <ai4s-skill-root>")
    target = Path(sys.argv[1]) / "integrity-auditor" / "forensics_tools" / "image_dup_orb.py"
    source = target.read_text(encoding="utf-8")
    old = '''try:
    import cv2
except ImportError:
    sys.stderr.write("install opencv-python first: pip install opencv-python\\n")
    sys.exit(2)

try:
    import numpy as np
except ImportError:
    sys.stderr.write("install numpy first: pip install numpy\\n")
    sys.exit(2)
'''
    new = '''try:
    import cv2
except ImportError:
    cv2 = None

try:
    import numpy as np
except ImportError:
    np = None
'''
    if old in source:
        source = source.replace(old, new, 1)
    guard = '''    args = parser.parse_args()

    if cv2 is None:
        sys.stderr.write("install opencv-python first: pip install opencv-python\\n")
        return 2
    if np is None:
        sys.stderr.write("install numpy first: pip install numpy\\n")
        return 2

    paths = [p for p in args.paths if Path(p).is_file()]
'''
    original = '''    args = parser.parse_args()

    paths = [p for p in args.paths if Path(p).is_file()]
'''
    if original in source:
        source = source.replace(original, guard, 1)
    if "if cv2 is None:" not in source:
        raise SystemExit("AI4S integrity-auditor source drifted; compatibility patch was not applied")
    target.write_text(source, encoding="utf-8")

    experiment = Path(sys.argv[1]) / "experiment-suite" / "SKILL.md"
    experiment_source = experiment.read_text(encoding="utf-8")
    experiment_source = experiment_source.replace(
        "**simulated** (default) — agent generates a plausible-shaped, deterministic `results.json` as a placeholder.",
        "**simulated** (explicit dry-run only; never the default) — only when the user asks for a simulation may the agent generate a deterministic placeholder `results.json`.",
    )
    experiment_source = experiment_source.replace(
        "If the user has data and time, push toward measured mode. If not, simulated is acceptable **provided** disclosures are honest in every artefact.",
        "Measured mode is the default. If measured data or compute are unavailable, deliver the design and runnable code with results pending. Use simulated mode only after an explicit user request, and never treat it as publication evidence even when disclosures are present.",
    )
    if "Measured mode is the default" not in experiment_source:
        raise SystemExit("AI4S experiment-suite source drifted; EviMed provenance policy was not applied")
    experiment.write_text(experiment_source, encoding="utf-8")

    paper = Path(sys.argv[1]) / "paper-writer" / "SKILL.md"
    paper_source = paper.read_text(encoding="utf-8")
    paper_source = paper_source.replace(
        "or simulated. Default is simulated; in that case the disclosure footnote must flag it",
        "or simulated. Measured is the default; simulated inputs require an explicit dry-run request and cannot support a submission-ready claim, even when the disclosure footnote flags them",
    )
    if "Measured is the default" not in paper_source:
        raise SystemExit("AI4S paper-writer source drifted; EviMed provenance policy was not applied")
    paper.write_text(paper_source, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
