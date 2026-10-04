"""What a piece of audit evidence certifies, as digests this checkout can compute.

Evidence is valid for as long as what it certifies is unchanged, and not for a
fixed number of days (owner ruling, 2026-10-04): a probe taken a month ago of a
source nobody has touched describes it exactly as well as one taken today, and
the old fourteen-day window turned `pnpm audit:capabilities` red on every
machine two weeks after each probe although nothing had moved. So the runner
that records the evidence also records the identity of what it was taken on,
and the verifier computes the same identity from the tree it is asked about.
One implementation, imported by both, so the two cannot disagree about what
"the same source" means.

The identity of a tool probe is two digests, kept apart so a refusal can say
which one moved: the research MCP server's source tree (what executes when a
tool is called) and the domain's tool-name registry (the names the model is
offered). The specialists' own evidence needs none of this: a job receipt
already carries the digests of the engine tree and the adapter it ran, and
`hosted_receipts.current_evidence` computes the same ones from this checkout by
importing the adapter's own function.
"""
from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
MCP_ROOT = "runtime/mcp/evimed-research"
TOOL_NAMES = "packages/domain/src/toolNames.mjs"
IDENTITY_SCHEMA = 1
#: Part name -> what a reader is told moved.
IDENTITY_PARTS = {
    "mcpSource": "the research MCP server source (runtime/mcp/evimed-research)",
    "toolNames": "the tool-name registry (packages/domain/src/toolNames.mjs)",
}


def _evidence_helper(repo):
    """The source-tree walk the specialists' evidence already uses, so its exclusions and extensions are shared."""
    location = Path(repo) / MCP_ROOT / "execution_evidence.py"
    spec = importlib.util.spec_from_file_location("evimed_audit_identity_execution_evidence", location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def tool_source_identity(repo=REPO):
    """The digests a tool probe is taken on, from the tree at `repo`.

    The MCP tree is hashed without its own `test/` directory: tests are not what
    a probe certifies, and editing one must not void a recording of the tools.
    """
    repo = Path(repo)
    helper = _evidence_helper(repo)
    root = (repo / MCP_ROOT).resolve(strict=True)
    excluded = set(helper.EXCLUDED_DIRECTORIES) | {"test"}
    files = []
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(root)
        if any(part in excluded for part in relative.parts[:-1]):
            continue
        if path.name.startswith(".env") or path.name == "deploy.env":
            continue
        if path.suffix.casefold() not in helper.SOURCE_EXTENSIONS and path.name not in helper.SOURCE_FILENAMES:
            continue
        files.append((relative.as_posix(), path))
    if not files:
        raise ValueError("the research MCP source tree contains no auditable files")
    digest = hashlib.sha256()
    for relative, path in sorted(files):
        encoded = relative.encode("utf-8")
        digest.update(len(encoded).to_bytes(4, "big"))
        digest.update(encoded)
        digest.update(bytes.fromhex(helper.file_sha256(path)))
    names = (repo / TOOL_NAMES).resolve(strict=True)
    return {
        "schemaVersion": IDENTITY_SCHEMA,
        "mcpSource": {"sha256": digest.hexdigest(), "files": len(files)},
        "toolNames": {"sha256": helper.file_sha256(names)},
    }


def identity_changes(recorded, current):
    """Which parts of a recorded identity are not the current one, as readable names; empty when it still holds.

    A record that is not an identity at all changes every part: it certifies
    nothing about this tree.
    """
    if not isinstance(recorded, dict) or recorded.get("schemaVersion") != IDENTITY_SCHEMA:
        return list(IDENTITY_PARTS.values())
    changed = []
    for part, words in IDENTITY_PARTS.items():
        before = recorded.get(part)
        if not isinstance(before, dict) or before.get("sha256") != current[part]["sha256"]:
            changed.append(words)
    return changed
