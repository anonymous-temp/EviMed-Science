"""LLM-backed translation fallbacks for the normalize layer (P7).

Implements the预留 seams:
- ``suggest_generic_name`` — the ``DrugNameLLMFallback`` protocol from
  ``safety_agent.normalize.drugs``: Chinese (or other non-English) drug
  names -> English generic (INN/USAN) name;
- ``suggest_adr_pt`` — same idea for ADR terms not covered by the built-in
  Chinese->MedDRA-PT map.

Both use the flash tier with a tiny prompt and a plain-text answer. The
output is sanitized aggressively (first line, no quotes/punctuation, must
not still be CJK); anything suspicious returns None so the caller keeps
its original text and the pipeline's explicit NoData semantics still apply.
The LLM only translates words — it never touches numbers.
"""

from __future__ import annotations

import re

from safety_agent.core.logging import get_logger

from .client import DeepSeekClient

logger = get_logger(__name__)

_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")

_DRUG_PROMPT = (
    "把给定的药品名翻译成英文通用名(INN/USAN,小写,单个词或短语)。"
    "只输出通用名本身,不要任何解释、引号或标点。若无法识别,输出空行。"
    "示例:阿托伐他汀 → atorvastatin;二甲双胍 → metformin;立普妥 → atorvastatin。"
)

_ADR_PROMPT = (
    "把给定的不良反应名称翻译成对应的 MedDRA 首选词(PT,英文小写)。"
    "只输出 PT 本身,不要任何解释、引号或标点。若无法确定,输出空行。"
    "示例:肌痛 → myalgia;乳酸性酸中毒 → lactic acidosis;肺炎 → pneumonia。"
)


def contains_cjk(text: str) -> bool:
    """True when the string carries CJK characters (needs translation)."""
    return bool(_CJK_RE.search(text))


class DeepSeekNameTranslator:
    """Flash-tier translator implementing both normalize fallback seams."""

    def __init__(self, client: DeepSeekClient) -> None:
        self._client = client

    async def suggest_generic_name(self, query: str) -> str | None:
        return await self._translate(_DRUG_PROMPT, query)

    async def suggest_adr_pt(self, query: str) -> str | None:
        return await self._translate(_ADR_PROMPT, query)

    async def _translate(self, system_prompt: str, query: str) -> str | None:
        """One tiny flash completion; None on any unusable output."""
        content = await self._client.complete(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": query},
            ],
            tier="flash",
            temperature=0.0,
            max_tokens=32,
        )
        suggestion = _sanitize(content)
        if suggestion is None:
            logger.warning("LLM translation of %r was unusable (%r)", query, content[:60])
        return suggestion


def _sanitize(content: str) -> str | None:
    """First line, lower-case, alnum/space/hyphen only; reject CJK/empty/long."""
    line = content.strip().splitlines()[0] if content.strip() else ""
    line = line.strip(" \t\"'`.,;:!?()[]{}<>")
    line = " ".join(line.lower().split())
    if not line or len(line) > 60:
        return None
    if contains_cjk(line):
        return None
    if not re.fullmatch(r"[a-z0-9][a-z0-9 \-/+]*", line):
        return None
    return line
