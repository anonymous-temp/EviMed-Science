"""Read one finished solver run (a bench-driver result folder) the way Harness2's editors need it.

A run directory holds what bench-driver wrote for the item: `result.json` (status, route, cost), `answer.md` (the last assistant
message), `transcript.json` (the kernel's messages) and `files/` (what the run wrote, at most 40 files). Nothing else is read here,
and in particular nothing that could carry a grade: the driver does not write one, the lab does not either, and `leak_globs`
in the adapter's spec is the tripwire if that ever changes.

The trajectory is rendered into upstream's grammar: [ASSISTANT], [THINKING], [ACTION] tool(args), [OBSERVATION], [OBSERVATION ERROR],
[ERROR]. Platform-injected user messages (runtime context, skill catalogue, plugin text, the brief the run policy adds) are not part of
what the harness controls and are skipped; the task is in task.md already.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

TRUNC = "…(+{n} chars — render truncation)"

# Message sources that are the platform talking to the model, not the person. A follow-up message from the person has source "user".
PLATFORM_SOURCES_SKIPPED = {"runtime-context", "skill-catalog"}
NOTE_SOURCES = {"tool-jobs", "compact-checkpoint", "subagent-settled", "repeat-tool-reminder"}

FINAL_STATUSES = {"succeeded", "failed", "canceled", "timeout"}
REPORT_SUFFIXES = {".md", ".markdown", ".txt", ".html", ".htm", ".tex", ".rst"}
BINARY_REPORT_SUFFIXES = {".docx", ".pdf", ".pptx", ".xlsx", ".odt"}
MAX_FILES = 6
MAX_FILE_CHARS = 120_000


def clip(value, limit: int) -> str:
    text = "" if value is None else str(value)
    text = text.replace("\x00", "")
    if limit <= 0 or len(text) <= limit:
        return text
    return text[:limit] + TRUNC.format(n=len(text) - limit)


def read_json(path: Path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def result_of(run_dir: Path) -> dict:
    data = read_json(Path(run_dir) / "result.json")
    return data if isinstance(data, dict) else {}


def answer_of(run_dir: Path) -> str:
    try:
        return (Path(run_dir) / "answer.md").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def route_of(result: dict) -> str | None:
    """The dispatch `line` that reproduces the route this run took: "answer" for the answer line, else the capability id."""
    agent = result.get("effectiveAgentId")
    if not agent:
        return None
    return "answer" if agent == "open-domain-answer" else str(agent)


def render_trajectory(run_dir: Path, *, obs_trunc: int = 50_000, args_trunc: int = 400) -> str:
    run_dir = Path(run_dir)
    transcript = read_json(run_dir / "transcript.json")
    if not isinstance(transcript, dict) or not isinstance(transcript.get("messages"), list):
        return f"(no trajectory recorded for {run_dir.name})"
    lines: list[str] = []
    first_user_seen = False
    for message in transcript["messages"]:
        if not isinstance(message, dict):
            continue
        role, source = message.get("role"), str(message.get("source") or "")
        parts = message.get("parts") if isinstance(message.get("parts"), list) else []
        if role == "user":
            if source == "user":
                text = "\n".join(str(p.get("text", "")) for p in parts if isinstance(p, dict) and p.get("type") == "text").strip()
                if first_user_seen and text:  # the first one is the task (plus a probe's preamble): task.md has it
                    lines.append(f"[USER] {clip(text, obs_trunc)}")
                first_user_seen = True
            elif source in NOTE_SOURCES:
                text = "\n".join(str(p.get("text", "")) for p in parts if isinstance(p, dict) and p.get("type") == "text").strip()
                if text:
                    lines.append(f"[NOTE {source}] {clip(text, 600)}")
            continue
        for part in parts:
            if not isinstance(part, dict):
                continue
            kind = part.get("type")
            if kind == "reasoning" and str(part.get("text") or "").strip():
                lines.append(f"[THINKING] {clip(part['text'], obs_trunc)}")
            elif kind == "text" and str(part.get("text") or "").strip():
                lines.append(f"[ASSISTANT] {clip(part['text'], obs_trunc)}")
            elif kind == "tool":
                args = part.get("input")
                rendered = json.dumps(args, ensure_ascii=False, default=str) if args is not None else ""
                lines.append(f"[ACTION] {part.get('tool') or 'tool'}({clip(rendered, args_trunc)})")
                status = part.get("status")
                output = part.get("output")
                if status == "error":
                    lines.append(f"[OBSERVATION ERROR] {clip(output if output is not None else part.get('error'), obs_trunc)}")
                elif status in ("pending", "running"):
                    lines.append(f"[OBSERVATION] (no result: the call was still {status} when the run ended)")
                elif output is not None:
                    lines.append(f"[OBSERVATION] {clip(output if isinstance(output, str) else json.dumps(output, ensure_ascii=False, default=str), obs_trunc)}")
    result = result_of(run_dir)
    status = result.get("status")
    if status and status != "succeeded":
        code = result.get("errorCode")
        lines.append(f"[ERROR] the run ended with status {status}" + (f" ({code})" if code else ""))
    rendered = "\n".join(lines).strip()
    return rendered or "(no parseable events in trajectory)"


def _is_report_like(rel: str, presented: set[str]) -> bool:
    low = rel.lower()
    if rel in presented:
        return Path(low).suffix in REPORT_SUFFIXES | BINARY_REPORT_SUFFIXES
    parts = Path(low).parts
    stem = Path(low).stem
    if Path(low).suffix not in REPORT_SUFFIXES | BINARY_REPORT_SUFFIXES:
        return False
    if parts[0] in ("code", "scripts", "outputs", "inputs") and "report" not in stem:
        return False
    return "report" in stem or parts[0] in ("report", "deliverables") or len(parts) == 1


def deliverable_files(run_dir: Path) -> dict[str, str]:
    """filename -> readable text for the final answer and the report-like files the run wrote; nothing else.

    Binary documents (docx, pdf …) are listed by name with a size, because the harness editors cannot read bytes and a listing is
    honest about that. A file longer than the cap is cut with an explicit marker.
    """
    run_dir = Path(run_dir)
    out: dict[str, str] = {}
    answer = answer_of(run_dir)
    result = result_of(run_dir)
    if answer.strip() and result.get("status") == "succeeded":
        out["answer.md"] = answer
    files_dir = run_dir / "files"
    if files_dir.is_dir():
        presented = {str(p) for p in (result.get("presentedFiles") or [])}
        candidates = sorted(
            (p for p in files_dir.rglob("*") if p.is_file()),
            key=lambda p: (0 if str(p.relative_to(files_dir)) in presented else 1, str(p)),
        )
        for path in candidates:
            if len(out) >= MAX_FILES + (1 if "answer.md" in out else 0):
                break
            rel = str(path.relative_to(files_dir))
            if not _is_report_like(rel, presented):
                continue
            if path.suffix.lower() in BINARY_REPORT_SUFFIXES:
                out[f"files/{rel}"] = f"(binary document, {path.stat().st_size} bytes; its text is not available to the editors)"
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            out[f"files/{rel}"] = clip(text, MAX_FILE_CHARS)
    return out


def has_deliverable(run_dir: Path) -> bool:
    """True when the run left a final answer or a readable report. A binary-only listing is not text the editors can judge."""
    return any(not text.startswith("(binary document") for text in deliverable_files(run_dir).values())


def deliverable_text(run_dir: Path) -> str:
    files = deliverable_files(run_dir)
    if not files:
        return "(this run produced NO deliverable)"
    return "\n\n".join(f"----- {name} -----\n{text.strip() or '(empty)'}" for name, text in files.items())


def cost_of(result: dict) -> dict:
    """Settled cost of one run as the control plane recorded it. `cny` is None when it was not recorded."""
    cost = result.get("cost") if isinstance(result.get("cost"), dict) else {}
    usage = result.get("listUsage") if isinstance(result.get("listUsage"), dict) else {}
    cny = cost.get("cost")
    if not isinstance(cny, (int, float)):
        cny = usage.get("costCny") if isinstance(usage.get("costCny"), (int, float)) else None
    open_cost = cost.get("openCost") if isinstance(cost.get("openCost"), (int, float)) else 0
    return {
        "cny": None if cny is None else round(float(cny) + float(open_cost or 0), 6),
        "calls": cost.get("calls") if cost else usage.get("requests"),
        "uncertain": cost.get("uncertain") if cost else None,
        "currency": cost.get("currency") or ("CNY" if cny is not None else None),
        "captured": (result.get("capture") or {}).get("cost") if isinstance(result.get("capture"), dict) else None,
    }


_SECRETISH = re.compile(r"sk-[A-Za-z0-9]{16,}")


def assert_no_secret(text: str) -> None:
    if _SECRETISH.search(text):
        raise ValueError("a key-shaped string would enter a model context")
