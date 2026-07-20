"""
内部数据库检索服务
优先使用内部知识库，PubMed 作为兜底。

接口地址: POST https://www.evimed.com/api-evimed/FineScreenController/interface/paper
请求体: {"query": "检索词"}
接口会自动拆分 PICO 并返回文献列表。
"""
import asyncio
import logging
import re
from typing import List, Optional

import aiohttp

from models.schemas import LiteratureRecord

logger = logging.getLogger(__name__)

import os
INTERNAL_DB_URL = os.getenv(
    "INTERNAL_DB_URL",
    "https://www.evimed.com/api-evimed/FineScreenController/interface/paper"
)
REQUEST_TIMEOUT = 30  # 秒

# 与 PubMed _identify_study_design 保持一致的标准类型集合
_CLINICAL_DESIGNS = {
    'RCT', 'Cohort', 'Case-Control', 'Meta-analysis', 'Systematic Review',
    'Clinical Trial', 'Clinical Study', 'Cross-sectional', 'Comparative Study',
    'Quasi-experimental',
}

# 原始 PublicationType / studyDesign → 标准研究设计类型
_PUBTYPE_TO_DESIGN = {
    "meta-analysis": "Meta-analysis",
    "systematic review": "Systematic Review",
    "randomized controlled trial": "RCT",
    "controlled clinical trial": "RCT",
    "clinical trial, phase i": "Clinical Trial",
    "clinical trial, phase ii": "Clinical Trial",
    "clinical trial, phase iii": "Clinical Trial",
    "clinical trial, phase iv": "Clinical Trial",
    "clinical trial": "Clinical Trial",
    "review": "Review",
    "case reports": "Case Report",
    "case report": "Case Report",
    "comparative study": "Comparative Study",
    "observational study": "Cohort",
    "cohort study": "Cohort",
    "case-control study": "Case-Control",
    "cross-sectional study": "Cross-sectional",
    "in vitro": "In Vitro",
    "animal study": "Animal Study",
    # 非研究设计类型 → None（后续用摘要/关键词推断）
    "journal article": None,
    "english abstract": None,
    "multicenter study": "Clinical Study",
    "letter": None,
    "editorial": None,
    "comment": None,
    "news": None,
    "other": None,
}

# 已经是标准类型则直接返回
_STANDARD_DESIGNS = {
    "Meta-analysis", "Systematic Review", "RCT", "Clinical Trial",
    "Non-randomized Trial", "Cohort", "Case-Control", "Cross-sectional",
    "Comparative Study", "Clinical Study", "Review", "Case Report",
    "Case Series", "Animal Study", "In Vitro", "Basic Research", "Other",
}


def _normalize_study_design(
    raw: str,
    abstract: str = "",
    keywords: List[str] = None,
    title: str = "",
) -> Optional[str]:
    """
    将原始 PublicationType 或 studyDesign 字段映射为标准研究设计类型。
    与 PubMed 的 _identify_study_design 保持一致：
    1. 精确匹配
    2. 模糊匹配
    3. 基于摘要关键词推断（与 PubMed Abstract cue 一致）
    """
    if not raw:
        raw = ""

    if raw in _STANDARD_DESIGNS:
        return raw

    key = raw.strip().lower()

    # 精确匹配
    if key in _PUBTYPE_TO_DESIGN:
        result = _PUBTYPE_TO_DESIGN[key]
        if result:
            return result
    else:
        # 模糊匹配
        for pattern, design in _PUBTYPE_TO_DESIGN.items():
            if pattern and pattern in key and design:
                return design

    # 基于摘要推断（与 PubMed _identify_study_design Abstract cue 一致）
    abstract_lower = (abstract or "").lower()
    title_lower = (title or "").lower()
    kw_text = " ".join(keywords or []).lower()
    combined = title_lower + " " + abstract_lower + " " + kw_text

    if "protocol" in title_lower or "study protocol" in abstract_lower:
        return "Protocol"
    if "meta-analysis" in combined:
        return "Meta-analysis"
    if "systematic review" in combined:
        return "Systematic Review"
    if any(t in title_lower for t in [
        "systematic review", "narrative review", "scoping review", "review of",
        "current knowledge", "expert statement", "what clinicians", "perspective",
    ]) or re.search(r"\b(review|overview)\b", title_lower):
        return "Review"
    if any(t in title_lower for t in ["case report", "case series"]):
        return "Case Report" if "case report" in title_lower else "Case Series"
    if any(t in combined for t in ["randomized controlled", "randomised controlled", "randomized trial"]):
        return "RCT"
    if any(t in title_lower for t in ["cross-sectional", "cross sectional", "survey"]):
        return "Cross-sectional"
    if any(t in title_lower for t in ["before-after", "before and after", "pre-post", "quality improvement"]):
        return "Quasi-experimental"
    if any(t in combined for t in ["case-control", "case control"]):
        return "Case-Control"
    if any(t in combined for t in ["cohort", "registry", "retrospective", "prospective", "cross-sectional"]):
        return "Cohort" if "cross-sectional" not in combined else "Cross-sectional"
    human_cues = any(t in combined for t in [
        "patient", "participant", "intensive care", "hospital", "clinical outcome",
        "therapeutic drug monitoring", "electronic health record",
    ])
    if (
        any(t in title_lower for t in ["in vitro", "cell line", "cell culture"])
        or (not human_cues and any(t in abstract_lower for t in ["in vitro study", "cell line", "cell culture"]))
    ):
        return "In Vitro"
    # Do not classify a clinical review as an animal experiment merely because
    # its abstract discusses animal evidence.  Require an experimental cue.
    animal_experiment = any(t in combined for t in [
        "mice were", "rats were", "animals were", "murine model", "rat model",
        "mouse model", "animal model", "in vivo experiment", "in vivo study",
    ])
    if animal_experiment and not any(t in combined for t in [
        "patients were", "participants were", "intensive care unit", "critically ill patients",
    ]):
        return "Animal Study"

    if any(t in title_lower for t in [
        "population pharmacokinetic", "pharmacokinetic-pharmacodynamic",
        "pharmacokinetic/pharmacodynamic", "target attainment", "monte carlo simulation",
    ]):
        return "Pharmacometric Study"
    if any(t in title_lower for t in [
        "quantitative method", "analytical method", "assay", "chromatography and mass spectrometry",
    ]):
        return "Methods Study"

    # Ambiguous prose is not automatically a clinical study.  Only use the
    # clinical label when the text contains an observable human-study cue.
    if human_cues:
        return "Clinical Study"
    if abstract_lower:
        return "Other"

    return "Basic Research"


def _map_record(item: dict, idx: int) -> Optional[LiteratureRecord]:
    """将内部接口返回的单条记录映射为 LiteratureRecord，与 PubMed 路径保持一致"""
    try:
        source_id = str(item.get("id") or item.get("paperId") or item.get("pmid") or f"internal_{idx}")
        raw_pmid = str(item.get("pmid") or "").strip()
        # PubMed identifiers are decimal numbers.  Internal compound IDs must
        # remain provenance IDs and must never be rendered as fake PMIDs.
        pmid = raw_pmid if re.fullmatch(r"[1-9][0-9]{0,8}", raw_pmid) else None
        title = item.get("title") or item.get("paperTitle") or "Unknown Title"
        abstract = item.get("abstract") or item.get("paperAbstract") or None
        if abstract:
            abstract = abstract[:2000]

        authors_raw = item.get("authors") or item.get("authorList") or []
        if isinstance(authors_raw, str):
            authors = [a.strip() for a in authors_raw.split(";") if a.strip()]
        else:
            authors = [str(a) for a in authors_raw]

        journal = item.get("journal") or item.get("journalName") or None

        # 年份：兼容 publication_year（下划线）、publicationYear（驼峰）、year、publishYear
        year_raw = (item.get("publication_year")
                    or item.get("year")
                    or item.get("publicationYear")
                    or item.get("publishYear"))
        try:
            publication_year = int(year_raw) if year_raw else None
        except (ValueError, TypeError):
            publication_year = None

        doi = item.get("doi") or None

        keywords_raw = item.get("keywords") or item.get("keyword") or []
        if isinstance(keywords_raw, str):
            keywords = [k.strip() for k in keywords_raw.split(";") if k.strip()]
        else:
            keywords = [str(k) for k in keywords_raw]
        keywords = keywords[:10]

        # mesh_terms：内部数据库可能有，尽量提取
        mesh_raw = item.get("meshTerms") or item.get("mesh_terms") or item.get("mesh") or []
        if isinstance(mesh_raw, str):
            mesh_terms = [m.strip() for m in mesh_raw.split(";") if m.strip()]
        else:
            mesh_terms = [str(m) for m in mesh_raw]
        mesh_terms = mesh_terms[:20]

        # 研究设计：多维识别，与 PubMed _identify_study_design 保持一致
        study_design = _normalize_study_design(
            item.get("studyDesign") or item.get("study_design") or "",
            abstract=abstract or "",
            keywords=keywords + mesh_terms,
            title=title,
        )

        # is_clinical：优先使用 JSON 里的直接值，否则从 study_design 推导
        is_clinical_raw = item.get("is_clinical")
        if is_clinical_raw is not None:
            is_clinical = bool(is_clinical_raw)
        else:
            is_clinical = study_design in _CLINICAL_DESIGNS

        # language：默认英文（与 PubMed 一致）
        language = item.get("language") or "en"

        return LiteratureRecord(
            id=f"internal_{source_id}",
            title=title,
            abstract=abstract,
            authors=authors[:10],
            journal=journal,
            publication_year=publication_year,
            doi=doi,
            pmid=pmid,
            keywords=keywords,
            mesh_terms=mesh_terms,
            study_design=study_design,
            is_clinical=is_clinical,
            language=language,
            citations=int(item.get("citations") or item.get("citationCount") or 0),
        )
    except Exception as e:
        logger.warning(f"内部数据库记录映射失败(idx={idx}): {e}")
        return None


async def search_internal_db(query: str) -> List[LiteratureRecord]:
    """
    调用内部数据库接口检索文献。

    Args:
        query: 原始检索词（接口自行拆分 PICO）

    Returns:
        LiteratureRecord 列表，接口异常或无结果时返回空列表
    """
    try:
        timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                INTERNAL_DB_URL,
                json={"query": query},
                headers={"Content-Type": "application/json"},
            ) as resp:
                if resp.status != 200:
                    logger.warning(f"内部数据库接口返回非200状态: {resp.status}")
                    return []
                data = await resp.json(content_type=None)

        # 兼容多种响应结构
        if isinstance(data, list):
            items = data
        elif isinstance(data, dict):
            items = (
                data.get("data")
                or data.get("records")
                or data.get("papers")
                or data.get("result")
                or []
            )
            if not items:
                logger.warning(f"内部数据库响应dict但未找到有效列表，顶层keys: {list(data.keys())}")
        else:
            logger.warning(f"内部数据库接口返回未知格式: {type(data)}")
            return []

        logger.info(f"内部数据库原始返回条数: {len(items)}")
        records = []
        for idx, item in enumerate(items):
            record = _map_record(item, idx)
            if record:
                records.append(record)

        logger.info(f"内部数据库检索成功，映射后有效文献: {len(records)}/{len(items)} 篇")
        return records

    except asyncio.TimeoutError:
        logger.warning(f"内部数据库接口超时（>{REQUEST_TIMEOUT}s）")
        return []
    except aiohttp.ClientError as e:
        logger.warning(f"内部数据库接口网络错误: {e}")
        return []
    except Exception as e:
        logger.warning(f"内部数据库检索异常: {e}")
        return []
