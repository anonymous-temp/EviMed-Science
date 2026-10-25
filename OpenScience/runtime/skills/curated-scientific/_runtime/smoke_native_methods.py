#!/usr/bin/env python3
"""Offline smoke of adopted native methods and their shipped supporting files."""

from __future__ import annotations

import argparse
import io
import json
import platform
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def smoke(root: Path) -> dict:
    hypothesis = root / "hypothesis-development"
    assets = hypothesis / "assets"
    record = assets / "hypothesis_record_template.json"

    def cli(name: str, *arguments: Path, expected: int = 0) -> str:
        result = subprocess.run(
            [sys.executable, str(hypothesis / "scripts" / name), *map(str, arguments)],
            text=True, capture_output=True, timeout=30,
        )
        if result.returncode != expected:
            raise RuntimeError(f"{name}: {result.stderr or result.stdout}")
        return result.stdout

    validation = json.loads(cli("validate_hypothesis_schema.py", record))
    if not validation["valid"]:
        raise RuntimeError("bundled hypothesis record is invalid")
    cli("check_operationalization.py", assets / "operationalization_template.json")
    cli("validate_prediction_matrix.py", assets / "prediction_rival_matrix_template.csv", "--record", record)
    cli("check_falsification_controls.py", assets / "falsification_controls_template.json", "--record", record)
    cli("audit_evidence_ledger.py", assets / "evidence_ledger_template.csv", assets / "search_boundary_template.json", "--record", record)
    with tempfile.TemporaryDirectory(prefix="evimed-native-methods-") as temporary:
        directory = Path(temporary)
        draft = directory / "claim.md"
        draft.write_text("[claim:associational] Exposure X was associated with outcome Y.\n", encoding="utf-8")
        cli("lint_causal_claims.py", draft)
        first, second = directory / "first.md", directory / "second.md"
        cli("generate_preregistration_scaffold.py", record, "--output", first)
        cli("generate_preregistration_scaffold.py", record, "--output", second)
        rendered = first.read_text(encoding="utf-8")
        if rendered != second.read_text(encoding="utf-8") or re.search(r"\{\{[A-Z0-9_]+\}\}", rendered):
            raise RuntimeError("preregistration scaffold is not deterministic or has unresolved placeholders")
        broken = json.loads(record.read_text(encoding="utf-8"))
        broken["predictions"][0]["hypothesis_id"] = "H-MISSING"
        broken_path = directory / "broken.json"
        broken_path.write_text(json.dumps(broken), encoding="utf-8")
        if json.loads(cli("validate_hypothesis_schema.py", broken_path, expected=1))["valid"]:
            raise RuntimeError("broken hypothesis references were accepted")

    grant = root / "research-grant-development"
    files = sorted([*(grant / "references").glob("*.md"), *(grant / "assets").glob("*.md")])
    if len(files) != 15 or any(not file.stat().st_size for file in files):
        raise RuntimeError("grant references/templates are incomplete")
    for file in [grant / "SKILL.md", *files]:
        for reference in re.findall(r"\]\(([^)#]+)(?:#[^)]*)?\)", file.read_text(encoding="utf-8")):
            if ":" not in reference and not (file.parent / reference).is_file():
                raise RuntimeError(f"unresolved grant reference: {file.name}: {reference}")

    import Bio
    from Bio import Align, SeqIO
    from Bio.Seq import Seq
    from Bio.SeqRecord import SeqRecord

    sequence = Seq("ATGGCCATTGTAATGGGCCGCTGAAAGGGTGCCCGATAG")
    if str(sequence.translate()) != "MAIVMGR*KGAR*" or sequence.reverse_complement().reverse_complement() != sequence:
        raise RuntimeError("Biopython sequence transform failed")
    if str(sequence.transcribe()) != str(sequence).replace("T", "U"):
        raise RuntimeError("Biopython transcription failed")
    aligner = Align.PairwiseAligner()
    aligner.mode = "global"
    aligner.match_score, aligner.mismatch_score = 2, -1
    aligner.open_gap_score, aligner.extend_gap_score = -2, -0.5
    if aligner.score("ACCGGT", "ACGGT") != 8 or not len(aligner.align("ACCGGT", "ACGGT")):
        raise RuntimeError("Biopython alignment failed")
    sequence_record = SeqRecord(sequence, id="synthetic", description="offline smoke", annotations={"molecule_type": "DNA"})
    for format_name in ("fasta", "genbank"):
        buffer = io.StringIO()
        SeqIO.write(sequence_record, buffer, format_name)
        buffer.seek(0)
        restored = SeqIO.read(buffer, format_name)
        if restored.id != sequence_record.id or restored.seq != sequence:
            raise RuntimeError(f"Biopython {format_name} round trip failed")
    return {
        "hypothesis_native_operations": 7,
        "grant_reference_and_asset_files": len(files),
        "biopython_round_trips": 2,
        "biopython_version": Bio.__version__,
        "python_version": platform.python_version(),
        "scope": "offline local APIs and assets; no model or external-service certification",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    print(json.dumps(smoke(parser.parse_args().root), sort_keys=True))
