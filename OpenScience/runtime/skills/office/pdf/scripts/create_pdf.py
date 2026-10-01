#!/usr/bin/env python3
"""Create a Unicode PDF with the shared offline renderer."""
from __future__ import annotations
import argparse
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from render_document import render_text


def create_pdf(text: str, output: Path) -> None:
    render_text(text, output, "pdf")


def main() -> None:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path)
    source.add_argument("--text")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.suffix.lower() != ".pdf":
        parser.error("--output must end in .pdf")
    create_pdf(args.input.read_text(encoding="utf-8") if args.input else args.text, args.output)


if __name__ == "__main__":
    main()
