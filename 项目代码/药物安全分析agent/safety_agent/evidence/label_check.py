"""FDA label cross-check: are the target ADRs already on the label?

Fetches the safety-relevant sections (boxed_warning / adverse_reactions /
warnings / warnings_and_cautions) via the openFDA label endpoint and asks
the Flash-tier LLM to classify each target ADR as ``labeled`` /
``partially_labeled`` / ``unlabeled`` with verbatim sentence-level quotes.

Anti-hallucination guard: every returned quote is verified deterministically
against the fetched label text; quotes that are not literal substrings are
dropped and counted in the report note. The LLM does text matching only —
never any counting or statistics.
"""

from __future__ import annotations

import json
import re
from typing import Literal

from pydantic import BaseModel, Field

from safety_agent.core.exceptions import LLMError, NoResults, OpenFDAError
from safety_agent.core.logging import get_logger
from safety_agent.openfda.client import DrugLabel, OpenFDAClient

logger = get_logger(__name__)

LABEL_SECTIONS = ("boxed_warning", "adverse_reactions", "warnings", "warnings_and_cautions")

#: Prompt construction per label section: head chars plus a window around
#: every target-ADR hit (label sections can reach ~40k chars; blind head
#: truncation hid deep ADR mentions — see _collect_sections).
_HEAD_CHARS = 2000
_HIT_WINDOW = 600
_MAX_SECTION_CHARS = 8000


class LabelQuote(BaseModel):
    section: str
    sentence: str


class LabelCheckResult(BaseModel):
    reaction: str
    status: Literal["labeled", "partially_labeled", "unlabeled"]
    quotes: list[LabelQuote] = Field(default_factory=list)


class LabelCheckReport(BaseModel):
    drug: str
    status: Literal["ok", "no_label_data", "unavailable", "llm_unavailable"]
    checks: list[LabelCheckResult] = Field(default_factory=list)
    label_refs: list[str] = Field(default_factory=list)  # e.g. set_id / brand names
    note: str = ""


class _LLMCheckOutput(BaseModel):
    checks: list[LabelCheckResult]


_SYSTEM_PROMPT = (
    "你是药物警戒说明书对照助手。给定某药品 FDA 说明书的若干安全性章节原文,"
    "逐一判断每个目标不良反应(ADR)在说明书中的标注情况。"
    "规则:1) 每个 ADR 判定为 labeled(明确标注)/ partially_labeled(仅有相关或"
    "笼统描述)/ unlabeled(未提及);2) 判定为 labeled 或 partially_labeled 时,"
    "必须给出原文中的整句作为证据(逐字引用,不得改写或翻译),section 字段必须"
    "使用输入 JSON 的章节键名(boxed_warning/adverse_reactions/warnings/"
    "warnings_and_cautions)之一;3) 不得编造原文中不存在的句子;4) 只输出 JSON,"
    "不要输出任何解释文字。"
    "输出格式:{\"checks\":[{\"reaction\":\"...\",\"status\":\"labeled|"
    "partially_labeled|unlabeled\",\"quotes\":[{\"section\":\"...\",\"sentence\":\"...\"}]}]}"
)


async def check_label_coverage(
    client: OpenFDAClient,
    llm: "object",
    drug: str,
    reactions: list[str],
) -> LabelCheckReport:
    """Cross-check target ADRs against the FDA label safety sections.

    ``llm`` is a DeepSeekClient (typed loosely to keep the layer mockable).
    Degradations are explicit statuses, never silent: no label data,
    openFDA unavailable, or LLM unavailable.
    """
    try:
        labels = await client.search_labels(drug=drug, limit=2)
    except NoResults:
        return LabelCheckReport(
            drug=drug, status="no_label_data",
            note="openFDA 未检索到该药品的说明书记录。",
        )
    except OpenFDAError as exc:
        logger.warning("label fetch failed: %s", exc)
        return LabelCheckReport(
            drug=drug, status="unavailable",
            note="openFDA 说明书查询失败,本次对照未完成。",
        )

    sections, truncated = _collect_sections(labels, reactions)
    refs = _label_refs(labels)
    if not sections:
        return LabelCheckReport(
            drug=drug, status="no_label_data", label_refs=refs,
            note="说明书记录未包含黑框警告/不良反应/警告等安全性章节。",
        )
    truncation_note = (
        "说明书原文过长,对照基于各章节开头+目标 ADR 命中窗口的节选文本,"
        "「未标注」结论可能受截断影响。"
        if truncated
        else ""
    )

    user_payload = {
        "drug": drug,
        "label_sections": sections,
        "target_adrs": reactions,
    }

    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {
            "role": "user",
            "content": "请完成对照,只输出 JSON。输入:\n"
            + json.dumps(user_payload, ensure_ascii=False),
        },
    ]
    try:
        output = await llm.complete_json(messages, schema=_LLMCheckOutput, tier="flash")
    except LLMError as exc:
        logger.warning("label cross-check LLM call failed: %s", exc)
        return LabelCheckReport(
            drug=drug, status="llm_unavailable", label_refs=refs,
            note="LLM 说明书对照失败,本次仅提供统计结果。",
        )

    checks, dropped, missing = _verify_output(output, reactions, sections)
    note = ""
    if dropped:
        note += f"已剔除 {dropped} 条无法在说明书原文中定位的引用句(防编造校验)。"
    if missing:
        note += "LLM 未给出判定的 ADR:" + "、".join(missing) + "。"
    if truncation_note:
        note += truncation_note
    return LabelCheckReport(
        drug=drug, status="ok", checks=checks, label_refs=refs, note=note.strip()
    )


def _collect_sections(
    labels: list[DrugLabel], reactions: list[str] | tuple[str, ...] = ()
) -> tuple[dict[str, str], bool]:
    """Section name -> prompt text, plus a truncation flag.

    Label sections can reach 40k chars. Instead of blind head truncation
    (which hid ADR mentions deep in the text — e.g. "Pneumonia" at index
    17631 in a rituximab label), each section contributes its head plus a
    window around every (case-insensitive) hit of each target ADR term.
    """
    collected: dict[str, str] = {}
    for label in labels:
        for section in LABEL_SECTIONS:
            texts = getattr(label, section, ())
            if not texts:
                continue
            merged = "\n".join(texts)
            existing = collected.get(section)
            collected[section] = merged if existing is None else existing + "\n" + merged
    sections: dict[str, str] = {}
    truncated = False
    for name, text in collected.items():
        if not text.strip():
            continue
        chunks = [text[:_HEAD_CHARS]]
        for term in reactions:
            term = term.strip()
            if not term:
                continue
            for match in re.finditer(re.escape(term), text, re.IGNORECASE):
                start = max(0, match.start() - _HIT_WINDOW)
                chunks.append(text[start : match.end() + _HIT_WINDOW])
        merged_chunks: list[str] = []
        for chunk in chunks:
            if chunk.strip() and chunk not in merged_chunks:
                merged_chunks.append(chunk)
        prompt_text = "\n…\n".join(merged_chunks)[:_MAX_SECTION_CHARS]
        if len(prompt_text) < len(text):
            truncated = True
        sections[name] = prompt_text
    return sections, truncated


def _label_refs(labels: list[DrugLabel]) -> list[str]:
    refs: list[str] = []
    for label in labels:
        names = ", ".join(label.brand_names or label.generic_names)
        refs.append(f"{label.set_id} ({names})" if names else label.set_id)
    return refs


def _normalize_ws(text: str) -> str:
    # whitespace- and case-insensitive comparison: the LLM may adjust case
    # when quoting, which is acceptable; changing the words is not.
    return " ".join(text.split()).casefold()


_SQUASH_RE = re.compile(r"[^0-9a-z一-鿿]+")


def _squash(text: str) -> str:
    """Aggressive normalization for quote verification: alphanumerics only.

    Tolerates the label's typographic noise (section numbers, brackets,
    unicode symbols like ≥, line breaks) that a quoting LLM legitimately
    drops, while still rejecting genuine paraphrases.
    """
    return _SQUASH_RE.sub("", text.casefold())


def _locate_section(
    needle: str, preferred: str, squashed_sections: dict[str, str]
) -> str | None:
    """Find the section whose text contains the squashed quote.

    Exact field-name match first; otherwise search every section, because
    the LLM may cite the SPL heading ("5.1 Myopathy...") instead of the
    API field name ("warnings_and_cautions").
    """
    if not needle:
        return None
    preferred_text = squashed_sections.get(preferred)
    if preferred_text is not None:
        if needle in preferred_text:
            return preferred
    for name, text in squashed_sections.items():
        if needle in text:
            return name
    return None


def _verify_output(
    output: _LLMCheckOutput,
    reactions: list[str],
    sections: dict[str, str],
) -> tuple[list[LabelCheckResult], int, list[str]]:
    """Keep only quotes that literally appear in the fetched label text."""
    wanted = {_normalize_ws(r) for r in reactions}
    squashed_sections = {name: _squash(text) for name, text in sections.items()}
    seen: set[str] = set()
    checks: list[LabelCheckResult] = []
    dropped = 0
    for check in output.checks:
        key = _normalize_ws(check.reaction)
        if key in seen:
            continue
        seen.add(key)
        verified: list[LabelQuote] = []
        for quote in check.quotes:
            needle = _squash(quote.sentence)
            located = _locate_section(needle, quote.section, squashed_sections)
            if located is not None:
                # Keep the LLM's section label (it may cite the SPL heading,
                # e.g. "5.1 Myopathy and Rhabdomyolysis"); verification only
                # requires the sentence to exist in the fetched label text.
                verified.append(quote)
            else:
                dropped += 1
        if check.status != "unlabeled" and not verified:
            # A positive claim without a verifiable quote is downgraded.
            check = check.model_copy(update={"status": "unlabeled", "quotes": []})
            dropped += 1
        else:
            check = check.model_copy(update={"quotes": verified})
        checks.append(check)
    missing = sorted(wanted - seen)
    return checks, dropped, missing
