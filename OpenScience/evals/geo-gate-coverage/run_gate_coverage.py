#!/usr/bin/env python3
"""Measure which of the geo-skills BLOCK rules are actually proved by a test.

A rule that can be switched off with the suite still green is a rule nothing
proves. It may be right, but the next refactor that breaks it will ship. This
is the same discipline the rest of this repository applies to its own gates —
a check without a negative control is a check that passes forever — and it is
the reason the review of geo-skills 2.0.0 could not stop at "309 tests pass".

Run it as:

    python3 evals/geo-gate-coverage/run_gate_coverage.py --package /path/to/geo-skills-2.0.0

The measurement itself has two failure modes that both inflate the score, and
both of them bit me once before this file existed, so the harness refuses to
report a number unless it has ruled them out:

  1. `test_readme_test_count_is_current` pins the suite's own test count, so
     *every* mutation makes it red and hides which rules are genuinely covered.
     Deselecting it fixes the measurement — but a typo in the node id makes the
     deselect a silent no-op, and the run then reports 78/78 caught. So the
     node id is collected first and a miss is fatal.
  2. The added adversarial tests are copied into the package tree. A copy that
     silently fails means measuring the unpatched suite. So the collected test
     count is compared before and after, and a delta of zero is fatal.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
COUNT_PIN = "tests/test_core.py::TestDocsMatchReality::test_readme_test_count_is_current"
# The files whose contents decide the measurement. A package that differs in any
# of them is a different measurement, whatever its VERSION file says.
DIGEST_GLOBS = ("shared/scripts/validate.py", "shared/rules/catalogue.yaml", "shared/scripts/tests/test_*.py")


def tree_digest(root: Path) -> str:
    """Digest the files the measurement depends on, ignoring anything we inject."""
    digest = hashlib.sha256()
    paths: list[Path] = []
    for pattern in DIGEST_GLOBS:
        paths.extend(sorted(root.glob(pattern)))
    for path in paths:
        if path.name == "test_uncovered_gates.py":
            continue  # ours; it is versioned here, not there
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def collected(scripts: Path, *extra: str) -> int:
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "tests", "--collect-only", "-q", "--no-header", *extra],
        cwd=scripts, capture_output=True, text=True, timeout=300,
    )
    # Order matters: with --deselect pytest prints "317/318 tests collected",
    # and the plain pattern happily matches the "318 tests collected" inside it,
    # which reports the deselect as having removed nothing.
    found = re.search(r"(\d+)/\d+ tests collected", proc.stdout) or re.search(r"(\d+) tests? collected", proc.stdout)
    return int(found.group(1)) if found else -1


def suite_is_green(scripts: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "pytest", "tests", "-q", "--no-header", "--deselect", COUNT_PIN],
        cwd=scripts, capture_output=True, text=True, timeout=600,
    )


def block_rules(catalogue: Path) -> list[dict]:
    import yaml  # noqa: PLC0415 — optional dependency, only needed for a real run

    loaded = yaml.safe_load(catalogue.read_text(encoding="utf-8")) or {}
    return [
        rule for rule in (loaded.get("rules") or [])
        if rule.get("severity") == "BLOCK" and str(rule.get("check", "")).startswith("validate.")
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--package", required=True, type=Path, help="unpacked geo-skills root (the dir holding VERSION)")
    parser.add_argument("--record-baseline", action="store_true", help="rewrite baseline.json from this run")
    parser.add_argument("--json", type=Path, help="also write the full result here")
    args = parser.parse_args()

    root = args.package.resolve()
    scripts = root / "shared" / "scripts"
    catalogue = root / "shared" / "rules" / "catalogue.yaml"
    source = scripts / "validate.py"
    for path in (scripts, catalogue, source, scripts / "tests"):
        if not path.exists():
            print(f"not a geo-skills package: missing {path}", file=sys.stderr)
            return 2

    baseline = json.loads((HERE / "baseline.json").read_text(encoding="utf-8"))
    digest = tree_digest(root)
    version = (root / "VERSION").read_text(encoding="utf-8").strip() if (root / "VERSION").exists() else "?"
    drifted = digest != baseline.get("treeDigest")
    print(f"package  : {root}")
    print(f"version  : {version}")
    print(f"digest   : {digest}{'  (DIFFERS from baseline — comparing anyway, numbers are not the recorded ones)' if drifted else ''}")

    injected = scripts / "tests" / "test_uncovered_gates.py"
    had_injected = injected.exists()
    before = collected(scripts) if not had_injected else -1
    shutil.copy2(HERE / "tests" / "test_uncovered_gates.py", injected)
    after = collected(scripts)

    original = source.read_text(encoding="utf-8")
    try:
        # Guard 2: the injection has to have landed.
        if not had_injected and after <= before:
            print(f"adversarial tests did not register ({before} -> {after} collected); refusing to report", file=sys.stderr)
            return 2
        # Guard 1: the deselect has to name a test that exists, or it is a no-op
        # and every rule will look covered.
        if collected(scripts, "--deselect", COUNT_PIN) != after - 1:
            print(f"--deselect {COUNT_PIN} removed nothing; the node id is stale and the score would be inflated", file=sys.stderr)
            return 2

        green = suite_is_green(scripts)
        if green.returncode != 0:
            print("the unmutated suite is not green; fix that before measuring coverage", file=sys.stderr)
            print(green.stdout[-2000:], file=sys.stderr)
            return 2

        rules = block_rules(catalogue)
        caught: list[str] = []
        survived: list[str] = []
        unlocatable: list[str] = []
        for index, rule in enumerate(rules, start=1):
            function = str(rule["check"]).split(".")[-1]
            match = re.search(rf"(def {re.escape(function)}\([^)]*\)[^:]*:\n)", original)
            if not match:
                unlocatable.append(rule["id"])
                continue
            # Neuter it: the check can no longer produce an issue, so the rule
            # can no longer block. Anything still red is a test that proves it.
            source.write_text(original[: match.end(1)] + "    return []\n" + original[match.end(1):], encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, "-m", "pytest", "tests", "-q", "--no-header", "-x", "--deselect", COUNT_PIN],
                cwd=scripts, capture_output=True, text=True, timeout=600,
            )
            (caught if proc.returncode != 0 else survived).append(rule["id"])
            print(f"  [{index}/{len(rules)}] {rule['id']:<10} {'caught' if proc.returncode != 0 else 'SURVIVED'}")
    finally:
        source.write_text(original, encoding="utf-8")
        if not had_injected:
            injected.unlink(missing_ok=True)

    result = {
        "package": str(root),
        "version": version,
        "treeDigest": digest,
        "blockRules": len(caught) + len(survived),
        "caught": sorted(caught),
        "survived": sorted(survived),
        "unlocatable": sorted(unlocatable),
    }
    if args.json:
        args.json.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\nBLOCK rules mutated : {result['blockRules']}")
    print(f"  proved by a test  : {len(caught)}")
    print(f"  SURVIVED          : {len(survived)}")
    if survived:
        print("  " + ", ".join(sorted(survived)))
    if unlocatable:
        print(f"  not locatable     : {', '.join(sorted(unlocatable))}")

    if args.record_baseline:
        baseline = {**baseline, "treeDigest": digest, "version": version, "survivors": sorted(survived)}
        (HERE / "baseline.json").write_text(json.dumps(baseline, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\nbaseline rewritten: {len(survived)} survivors")
        return 0

    # The ratchet. Survivors may shrink freely; a rule that used to be proved
    # and now is not is a regression, and so is a new BLOCK rule arriving
    # without a control.
    known = set(baseline.get("survivors", []))
    regressed = sorted(set(survived) - known)
    closed = sorted(known - set(survived))
    if closed:
        print(f"\nclosed since baseline ({len(closed)}): {', '.join(closed)}")
    if regressed:
        print(f"\nno longer proved by any test ({len(regressed)}): {', '.join(regressed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
