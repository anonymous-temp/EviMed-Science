"""No definition in the package may be silently overwritten by a later one.

Python binds definitions in order, so a second `def` of the same name in a
module or class body replaces the first with no error and no warning. The
earlier body simply stops running. `_append_citation_to_sentence` was defined
twice in the pre-split writing agent and one of the two had been unreachable
since it was written; nothing failed, so nothing noticed.
"""
import ast
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1] / "new_meta"
SKIPPED = {"__pycache__", ".venv"}


def _shadowed(body, prefix: str, path: Path) -> list[str]:
    seen: dict[str, int] = {}
    found: list[str] = []
    for node in body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if node.name in seen:
            found.append(
                f"{path.relative_to(PACKAGE.parent)}:{node.lineno} {prefix}{node.name} "
                f"overwrites the definition at line {seen[node.name]}"
            )
        seen[node.name] = node.lineno
    return found


def test_no_definition_is_overwritten_by_a_later_one() -> None:
    findings: list[str] = []
    scanned = 0
    for path in sorted(PACKAGE.rglob("*.py")):
        if SKIPPED & set(path.parts):
            continue
        scanned += 1
        tree = ast.parse(path.read_text(encoding="utf-8"))
        findings += _shadowed(tree.body, "", path)
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                findings += _shadowed(node.body, f"{node.name}.", path)
    # A guard that silently scans nothing is the failure it is meant to catch.
    assert scanned > 50, f"only {scanned} modules scanned; the package layout moved"
    assert findings == [], "\n".join(findings)
