# [IN] what an optional data source did when the analysis asked it
# [OUT] the three-word status, the ledger row, the sentence a report carries
# [POS] mr_agent/source_notes.py - an optional source that was not used is said, not logged
"""Which optional data source was not used, and why.

An optional source (UMLS for synonym expansion today) that the deployment has no
key for, that refuses the key, or that cannot be reached used to leave one line
in the log and a result that read as if it had been used. The job result now
states it, in the three words every engine uses (``not_configured``, ``refused``,
``unreachable``), in the methods text where the data sources are listed, and in
the module ledger.
"""

from __future__ import annotations

STATUS_NOT_CONFIGURED = "not_configured"
STATUS_REFUSED = "refused"
STATUS_UNREACHABLE = "unreachable"
STATUSES = (STATUS_NOT_CONFIGURED, STATUS_REFUSED, STATUS_UNREACHABLE)

_WORDS = {
    STATUS_NOT_CONFIGURED: ("未配置", "not configured"),
    STATUS_REFUSED: ("被拒绝", "refused"),
    STATUS_UNREACHABLE: ("无法连接", "unreachable"),
}
#: What stood in for the source, by key.
_FALLBACKS = {"llm": ("语言模型", "the language model")}


def row(source: str, label: str, status: str, module: str, fallback: str = "") -> dict[str, str]:
    """One `sourcesNotUsed` row: the source, its label, why, the ledger module it degrades, what stood in for it."""
    if status not in STATUSES or (fallback and fallback not in _FALLBACKS):
        raise ValueError("unknown source status or fallback")
    return {"source": source, "label": label, "status": status, "module": module, "fallback": fallback}


def ledger_reason(note: dict[str, str]) -> str:
    text = f"{note['label']} {_WORDS[note['status']][1]}"
    return f"{text}; {_FALLBACKS[note['fallback']][1]} was used instead" if note.get("fallback") else text


def sentence(notes: list[dict[str, str]], language: str) -> str:
    """The sentence the methods text carries where the data sources are listed; empty when none."""
    if not notes:
        return ""
    zh = str(language).lower().startswith("zh")
    parts = []
    index = 0 if zh else 1
    for note in notes:
        words = _WORDS[note["status"]][index]
        stood_in = _FALLBACKS[note["fallback"]][index] if note.get("fallback") else ""
        if zh:
            parts.append(f"{note['label']}（{words}）" + (f"，改用{stood_in}" if stood_in else ""))
        else:
            parts.append(f"{note['label']} ({words})" + (f"; {stood_in} was used instead" if stood_in else ""))
    return (
        "未能使用的可选数据来源：" + "；".join(parts) + "。" if zh
        else "Optional data sources that could not be used: " + "; ".join(parts) + "."
    )
