#!/usr/bin/env python3
"""Cross-check the gold tables against the article's own JATS XML table (a check on the transcription, not a second gold).

    python3 xml_check.py --pdfs /tmp/vcr-baseline-tables/pdfs --gold gold

The gold was read from the rendered page by a model. The same article's XML (from the PMC Open Access dataset) holds the table as the
publisher typed it, so a gold cell that is not in the XML's matching row is flagged: either the model misread the page, or the XML and
the PDF differ. Each flag is settled by looking at the page again; the XML is never copied into the gold.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import score_lib  # noqa: E402


def cell_text(element) -> str:
    return re.sub(r"\s+", " ", "".join(element.itertext())).strip()


def xml_tables(path: Path):
    """[(label, grid)] for every table in the article."""
    root = ET.parse(path).getroot()
    out = []
    for wrap in root.iter("table-wrap"):
        label = cell_text(wrap.find("label")) if wrap.find("label") is not None else ""
        table = wrap.find(".//table")
        if table is None:
            continue
        grid = [[cell_text(c) for c in row if c.tag in ("td", "th")] for row in table.iter("tr")]
        out.append((label, grid))
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pdfs", required=True)
    parser.add_argument("--gold", default=str(Path(__file__).resolve().parent / "gold"))
    args = parser.parse_args(argv)
    flagged = 0
    totals = [0, 0]
    for gold_path in sorted(Path(args.gold).glob("PMC*.json")):
        gold = json.loads(gold_path.read_text(encoding="utf-8"))
        xml = Path(args.pdfs) / (gold["pmcid"] + ".xml")
        if not xml.exists():
            print("%s: no XML" % gold["pmcid"])
            continue
        wanted = re.sub(r"\W+", "", gold["table"]).lower()
        tables = [(label, grid) for label, grid in xml_tables(xml) if re.sub(r"\W+", "", label).lower() == wanted]
        if not tables:
            print("%s: no XML table labelled %s" % (gold["pmcid"], gold["table"]))
            continue
        grid = tables[0][1]
        result = score_lib.score_table(gold, grid)
        missing = [c for c in result["cells"] if not c["anywhere"]]
        table_text = score_lib.norm_value(" ".join(cell for row in grid for cell in row))
        in_text = sum(1 for c in result["cells"] if score_lib.norm_value(c["value"]) in table_text)
        totals[0] += in_text
        totals[1] += len(result["cells"])
        print("%s %s: %d/%d rows found in the XML table, %d/%d cells found in their row" % (
            gold["pmcid"], gold["table"], result["rowsMatched"], result["rows"], len(result["cells"]) - len(missing), len(result["cells"])))
        for cell in missing:
            flagged += 1
            print("    ? %s | %s | gold %r%s" % (cell["variable"], cell["column"], cell["value"], "" if cell["rowFound"] else "  (row not found)"))
    print("flagged cells:", flagged)
    print("gold cells whose value is somewhere in the XML table's text: %d of %d" % tuple(totals))
    return 0


if __name__ == "__main__":
    sys.exit(main())
