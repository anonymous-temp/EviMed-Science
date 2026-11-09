"""Scoring a parsed table against a gold table, cell by cell.

A gold table is ``{"columns": [...], "keys": [...], "rows": [[label, v1, v2, ...], ...]}``: the columns as printed, one short key per
column (the words that identify it in a header), and one row per printed row that has any value. A parsed table is a grid, a list of
rows of strings, from whatever the parser calls a table.

A gold cell is (variable = the row label, column = an arm or the p-value, value). It is **right** when the variable, the column and the
value all match after normalising whitespace and the minus sign (``norm_value``); that is the strict score. Two looser scores say where
a strict miss went wrong: ``order`` (the row's values come out in the printed order, whatever the header says) and ``anywhere`` (the value is
somewhere in the right row). Nothing here is judged by a model: the match is string equality and a fixed similarity threshold on labels.

Hidden knowledge:

- A row label that repeats (Male under two headings, "Baseline" under three outcomes) is matched by occurrence: the k-th gold row with that
  label is the k-th parsed row with it. A parser that loses one of them shifts every later one, and that is counted as the loss it is.
- A label may wrap onto a second line and a parser may keep the first line as the row; a label that is a prefix of the other (at least
  eight characters) matches. A short label ("n", "I", "III", "3") must be equal.
- Footnote marks (``*``, a dagger, a section sign) are not part of a value: they are dropped on both sides. A superscript letter that a
  parser flattens into the digit's line (0.191a) is left alone and costs that cell, for every parser alike.
- Columns are found by header words, never by position: header rows are the rows above the first row whose label matched, a column's
  header is its cells in those rows joined, and a key names the column whose header words equal the key's, else the only column whose
  header contains them.
"""

from __future__ import annotations

import difflib
import re
import unicodedata

DASHES = "‐‑‒–—―−﹘﹣－"
MARKS = "*†‡§¶∗"
STOP = {"n", "group", "arm", "groups", "overall"}


def norm_value(text) -> str:
    text = unicodedata.normalize("NFKC", str(text if text is not None else ""))
    for dash in DASHES:
        text = text.replace(dash, "-")
    for mark in MARKS:
        text = text.replace(mark, "")
    return re.sub(r"\s+", "", text)


def norm_label(text) -> str:
    text = unicodedata.normalize("NFKC", str(text if text is not None else "")).lower()
    return "".join(ch for ch in text if ch.isalnum() or ch in "<>\u2264\u2265")


def labels_close(gold: str, parsed: str) -> bool:
    """Not equal but the same label with a flattened mark, a wrap or a typo: a high similarity, or one is the start of the other."""
    a, b = norm_label(gold), norm_label(parsed)
    if not a or not b or min(len(a), len(b)) <= 3:
        return False
    if difflib.SequenceMatcher(None, a, b).ratio() >= 0.92:
        return True
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    return len(short) >= 8 and long_.startswith(short)


def labels_match(gold: str, parsed: str) -> bool:
    a, b = norm_label(gold), norm_label(parsed)
    return bool(a) and (a == b or labels_close(gold, parsed))


def tokens(text) -> list:
    text = unicodedata.normalize("NFKC", str(text if text is not None else "")).lower()
    return re.findall(r"[a-z0-9]+", text)


def content_tokens(text) -> list:
    return [t for t in tokens(text) if t not in STOP and not re.fullmatch(r"\d+", t)]


def row_label(row) -> str:
    for cell in row:
        if str(cell or "").strip():
            return str(cell)
    return ""


def match_rows(gold_rows, grid):
    """For each gold row, the index of the parsed row it is, or None.

    By label, and by occurrence among rows whose label is exactly the same once normalised; only a label that no parsed row has exactly
    falls back to the close match. So "6-month" and "6 months" are two labels, and SBP is not DBP.
    """
    parsed_labels = [row_label(r) for r in grid]
    parsed_keys = [norm_label(label) for label in parsed_labels]
    seen = {}
    out = []
    for gold in gold_rows:
        key = norm_label(gold[0])
        k = seen.get(key, 0)
        seen[key] = k + 1
        hits = [i for i, other in enumerate(parsed_keys) if other and other == key]
        if not hits:
            hits = [i for i, label in enumerate(parsed_labels) if labels_close(gold[0], label)]
            k = 0 if k == 0 else k
        out.append(hits[k] if k < len(hits) else None)
    return out


def coverage(gold, grid) -> int:
    """How many gold rows find a parsed row (used to pick the right table among a parser's tables)."""
    return sum(1 for hit in match_rows(gold["rows"], grid) if hit is not None)


def find_columns(gold, grid, matched):
    """Gold column index to parsed column index, by header words."""
    first = min((i for i in matched if i is not None), default=None)
    if first is None:
        return {}
    width = max((len(r) for r in grid), default=0)
    headers = [" ".join(str(grid[r][j]) for r in range(first) if j < len(grid[r]) and grid[r][j]) for j in range(width)]
    mapping = {}
    for index, key in enumerate(gold["keys"]):
        want = set(tokens(key)) - STOP
        if not want:
            want = set(tokens(key))
        exact = [j for j, header in enumerate(headers) if set(content_tokens(header)) == want or set(tokens(header)) - STOP == want]
        if len(exact) == 1:
            mapping[index] = exact[0]
            continue
        inside = [j for j, header in enumerate(headers) if want <= set(tokens(header))]
        if len(inside) == 1:
            mapping[index] = inside[0]
        elif len(exact) > 1:
            mapping[index] = exact[0]
    return mapping


def score_table(gold, grid):
    """Per-cell verdicts of one parsed grid against one gold table."""
    rows = gold["rows"]
    matched = match_rows(rows, grid)
    columns = find_columns(gold, grid, matched)
    cells = []
    for gold_row, hit in zip(rows, matched):
        values = gold_row[1:]
        parsed = grid[hit] if hit is not None else None
        label_at = None
        if parsed is not None:
            label_at = next((j for j, cell in enumerate(parsed) if str(cell or "").strip()), 0)
        non_empty_gold = [(i, v) for i, v in enumerate(values) if str(v).strip()]
        parsed_values = [norm_value(c) for j, c in enumerate(parsed or []) if j != label_at and str(c or "").strip()]
        for position, (index, value) in enumerate(non_empty_gold):
            want = norm_value(value)
            verdict = {"variable": gold_row[0], "column": gold["keys"][index], "value": value, "rowFound": parsed is not None,
                       "strict": False, "order": False, "anywhere": False}
            if parsed is not None:
                verdict["anywhere"] = want in parsed_values
                verdict["order"] = len(parsed_values) == len(non_empty_gold) and parsed_values[position] == want
                j = columns.get(index)
                verdict["columnFound"] = j is not None
                if j is not None and j < len(parsed):
                    verdict["strict"] = norm_value(parsed[j]) == want
            cells.append(verdict)
    return {"cells": cells, "rowsMatched": sum(1 for h in matched if h is not None), "rows": len(rows), "columnsFound": len(columns), "columns": len(gold["keys"])}


def summarize(verdicts):
    cells = [c for v in verdicts for c in v["cells"]]
    total = len(cells)

    def share(field):
        return sum(1 for c in cells if c[field]) / total if total else 0.0

    return {"cells": total, "strict": sum(1 for c in cells if c["strict"]), "order": sum(1 for c in cells if c["order"]),
            "anywhere": sum(1 for c in cells if c["anywhere"]), "rowFound": sum(1 for c in cells if c["rowFound"]),
            "strictShare": round(share("strict"), 4), "orderShare": round(share("order"), 4), "anywhereShare": round(share("anywhere"), 4),
            "rowFoundShare": round(share("rowFound"), 4)}
