#!/usr/bin/env python3
"""Execute every clean-delivery curated Skill and persist artifact receipts."""

from __future__ import annotations

import fcntl
import hashlib
import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SKILL_ROOT = ROOT / "runtime" / "skills" / "curated-scientific"
RESULT_FILE = ROOT / "evals" / "capability-audit" / "results" / "skill-execution-v1.json"
ARTIFACT_ROOT = ROOT / "evals" / "capability-audit" / "results" / "skill-execution-v1-artifacts"
LOCK_FILE = ROOT / "evals" / "capability-audit" / "results" / ".skill-execution.lock"


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    environment = {
        **os.environ,
        "MPLBACKEND": "Agg",
        "PYTHONHASHSEED": "0",
    }
    return subprocess.run(command, cwd=cwd, env=environment, text=True, capture_output=True, timeout=120, check=False)


def verified_artifact(path: Path) -> dict:
    metadata = path.lstat()
    if path.is_symlink() or not path.is_file() or metadata.st_size <= 0:
        raise RuntimeError(f"Invalid Skill artifact: {path}")
    return {"path": path.relative_to(ROOT).as_posix(), "bytes": metadata.st_size, "sha256": sha256(path)}


def dependency_environment(executable: dict) -> dict:
    exact = {}
    for descriptor in executable.values():
        for dependency in descriptor.get("dependencies", []):
            if "==" in dependency:
                package, expected = dependency.split("==", 1)
                exact[package] = expected
    installed = {}
    mismatched = []
    for package, expected in sorted(exact.items()):
        try:
            actual = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            actual = None
        installed[package] = actual
        if actual != expected:
            mismatched.append({"package": package, "expected": expected, "actual": actual})
    return {
        "pythonExecutable": sys.executable,
        "pythonVersion": ".".join(map(str, sys.version_info[:3])),
        "exactDependencies": installed,
        "matchesInventory": not mismatched,
        "mismatches": mismatched,
    }


def execute_shared(skill: str, output: Path) -> tuple[subprocess.CompletedProcess[str], list[Path]]:
    process = run([
        sys.executable,
        str(SKILL_ROOT / "_runtime" / "execute_skill.py"),
        "--skill", skill,
        "--smoke",
        "--output-dir", str(output),
    ], ROOT)
    return process, [output / "results.json", output / f"{skill}-report.md", output / "execution-receipt.json"]


def execute_matplotlib(output: Path) -> tuple[subprocess.CompletedProcess[str], list[Path]]:
    png = output / "figure.png"
    svg = output / "figure.svg"
    first = run([sys.executable, str(SKILL_ROOT / "matplotlib" / "scripts" / "plot_template.py"), "--plot-type", "line", "--output", str(png)], ROOT)
    if first.returncode:
        return first, [png, svg]
    second = run([sys.executable, str(SKILL_ROOT / "matplotlib" / "scripts" / "plot_template.py"), "--plot-type", "line", "--output", str(svg)], ROOT)
    return second, [png, svg]


def execute_power(output: Path) -> tuple[subprocess.CompletedProcess[str], list[Path]]:
    process = run([sys.executable, str(SKILL_ROOT / "statistical-power" / "scripts" / "export_power_analysis.py"), "--output-dir", str(output)], ROOT)
    return process, [output / "power-analysis.md", output / "power-curve.csv", output / "power-curve.png"]


def run_audit() -> int:
    inventory = json.loads((SKILL_ROOT / "inventory.json").read_text(encoding="utf-8"))
    executable = inventory["policy"]["delivery"]["executable"]
    started = now()
    environment = dependency_environment(executable)
    rows = []
    shutil.rmtree(ARTIFACT_ROOT, ignore_errors=True)
    ARTIFACT_ROOT.mkdir(parents=True)
    for skill in sorted(executable):
        output = ARTIFACT_ROOT / skill
        output.mkdir()
        if skill == "matplotlib":
            process, artifacts = execute_matplotlib(output)
        elif skill == "statistical-power":
            process, artifacts = execute_power(output)
        else:
            process, artifacts = execute_shared(skill, output)
        row = {
            "skill": skill,
            "operation": "smoke-task",
            "entrypoints": executable[skill].get("entrypoints", []),
            "returnCode": process.returncode,
            "stdout": process.stdout[-2000:],
            "stderr": process.stderr[-2000:],
            "artifacts": [],
            "passed": False,
        }
        try:
            if process.returncode != 0:
                raise RuntimeError(f"Skill process exited {process.returncode}")
            row["artifacts"] = [verified_artifact(path) for path in artifacts]
            row["passed"] = True
        except (OSError, RuntimeError) as error:
            row["error"] = str(error)
        rows.append(row)

    passed = sum(bool(row["passed"]) for row in rows)
    report = {
        "schemaVersion": 1,
        "startedAt": started,
        "finishedAt": now(),
        "inventorySha256": sha256(SKILL_ROOT / "inventory.json"),
        "runtimeEngineSha256": sha256(SKILL_ROOT / "_runtime" / "execute_skill.py"),
        "environment": environment,
        "inventoryExecutable": len(executable),
        "executionCertified": passed if environment["matchesInventory"] else 0,
        "failed": len(rows) - passed,
        "certificationBoundary": "Each package completed one bounded deterministic smoke task and produced the declared non-empty artifacts. This does not validate every method, input type, or scientific interpretation described by the Skill.",
        "skills": rows,
    }
    RESULT_FILE.parent.mkdir(parents=True, exist_ok=True)
    RESULT_FILE.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("inventoryExecutable", "executionCertified", "failed")}, sort_keys=True))
    return 0 if report["failed"] == 0 and environment["matchesInventory"] else 1


def main() -> int:
    RESULT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_FILE.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            return run_audit()
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


if __name__ == "__main__":
    raise SystemExit(main())
