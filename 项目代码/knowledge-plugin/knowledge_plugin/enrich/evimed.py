"""EviMed evidence API for ``/text``: impact factor, core-journal tags, and the NMPA label excerpt.

Both lookups go to the owner's own API (unmetered, plan 12.2) through the core's fetcher, which
adds ``Authorization: Bearer <key>`` for ``www.evimed.com`` from ``KNOWLEDGE_PLUGIN_EVIMED_API_KEY_FILE``;
nothing here reads the key. They run only when the deployment configured that file, and only on
an entry's final answer (``available`` / ``unavailable``), not on every pending retry.

**Impact factor and core-journal tags** (``v2/literature-guide``, ``type=literature``, by title).
The search is relevance-ranked: on 2026-09-22 the exact title of an NEJM RCT returned a JACI
article first. So a record counts only when its normalised title equals the entry's; failing
that, a record from the *same journal* (normalised journal names equal) gives the journal-level
facts (impact factor and tags describe the journal, not the article). Tags come as the API writes
them: JCR categories (``ALLERGY - SCIE(Q1)``) or Chinese core lists (``北大核心``).

**NMPA label excerpt** (v1 ``instruction``, ``source=["nmpa"]``). v2 answers carried only the
indication; v1 carries the label sections (boxed warning, warnings, contraindications, adverse
reactions, precautions, interactions, special populations). A drug is named only by a closed
title form — the NMPA announcement templates 「国家药监局关于修订…说明书的公告」 and
「国家药监局关于…转换为处方药/非处方药的公告」, and a regulator safety title that starts with a
drug name and a colon (MHRA's "Domperidone: new contraindication …"); no free-text guessing. A
label is used only when its generic name contains the named ingredient and a compatible dosage
form (a closed list of form words), or its English name equals the English drug name. The
excerpt is the index's copy of the label — the doc says an index record is not proof of the
current label — so it is context for the platform, cited with its ``url``.
"""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Any

from ..adapters.common import clean_markup
from .common import Endpoints, Trace, get

LITERATURE_COUNT = 10
LABEL_COUNT = 5
EXCERPT_MAX = 2_000

# Closed dosage-form vocabulary, longest first, and the substring a matching generic name must carry.
DOSAGE_FORMS = (
    ("注射用", "注射"), ("注射制剂", "注射"), ("注射剂", "注射"), ("注射液", "注射"), ("软胶囊", "胶囊"), ("缓释片", "片"),
    ("缓释胶囊", "胶囊"), ("肠溶片", "片"), ("分散片", "片"), ("口服溶液", "口服"), ("口服液", "口服"), ("颗粒", "颗粒"),
    ("胶囊", "胶囊"), ("片", "片"), ("丸", "丸"), ("散", "散"), ("糖浆", "糖浆"), ("滴眼液", "滴眼"), ("软膏", "软膏"),
    ("乳膏", "乳膏"), ("凝胶", "凝胶"), ("栓", "栓"), ("贴剂", "贴"), ("喷雾剂", "喷雾"), ("气雾剂", "气雾"),
    ("吸入剂", "吸入"), ("露", "露"), ("制剂", ""), ("粘合剂", "粘合剂"),
)
_LABEL_NOTICE = re.compile(r"^(?:国家药监局|国家药品监督管理局)关于修订(?P<drugs>.+?)(?:药品)?说明书的公告")
_SWITCH_NOTICE = re.compile(r"^(?:国家药监局|国家药品监督管理局)关于(?P<drugs>.+?)(?:非处方药)?转换为(?:处方药|非处方药)的公告")
_ENGLISH_SAFETY_TITLE = re.compile(r"^(?P<drug>[A-Z][A-Za-z\-]{2,40}(?: [a-z][A-Za-z\-]{2,40}){0,2})(?: \([^)]{1,60}\))?:\s")
_SPLIT = re.compile(r"[和、及与,，]")
_TRAILING = re.compile(r"(?:等非处方药|等处方药|等药品|等品种|等)$")
PLACEHOLDERS = ("未进行该项实验且无可靠参考文献", "尚不明确", "尚未明确", "目前尚无", "无")
LABEL_SECTIONS = (("boxedWarning", "黑框警告"), ("warningsMarks", "警示语"), ("contraindications", "禁忌"),
                  ("adverseReactions", "不良反应"), ("precautions", "注意事项"), ("drugInteractions", "药物相互作用"),
                  ("useInPregLact", "孕妇及哺乳期妇女用药"), ("useInChildren", "儿童用药"), ("useInElderly", "老年用药"))


def literature_url(endpoints: Endpoints) -> str:
    return endpoints.evimed_literature


def instruction_url(endpoints: Endpoints) -> str:
    return endpoints.evimed_instruction


def fold(text: Any) -> str:
    """Case-, width- and punctuation-folded text for exact comparisons (titles, journal names)."""
    value = unicodedata.normalize("NFKC", clean_markup(text)).casefold()
    value = re.sub(r"^the\s+", "", value)
    return re.sub(r"[\W_]+", "", value)


def drug_mentions(title: str, source_type: str | None) -> list[str]:
    """Drug names a safety notice names in one of the closed title forms (module docstring)."""
    for pattern in (_LABEL_NOTICE, _SWITCH_NOTICE):
        match = pattern.match(title.strip())
        if match:
            names = [_TRAILING.sub("", part.strip()) for part in _SPLIT.split(match.group("drugs"))]
            return [n for n in names if len(n) >= 2]
    if source_type == "regulator":
        match = _ENGLISH_SAFETY_TITLE.match(title.strip())
        if match:
            return [match.group("drug")]
    return []


def split_form(name: str) -> tuple[str, str | None]:
    """``(ingredient, required substring of a matching generic name)`` for a Chinese drug phrase."""
    for form, needle in DOSAGE_FORMS:
        if name.startswith(form) and len(name) > len(form):  # 注射用肌苷
            return name[len(form):], needle
        if name.endswith(form) and len(name) > len(form):
            return name[: -len(form)], needle
    return name, None


def label_matches(record: dict, name: str) -> bool:
    if re.fullmatch(r"[A-Za-z][A-Za-z \-]+", name):
        return fold(record.get("englishName")).startswith(fold(name)) and bool(fold(name))
    ingredient, needle = split_form(name)
    generic = clean_markup(record.get("genericNames"))
    return bool(ingredient) and ingredient in generic and (not needle or needle in generic)


def label_excerpt(record: dict) -> str | None:
    lines = []
    head = clean_markup(record.get("genericNames"))
    maker = clean_markup(record.get("enterpriseName"))
    spec = clean_markup(record.get("specifications"))
    detail = "，".join(p for p in (maker, spec) if p)
    lines.append(f"【药品】{head}" + (f"（{detail}）" if detail else ""))
    for field, label in LABEL_SECTIONS:
        text = clean_markup(record.get(field))
        if text and text.rstrip("。.") not in PLACEHOLDERS:
            lines.append(f"【{label}】{text}")
    if len(lines) == 1:
        return None
    url = str(record.get("url") or "")
    if url.startswith("https://"):
        lines.append(f"【说明书】{url}")
    excerpt = "\n".join(lines)
    return excerpt if len(excerpt) <= EXCERPT_MAX else excerpt[: EXCERPT_MAX - 1].rstrip() + "…"


async def _post(fetcher: Any, url: str, body: dict, trace: Trace, step: str) -> Any:
    attempt = await get(fetcher, url, method="POST", body=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                        headers={"Content-Type": "application/json"})
    if attempt.result is None:
        trace.record(attempt, step)
        return None
    try:
        payload = json.loads(attempt.result.body.decode("utf-8", errors="replace"))
    except ValueError:
        trace.notes.append(f"{step}_unreadable")
        return None
    if not isinstance(payload, dict) or payload.get("code") != 200:
        trace.notes.append(f"{step}_code_{payload.get('code') if isinstance(payload, dict) else 'none'}")
        return None
    return payload.get("data")


async def journal_facts(fetcher: Any, endpoints: Endpoints, *, title: str, journal: str | None,
                        trace: Trace) -> dict[str, Any]:
    """``impact_factor`` / ``core_journal_tags`` for an article (exact title, else same journal)."""
    data = await _post(fetcher, literature_url(endpoints),
                       {"query": title[:200], "type": "literature", "count": LITERATURE_COUNT}, trace, "evimed_literature")
    records = ((data or {}).get("literature") or {}).get("list") if isinstance(data, dict) else None
    if not isinstance(records, list):
        return {}
    wanted_title, wanted_journal = fold(title), fold(journal)
    chosen = next((r for r in records if fold(r.get("title")) == wanted_title), None)
    if chosen is None and wanted_journal:
        chosen = next((r for r in records if fold(r.get("journal")) == wanted_journal and r.get("impactFactor") is not None), None)
    if chosen is None:
        trace.notes.append("evimed_literature_no_match")
        return {}
    facts: dict[str, Any] = {}
    factor = chosen.get("impactFactor")
    if isinstance(factor, (int, float)) and not isinstance(factor, bool) and factor >= 0:
        facts["impact_factor"] = float(factor)
    tags = [clean_markup(t) for t in chosen.get("coreJournals") or [] if clean_markup(t)]
    if tags:
        facts["core_journal_tags"] = tags
    return facts


async def drug_label(fetcher: Any, endpoints: Endpoints, names: list[str], trace: Trace) -> str | None:
    """The NMPA label excerpt of the first named drug the index has a matching label for."""
    for name in names[:3]:
        data = await _post(fetcher, instruction_url(endpoints), {"query": name, "count": LABEL_COUNT, "source": ["nmpa"]},
                           trace, "evimed_instruction")
        records = (data or {}).get("nmpa") if isinstance(data, dict) else None
        for record in records if isinstance(records, list) else []:
            if isinstance(record, dict) and label_matches(record, name):
                excerpt = label_excerpt(record)
                if excerpt:
                    return excerpt
    trace.notes.append("evimed_label_no_match")
    return None
