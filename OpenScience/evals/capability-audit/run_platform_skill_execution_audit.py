#!/usr/bin/env python3
"""Execute first-party platform Skills and retain task-level evidence.

This audit deliberately covers only packages with a bounded, deterministic,
offline entrypoint. Installing a SKILL.md or parsing ``--help`` is not enough.
Each passing row has an input, a real output, structural validation, and
content-addressed artifact receipts.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZipFile


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
RESULTS = HERE / "results"
ARTIFACT_ROOT = RESULTS / "platform-skill-execution-v1-artifacts"
AUDIT_PYTHON = os.environ.get("EVIMED_AUDIT_PYTHON", sys.executable)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def receipt(path: Path) -> dict:
    resolved = path.resolve()
    if not resolved.is_relative_to(REPO) or not resolved.is_file() or resolved.is_symlink():
        raise RuntimeError("artifact is not a retained regular repository file: %s" % path)
    return {
        "path": resolved.relative_to(REPO).as_posix(),
        "bytes": resolved.stat().st_size,
        "sha256": sha256(resolved),
    }


def run(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd or REPO,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def parse_review(stdout: str) -> dict:
    match = re.fullmatch(r"\s*```review\s*\n(.*?)\n```\s*", stdout, re.DOTALL)
    if not match:
        raise RuntimeError("reviewer did not emit the fenced JSON contract")
    document = json.loads(match.group(1))
    if not isinstance(document, dict) or not isinstance(document.get("findings"), list):
        raise RuntimeError("reviewer output has an invalid contract")
    return document


def write_text(path: Path, value: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")
    return path


def package_row(
    package: str,
    entrypoint: Path,
    command: list[str],
    completed: subprocess.CompletedProcess[str],
    artifacts: list[Path],
    checks: dict[str, bool],
) -> dict:
    manifest = REPO / "runtime" / "skills" / package / "SKILL.md"
    artifact_receipts = []
    artifact_errors = []
    for artifact in artifacts:
        try:
            artifact_receipts.append(receipt(artifact))
        except RuntimeError as error:
            artifact_errors.append(str(error))
    passed = (
        completed.returncode == 0
        and bool(checks)
        and all(checks.values())
        and not artifact_errors
    )
    return {
        "package": package,
        "operation": "task",
        "command": [str(part) for part in command],
        "returnCode": completed.returncode,
        "passed": passed,
        "checks": checks,
        "stdout": completed.stdout[-4000:],
        "stderr": completed.stderr[-4000:],
        "manifestSha256": sha256(manifest),
        "entrypoint": entrypoint.relative_to(REPO).as_posix(),
        "entrypointSha256": sha256(entrypoint),
        "artifacts": artifact_receipts,
        "artifactErrors": artifact_errors,
    }


def audit_office(run_root: Path) -> list[dict]:
    rows = []
    specs = (
        ("office/docx", "create_docx.py", "report.docx"),
        ("office/pdf", "create_pdf.py", "report.pdf"),
        ("office/pptx", "create_pptx.py", "report.pptx"),
        ("office/xlsx", "create_xlsx.py", "report.xlsx"),
    )
    for package, script_name, output_name in specs:
        name = package.rsplit("/", 1)[1]
        task = run_root / name
        source = task / ("results.csv" if name == "xlsx" else "source.txt")
        output = task / output_name
        content = "drug,count\naspirin,3\nwarfarin,2\n" if name == "xlsx" else "EviMed evidence report\nTraceable result"
        write_text(source, content)
        entrypoint = REPO / "runtime" / "skills" / package / "scripts" / script_name
        command = [AUDIT_PYTHON, str(entrypoint)]
        if name == "pptx":
            command.extend(["--title", "EviMed evidence", "--body-file", str(source), "--output", str(output)])
        else:
            command.extend(["--input", str(source), "--output", str(output)])
            if name == "xlsx":
                command.extend(["--sheet", "Evidence"])
        completed = run(command)
        checks = {"nonEmptyOutput": output.is_file() and output.stat().st_size > 0}
        if checks["nonEmptyOutput"] and name == "pdf":
            data = output.read_bytes()
            checks.update({"pdfHeader": data.startswith(b"%PDF-"), "pdfTrailer": data.rstrip().endswith(b"%%EOF")})
        elif checks["nonEmptyOutput"]:
            required = {
                "docx": {"[Content_Types].xml", "word/document.xml"},
                "pptx": {"[Content_Types].xml", "ppt/presentation.xml", "ppt/slides/slide1.xml"},
                "xlsx": {"[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"},
            }[name]
            with ZipFile(output) as archive:
                members = set(archive.namelist())
                payload = b"\n".join(archive.read(member) for member in required - {"[Content_Types].xml"})
            checks.update({"ooxmlMembers": required.issubset(members), "expectedContent": b"EviMed" in payload or b"aspirin" in payload})
        rows.append(package_row(package, entrypoint, command, completed, [source, output], checks))
    return rows


def audit_reviewers(run_root: Path) -> list[dict]:
    rows = []
    cases = (
        (
            "core/domain-check",
            "domain_check.py",
            "analysis.py",
            "time_seconds = 2\ndistance_meters = 5\nvalue = time_seconds + distance_meters\n",
            "unit",
        ),
        (
            "core/stats-integrity",
            "stats_integrity_check.py",
            "analysis.py",
            "import numpy as np\nvalues = np.random.normal(size=10)\n",
            "seed",
        ),
    )
    for package, script_name, input_name, content, expected_fragment in cases:
        name = package.rsplit("/", 1)[1]
        task = run_root / name
        source = write_text(task / input_name, content)
        output = task / "review.json"
        entrypoint = REPO / "runtime" / "skills" / package / script_name
        command = [AUDIT_PYTHON, str(entrypoint), str(source)]
        completed = run(command)
        checks = {"reviewContract": False, "expectedFindingClass": False}
        try:
            review = parse_review(completed.stdout)
            write_text(output, json.dumps(review, ensure_ascii=False, indent=2) + "\n")
            checks["reviewContract"] = True
            checks["expectedFindingClass"] = any(
                expected_fragment in json.dumps(finding, ensure_ascii=False).lower()
                for finding in review["findings"]
            )
        except (RuntimeError, json.JSONDecodeError):
            write_text(output, completed.stdout)
        rows.append(package_row(package, entrypoint, command, completed, [source, output], checks))

    package = "core/large-file"
    task = run_root / "large-file"
    source = write_text(task / "data.csv", "drug,count\naspirin,3\nwarfarin,2\n")
    output = task / "pointer.json"
    entrypoint = REPO / "runtime" / "skills" / package / "large_file_probe.py"
    command = [AUDIT_PYTHON, str(entrypoint), str(source), "--sample", "1"]
    completed = run(command)
    checks = {"validJsonPointer": False, "boundedSample": False, "correctSchema": False}
    try:
        pointer = json.loads(completed.stdout)
        write_text(output, json.dumps(pointer, ensure_ascii=False, indent=2) + "\n")
        checks["validJsonPointer"] = isinstance(pointer, dict)
        checks["boundedSample"] = len(pointer.get("sample_head", [])) <= 1 and len(pointer.get("sample_tail", [])) <= 1
        checks["correctSchema"] = pointer.get("n_columns") == 2 and pointer.get("approx_rows") == 2
    except json.JSONDecodeError:
        write_text(output, completed.stdout)
    rows.append(package_row(package, entrypoint, command, completed, [source, output], checks))
    return rows


def audit_run_recorders(run_root: Path) -> list[dict]:
    rows = []
    for package, surface in (("core/remote-compute", "ssh"), ("core/modal-run", "modal")):
        name = package.rsplit("/", 1)[1]
        task = run_root / name
        code = write_text(task / "compute.py", "print('traceable result')\n")
        output = write_text(task / "results" / "result.json", '{"estimate": 1.0, "seed": 0}\n')
        env = None
        if surface == "ssh":
            env = write_text(task / "results" / "env.txt", "Python 3.11.9\nPLATFORM=linux-x86_64\n--- pip freeze ---\nnumpy==1.26.4\n")
        entrypoint = REPO / "runtime" / "skills" / package / "record_run.py"
        command = [
            AUDIT_PYTHON,
            str(entrypoint),
            "--surface", surface,
            "--command", "python compute.py",
            "--status", "ok",
            "--host", "audit-fixture",
            "--hardware", "CPU audit fixture",
            "--wall-ms", "10",
            "--code", str(code.relative_to(task)),
            "--output", str(output.relative_to(task)),
            "--session-id", "audit-session",
        ]
        if env is not None:
            command.extend(["--env-file", str(env.relative_to(task))])
        completed = run(command, cwd=task)
        store = task / ".openscience" / "remote-runs.jsonl"
        checks = {"provenanceCreated": store.is_file(), "singleTerminalReceipt": False, "artifactHashesPresent": False}
        if store.is_file():
            records = [json.loads(line) for line in store.read_text(encoding="utf-8").splitlines() if line.strip()]
            checks["singleTerminalReceipt"] = len(records) == 1 and records[0].get("surface") == surface and records[0].get("status") == "ok"
            checks["artifactHashesPresent"] = bool(
                records
                and records[0].get("code")
                and records[0].get("outputs")
                and records[0]["code"][0].get("hash")
                and records[0]["outputs"][0].get("hash")
            )
        artifacts = [code, output, store]
        if env is not None:
            artifacts.append(env)
        rows.append(package_row(package, entrypoint, command, completed, artifacts, checks))
    return rows


def audit_artifact_utilities(run_root: Path) -> list[dict]:
    rows = []

    package = "core/hpc-slurm"
    task = run_root / "hpc-slurm"
    output = task / "analysis.sbatch"
    entrypoint = REPO / "runtime" / "skills" / package / "render_job.py"
    command = [
        AUDIT_PYTHON, str(entrypoint), "--job-name", "evimed-audit",
        "--command", "python analysis.py", "--output", str(output),
        "--time", "00:10:00", "--cpus-per-task", "2", "--module", "python/3.11",
    ]
    completed = run(command)
    content = output.read_text(encoding="utf-8") if output.is_file() else ""
    checks = {
        "batchArtifactCreated": output.is_file(),
        "strictShell": "set -euo pipefail" in content,
        "boundedRequestedResources": "#SBATCH --cpus-per-task=2" in content and "module load python/3.11" in content,
        "noCredentialHandling": "password" not in content.casefold() and "secret" not in content.casefold(),
    }
    rows.append(package_row(package, entrypoint, command, completed, [output], checks))

    package = "core/publication-figures"
    task = run_root / "publication-figures"
    source = write_text(task / "observations.csv", "day,response\n0,10\n7,35\n14,55\n")
    output = task / "observed-response.png"
    entrypoint = REPO / "runtime" / "skills" / package / "render_csv_figure.py"
    command = [
        AUDIT_PYTHON, str(entrypoint), "--input", str(source), "--output", str(output),
        "--x-label", "Time (days)", "--y-label", "Response (%)", "--title", "Observed response",
    ]
    completed = run(command)
    data = output.read_bytes() if output.is_file() else b""
    checks = {
        "pngArtifactCreated": len(data) > 1000,
        "pngSignature": data.startswith(b"\x89PNG\r\n\x1a\n"),
        "boundedInputRetained": source.read_text(encoding="utf-8").count("\n") == 4,
    }
    rows.append(package_row(package, entrypoint, command, completed, [source, output], checks))

    package = "core/traceability-review"
    task = run_root / "traceability-review"
    source = run_root / "pdf" / "report.pdf"
    output = task / "extracted.json"
    entrypoint = REPO / "runtime" / "skills" / package / "pdf_extract.py"
    command = [AUDIT_PYTHON, str(entrypoint), str(source)]
    completed = run(command)
    extracted = {}
    try:
        extracted = json.loads(completed.stdout)
    except json.JSONDecodeError:
        pass
    write_text(output, json.dumps(extracted, ensure_ascii=False, indent=2) + "\n")
    checks = {
        "pdfActuallyParsed": isinstance(extracted.get("pages"), int) and extracted.get("pages", 0) >= 1,
        "textActuallyExtracted": "EviMed" in str(extracted.get("text") or ""),
        "claimContractPresent": isinstance(extracted.get("claims"), list),
    }
    rows.append(package_row(package, entrypoint, command, completed, [source, output], checks))

    package = "external/ai4s-skills/integrity-auditor"
    task = run_root / "integrity-auditor"
    output = task / "smoketest.log"
    entrypoint = REPO / "runtime" / "skills" / package / "tests" / "smoketest.sh"
    command = ["bash", str(entrypoint)]
    completed = run(command)
    write_text(output, completed.stdout + completed.stderr)
    checks = {
        "positiveAndNegativeControlsExecuted": "PASS: 22" in completed.stdout,
        "allForensicChecksPassed": "FAIL: 0" in completed.stdout,
    }
    rows.append(package_row(package, entrypoint, command, completed, [output], checks))

    package = "external/ai4s-skills/mindmap-render"
    task = run_root / "mindmap-render"
    source = write_text(task / "topic_matrix.md", "# Evidence synthesis\n- Discovery\n  - Search\n  - Screen\n- Analysis\n  - Estimate\n")
    output_dir = task / "output"
    entrypoint = REPO / "runtime" / "skills" / package / "scripts" / "generate_mindmap.py"
    command = [
        AUDIT_PYTHON, str(entrypoint), "--md", str(source), "--output-dir", str(output_dir),
        "--title", "evidence-synthesis", "--theme", "air", "--scale", "1",
    ]
    completed = run(command)
    html = output_dir / "evidence-synthesis.html"
    png = output_dir / "evidence-synthesis.png"
    pdf = output_dir / "evidence-synthesis.pdf"
    checks = {
        "htmlArtifactCreated": html.is_file() and "Evidence synthesis" in html.read_text(encoding="utf-8"),
        "pngArtifactCreated": png.is_file() and png.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"),
        "pdfArtifactCreated": pdf.is_file() and pdf.read_bytes().startswith(b"%PDF"),
    }
    rows.append(package_row(package, entrypoint, command, completed, [source, html, png, pdf], checks))
    return rows


def main() -> None:
    started = datetime.now(timezone.utc)
    run_root = ARTIFACT_ROOT / (started.strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
    run_root.mkdir(parents=True, exist_ok=False)
    rows = (
        audit_office(run_root)
        + audit_reviewers(run_root)
        + audit_run_recorders(run_root)
        + audit_artifact_utilities(run_root)
    )
    finished = datetime.now(timezone.utc)
    document = {
        "schemaVersion": 1,
        "startedAt": started.isoformat(),
        "finishedAt": finished.isoformat(),
        "environment": {
            "pythonExecutable": AUDIT_PYTHON,
            "pythonVersion": run([AUDIT_PYTHON, "-c", "import platform; print(platform.python_version())"]).stdout.strip(),
            "dependencyContract": "selected audit runtime plus package-declared dependencies",
        },
        "installedPackagesExamined": len(rows),
        "executionCertified": sum(row["passed"] for row in rows),
        "failed": sum(not row["passed"] for row in rows),
        "packages": rows,
        "claimBoundary": (
            "This certifies one bounded deterministic task per listed first-party package. "
            "It does not certify every input shape, external remote availability, or feature-complete Office fidelity."
        ),
    }
    RESULTS.mkdir(parents=True, exist_ok=True)
    destination = RESULTS / "platform-skill-execution-v1.json"
    destination.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: document[key] for key in ("installedPackagesExamined", "executionCertified", "failed")}, indent=2))
    if document["failed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
