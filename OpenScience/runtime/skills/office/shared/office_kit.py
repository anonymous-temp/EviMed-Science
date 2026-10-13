#!/usr/bin/env python3
"""Run the LibreOffice Kit CLI that ships inside the DSH kernel.

The kernel's closure already carries `@deepseek-ai/libreoffice-kit` (prebuilt WebAssembly
LibreOffice, MPL-2.0), so the image needs no system LibreOffice. The kit renders pages of
Office and PDF files to PNG, converts between Office formats and PDF, and recalculates the
formulas of a workbook. It never overwrites an existing output and wants absolute paths;
this wrapper takes care of both and finds the CLI.

    python3 office_kit.py render --input deck.pptx --output-dir preview --pages 1,3
    python3 office_kit.py convert --input contract.docx --output contract.pdf
    python3 office_kit.py recalculate --input budget.xlsx --output budget-calculated.xlsx
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

CLI_ENV = "EVIMED_LIBREOFFICE_KIT_CLI"
_RELATIVE = "@deepseek-ai/libreoffice-kit/lib/cli.js"
# The global CLI install keeps the whole kernel closure under its own node_modules; a sealed profile keeps it
# in pnpm's layout. The first existing file wins.
_ROOTS = (
    "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules",
    "/usr/lib/node_modules/@deepseek-ai/dsh/node_modules",
    "/usr/local/lib/node_modules",
)


class KitError(RuntimeError):
    pass


def find_cli() -> Path:
    explicit = os.environ.get(CLI_ENV)
    if explicit:
        path = Path(explicit)
        if path.is_file():
            return path
        raise KitError(f"{CLI_ENV} names {explicit}, which is not a file")
    candidates: list[str] = [f"{root}/{_RELATIVE}" for root in _ROOTS]
    homes = [os.environ.get("DSH_HOME"), "/opt/evimed/dsh-home-seed"]
    for home in filter(None, homes):
        candidates += glob.glob(f"{home}/profiles/*/node_modules/{_RELATIVE}")
        candidates += glob.glob(f"{home}/profiles/*/node_modules/.pnpm/@deepseek-ai+libreoffice-kit@*/node_modules/{_RELATIVE}")
    for candidate in candidates:
        if Path(candidate).is_file():
            return Path(candidate)
    raise KitError("the LibreOffice Kit CLI is not installed here; set " + CLI_ENV + " to its cli.js")


def run(arguments: list[str], timeout: int = 240) -> dict:
    node = shutil.which("node")
    if not node:
        raise KitError("node is not on PATH")
    done = subprocess.run([node, str(find_cli()), *arguments], capture_output=True, text=True, timeout=timeout)
    text = (done.stdout or done.stderr).strip()
    try:
        result = json.loads(text.splitlines()[-1]) if text else {}
    except (ValueError, IndexError):
        result = {"raw": text}
    if done.returncode != 0 or result.get("code") == "failed":
        raise KitError(str(result.get("error") or text or f"kit exited {done.returncode}"))
    return result


def _absolute(value: str | Path) -> str:
    return str(Path(value).expanduser().resolve())


def convert(source: str | Path, output: str | Path, sheet: str | None = None) -> dict:
    """Export `source` to the format named by the output suffix (pdf, docx, xlsx, pptx, csv ...)."""
    args = ["convert", "--input", _absolute(source), "--output", _absolute(output)]
    if sheet:
        args += ["--sheet", sheet]
    return run(args)


def recalculate(source: str | Path, output: str | Path) -> dict:
    """Refresh every formula result of a workbook into a new xlsx or ods file."""
    return run(["recalculate", "--input", _absolute(source), "--output", _absolute(output)])


def render(source: str | Path, output_dir: str | Path, pages: str = "all", dpi: int = 144, sheet: str | None = None, cell_range: str | None = None) -> dict:
    """Paint pages (slides, sheets, PDF pages) to PNG files in a new directory; returns the kit's manifest."""
    args = ["render", "--input", _absolute(source), "--output-dir", _absolute(output_dir), "--pages", str(pages), "--dpi", str(dpi)]
    if sheet:
        args += ["--sheet", sheet]
    if cell_range:
        args += ["--range", cell_range]
    return run(args)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    one = sub.add_parser("convert")
    one.add_argument("--input", required=True)
    one.add_argument("--output", required=True)
    one.add_argument("--sheet")
    two = sub.add_parser("recalculate")
    two.add_argument("--input", required=True)
    two.add_argument("--output", required=True)
    three = sub.add_parser("render")
    three.add_argument("--input", required=True)
    three.add_argument("--output-dir", required=True)
    three.add_argument("--pages", default="all")
    three.add_argument("--dpi", type=int, default=144)
    three.add_argument("--sheet")
    three.add_argument("--range", dest="cell_range")
    sub.add_parser("where")
    args = parser.parse_args()
    try:
        if args.command == "where":
            print(find_cli())
            return 0
        if args.command == "convert":
            result = convert(args.input, args.output, args.sheet)
        elif args.command == "recalculate":
            result = recalculate(args.input, args.output)
        else:
            result = render(args.input, args.output_dir, args.pages, args.dpi, args.sheet, args.cell_range)
    except (KitError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
