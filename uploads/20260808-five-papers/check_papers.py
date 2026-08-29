#!/usr/bin/env python3
"""Mechanical checks over the five rewritten manuscripts.

Everything here is a hard property the author agents were instructed to hold:
citation numbering closes, no runtime leakage, no banned register, references
trace to the source bib. The verify agents judge; this script proves.
"""
import re
import sys
from pathlib import Path

BASE = Path(__file__).parent
SOURCES = {
    "rq01": Path("/home/coder/workspace/EviMedScience/uploads/20260801-135807-50gqt6/analysis/pipeline-delivered"),
    "rq02": Path("/home/coder/workspace/EviMedScience/uploads/20260804-argument-structure/rq02"),
    "rq06": Path("/home/coder/workspace/EviMedScience/uploads/20260804-argument-structure/rq06"),
    "rq08": Path("/home/coder/workspace/EviMedScience/uploads/20260804-argument-structure/rq08"),
    "rq29": Path("/home/coder/workspace/EviMedScience/uploads/20260804-argument-structure/rq29"),
}
LEAK = ["claim:", "CLM-", "<!--", "evimed", "保真件", "访问层级", "full_text",
        "structured_record", ".evimed-sources", "本次运行", "本环境", "检索环境"]
BANNED = ["审计", "盘点", "摸底", "情况分析", "现状调查"]
REQUIRED = ["## 摘要", "## Abstract", "## 1 引言", "## 2 资料与方法", "## 3 结果",
            "## 4 讨论", "## 5 结论", "## 参考文献", "局限", "**关键词", "**Keywords"]


def check(md_path: Path) -> list[str]:
    text = md_path.read_text(encoding="utf-8")
    issues = []
    refs_at = text.find("## 参考文献")
    body, refs = (text[:refs_at], text[refs_at:]) if refs_at >= 0 else (text, "")

    for token in REQUIRED:
        if token not in text:
            issues.append(f"missing section/element: {token}")

    ref_nums = {int(n) for n in re.findall(r"^\[(\d+)\]", refs, re.M)}
    cited = set()
    for group in re.findall(r"\[(\d+(?:\s*[,，\-–\-]\s*\d+)*)\]", body):
        parts = re.split(r"[,，]", group)
        for part in parts:
            rng = re.split(r"[\-–]", part)
            if len(rng) == 2 and rng[0].strip().isdigit() and rng[1].strip().isdigit():
                cited.update(range(int(rng[0]), int(rng[1]) + 1))
            elif part.strip().isdigit():
                cited.add(int(part))
    if ref_nums and cited - ref_nums:
        issues.append(f"cited but not listed: {sorted(cited - ref_nums)}")
    if ref_nums and ref_nums - cited:
        issues.append(f"listed but never cited: {sorted(ref_nums - cited)}")
    if ref_nums and sorted(ref_nums) != list(range(1, max(ref_nums) + 1)):
        issues.append(f"reference numbering has gaps: {sorted(ref_nums)}")

    for token in LEAK:
        # "full_text" may legitimately appear nowhere; any hit is leakage
        hits = [i + 1 for i, line in enumerate(text.splitlines()) if token.lower() in line.lower()]
        if hits:
            issues.append(f"runtime leakage {token!r} at lines {hits[:5]}")
    for token in BANNED:
        hits = [i + 1 for i, line in enumerate(body.splitlines()) if token in line]
        if hits:
            issues.append(f"banned register {token!r} at lines {hits[:5]}")
    if re.search(r"https?://", body):
        issues.append("bare URL in body text (citations must be [n])")

    hanzi = len(re.findall(r"[一-鿿]", body))
    if hanzi < 5500:
        issues.append(f"body too short: {hanzi} hanzi (< 5500)")

    src = SOURCES.get(md_path.stem)
    if src:
        bib = (src / "references.bib").read_text(encoding="utf-8")
        bib_dois = set(re.findall(r"doi\s*=\s*\{([^}]+)\}", bib, re.I))
        paper_dois = set(re.findall(r"DOI[:：]\s*(10\.[^\s.。;；]+(?:\.[^\s.。;；]+)*)", refs))
        strange = {d for d in paper_dois if d.rstrip(".") not in {b.strip() for b in bib_dois}}
        if strange:
            issues.append(f"DOIs not in source bib: {sorted(strange)}")

    tables = len(re.findall(r"^\*\*表\s*\d+\*\*", text, re.M))
    if tables < 2:
        issues.append(f"only {tables} captioned tables (< 2)")
    return issues


def main():
    targets = sys.argv[1:] or sorted(p.stem for p in (BASE / "papers").glob("*.md"))
    failed = False
    for stem in targets:
        issues = check(BASE / "papers" / f"{stem}.md")
        status = "OK" if not issues else f"{len(issues)} issue(s)"
        print(f"== {stem}: {status}")
        for issue in issues:
            print(f"   - {issue}")
        failed = failed or bool(issues)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
