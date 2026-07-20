#!/usr/bin/env python3
"""Create a small valid PDF using only the Python standard library."""

from __future__ import annotations

import argparse
import textwrap
from pathlib import Path


def pdf_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def create_pdf(text: str, output: Path) -> None:
    lines = [part for line in text.splitlines() for part in (textwrap.wrap(line, 88) or [""])]
    pages = [lines[index:index + 48] for index in range(0, max(1, len(lines)), 48)]
    objects: list[bytes] = []
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    page_ids = [4 + index * 2 for index in range(len(pages))]
    objects.append(f"<< /Type /Pages /Kids [{' '.join(f'{page} 0 R' for page in page_ids)}] /Count {len(pages)} >>".encode())
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for index, page_lines in enumerate(pages):
        content_id = 5 + index * 2
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>".encode())
        commands = ["BT", "/F1 10 Tf", "50 742 Td", "13 TL"]
        for line in page_lines:
            safe = line.encode("latin-1", "replace").decode("latin-1")
            commands.append(f"({pdf_escape(safe)}) Tj")
            commands.append("T*")
        commands.append("ET")
        stream = "\n".join(commands).encode("latin-1")
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")

    output.parent.mkdir(parents=True, exist_ok=True)
    data = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for object_id, body in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f"{object_id} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = len(data)
    data.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        data.extend(f"{offset:010d} 00000 n \n".encode())
    data.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    output.write_bytes(data)


def main() -> None:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path)
    source.add_argument("--text")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.suffix.lower() != ".pdf":
        parser.error("--output must end in .pdf")
    text = args.input.read_text(encoding="utf-8") if args.input else args.text
    create_pdf(text, args.output)


if __name__ == "__main__":
    main()
