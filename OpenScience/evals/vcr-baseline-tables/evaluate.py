#!/usr/bin/env python3
"""Score every parser's tables against the gold baseline tables, and write the aggregate.

    python3 evaluate.py --parse /tmp/vcr-baseline-tables/parse [--out results.json] [--print]

Each parser's output for a paper is a set of grids (``pdfplumber.json``: three settings; ``<name>/<pmcid>.txt``: a parser's text, whose
Markdown or HTML tables are the grids). For each gold table the grid with the most gold row labels is the parser's table for it: the
gold picks the table, so what is measured is how well the cells of the right table are read, not whether the right table was found
among the others. ``score_lib`` then decides cell by cell (variable, column, value). Nothing is judged by a model.
"""

from __future__ import annotations

import argparse
import html.parser
import json
import re
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import score_lib  # noqa: E402

PDFPLUMBER_SETTINGS = ("lines", "text", "gaps")
PARSER_LABELS = {
    "pdfplumber-lines": "pdfplumber，默认设置（靠线框切格子）",
    "pdfplumber-text": "pdfplumber，文字对齐切格子",
    "pdfplumber-gaps": "pdfplumber，不找表、把版面文字按两个以上空格切开",
    "docling": "Docling（CPU，表格输出为 Markdown）",
    "inhouse": "平台自己的文档解析接口",
}


class _Tables(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables, self._rows, self._row, self._cell, self._depth = [], None, None, None, 0

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._depth += 1
            if self._depth == 1:
                self._rows = []
        elif tag == "tr" and self._rows is not None:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(re.sub(r"\s+", " ", "".join(self._cell)).strip())
            self._cell = None
        elif tag == "tr" and self._row is not None and self._rows is not None:
            self._rows.append(self._row)
            self._row = None
        elif tag == "table":
            self._depth -= 1
            if self._depth == 0 and self._rows is not None:
                self.tables.append(self._rows)
                self._rows = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def text_tables(text: str):
    """Grids out of a parser's text: Markdown pipe tables and HTML tables."""
    grids = []
    block = []
    for line in text.splitlines() + [""]:
        stripped = line.strip()
        if stripped.startswith("|") and stripped.count("|") >= 2:
            if re.fullmatch(r"\|?[\s:|-]+\|?", stripped) and "-" in stripped:
                continue
            block.append([c.strip() for c in stripped.strip("|").split("|")])
        else:
            if len(block) >= 2:
                grids.append(block)
            block = []
    parser = _Tables()
    try:
        parser.feed(text)
    except Exception:  # noqa: BLE001 - a malformed fragment loses its table, not the paper
        pass
    grids.extend(parser.tables)
    return grids


def best_grid(gold, grids):
    best, best_cover = None, -1
    for grid in grids:
        cover = score_lib.coverage(gold, grid)
        if cover > best_cover or (cover == best_cover and best is not None and len(grid) > len(best)):
            best, best_cover = grid, cover
    return best, max(best_cover, 0)


def load_parsers(parse_dir: Path, pmcids):
    """{parser name: {pmcid: [grids]}} from whatever outputs are in the directory."""
    parsers = {}
    plumber = parse_dir / "pdfplumber.json"
    if plumber.exists():
        data = json.loads(plumber.read_text(encoding="utf-8"))
        for setting in PDFPLUMBER_SETTINGS:
            parsers["pdfplumber-" + setting] = {p: [t["grid"] for t in data.get(p, {}).get(setting, [])] for p in pmcids if p in data}
    for name in ("docling", "inhouse"):
        folder = parse_dir / name
        if not folder.is_dir():
            continue
        found = {}
        for pmcid in pmcids:
            path = folder / (pmcid + ".txt")
            if path.exists():
                found[pmcid] = text_tables(path.read_text(encoding="utf-8", errors="replace"))
        if found:
            parsers[name] = found
    return parsers


def evaluate(gold_dir: Path, parse_dir: Path):
    golds = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted(gold_dir.glob("PMC*.json"))}
    parsers = load_parsers(parse_dir, list(golds))
    results = {}
    for name, per_paper in parsers.items():
        papers = {}
        for pmcid, gold in golds.items():
            if pmcid not in per_paper:
                continue
            grid, cover = best_grid(gold, per_paper[pmcid])
            verdict = score_lib.score_table(gold, grid) if grid else {"cells": [], "rowsMatched": 0, "rows": len(gold["rows"]), "columnsFound": 0, "columns": len(gold["keys"])}
            if not grid:  # nothing came out: every gold cell is a miss
                verdict["cells"] = [{"variable": r[0], "column": gold["keys"][i], "value": v, "rowFound": False, "strict": False, "order": False, "anywhere": False}
                                    for r in gold["rows"] for i, v in enumerate(r[1:]) if str(v).strip()]
            summary = score_lib.summarize([verdict])
            papers[pmcid] = {**summary, "rowsMatched": verdict["rowsMatched"], "rows": verdict["rows"], "columnsFound": verdict["columnsFound"], "columns": verdict["columns"],
                             "gridsOffered": len(per_paper[pmcid])}
        results[name] = papers
    return golds, results


def aggregate(papers: dict):
    cells = sum(p["cells"] for p in papers.values())

    def total(field):
        return sum(p[field] for p in papers.values())

    shares = [p["strictShare"] for p in papers.values()]
    return {"papers": len(papers), "cells": cells, "strict": total("strict"), "order": total("order"), "anywhere": total("anywhere"), "rowFound": total("rowFound"),
            "strictShare": round(total("strict") / cells, 4) if cells else None, "orderShare": round(total("order") / cells, 4) if cells else None,
            "anywhereShare": round(total("anywhere") / cells, 4) if cells else None, "rowFoundShare": round(total("rowFound") / cells, 4) if cells else None,
            "paperMeanStrict": round(statistics.mean(shares), 4) if shares else None, "paperMedianStrict": round(statistics.median(shares), 4) if shares else None,
            "papersAtLeast90": sum(1 for s in shares if s >= 0.9), "papersAtLeast50": sum(1 for s in shares if s >= 0.5), "papersZero": sum(1 for s in shares if s == 0)}


def print_tables(out: dict):
    """The README's tables, from the aggregate (so no number in the README is typed by hand)."""
    names = list(out["parsers"])
    print("### 表 1：每种解析器读对了多少格（%d 篇、%d 格）\n" % (out["papers"], out["goldCells"]))
    print("| 解析器 | 严格读对（变量、组别、数值都对） | 行顺序对（不看表头，按行内顺序） | 数值在对的行里（不问列） | 找到对的行 | 每篇读对 90% 以上 | 每篇一格都没读对 |")
    print("|---|---|---|---|---|---|---|")
    for name in names:
        a = out["parsers"][name]["aggregate"]
        print("| %s | %d / %d（%.1f%%） | %.1f%% | %.1f%% | %.1f%% | %d / %d 篇 | %d 篇 |" % (
            out["parsers"][name]["label"], a["strict"], a["cells"], 100 * a["strictShare"], 100 * a["orderShare"], 100 * a["anywhereShare"], 100 * a["rowFoundShare"],
            a["papersAtLeast90"], a["papers"], a["papersZero"]))
    print("\n### 表 2：每篇论文，严格读对的格数占该表格数的比例\n")
    print("| PMC 编号 | 期刊、年份 | 表 | 行×列 | 格数 | " + " | ".join(out["parsers"][n]["label"].split("（")[0] if n.startswith("pdfplumber") else out["parsers"][n]["label"] for n in names) + " |")
    print("|---|---|---|---|---|" + "---|" * len(names))
    for paper in out["paperList"]:
        cells = []
        for name in names:
            row = out["parsers"][name]["byPaper"].get(paper["pmcid"])
            cells.append("-" if row is None else "%d%%" % round(100 * row["strictShare"]))
        print("| %s | %s %s | %s | %d×%d | %d | %s |" % (paper["pmcid"], paper["journal"], paper["year"], paper["table"], paper["goldRows"], paper["columns"], paper["goldCells"], " | ".join(cells)))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--print", dest="show", action="store_true", help="print the README tables from the written aggregate")
    parser.add_argument("--parse", required=True)
    parser.add_argument("--gold", default=str(HERE / "gold"))
    parser.add_argument("--papers", default=str(HERE / "papers.json"))
    parser.add_argument("--status", default=str(HERE / "parser-status.json"), help="what could not be run, and why")
    parser.add_argument("--out", default=str(HERE / "results.json"))
    args = parser.parse_args(argv)
    if args.show:
        print_tables(json.loads(Path(args.out).read_text(encoding="utf-8")))
        return 0
    golds, per_parser = evaluate(Path(args.gold), Path(args.parse))
    papers = json.loads(Path(args.papers).read_text(encoding="utf-8"))
    status = json.loads(Path(args.status).read_text(encoding="utf-8")) if Path(args.status).exists() else {}
    out = {"schema": "vcr-baseline-tables/1", "papers": len(golds), "goldCells": sum(1 for g in golds.values() for r in g["rows"] for v in r[1:] if str(v).strip()),
           "parsers": {name: {"label": PARSER_LABELS.get(name, name), "aggregate": aggregate(per), "byPaper": per} for name, per in per_parser.items()},
           "notRun": status, "paperList": [{k: p[k] for k in ("pmcid", "journal", "year", "licence", "page", "table", "goldRows", "goldCells", "columns")} for p in papers]}
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    for name, body in out["parsers"].items():
        a = body["aggregate"]
        print("%-18s strict %4d/%d = %.1f%%   in-order %.1f%%   value-in-row %.1f%%   row found %.1f%%   papers >=90%%: %d of %d, zero: %d" % (
            name, a["strict"], a["cells"], 100 * a["strictShare"], 100 * a["orderShare"], 100 * a["anywhereShare"], 100 * a["rowFoundShare"], a["papersAtLeast90"], a["papers"], a["papersZero"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
