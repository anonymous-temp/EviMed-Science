"""The deterministic judges of the general-task baseline.

Each check reads one case's slice of a cell record (see runner/cell.mjs) and the files the turns left behind, and returns a list
of results: {id, ok (True / False / None when it could not be decided), detail, required}. A script decides everything it can
(a file opens, a cell is a formula, a value equals an independent computation, a test passes, a route was or was not taken);
the language judgement (tone, relevance, brevity) is the offline model judge's (model_judge.py), never a pattern's.

The prose detectors below (FORBIDDEN) are detectors for an offline report: they list what they matched so a reader can see
it, and they never run inside the product. They are closed lists of phrases the baseline names (a reference list, a medical
disclaimer on a business email, "we do not do that", a tool name); a model-judge pass reads the same replies.
"""
from __future__ import annotations

import gzip
import json
import math
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Any, Callable

import textio

# ---------------------------------------------------------------------------------------------------------------- tool groups
MEDICAL_RETRIEVAL = {"literature_search", "guideline_search", "clinical_trial_search", "drug_label_search", "pharmacy_reference_search",
                     "biomedical_source_search", "open_access_full_text", "dailymed_label", "frontier_search", "search_papers", "identifier_resolve",
                     "drug_term_normalize", "term_normalize", "evidence_deduplicate"}
WEB = {"web_search", "web_read", "webfetch"}
RETRIEVAL = MEDICAL_RETRIEVAL | WEB | {"kb_search", "data_source_catalog", "locate_quote", "patent_search", "get_fred_series", "get_weather"}
PLAN = {"evimed_plan", "evimed_delegate", "evimed_await", "evimed_submit_deliverable", "evimed_package_check", "evimed_revise_deliverable", "evimed_render_report"}
GROUPS = {"retrieval": RETRIEVAL, "medical_retrieval": MEDICAL_RETRIEVAL, "web": WEB, "plan": PLAN}

TOOL_NAME_WORDS = (r"literature_search|guideline_search|clinical_trial_search|drug_label_search|pharmacy_reference_search|biomedical_source_search|"
                   r"web_search|web_read|kb_search|evimed_[a-z_]+|mcp__[a-z_]+|submit_deliverable|dataset-research-scoping|clinical-evidence-synthesis")
FORBIDDEN: dict[str, re.Pattern] = {
    "references": re.compile(r"(?im)^\s*(?:#{1,4}\s*)?(?:\*\*)?(?:参考文献|参考资料|引用文献|文献引用|References?|Bibliography|Works Cited)(?:\*\*)?\s*[:：]?\s*$"),
    "medical_disclaimer": re.compile(r"仅供参考|不构成(?:任何)?(?:医疗|诊疗|医学|法律|投资)?建议|不能替代(?:专业)?(?:医生|医师|医疗)|请咨询(?:专业)?(?:医生|医师)|遵医嘱|not (?:medical|legal|financial) advice"),
    "refusal": re.compile(r"我们目前不做|目前不支持|不在(?:我们)?(?:服务|能力)?范围|超出(?:了)?(?:我的|我们的)?(?:能力|范围)|我无法(?:为您|帮您|协助)|无法(?:为您)?提供该|I (?:can't|cannot) help"),
    "tool_names": re.compile(r"\b(?:%s)\b" % TOOL_NAME_WORDS),
    "internal_terms": re.compile(r"evimed-brief|task-plan\.json|\.evimed-|claim:CLM|<evimed|state\.json"),
    "evidence_framework": re.compile(r"证据等级|纳入(?:与|和|及)?排除标准|纳入标准|排除标准|PICO|系统评价|GRADE\s*(?:证据|评级|分级)|Cochrane|偏倚风险"),
    "research_artifacts": re.compile(r"候选科研问题|科研选题|文献对照|研究问题候选|候选研究问题|文献综述|已发表文献"),
    "fabricated_references": re.compile(r"10\.\d{4,9}/\S+|PMID\s*[:：]?\s*\d{5,9}|(?:\[\d{1,2}\][^\n]*){4,}"),
}


def result(id: str, ok: bool | None, detail: str = "", required: bool = True) -> dict:
    return {"id": id, "ok": ok, "detail": detail, "required": required}


def squash(text: str) -> str:
    """Whitespace-free, comma-free text for matching numbers and dates that a writer may space differently."""
    return re.sub(r"[\s,，]", "", text)


class Ctx:
    """One case's view of a cell record."""

    def __init__(self, case: dict, record: dict, files_dir: Path, fixtures: Path, truth: dict, tree: str | None = None):
        self.case, self.record, self.files_dir, self.fixtures, self.truth, self.tree = case, record, Path(files_dir), Path(fixtures), truth, tree
        self.offset = int(record.get("turnOffsets", {}).get(case["id"], 0))
        self.all_turns = record.get("turns", [])
        self.turns = self.all_turns[self.offset: self.offset + len(case["turns"])]

    # turns / replies
    def pick(self, spec: dict) -> list[dict]:
        indexes = spec.get("turns")
        if spec.get("turn") is not None:
            indexes = [spec["turn"]]
        return [self.turns[i] for i in indexes if i < len(self.turns)] if indexes else self.turns

    def reply(self, spec: dict) -> str:
        return "\n\n".join(t.get("reply", "") for t in self.pick(spec))

    def tools(self, spec: dict) -> list[dict]:
        return [tool for t in self.pick(spec) for tool in t.get("tools", [])]

    # files the turns left (latest version of each path)
    def snapshot(self, upto: int | None = None, since: int = 0) -> dict[str, Path]:
        found: dict[str, Path] = {}
        last = len(self.all_turns) if upto is None else upto + 1
        for index in range(since, last):
            root = self.files_dir / f"ws-t{index}"
            if not root.is_dir():
                continue
            for file in sorted(root.rglob("*")):
                if file.is_file():
                    found[file.relative_to(root).as_posix()] = file
        return found

    def new_files(self, exts: list[str] | None = None) -> list[tuple[str, Path]]:
        """Files this case's turns left new or changed, newest turn last."""
        out = []
        for index in range(self.offset, self.offset + len(self.turns)):
            root = self.files_dir / f"ws-t{index}"
            if not root.is_dir():
                continue
            for file in sorted(root.rglob("*")):
                rel = file.relative_to(root).as_posix()
                if file.is_file() and (not exts or file.suffix.lower() in exts) and not rel.startswith(("deliverables/.", ".")):
                    out.append((rel, file))
        latest: dict[str, Path] = {}
        for rel, file in out:
            latest[rel] = file
        return list(latest.items())

    def transcript_text(self) -> str:
        """Every tool output of the cell's turns (from the saved transcripts), for provenance checks."""
        chunks = []
        for index in range(self.offset, self.offset + len(self.turns)):
            for file in (self.files_dir / "transcripts").glob(f"t{index}-*.jsonl.gz"):
                try:
                    for line in gzip.open(file, "rt", encoding="utf-8"):
                        message = json.loads(line)
                        for part in message.get("parts", []) if isinstance(message, dict) else []:
                            if part.get("type") == "tool":
                                chunks.append(str(part.get("output", "")))
                except (OSError, ValueError):
                    pass
        return "\n".join(chunks)

    def check_text(self, spec: dict) -> str:
        text = self.reply(spec)
        if spec.get("scope") == "reply+files":
            text += "\n" + "\n".join(textio.file_text(p) for _, p in self.new_files([".md", ".txt", ".docx", ".html", ".pdf", ".pptx", ".csv", ".py"]))
        return text


# ---------------------------------------------------------------------------------------------------------- record-level checks
def _agent_of(turn: dict) -> tuple[str, str]:
    run = turn.get("run", {})
    return str(run.get("effectiveAgentId") or ""), str(run.get("effectiveRouteReason") or "")


def chk_run_ok(spec, ctx: Ctx):
    bad = [f"turn {i}: {t.get('run', {}).get('status') or t.get('error') or 'no run'}" + (" (timed out)" if t.get("timedOut") else "")
           for i, t in enumerate(ctx.turns) if t.get("run", {}).get("status") != "succeeded" or t.get("timedOut")]
    if len(ctx.turns) < len(ctx.case["turns"]):
        bad.append(f"only {len(ctx.turns)} of {len(ctx.case['turns'])} turns ran")
    return [result("run_succeeded", not bad, "; ".join(bad) or "all turns succeeded")]


def _picked(ctx: Ctx, spec: dict) -> list[tuple[int, dict]]:
    indexes = [spec["turn"]] if spec.get("turn") is not None else spec.get("turns") or range(len(ctx.turns))
    return [(i, ctx.turns[i]) for i in indexes if i < len(ctx.turns)]


def chk_route_not(spec, ctx):
    hits = []
    for i, turn in _picked(ctx, spec):
        agent, reason = _agent_of(turn)
        for banned in spec["agents"]:
            if agent == banned or f"named:{banned}" in reason or reason.endswith(f":{banned}"):
                hits.append(f"turn {i}: routed to {banned} ({reason})")
    seen = ", ".join(f"{_agent_of(t)[0] or '-'}/{_agent_of(t)[1] or '-'}" for t in ctx.pick(spec))
    return [result(f"route_not:{'|'.join(spec['agents'])}", not hits, "; ".join(hits) or f"routes: {seen}")]


def chk_route_is(spec, ctx):
    wrong = []
    for i, turn in _picked(ctx, spec):
        agent, reason = _agent_of(turn)
        if agent != spec["agent"]:
            wrong.append(f"turn {i}: {agent or '-'}/{reason or '-'}")
    return [result(f"route_is:{spec['agent']}", not wrong, "; ".join(wrong) or "route as expected")]


def chk_route_reason_not(spec, ctx):
    pattern = re.compile(spec["pattern"])
    hits = [f"turn {i}: {_agent_of(t)[1]}" for i, t in _picked(ctx, spec) if pattern.search(_agent_of(t)[1])]
    return [result(f"route_reason_not:{spec['pattern']}", not hits, "; ".join(hits) or "no such route reason")]


def chk_tools(spec, ctx):
    calls = ctx.tools(spec)
    names = set(spec.get("names") or ())
    group = GROUPS.get(spec.get("group", ""), None)
    selected = [c for c in calls if (c["name"] in names if names else (c["name"] in group if group else True))]
    count = len(selected)
    label = spec.get("group") or ("+".join(sorted(names)) if names else "all")
    problems = []
    if "max" in spec and count > spec["max"]:
        problems.append(f"{count} calls > max {spec['max']}")
    if "min" in spec and count < spec["min"]:
        problems.append(f"{count} calls < min {spec['min']}")
    listing = ", ".join(sorted({c["name"] for c in selected})) or "none"
    return [result(f"tools:{label}", not problems, ("; ".join(problems) + f" ({listing})") if problems else f"{count} call(s): {listing}")]


def chk_wall(spec, ctx):
    wall = sum(t.get("wallMs", 0) for t in ctx.turns) / 1000
    return [result("wall_time", wall <= spec["max_s"], f"{wall:.0f}s (max {spec['max_s']}s)")]


def chk_reply_forbidden(spec, ctx):
    text = ctx.check_text(spec)
    out = []
    for kind in spec["kinds"]:
        matches = [m.group(0)[:60] for m in FORBIDDEN[kind].finditer(text)]
        out.append(result(f"forbidden:{kind}", not matches, f"found {matches[:3]}" if matches else "none found"))
    return out


def chk_reply_contains(spec, ctx):
    text = squash(ctx.check_text(spec)).lower()
    missing_all = [s for s in spec.get("all", []) if squash(s).lower() not in text]
    any_list = spec.get("any", [])
    any_ok = (not any_list) or any(squash(s).lower() in text for s in any_list)
    ok = not missing_all and any_ok
    detail = ""
    if missing_all:
        detail += f"missing {missing_all}; "
    if not any_ok:
        detail += f"none of {any_list[:6]} present"
    return [result("reply_contains", ok, detail or "present")]


def chk_reply_length(spec, ctx):
    text = ctx.reply(spec)
    n = len(re.sub(r"\s", "", text))
    ok = (spec.get("min") is None or n >= spec["min"]) and (spec.get("max") is None or n <= spec["max"])
    return [result("reply_length", ok, f"{n} characters (min {spec.get('min')}, max {spec.get('max')})")]


def chk_verification_not_unverified(spec, ctx):
    marks = [str(t.get("run", {}).get("verification")) for t in ctx.turns]
    notices = [n for t in ctx.turns for n in t.get("run", {}).get("qualityNotices", [])]
    return [result("not_marked_unverified", "unverified" not in marks, f"verification={marks}, notices={len(notices)}")]


def _registered_paths(ctx: Ctx) -> set[str]:
    paths: set[str] = set()
    for t in ctx.turns:
        run = t.get("run", {})
        for key in ("artifacts", "outputFiles", "presentedFiles"):
            paths |= {str(p) for p in run.get(key, []) or []}
    body = ctx.record.get("outputs", {}).get("body")
    items = body.get("data", {}).get("items", []) if isinstance(body, dict) else []
    paths |= {str(i.get("path")) for i in items if isinstance(i, dict)}
    return paths


def chk_registered(spec, ctx):
    paths = _registered_paths(ctx)
    exts = [e.lower() for e in spec.get("ext", [])]
    kept = [p for p in paths if not exts or Path(p).suffix.lower() in exts]
    deliverable = [t.get("run", {}).get("artifactCounts", {}).get("deliverable", 0) for t in ctx.turns]
    works = ctx.record.get("outputs", {}).get("body", {})
    works_items = works.get("data", {}).get("items", []) if isinstance(works, dict) else []
    ok = len(kept) >= spec.get("min", 1)
    return [result("file_registered", ok, f"registered paths {sorted(kept)[:4] or 'none'}; deliverable count {deliverable}; works list {len(works_items)} item(s)")]


def chk_file_new(spec, ctx):
    exts = [e.lower() for e in spec.get("ext", [])]
    files = ctx.new_files(exts)
    count = len(files)
    ok = (count >= spec.get("min", 0)) and (spec.get("max") is None or count <= spec["max"])
    return [result(f"file_new:{'/'.join(exts)}", ok, f"{count} file(s): {[r for r, _ in files][:5]}")]


# ------------------------------------------------------------------------------------------------------------------- Word files
def _any_candidate(files, predicate: Callable[[Path], tuple[bool, str]]):
    notes = []
    for rel, path in reversed(files):
        try:
            ok, note = predicate(path)
        except Exception as error:  # a file that cannot be read fails the predicate and says why
            ok, note = False, f"{type(error).__name__}: {str(error)[:120]}"
        notes.append(f"{rel}: {note}")
        if ok:
            return True, f"{rel}: {note}"
    return False, " | ".join(notes) or "no candidate file"


def chk_docx(spec, ctx):
    files = ctx.new_files([".docx"])

    def check(path: Path):
        doc = textio.docx_open(path)
        text = squash(textio.docx_text(path))
        problems = []
        headings = [p for p in doc.paragraphs if p.style is not None and re.match(r"(?i)^(heading|title|标题)", p.style.name or "") and p.text.strip()]
        if len(headings) < spec.get("headings_min", 0):
            problems.append(f"{len(headings)} heading(s) < {spec['headings_min']}")
        cols = max((max((len(r) for r in t), default=0) for t in textio.docx_tables(path)), default=0)
        if cols < spec.get("table_cols_min", 0):
            problems.append(f"widest table has {cols} column(s) < {spec['table_cols_min']}")
        missing = [s for s in spec.get("contains_all", []) if squash(s) not in text]
        if missing:
            problems.append(f"missing {missing}")
        for group in spec.get("contains_any_group", []):
            if not any(squash(v) in text for v in group):
                problems.append(f"none of {group[:3]}")
        return (not problems), "; ".join(problems) or f"opens; {len(headings)} headings; widest table {cols} columns"

    ok, note = _any_candidate(files, check)
    return [result("docx", ok, note)]


def chk_docx_edit(spec, ctx):
    original = textio.docx_open(ctx.fixtures / spec["original"])
    candidates = [(rel, p) for rel, p in ctx.new_files([".docx"])]

    def check(path: Path):
        out = textio.docx_open(path)
        problems = []
        if len(out.paragraphs) != len(original.paragraphs):
            return False, f"{len(out.paragraphs)} paragraphs vs {len(original.paragraphs)} in the original"
        changed = []
        style_drift = 0
        for a, b in zip(original.paragraphs, out.paragraphs):
            if a.text != b.text:
                changed.append((a.text, b.text))
            if (a.style.name if a.style is not None else None) != (b.style.name if b.style is not None else None) or _ppr(a) != _ppr(b):
                style_drift += 1
        if len(changed) != 1:
            problems.append(f"{len(changed)} paragraphs differ (expected exactly 1)")
        elif changed[0][0].replace(spec["old"], spec["new"]) != changed[0][1] or spec["old"] not in changed[0][0]:
            problems.append(f"the one changed paragraph is not the {spec['old']} -> {spec['new']} edit: {changed[0][1][:80]!r}")
        if style_drift:
            problems.append(f"{style_drift} paragraph style/numbering properties changed")
        for i, (sa, sb) in enumerate(zip(original.sections, out.sections)):
            if [p.text for p in sa.header.paragraphs] != [p.text for p in sb.header.paragraphs] or [p.text for p in sa.footer.paragraphs] != [p.text for p in sb.footer.paragraphs]:
                problems.append(f"header/footer of section {i} changed")
        if len(original.tables) != len(out.tables):
            problems.append("table count changed")
        return (not problems), "; ".join(problems) or "exactly one paragraph differs and it is the requested edit; styles, numbering, header and footer kept"

    ok, note = _any_candidate(candidates, check)
    return [result("docx_edit_only_the_clause", ok, note)]


def _ppr(paragraph) -> str:
    properties = paragraph._p.pPr
    return properties.xml if properties is not None else ""


# ---------------------------------------------------------------------------------------------------------------- Excel files
HEADER_PROFIT = re.compile(r"利润|profit|净利", re.I)
HEADER_TOTAL = re.compile(r"合计|总计|total|sum", re.I)
HEADER_REVENUE = re.compile(r"收入|营收|revenue|income|sales", re.I)
MONTH = re.compile(r"(?:^|[^\d])(1[0-2]|[1-9])\s*月|^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)", re.I)


def _is_formula(value) -> bool:
    return isinstance(value, str) and value.startswith("=")


def chk_xlsx_budget(spec, ctx):
    files = ctx.new_files([".xlsx", ".xlsm"])

    def check(path: Path):
        wb = textio.xlsx_load(path)
        best = ""
        for ws in wb.worksheets:
            grid = [[c for c in row] for row in ws.iter_rows()]
            labels = {}
            for row in grid:
                for cell in row:
                    if isinstance(cell.value, str):
                        labels.setdefault(cell.value.strip(), []).append(cell)
            # Labels are short cells ("利润", "Profit", "合计"); a sentence that mentions profit is a note, not an anchor.
            short = {t: cells for t, cells in labels.items() if len(t) <= 14}
            profit_cells = [c for text, cells in short.items() if HEADER_PROFIT.search(text) and not HEADER_TOTAL.fullmatch(text) and not re.search(r"率|margin|rate", text, re.I) for c in cells]
            if not profit_cells:
                best = best or f"{ws.title}: no profit label"
                continue
            # Months as rows (profit is a column) or as columns (profit is a row): take the anchor with the most formulas.
            scored = []
            for anchor in profit_cells:
                column_values = [row[anchor.column - 1] for row in grid[anchor.row:] if len(row) >= anchor.column]
                row_values = [c for c in grid[anchor.row - 1][anchor.column:]]
                scored.append((sum(1 for c in column_values if _is_formula(c.value)), sum(1 for c in row_values if _is_formula(c.value)), column_values, row_values))
            col_formulas, row_formulas, column_values, row_values = max(scored, key=lambda x: max(x[0], x[1]))
            col_literals = [c.coordinate for c in column_values if isinstance(c.value, (int, float)) and not isinstance(c.value, bool)]
            row_literals = [c.coordinate for c in row_values if isinstance(c.value, (int, float)) and not isinstance(c.value, bool)]
            if col_formulas >= row_formulas:
                formulas, literals, orient = col_formulas, col_literals, "profit column"
            else:
                formulas, literals, orient = row_formulas, row_literals, "profit row"
            # month rows/columns of the sheet
            month_cells = [c for row in grid for c in row if isinstance(c.value, str) and MONTH.search(c.value.strip())]
            numeric_months = len({c.value for c in month_cells})
            if numeric_months < spec["months"]:
                numeric_months = max(numeric_months, _count_month_numbers(grid))
            has_total = any(HEADER_TOTAL.search(str(c.value)) for row in grid for c in row if isinstance(c.value, str))
            total_formula = any(_is_formula(c.value) and re.search(r"(?i)sum\(", c.value) for row in grid for c in row)
            cost_labels = {t for t in short if re.search(r"成本|费用|房租|人力|营销|工资|采购|cost|expense|rent|marketing|payroll", t, re.I)}
            number_formats = {c.number_format for row in grid for c in row if isinstance(c.value, (int, float)) or _is_formula(c.value)} - {"General"}
            problems = []
            if formulas < spec["months"]:
                problems.append(f"{formulas} profit formulas in the {orient} (need >= {spec['months']}); literals {literals[:3]}")
            elif literals and len(literals) > 1:
                problems.append(f"profit {orient} also holds literal numbers {literals[:3]}")
            if numeric_months < spec["months"]:
                problems.append(f"{numeric_months} month labels")
            if not (has_total and total_formula):
                problems.append("no total row/column with SUM formulas" if has_total else "no total label")
            if len(cost_labels) < spec.get("min_cost_columns", 3):
                problems.append(f"{len(cost_labels)} cost labels")
            if not number_formats:
                problems.append("every number cell has the General format")
            if not problems:
                return True, f"{ws.title}: {formulas} profit formulas ({orient}), {numeric_months} months, totals by SUM, {len(cost_labels)} cost labels, formats {sorted(number_formats)[:2]}"
            best = f"{ws.title}: " + "; ".join(problems)
        return False, best or "no sheet"

    ok, note = _any_candidate(files, check)
    return [result("xlsx_budget", ok, note)]


def _count_months(values) -> int:
    return len({str(v) for v in values if isinstance(v, str) and MONTH.search(v)})


def _count_month_numbers(grid) -> int:
    for row in grid:
        numbers = [c.value for c in row if isinstance(c.value, int) and 1 <= c.value <= 12]
        if len(set(numbers)) >= 12:
            return 12
    for col in zip(*grid) if grid else []:
        numbers = [c.value for c in col if isinstance(c.value, int) and 1 <= c.value <= 12]
        if len(set(numbers)) >= 12:
            return 12
    return 0


def sales_expected(fixtures: Path) -> dict[tuple[str, int], float]:
    import pandas as pd

    df = pd.read_excel(fixtures / "sales.xlsx")
    df["m"] = pd.to_datetime(df["日期"]).dt.month
    grouped = df.groupby(["地区", "m"])["销售额"].sum()
    return {(region, int(month)): round(float(value), 2) for (region, month), value in grouped.items()}


def chk_xlsx_pivot(spec, ctx):
    expected = sales_expected(ctx.fixtures)
    files = ctx.new_files([".xlsx", ".xlsm"])

    def check(path: Path):
        import zipfile

        charts = len([n for n in zipfile.ZipFile(path).namelist() if re.match(r"xl/charts/chart\d+\.xml$", n)])
        wb = textio.xlsx_load(path, data_only=True)
        formulas_wb = textio.xlsx_load(path)
        has_formula = any(_is_formula(c.value) for ws in formulas_wb.worksheets for row in ws.iter_rows() for c in row)
        if has_formula and any(c.value is None for ws in formulas_wb.worksheets if ws.max_row < 400 for row in ws.iter_rows() for c in row if _is_formula(c.value) and wb[ws.title][c.coordinate].value is None):
            wb = textio.xlsx_load(textio.recalculated(path), data_only=True)
        values = []
        sheet_names = []
        for ws in wb.worksheets:
            if ws.max_row > 400:  # the 5,000-row source sheet
                continue
            sheet_names.append(ws.title)
            values += [float(c.value) for row in ws.iter_rows() for c in row if isinstance(c.value, (int, float)) and not isinstance(c.value, bool)]
        if not sheet_names:
            return False, "no new summary sheet (every sheet is the long source sheet)"
        pool = sorted(values)
        import bisect

        def present(target: float) -> bool:
            i = bisect.bisect_left(pool, target - 0.011)
            return i < len(pool) and abs(pool[i] - target) <= 0.011

        matched = sum(1 for v in expected.values() if present(v))
        ratio = matched / len(expected)
        problems = []
        if ratio < 0.98:
            problems.append(f"{matched}/{len(expected)} region-month sums found in {sheet_names}")
        if charts < 1:
            problems.append("no chart part in the workbook")
        return (not problems), "; ".join(problems) or f"{matched}/{len(expected)} sums match the independent computation in {sheet_names}; {charts} chart(s)"

    ok, note = _any_candidate(files, check)
    return [result("xlsx_pivot_matches_independent_sums", ok, note)]


def _norm_cell(value) -> str:
    text = "" if value is None else str(value).strip().replace(",", "")
    try:
        number = float(text)
        return f"{number:g}"
    except ValueError:
        return text


def chk_xlsx_table(spec, ctx):
    table = ctx.truth["report"]["table"]
    files = ctx.new_files([".xlsx", ".xlsm", ".csv"])

    def check(path: Path):
        if path.suffix.lower() == ".csv":
            import csv

            rows = [[_norm_cell(v) for v in r] for r in csv.reader(path.open(encoding="utf-8-sig"))]
            sheets = {"csv": rows}
        else:
            wb = textio.xlsx_load(path, data_only=True)
            sheets = {ws.title: [[_norm_cell(c) for c in row] for row in ws.iter_rows(values_only=True)] for ws in wb.worksheets}
        expected = [[_norm_cell(v) for v in row] for row in table]
        for name, rows in sheets.items():
            found = 0
            for want in expected:
                for row in rows:
                    it = iter(row)
                    if all(any(cell == w for cell in it) for w in want):
                        found += 1
                        break
            if found == len(expected):
                return True, f"{name}: all {found} rows of the page-5 table found cell for cell"
        return False, f"best sheet matched fewer than {len(expected)} table rows"

    ok, note = _any_candidate(files, check)
    return [result("xlsx_table_equals_page5_table", ok, note)]


NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?%?")


def numbers_in(text: str, min_digits: int = 2) -> list[str]:
    out = []
    for m in NUMBER.finditer(text):
        token = m.group(0).rstrip(",")
        digits = re.sub(r"\D", "", token)
        if len(digits) >= min_digits or "." in token or token.endswith("%"):
            out.append(token)
    return out


def chk_pdf_summary(spec, ctx):
    source = squash(textio.pdf_text(ctx.fixtures / spec["source"]))
    text = ctx.reply(spec)
    for rel, path in ctx.new_files([".md", ".txt", ".docx", ".html", ".pdf"]):
        text += "\n" + textio.file_text(path)
    tokens = sorted({t for t in numbers_in(text, 2) if not re.fullmatch(r"(?:19|20)\d\d", t)})
    found = [t for t in tokens if squash(t) in source or squash(t.rstrip("%")) in source]
    ratio = len(found) / len(tokens) if tokens else 0
    # Five facts picked from the summary must each be in the source; a derived figure (a total, a share) is not in the source and
    # is not held against the summary, so the bar is five found facts and three quarters of the numbers found.
    ok = len(found) >= spec["min_numbers"] and ratio >= spec["min_found_ratio"]
    missing = [t for t in tokens if t not in found][:6]
    return [result("summary_facts_in_source", ok, f"{len(found)}/{len(tokens)} numeric facts of the summary are in the PDF; not found (derived or wrong) {missing}")]


def chk_numbers_from_source(spec, ctx):
    source = squash(textio.pdf_text(ctx.fixtures / spec["source"]))
    files = ctx.new_files([".pptx"] if spec["from"] == "pptx" else None)

    def check(path: Path):
        tokens = sorted(set(numbers_in(textio.file_text(path), 2)))
        # slide numbers and the deck's own counts are not clinical figures
        found = [t for t in tokens if squash(t) in source]
        ratio = len(found) / len(tokens) if tokens else 1
        missing = [t for t in tokens if t not in found][:8]
        return ratio >= spec["min_found_ratio"], f"{len(found)}/{len(tokens)} numbers in the deck are in the PDF; not found {missing}"

    ok, note = _any_candidate(files, check)
    return [result("numbers_from_source", ok, note)]


# ---------------------------------------------------------------------------------------------------------------- PowerPoint
def chk_pptx(spec, ctx):
    files = ctx.new_files([".pptx"])

    def check(path: Path):
        info = textio.pptx_info(path)
        slides = info["slides"]
        problems = []
        n = len(slides)
        if "slides_min" in spec and n < spec["slides_min"]:
            problems.append(f"{n} slides < {spec['slides_min']}")
        if "slides_exact" in spec and n != spec["slides_exact"]:
            problems.append(f"{n} slides != {spec['slides_exact']}")
        if spec.get("titles_each"):
            untitled = [i + 1 for i, s in enumerate(slides) if not (s["title"] or (s["texts"] and len(s["texts"][0]) <= 60 and len(s["texts"]) >= 2))]
            if untitled:
                problems.append(f"slides without a title: {untitled}")
        if spec.get("bullets_each_min"):
            thin = [i + 1 for i, s in enumerate(slides) if len(s["texts"]) + s["tables"] < spec["bullets_each_min"]]
            if thin:
                problems.append(f"slides with no points: {thin}")
        visuals = info["chart_parts"] + sum(s["charts"] for s in slides) + sum(s["pictures"] for s in slides) + info["media"]
        if visuals < spec.get("charts_min", 0):
            problems.append(f"{visuals} chart/picture parts < {spec['charts_min']}")
        if spec.get("converts"):
            pages = len(textio.pdf_pages(textio.to_pdf(path)))
            if pages != n:
                problems.append(f"LibreOffice renders {pages} pages for {n} slides")
        return (not problems), "; ".join(problems) or f"{n} slides, {sum(1 for s in slides if s['title'])} with a title placeholder, {visuals} chart/picture part(s), renders"

    ok, note = _any_candidate(files, check)
    return [result("pptx", ok, note)]


def _slide_dark(slide: dict, master_bg: str | None, theme_dark: bool | None) -> bool | None:
    bg = slide["background"] or master_bg
    if bg:
        return textio.luminance(bg) < 0.4
    return theme_dark


def chk_pptx_edit(spec, ctx):
    base_turn = spec.get("base_turn", 0)
    base_files = [(rel, p) for rel, p in (ctx.snapshot(upto=base_turn).items()) if p.suffix.lower() == ".pptx"]
    final_files = [(rel, p) for rel, p in ctx.snapshot().items() if p.suffix.lower() == ".pptx"]
    if not base_files or not final_files:
        return [result("pptx_edit", False, "no .pptx before or after the edit")]
    base = textio.pptx_info(base_files[-1][1])
    best = "no candidate"
    for rel, path in reversed(final_files):
        final = textio.pptx_info(path)
        problems = []
        nb, nf = len(base["slides"]), len(final["slides"])
        if nf != nb + spec.get("slides_delta", 1):
            problems.append(f"{nf} slides after, {nb} before (expected +{spec.get('slides_delta', 1)})")
        final_texts = [squash(s["all_text"]) for s in final["slides"]]
        unchanged = 0
        others = [i for i in range(nb) if i != 2]
        for i in others:
            want = squash(base["slides"][i]["all_text"])
            if any(want and want == t for t in final_texts):
                unchanged += 1
        if others and unchanged < len(others) - 1:
            problems.append(f"only {unchanged}/{len(others)} other slides keep their text")
        if nb >= 3 and nf >= 4:
            words = set(re.findall(r"\w+", base["slides"][2]["all_text"]))
            after = set(re.findall(r"\w+", final["slides"][2]["all_text"] + " " + final["slides"][3]["all_text"]))
            kept = len(words & after) / len(words) if words else 1
            if kept < 0.8:
                problems.append(f"the split slide keeps {kept:.0%} of its words")
        if spec.get("dark"):
            marks = [_slide_dark(s, final["master_background"], final["theme_dark"]) for s in final["slides"]]
            dark = sum(1 for m in marks if m)
            if dark < 0.7 * nf:
                problems.append(f"{dark}/{nf} slides read as dark (backgrounds {[s['background'] for s in final['slides']][:4]}, master {final['master_background']}, theme_dark {final['theme_dark']})")
        if not problems:
            return [result("pptx_edit", True, f"{rel}: {nb}->{nf} slides, {unchanged}/{len(others)} others unchanged, dark scheme")]
        best = f"{rel}: " + "; ".join(problems)
    return [result("pptx_edit", False, best)]


# ----------------------------------------------------------------------------------------------------------------------- code
def _run(cmd, cwd, timeout=90):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def _dir_state(directory: Path) -> dict[str, str]:
    import hashlib

    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(directory.iterdir()) if p.is_file()}


def chk_rename_script(spec, ctx):
    expected_dates = ctx.truth["photos"]
    scripts = ctx.new_files([".py"])

    def attempts(script: Path, directory: Path, flags: list[str]):
        yield [sys.executable, str(script), str(directory), *flags], directory
        help_text = ""
        try:
            help_text = _run([sys.executable, str(script), "--help"], directory, 30).stdout
        except Exception:
            pass
        for option in re.findall(r"(--(?:dir|directory|folder|path|input|source|src|root)[\w-]*)", help_text):
            yield [sys.executable, str(script), option, str(directory), *flags], directory
        yield [sys.executable, str(script), *flags], directory

    def check(script: Path):
        problems = []
        applied_with = None
        for mode in ("dry", "real"):
            work = Path(tempfile.mkdtemp(prefix="gt-photos-"))
            shutil.copytree(ctx.fixtures / "photos", work / "photos")
            directory = work / "photos"
            before = _dir_state(directory)
            flags = ["--dry-run"] if mode == "dry" else []
            outcome = None
            for cmd, cwd in attempts(script, directory, flags):
                try:
                    done = _run(cmd, cwd)
                except subprocess.TimeoutExpired:
                    continue
                if done.returncode == 0:
                    outcome = done
                    break
            if outcome is None:
                return False, f"the script did not run cleanly on the fixture folder ({mode}); tried the folder as argument, as an option and as cwd"
            after = _dir_state(directory)
            if mode == "real" and after == before:
                # A script that previews by default and renames under an explicit flag (--apply, --execute, ...) is still a script
                # that renames; the baseline notes it, because the request said --dry-run is the option.
                help_text = _run([sys.executable, str(script), "--help"], directory, 30).stdout
                apply_flags = re.findall(r"(--(?:apply|execute|exec|run|commit|yes|real|write|rename|go|do-it|no-dry-run)\b)", help_text)
                for flag in apply_flags[:2]:
                    for cmd, cwd in attempts(script, directory, [flag]):
                        try:
                            done = _run(cmd, cwd)
                        except subprocess.TimeoutExpired:
                            continue
                        if done.returncode == 0:
                            applied_with = flag
                            break
                    after = _dir_state(directory)
                    if after != before:
                        break
            if mode == "dry":
                if after != before:
                    problems.append("--dry-run changed the folder")
            else:
                import hashlib

                names = list(after)
                pattern = re.compile(r"^(\d{8})_(\d+)\.jpe?g$", re.I)
                wrong = [n for n in names if not pattern.match(n)]
                if wrong:
                    problems.append(f"names not YYYYMMDD_n.jpg: {wrong[:3]}")
                else:
                    by_hash = {digest: name for name, digest in before.items()}
                    for name, digest in after.items():
                        original = by_hash.get(digest)
                        if original is None:
                            problems.append("file contents changed")
                            break
                        if pattern.match(name).group(1) != expected_dates[original]:
                            problems.append(f"{original} became {name}, expected date {expected_dates[original]}")
                            break
                    if len(set(after)) != len(after):
                        problems.append("two files share a name")
        return (not problems), "; ".join(problems) or ("dry-run left the folder alone; the real run renamed all six photos by their EXIF date" + (f" (only with {applied_with}: the plain run previews)" if applied_with else ""))

    ok, note = _any_candidate(scripts, check)
    return [result("rename_script_works", ok, note)]


def chk_project_tests(spec, ctx):
    work = Path(tempfile.mkdtemp(prefix="gt-project-"))
    shutil.copytree(ctx.fixtures / spec["dir"], work / spec["dir"])
    root = work / spec["dir"]
    for rel, path in ctx.snapshot().items():
        if rel.startswith(spec["dir"] + "/"):
            target = work / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(path, target)
    import hashlib

    test_before = hashlib.sha256((ctx.fixtures / spec["dir"] / spec["test_file"]).read_bytes()).hexdigest()
    test_after = hashlib.sha256((root / spec["test_file"]).read_bytes()).hexdigest()
    done = _run([sys.executable, "-m", "unittest", "discover", "-s", str(root), "-p", "test_*.py"], root)
    passed = done.returncode == 0
    tail = (done.stderr or done.stdout).strip().splitlines()[-1:] or [""]
    return [result("project_tests_pass", passed, f"unittest exit {done.returncode}: {tail[0][:120]}"),
            result("project_test_file_unchanged", test_before == test_after, "test file identical to the fixture" if test_before == test_after else "the test file was modified")]


def churn_counts(fixtures: Path, thresholds) -> dict[int, int]:
    import pandas as pd

    df = pd.read_csv(fixtures / "orders.csv", parse_dates=["order_date"])
    last = df.groupby("customer_id").order_date.max()
    asof = df.order_date.max()
    return {int(t): int(((asof - last).dt.days > t).sum()) for t in thresholds}


def chk_churn(spec, ctx):
    counts = churn_counts(ctx.fixtures, spec["thresholds"])
    reply = ctx.reply(spec)
    for rel, path in ctx.new_files([".md", ".txt", ".html"]):
        reply += "\n" + textio.file_text(path)
    numbers = {int(n.replace(",", "")) for n in re.findall(r"\d[\d,]*", reply) if n.replace(",", "").isdigit()}
    total = 1200
    hit = {t: c for t, c in counts.items() if c in numbers or round(100 * c / total) in numbers}
    stated = re.search(r"\d+\s*(?:天|days?)", reply) is not None
    out = [result("churn_count_matches_a_definition", bool(hit), f"counts by threshold {counts}; reply states {sorted(hit.items()) or 'none of them'}"),
           result("churn_definition_stated_in_days", stated, "a day-count definition appears" if stated else "no 'N days' definition found", required=False)]
    scripts = ctx.new_files([".py"])
    if scripts:
        rel, path = scripts[-1]
        work = Path(tempfile.mkdtemp(prefix="gt-churn-"))
        shutil.copy(ctx.fixtures / "orders.csv", work / "orders.csv")
        shutil.copy(path, work / Path(rel).name)
        try:
            done = _run([sys.executable, Path(rel).name], work, 120)
            reproduced = done.returncode == 0 and any(str(c) in done.stdout for c in counts.values())
            out.append(result("churn_script_recomputes", reproduced, f"{rel}: exit {done.returncode}; its output {'contains' if reproduced else 'does not contain'} a churn count", required=False))
        except Exception as error:
            out.append(result("churn_script_recomputes", False, f"{rel}: {type(error).__name__}", required=False))
    else:
        out.append(result("churn_script_recomputes", None, "no script was left to rerun", required=False))
    return out


# ------------------------------------------------------------------------------------------------------------------------- web
URL = re.compile(r"https?://[^\s)\]>\"'，。；、]+")


def _urls(text: str) -> list[str]:
    seen = []
    for m in URL.finditer(text):
        u = m.group(0).rstrip(".,;:")
        if u not in seen:
            seen.append(u)
    return seen


def _fetch(url: str, timeout: int = 8) -> int | None:
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (general-task-eval link check)"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except Exception:
        return None


def chk_links(spec, ctx):
    urls = _urls(ctx.check_text(spec))
    out = []
    out.append(result("links_present", len(urls) >= spec.get("min", 1), f"{len(urls)} link(s): {urls[:3]}"))
    if spec.get("official_suffix"):
        hosts = [re.sub(r"^https?://([^/]+).*", r"\1", u) for u in urls]
        good = [h for h in hosts if h.endswith(spec["official_suffix"])]
        out.append(result(f"official_link:{spec['official_suffix']}", bool(good), f"hosts {sorted(set(hosts))[:5]}"))
    if spec.get("reachable_ratio_min") is not None and urls:
        sample = urls[:12]
        statuses = [(_fetch(u)) for u in sample]
        reached = [s for s in statuses if s is not None]
        if not reached:
            out.append(result("links_reachable", None, "no link could be fetched from this host (offline?)", required=False))
        else:
            ok_count = sum(1 for s in statuses if s is not None and s < 400)
            ratio = ok_count / len(sample)
            out.append(result("links_reachable", ratio >= spec["reachable_ratio_min"], f"{ok_count}/{len(sample)} sampled links answer below 400 (statuses {statuses})"))
    return out


def chk_web_unavailable_honest(spec, ctx):
    reply = ctx.reply(spec)
    says = re.search(r"无法(?:联网|访问|检索|搜索|查询|获取)|未能(?:查到|检索|获取|访问)|查不到|没有查到|搜索(?:功能)?(?:不可用|失败|受限)|暂时无法|不可用|无法确认|unable to|could not (?:find|retrieve|search)", reply) is not None
    searched = [t for t in ctx.tools(spec) if t["name"] in WEB]
    failed = [t for t in searched if t.get("error")]
    return [result("says_it_could_not_look_up", says, "the reply says the lookup was not possible" if says else "the reply never says the lookup failed or was unavailable"),
            result("web_tool_failure_observed", None, f"{len(searched)} web call(s), {len(failed)} errored", required=False)]


def _node_schedule():
    import urllib.request as ur

    index = json.loads(ur.urlopen(ur.Request("https://nodejs.org/dist/index.json", headers={"User-Agent": "eval"}), timeout=15).read())
    schedule = json.loads(ur.urlopen(ur.Request("https://raw.githubusercontent.com/nodejs/Release/main/schedule.json", headers={"User-Agent": "eval"}), timeout=15).read())
    return index, schedule


def chk_node_lts(spec, ctx):
    from datetime import date

    try:
        index, schedule = _node_schedule()
    except Exception as error:
        return [result("node_lts_matches_official_site", None, f"could not reach nodejs.org ({type(error).__name__})", required=False)]
    today = date.today().isoformat()
    supported = {}
    for key, row in schedule.items():
        lts, end = row.get("lts"), row.get("end")
        if lts and end and lts <= today <= end:
            supported[key.lstrip("v")] = end
    reply = ctx.reply(spec)
    ok_lines = []
    for major, end in supported.items():
        if re.search(rf"(?<![\d.]){major}(?![\d])", reply) and end[:4] in reply:
            ok_lines.append(f"v{major} (ends {end})")
    return [result("node_lts_matches_official_site", bool(ok_lines), f"official LTS lines today: {supported}; the reply matches {ok_lines or 'none of them with their end year'}")]


def _page_count(path: Path) -> int | None:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return len(textio.pdf_pages(path))
    if suffix == ".docx":
        return len(textio.pdf_pages(textio.to_pdf(path)))
    return None


def chk_report_pages(spec, ctx):
    files = ctx.new_files([".docx", ".pdf", ".md", ".html"])

    def check(path: Path):
        pages = _page_count(path)
        if pages is not None:
            return pages <= spec["max"], f"{pages} page(s) (max {spec['max']})"
        chars = len(re.sub(r"\s", "", textio.file_text(path)))
        return chars <= 6500, f"{chars} characters (about {chars / 1800:.1f} pages; max {spec['max']})"

    if not files:  # no file was left: the reply is the report, judged by its length (the missing file is the file check's finding)
        chars = len(re.sub(r"\s", "", ctx.reply(spec)))
        return [result("report_within_pages", chars <= 6500, f"no file; the reply is {chars} characters (about {chars / 1800:.1f} pages; max {spec['max']})")]
    ok, note = _any_candidate(files, check)
    return [result("report_within_pages", ok, note)]


def chk_reply_or_file_mentions(spec, ctx):
    text = ctx.reply(spec)
    for _, path in ctx.new_files([".md", ".txt", ".docx", ".pdf", ".html"]):
        text += "\n" + textio.file_text(path)
    low = text.lower()
    missing = [s for s in spec.get("all", []) if s.lower() not in low]
    any_ok = (not spec.get("any")) or any(s.lower() in low for s in spec["any"])
    return [result("report_mentions", not missing and any_ok, f"missing {missing}" if missing else ("recommendation word present" if any_ok else "no recommendation word"))]


# -------------------------------------------------------------------------------------------------------------------- language
def cjk_count(text: str) -> int:
    return len(re.findall(r"[一-鿿]", text))


def chk_translation(spec, ctx):
    turn = ctx.pick(spec)
    text = turn[0].get("reply", "") if turn else ""
    letters = len(re.findall(r"[A-Za-z]", text))
    cjk = cjk_count(text)
    problems = []
    if spec["to"] == "en":
        if letters < spec["min_chars"]:
            problems.append(f"{letters} Latin letters < {spec['min_chars']}")
        if cjk > 0.1 * max(1, letters):
            problems.append(f"{cjk} CJK characters left in an English translation")
    else:
        if cjk < spec["min_chars"]:
            problems.append(f"{cjk} CJK characters < {spec['min_chars']}")
    missing = [n for n in spec.get("keep_numbers", []) if n not in text]
    if missing:
        problems.append(f"numbers not carried over: {missing}")
    return [result(f"translation_{spec['to']}", not problems, "; ".join(problems) or f"{letters} letters, {cjk} CJK characters; numbers kept")]


def chk_numbers_preserved(spec, ctx):
    reply = ctx.reply(spec)
    missing = [n for n in spec["numbers"] if n not in reply]
    out = [result("numbers_byte_for_byte", not missing, f"missing {missing}" if missing else f"all {len(spec['numbers'])} numbers present exactly")]
    if spec.get("no_new_numbers"):
        source = set(numbers_in(spec["source"], 1))
        new = [t for t in numbers_in(reply, 1) if t not in source and t.rstrip("%") not in {s.rstrip("%") for s in source}]
        out.append(result("no_numbers_added", not new, f"numbers not in the original: {new[:5]}" if new else "no new numbers"))
    return out


def _items(text: str) -> int:
    return len(re.findall(r"(?m)^\s*(?:[-*•]\s+|\d+[.、)）]\s*|[一二三]、|[①②③])\S", text))


def _length(text: str) -> int:
    return len(re.sub(r"[\s#*>`\-]", "", text))


def chk_weekly(spec, ctx):
    t = ctx.turns
    out = []
    if len(t) < 3:
        return [result("weekly_three_turns", False, f"{len(t)} of 3 turns ran")]
    shortened, corrected = t[1].get("reply", ""), t[2].get("reply", "")
    out.append(result("shortened_to_200_chars_and_three_items", _length(shortened) <= 240 and _items(shortened) == 3, f"{_length(shortened)} characters, {_items(shortened)} items"))
    out.append(result("final_contains_37_percent", "37%" in corrected or "37 %" in corrected, "37% present" if "37%" in corrected else "37% not in the final text"))
    out.append(result("final_keeps_the_limits", _length(corrected) <= 240 and _items(corrected) == 3, f"{_length(corrected)} characters, {_items(corrected)} items"))
    ask = re.compile(r"请(?:你|您)?(?:提供|补充|告诉|发给我|说明)|请问|能否(?:提供|告知)|需要(?:你|您)(?:提供|补充)|麻烦(?:你|您)")
    asked = [m.group(0) for r in (shortened, corrected) for m in ask.finditer(r)]
    out.append(result("does_not_ask_again_for_given_information", not asked, f"asks {asked[:3]}" if asked else "no repeated question"))
    return out


# ------------------------------------------------------------------------------------------------------------ schedule / knowledge
def chk_schedule(spec, ctx):
    s = ctx.record.get("schedule") or {}
    agendas = s.get("agendas")
    items = agendas if isinstance(agendas, list) else (agendas or {}).get("items", []) if isinstance(agendas, dict) else []
    out = [result("task_created", bool(items), f"{len(items)} task(s) in the project; notes {s.get('notes')}")]
    executions = s.get("executions") or []
    statuses = [e.get("status") for e in executions]
    finished = [e for e in executions if e.get("status") not in ("queued", "running", "pending", "planned", "dispatching", "starting", "waiting", "scheduled", "verifying", "canceled", "cancelled", None, "")]
    out.append(result("execution_ran_to_the_end", bool(finished), f"{len(executions)} execution(s), statuses {statuses}"))
    text = "\n".join(str(e.get("reply") or "") for e in executions)
    exec_root = ctx.files_dir / "ws-execution"
    if exec_root.is_dir():
        for file in sorted(exec_root.rglob("*")):
            if file.is_file():
                text += "\n" + textio.file_text(file)
    urls = _urls(text)
    out.append(result("execution_output_has_links", len(urls) >= spec["min_items_links"], f"{len(urls)} link(s) in what the execution produced ({[e.get('files') for e in executions][:1]})"))
    agents = [str(e.get("agent") or "") for e in executions]
    clinical = "clinical-evidence-synthesis" in agents or bool(FORBIDDEN["evidence_framework"].search(text))
    out.append(result("execution_is_not_a_clinical_evidence_review", not clinical, f"execution agents {agents}; evidence-review vocabulary {'present' if FORBIDDEN['evidence_framework'].search(text) else 'absent'}"))
    types = [e.get("taskType") for e in executions]
    out.append(result("task_type_is_not_the_literature_sentinel", "literature-sentinel" not in types, f"the execution ran as task type {types}", required=False))
    inbox = json.dumps(ctx.record.get("inbox", {}), ensure_ascii=False)
    out.append(result("inbox_does_not_call_it_research", "研究" not in inbox, f"inbox mentions 研究: {re.findall(r'.{0,12}研究.{0,12}', inbox)[:2]}" if "研究" in inbox else "no 研究 in the inbox (inbox holds %d chars)" % len(inbox)))
    return out


def chk_kb(spec, ctx):
    out = []
    uploads = ctx.record.get("inputs", [])
    refused = [u["to"] for u in uploads if u["status"] != 200]
    unregistered = [u["to"] for u in uploads if u["status"] == 200 and not u.get("registered")]
    out.append(result("every_file_enters_the_knowledge_base", not refused and not unregistered, f"{len(uploads)} uploads; refused {refused}; accepted but not registered as a source {unregistered}"))
    sources = ctx.record.get("sources", {}).get("body")
    items = sources.get("data", {}).get("items", []) if isinstance(sources, dict) and isinstance(sources.get("data"), dict) else []
    states = {str(i.get("title") or i.get("id"))[:30]: (i.get("status") or i.get("state")) for i in items}
    out.append(result("sources_ledger", None, f"{len(items)} source(s): {states}", required=False))
    if len(ctx.turns) >= 3:
        answer = squash(ctx.turns[0].get("reply", ""))
        facts = [f for f in ctx.truth["policies"]["facts"] if squash(f) in answer]
        names_file = "请假管理办法" in answer or "员工请假" in answer
        out.append(result("answer_points_at_the_leave_policy", names_file and len(facts) >= 3, f"names the policy: {names_file}; {len(facts)}/4 facts {facts}"))
        final = ctx.turns[2]
        doc_text = final.get("reply", "")
        for rel, path in ctx.new_files([".md", ".docx", ".txt"]):
            doc_text = textio.file_text(path) if path.suffix.lower() != ".docx" else textio.docx_text(path)
        out.append(result("new_conversation_body_starts_at_level_2", _starts_level_two(ctx, final), "first heading of the document is a level-2 heading" if _starts_level_two(ctx, final) else "the first heading is not level 2 (or there is none)"))
        trad = len(re.findall("[為與這們個說務關開時點間後來還總學會對於進從過種實現麼樣經]", doc_text))
        simp = max(1, cjk_count(doc_text))
        out.append(result("simplified_chinese", trad / simp < 0.01 and cjk_count(doc_text) > 50, f"{trad} traditional-only characters in {simp} CJK characters"))
    overview = json.dumps(ctx.record.get("overview", {}), ensure_ascii=False)
    empty_slots = re.findall(r'"(?:population|intervention|comparator|outcome|pico\w*|specialty|人群|干预|对照|结局|专科)"\s*:\s*(?:null|""|\[\]|"—"|"-")', overview, flags=re.I)
    out.append(result("memory_page_has_no_empty_medical_slots", len(empty_slots) < 2, f"{len(empty_slots)} empty medical slot(s) in the project overview: {empty_slots[:3]}"))
    wait = ctx.record.get("memoryWait") or {}
    out.append(result("preference_was_remembered", None, f"memory records after the preference turn: {wait.get('records')}", required=False))
    return out


def _starts_level_two(ctx: Ctx, turn: dict) -> bool:
    candidates = ctx.new_files([".md", ".docx", ".txt"])
    if candidates:
        rel, path = candidates[-1]
        if path.suffix.lower() == ".docx":
            doc = textio.docx_open(path)
            for p in doc.paragraphs:
                name = (p.style.name if p.style is not None else "") or ""
                if re.match(r"(?i)^heading\s*\d", name) and p.text.strip():
                    return name.strip().endswith("2")
            return False
        text = textio.read_text_file(path)
    else:
        text = turn.get("reply", "")
    for line in text.splitlines():
        m = re.match(r"^(#{1,6})\s+\S", line)
        if m:
            return len(m.group(1)) == 2
    return False


# --------------------------------------------------------------------------------------------------------------------- medical
def chk_opening(spec, ctx):
    reply = ctx.reply(spec).strip()
    head = reply[: spec["within_chars"]]
    found = [w for w in spec["any"] if w in head]
    return [result("safety_condition_in_the_opening", bool(found), f"opening {head[:80]!r}; found {found}")]


def chk_citations(spec, ctx):
    reply = ctx.reply(spec)
    outputs = ctx.transcript_text()
    refs = []
    for line in reply.splitlines():
        if re.match(r"^\s*(?:\[\d+\]|\d+[.、)])\s", line) or (re.match(r"^\s*[-*]\s", line) and (URL.search(line) or re.search(r"PMID|DOI|10\.\d{4}", line))):
            refs.append(line)
    ids = []
    for line in refs:
        ids.append((line[:70], re.findall(r"PMC\d+|(?<=PMID[:：\s])\d{5,9}|10\.\d{4,9}/[^\s)\]，。,;]+|https?://[^\s)\]，。,;]+", line)))
    unresolved = []
    for line, tokens in ids:
        if not tokens:
            unresolved.append(line)
            continue
        if not any(t.rstrip(".") in outputs for t in tokens):
            unresolved.append(line)
    searched = [t for t in ctx.tools(spec) if t["name"] in MEDICAL_RETRIEVAL | WEB]
    ok_list = bool(refs) and (len(refs) - len(unresolved)) / len(refs) >= 0.8
    out = [result("citations_resolve_to_sources_read", ok_list if refs else False, f"{len(refs)} reference line(s); not found in any tool result: {unresolved[:3]}"),
           result("searched", bool(searched), f"{len(searched)} retrieval call(s)")]
    return out


def chk_clinical_package(spec, ctx):
    files = dict(ctx.new_files())
    report = [r for r in files if re.search(r"clinical-evidence-report\.md$", r)]
    matrix = [r for r in files if re.search(r"clinical-evidence-matrix\.json$", r)]
    run = ctx.turns[-1].get("run", {}) if ctx.turns else {}
    out = [result("report_and_evidence_matrix_delivered", bool(report) and bool(matrix), f"report {report[:1]}, matrix {matrix[:1]}"),
           result("verification_recorded", run.get("verification") in ("verified", "unverified"), f"verification={run.get('verification')}, notices={len(run.get('qualityNotices', []))}")]
    if matrix and ctx.tree:
        helper = Path(__file__).with_name("claim_marks.mjs")
        sources_dir = Path(tempfile.mkdtemp(prefix="gt-claims-"))
        for rel, path in ctx.snapshot().items():
            if path.suffix.lower() in (".md", ".txt", ".json", ".html", ".xml", ".csv") and path.stat().st_size < 5_000_000:
                target = sources_dir / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(path, target)
        try:
            done = subprocess.run(["node", str(helper), ctx.tree, str(files[matrix[0]]), str(sources_dir)], capture_output=True, text=True, timeout=120)
            marks = json.loads(done.stdout) if done.returncode == 0 else {"error": done.stderr[-200:]}
        except Exception as error:
            marks = {"error": str(error)[:200]}
        counts = marks.get("counts") if isinstance(marks, dict) else None
        if counts:
            total = sum(counts.values())
            out.append(result("every_claim_carries_a_mark", total > 0, f"claim marks by status {counts}"))
            out.append(result("verbatim_check_ran", ("verified" in counts) or ("quote_not_found" in counts), f"statuses {sorted(counts)}"))
        else:
            out.append(result("every_claim_carries_a_mark", None, f"the domain's claimVerification could not be run: {marks}", required=False))
    return out


def meta_expected(fixtures: Path) -> dict:
    import csv

    rows = list(csv.DictReader((fixtures / "rct_effects.csv").open(encoding="utf-8")))
    y = [math.log(float(r["hazard_ratio"])) for r in rows]
    se = [(math.log(float(r["ci_upper"])) - math.log(float(r["ci_lower"]))) / (2 * 1.96) for r in rows]
    w = [1 / s ** 2 for s in se]
    fixed = sum(wi * yi for wi, yi in zip(w, y)) / sum(w)
    q = sum(wi * (yi - fixed) ** 2 for wi, yi in zip(w, y))
    df = len(y) - 1
    c = sum(w) - sum(wi ** 2 for wi in w) / sum(w)
    tau2 = max(0.0, (q - df) / c)
    wr = [1 / (s ** 2 + tau2) for s in se]
    random = sum(wi * yi for wi, yi in zip(wr, y)) / sum(wr)
    se_f, se_r = 1 / math.sqrt(sum(w)), 1 / math.sqrt(sum(wr))
    i2 = max(0.0, (q - df) / q) * 100 if q > 0 else 0.0
    f = lambda m, s: (math.exp(m), math.exp(m - 1.96 * s), math.exp(m + 1.96 * s))
    return {"fixed": f(fixed, se_f), "random": f(random, se_r), "I2": i2, "Q": q, "tau2": tau2}


def chk_meta(spec, ctx):
    exp = meta_expected(ctx.fixtures)
    reply = ctx.reply(spec)
    reply_numbers = [float(n) for n in re.findall(r"(?<![\w.])\d+\.\d+(?![\w.])", reply)]
    near = lambda target, tol=0.011: any(abs(n - target) <= tol for n in reply_numbers)
    pooled_ok = near(exp["fixed"][0]) or near(exp["random"][0])
    i2_reply = [float(n) for n in re.findall(r"I\s*[²2]\s*[=≈:：]?\s*(\d+(?:\.\d+)?)\s*%", reply)] + [float(n) for n in re.findall(r"(\d+(?:\.\d+)?)\s*%[^\n]{0,12}异质", reply)]
    i2_ok = any(abs(v - exp["I2"]) <= 1.5 for v in i2_reply)
    files_text = "\n".join(textio.file_text(p) for _, p in ctx.new_files([".json", ".csv", ".md", ".txt", ".html"]))
    from_file = any(f"{v:.2f}" in files_text or f"{v:.3f}" in files_text for v in (exp["fixed"][0], exp["random"][0]))
    return [result("pooled_effect_equals_independent_computation", pooled_ok, f"independent: fixed HR {exp['fixed'][0]:.3f}, random HR {exp['random'][0]:.3f}; reply numbers {reply_numbers[:8]}"),
            result("heterogeneity_equals_independent_computation", i2_ok, f"independent I2 {exp['I2']:.1f}% (Q {exp['Q']:.2f}); reply I2 {i2_reply}"),
            result("numbers_come_from_a_result_file", from_file, "the pooled estimate is written in a result file the run produced" if from_file else "no result file the run produced contains the pooled estimate")]


CHECKS: dict[str, Callable[[dict, Ctx], list[dict]]] = {
    "route_not": chk_route_not, "route_is": chk_route_is, "route_reason_not": chk_route_reason_not, "tools": chk_tools, "wall": chk_wall,
    "reply_forbidden": chk_reply_forbidden, "reply_contains": chk_reply_contains, "reply_length": chk_reply_length,
    "verification_not_unverified": chk_verification_not_unverified, "registered": chk_registered, "file_new": chk_file_new,
    "docx": chk_docx, "docx_edit": chk_docx_edit, "xlsx_budget": chk_xlsx_budget, "xlsx_pivot": chk_xlsx_pivot, "xlsx_table": chk_xlsx_table,
    "pdf_summary": chk_pdf_summary, "numbers_from_source": chk_numbers_from_source, "pptx": chk_pptx, "pptx_edit": chk_pptx_edit,
    "rename_script": chk_rename_script, "project_tests": chk_project_tests, "churn": chk_churn, "links": chk_links,
    "web_unavailable_honest": chk_web_unavailable_honest, "node_lts": chk_node_lts, "report_pages": chk_report_pages,
    "reply_or_file_mentions": chk_reply_or_file_mentions, "translation": chk_translation, "numbers_preserved": chk_numbers_preserved,
    "weekly": chk_weekly, "schedule": chk_schedule, "kb": chk_kb, "opening": chk_opening, "citations": chk_citations,
    "clinical_package": chk_clinical_package, "meta": chk_meta,
}


def run_case(case: dict, variant: str, ctx: Ctx) -> list[dict]:
    """Every check of a case (the cell-level ones first), each wrapped so that one broken judge cannot hide the others."""
    specs = list(case.get("checks", [])) + list((case.get("checks_by_variant") or {}).get(variant, []))
    out = chk_run_ok({}, ctx)
    for spec in specs:
        fn = CHECKS.get(spec["type"])
        if fn is None:
            out.append(result(f"unknown_check:{spec['type']}", False, "no such check type"))
            continue
        try:
            produced = fn(spec, ctx)
            if spec.get("required") is False:  # an advisory check reports but never fails the case
                for r in produced:
                    r["required"] = False
            out += produced
        except Exception as error:
            out.append(result(spec["type"], None, f"the judge itself failed: {type(error).__name__}: {str(error)[:200]}", required=False))
    return out
