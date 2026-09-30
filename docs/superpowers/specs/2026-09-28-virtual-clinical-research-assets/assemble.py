#!/usr/bin/env python3
"""Assemble ../2026-09-28-EviMed虚拟临研平台方案.md from draft/part-*.md (image paths rewritten)."""
import pathlib
HERE = pathlib.Path(__file__).parent
NAME = "2026-09-28-EviMed虚拟临研平台方案"
ASSETS = "2026-09-28-virtual-clinical-research-assets"
ORDER = ["head", "summary", "eval", "research", "product", "flow", "modules", "evidence", "ops",
         "shared", "ui", "auto", "tech", "accept", "wps", "not", "owner", "sources"]
out = []
for name in ORDER:
    f = HERE / "draft" / f"part-{name}.md"
    if not f.exists():
        raise SystemExit(f"missing draft/part-{name}.md")
    out.append(f.read_text().replace("](../mockups/", f"]({ASSETS}/mockups/").replace("](../research/", f"]({ASSETS}/research/").rstrip() + "\n")
text = "\n---\n\n".join(out)
# CommonMark will not close **bold** when the closing ** follows CJK punctuation and precedes a CJK
# character; move that punctuation outside the span.
PUNCT = "。．，、；：！？）」』”"


def fix_line(line):
    parts = line.split("**")
    if len(parts) < 3 or len(parts) % 2 == 0:
        return line
    for k in range(1, len(parts), 2):
        moved = False
        while parts[k] and parts[k][-1] in PUNCT:
            parts[k + 1] = parts[k][-1] + parts[k + 1]
            parts[k] = parts[k][:-1]
            moved = True
        # "**…。** 下一句" leaves a half-width space after the moved CJK punctuation; drop it.
        if moved and len(parts[k + 1]) > 1 and parts[k + 1][1] == " ":
            parts[k + 1] = parts[k + 1][0] + parts[k + 1][2:]
    return "**".join(parts)


text = "\n".join(fix_line(l) for l in text.split("\n"))
target = HERE.parent / f"{NAME}.md"
target.write_text(text)
missing = [p for p in __import__("re").findall(r"\]\(" + ASSETS + r"/(mockups/[^)]+)\)", text) if not (HERE / p).exists()]
print(target.name, len(text), "chars;", "missing images:", missing or "none")
