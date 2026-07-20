# [IN] query string (user topic), date_from, date_to
# [OUT] formal_query (Boolean PubMed string), strategy_report (dict)
# [POS] src/bibliometric/pubmed/search_strategy.py - formal search strategy builder

from __future__ import annotations

import logging
import re
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Optional

import requests

logger = logging.getLogger(__name__)

_EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
_ESEARCH_URL = f"{_EUTILS_BASE}/esearch.fcgi"
_EFETCH_URL = f"{_EUTILS_BASE}/efetch.fcgi"
_REQUEST_TIMEOUT = 30
_last_request_time: float = 0.0


# ── 常用医学术语 MeSH 本地缓存（跳过 API 调用，加快多概念检索速度）──
# entry_terms 只保留最常用的同义词（≤5 个）
_MESH_CACHE: dict[str, "MeSHResult"] = {}

def _build_mesh_cache() -> dict[str, "MeSHResult"]:
    _raw: list[tuple[str, str, str, list[str]]] = [
        # (term_lower, descriptor_name, descriptor_ui, entry_terms[:5])
        # ── 常用药物 ──
        ("metformin",        "Metformin",                        "D008687", ["Dimethylbiguanide", "Glucophage"]),
        ("imatinib",         "Imatinib Mesylate",                "D000068877", ["Gleevec", "STI571", "Imatinib"]),
        ("semaglutide",      "Semaglutide",                      "D000077218", ["Ozempic", "Wegovy"]),
        ("liraglutide",      "Liraglutide",                      "D000067757", ["Victoza", "Saxenda"]),
        ("osimertinib",      "Osimertinib",                      "D000077264", ["Tagrisso", "AZD9291"]),
        ("pembrolizumab",    "Pembrolizumab",                    "D000077494", ["Keytruda", "MK-3475"]),
        ("nivolumab",        "Nivolumab",                        "D000077397", ["Opdivo", "BMS-936558"]),
        ("dapagliflozin",    "Dapagliflozin",                    "D000077733", ["Farxiga", "Forxiga"]),
        ("empagliflozin",    "Empagliflozin",                    "D000077985", ["Jardiance"]),
        ("aspirin",          "Aspirin",                          "D001241", ["Acetylsalicylic Acid", "ASA"]),
        ("warfarin",         "Warfarin",                         "D014859", ["Coumadin", "Coumarin anticoagulant"]),
        ("atorvastatin",     "Atorvastatin",                     "D000069059", ["Lipitor"]),
        ("rosuvastatin",     "Rosuvastatin Calcium",             "D000077290", ["Crestor"]),
        ("insulin",          "Insulin",                          "D007328", ["Insulins"]),
        ("sitagliptin",      "Sitagliptin Phosphate",            "D000068679", ["Januvia"]),
        # ── 常见疾病 ──
        ("diabetes mellitus",         "Diabetes Mellitus",                  "D003920", ["DM", "Diabetes"]),
        ("type 2 diabetes",           "Diabetes Mellitus, Type 2",          "D003924", ["NIDDM", "Non-Insulin-Dependent Diabetes", "T2DM", "Adult-Onset Diabetes"]),
        ("type 1 diabetes",           "Diabetes Mellitus, Type 1",          "D003922", ["IDDM", "Insulin-Dependent Diabetes", "T1DM", "Juvenile Diabetes"]),
        ("hypertension",              "Hypertension",                       "D006973", ["High Blood Pressure", "Arterial Hypertension"]),
        ("heart failure",             "Heart Failure",                      "D006333", ["Cardiac Failure", "Myocardial Failure", "Congestive Heart Failure"]),
        ("myocardial infarction",     "Myocardial Infarction",              "D009203", ["Heart Attack", "Acute MI", "AMI"]),
        ("coronary artery disease",   "Coronary Artery Disease",            "D003324", ["CAD", "Coronary Heart Disease", "Ischemic Heart Disease"]),
        ("atrial fibrillation",       "Atrial Fibrillation",                "D001281", ["AFib", "AF", "Auricular Fibrillation"]),
        ("stroke",                    "Stroke",                             "D020521", ["Cerebrovascular Accident", "CVA", "Brain Infarction"]),
        ("lung cancer",               "Lung Neoplasms",                     "D008175", ["Pulmonary Cancer", "Lung Carcinoma", "Bronchogenic Carcinoma"]),
        ("breast cancer",             "Breast Neoplasms",                   "D001943", ["Mammary Cancer", "Breast Carcinoma", "Breast Tumor"]),
        ("colorectal cancer",         "Colorectal Neoplasms",               "D015179", ["Colon Cancer", "Rectal Cancer", "Colorectal Carcinoma"]),
        ("hepatocellular carcinoma",  "Carcinoma, Hepatocellular",          "D006528", ["Liver Cancer", "HCC", "Hepatoma"]),
        ("gastric cancer",            "Stomach Neoplasms",                  "D013274", ["Gastric Carcinoma", "Stomach Cancer"]),
        ("prostate cancer",           "Prostatic Neoplasms",                "D011471", ["Prostate Carcinoma", "Prostatic Carcinoma"]),
        ("leukemia",                  "Leukemia",                           "D007938", ["Blood Cancer", "Leukaemia"]),
        ("lymphoma",                  "Lymphoma",                           "D008223", ["Lymphatic Cancer", "Lymph Node Cancer"]),
        ("copd",                      "Pulmonary Disease, Chronic Obstructive", "D029424", ["COPD", "Emphysema", "Chronic Obstructive Pulmonary Disease"]),
        ("asthma",                    "Asthma",                             "D001249", ["Bronchial Asthma", "Allergic Asthma"]),
        ("rheumatoid arthritis",      "Arthritis, Rheumatoid",              "D001172", ["RA", "Rheumatic Arthritis"]),
        ("alzheimer disease",         "Alzheimer Disease",                  "D000544", ["Alzheimer's Disease", "Senile Dementia"]),
        ("parkinson disease",         "Parkinson Disease",                  "D010300", ["Parkinson's Disease", "Paralysis Agitans"]),
        ("obesity",                   "Obesity",                            "D009765", ["Overweight", "Adiposity", "Corpulence"]),
        ("depression",                "Depressive Disorder",                "D003866", ["Major Depression", "Unipolar Depression"]),
        ("sepsis",                    "Sepsis",                             "D018805", ["Bacteremia", "Systemic Inflammatory Response Syndrome"]),
        ("covid-19",                  "COVID-19",                           "D000086382", ["Coronavirus Disease 2019", "SARS-CoV-2 Infection"]),
        ("chronic kidney disease",    "Renal Insufficiency, Chronic",       "D051436", ["CKD", "Chronic Renal Failure", "Chronic Renal Insufficiency"]),
        ("inflammatory bowel disease","Inflammatory Bowel Diseases",        "D015212", ["IBD", "Crohn Disease", "Ulcerative Colitis"]),
        ("osteoporosis",              "Osteoporosis",                       "D010024", ["Bone Loss", "Low Bone Density"]),
        # ── 常见症状与体征 ──
        ("headache",                  "Headache",                           "D006261", ["Cephalalgia", "Head Pain", "Cephalgia"]),
        ("migraine",                  "Migraine Disorders",                 "D008881", ["Migraine Headache", "Hemicrania", "Migraine"]),
        ("pain",                      "Pain",                               "D010146", ["Chronic Pain", "Acute Pain", "Nociception"]),
        ("fever",                     "Fever",                              "D005334", ["Pyrexia", "Hyperthermia", "Febrile"]),
        ("dizziness",                 "Dizziness",                          "D004244", ["Vertigo", "Lightheadedness"]),
        ("fatigue",                   "Fatigue",                            "D005221", ["Tiredness", "Exhaustion", "Chronic Fatigue"]),
        ("anxiety",                   "Anxiety Disorders",                  "D001008", ["Anxiety Disorder", "Anxiety", "Anxious"]),
        ("insomnia",                  "Sleep Initiation and Maintenance Disorders", "D007319", ["Sleeplessness", "Sleep Insomnia", "Sleep Disorder"]),
        ("nausea",                    "Nausea",                             "D009325", ["Emesis", "Vomiting", "Nausea and Vomiting"]),
        ("dyspnea",                   "Dyspnea",                            "D004417", ["Shortness of Breath", "Breathlessness", "Respiratory Distress"]),
        ("chest pain",                "Chest Pain",                         "D002637", ["Thoracic Pain", "Angina"]),
        ("back pain",                 "Back Pain",                          "D001416", ["Lumbar Pain", "Backache", "Low Back Pain"]),
        ("edema",                     "Edema",                              "D004487", ["Swelling", "Fluid Retention"]),
        ("anemia",                    "Anemia",                             "D000740", ["Anaemia", "Iron Deficiency Anemia"]),
        # ── 常见研究方法 ──
        ("meta-analysis",             "Meta-Analysis as Topic",             "D017418", ["Systematic Review", "Pooled Analysis"]),
        ("randomized controlled trial","Randomized Controlled Trials as Topic","D016032", ["RCT", "Clinical Trial"]),
        ("systematic review",         "Systematic Reviews as Topic",        "D000078182", ["Literature Review", "Systematic Analysis"]),
        ("clinical trial",            "Clinical Trials as Topic",           "D002986", ["RCT", "Trial"]),
        ("cohort study",              "Cohort Studies",                     "D015331", ["Prospective Study", "Longitudinal Study"]),
        ("case-control study",        "Case-Control Studies",               "D016022", ["Case Control", "Retrospective Study"]),
        # ── 常见干预 ──
        ("immunotherapy",             "Immunotherapy",                      "D007167", ["Immune Therapy", "Biological Therapy"]),
        ("chemotherapy",              "Drug Therapy",                       "D004358", ["Antineoplastic Therapy", "Cancer Chemotherapy"]),
        ("radiotherapy",              "Radiotherapy",                       "D011871", ["Radiation Therapy", "Irradiation"]),
        ("surgery",                   "Surgical Procedures, Operative",     "D013514", ["Operation", "Surgical Intervention"]),
        ("exercise",                  "Exercise",                           "D015444", ["Physical Activity", "Physical Exercise", "Training"]),
        # ── 常见共病/合并症 ──
        ("comorbidity",               "Comorbidity",                        "D015897", ["Comorbidities", "Multimorbidity", "Co-morbidity"]),
        ("metabolic syndrome",        "Metabolic Syndrome",                 "D024821", ["Syndrome X", "Insulin Resistance Syndrome"]),
        ("dyslipidemia",              "Dyslipidemias",                      "D050171", ["Hyperlipidemia", "Hypercholesterolemia"]),
        ("nonalcoholic fatty liver disease", "Non-alcoholic Fatty Liver Disease", "D065626", ["NAFLD", "NASH", "Fatty Liver"]),
        ("sleep apnea",               "Sleep Apnea Syndromes",              "D012891", ["OSA", "Obstructive Sleep Apnea", "Sleep Disordered Breathing"]),
        # ── 常见生物标志物/指标 ──
        ("biomarker",                 "Biomarkers",                         "D015415", ["Biological Marker", "Biomarkers"]),
        ("inflammation",              "Inflammation",                       "D007249", ["Inflammatory Response", "Neuroinflammation"]),
        ("oxidative stress",          "Oxidative Stress",                   "D018384", ["Reactive Oxygen Species", "ROS", "Antioxidant"]),
        ("fibrosis",                  "Fibrosis",                           "D005355", ["Scarring", "Fibrous Tissue"]),
    ]
    cache: dict[str, "MeSHResult"] = {}
    for term_lower, desc_name, desc_ui, entry_terms in _raw:
        result = MeSHResult(
            descriptor_name=desc_name,
            descriptor_ui=desc_ui,
            entry_terms=entry_terms,
            tree_numbers=[],
        )
        cache[term_lower] = result
    return cache


def _rate_limit():
    global _last_request_time
    elapsed = time.time() - _last_request_time
    if elapsed < 0.34:
        time.sleep(0.34 - elapsed)
    _last_request_time = time.time()


def _get_xml(url: str, params: dict) -> Optional[ET.Element]:
    _rate_limit()
    try:
        resp = requests.get(url, params=params, timeout=_REQUEST_TIMEOUT)
        resp.raise_for_status()
        return ET.fromstring(resp.text)
    except Exception as exc:
        logger.warning("MeSH API error: %s", exc)
        return None


@dataclass
class MeSHResult:
    descriptor_name: str
    descriptor_ui: str = ""
    entry_terms: list[str] = field(default_factory=list)
    tree_numbers: list[str] = field(default_factory=list)


@dataclass
class ConceptBlock:
    """A single concept in the search strategy."""
    label: str
    mesh: Optional[MeSHResult] = None
    free_terms: list[str] = field(default_factory=list)
    mesh_lookup_failed: bool = False


_MESH_CACHE = _build_mesh_cache()


def _has_chinese(text: str) -> bool:
    """检测文本是否包含中文字符。"""
    return any("\u4e00" <= c <= "\u9fff" for c in text)


def _build_pubmed_query_llm(query: str) -> str:
    """使用 LLM 直接生成完整 PubMed 检索式（含 MeSH + 同义词）。失败返回空字符串。"""
    try:
        from bibliometric.llm.client import DeepSeekClient

        client = DeepSeekClient()
        if not client.available:
            return ""
        result = client.complete(
            messages=[
                {"role": "system", "content": (
                    "你是PubMed医学检索专家。将用户输入转换为PubMed布尔检索式。\n"
                    "规则：\n"
                    "1. 只提取最核心的1-2个概念（AND条件不超过2个，避免过度限制结果）\n"
                    "2. 每个概念用MeSH主题词+2-3个自由词同义词，括号内OR连接\n"
                    "3. 不同核心概念之间AND连接\n"
                    "4. 只输出检索式本身，不加任何说明\n"
                    "示例：\n"
                    "头痛 → (\"Headache\"[MeSH Terms] OR \"headache\"[Title/Abstract] OR \"cephalalgia\"[Title/Abstract])\n"
                    "糖尿病共病 → (\"Diabetes Mellitus\"[MeSH Terms] OR \"diabetes\"[Title/Abstract] OR \"DM\"[Title/Abstract]) AND (\"Comorbidity\"[MeSH Terms] OR \"comorbidity\"[Title/Abstract] OR \"multimorbidity\"[Title/Abstract])"
                )},
                {"role": "user", "content": query},
            ],
            tier="flash",
            max_tokens=200,
            temperature=0,
        ).strip().strip("'\"")
        if "[Title/Abstract]" in result or "[MeSH Terms]" in result:
            return result
        return ""
    except Exception as e:
        logger.warning(f"LLM生成PubMed检索式失败: {query} - {e}")
        return ""


def _translate_chinese_term_llm(term: str) -> str:
    """使用 LLM 将中文医学术语翻译为英文。失败返回空字符串。"""
    try:
        from bibliometric.llm.client import DeepSeekClient

        client = DeepSeekClient()
        if not client.available:
            return ""
        return client.complete(
            messages=[
                {
                    "role": "system",
                    "content": "将中文医学术语翻译为标准英文MeSH术语或通用名。只输出英文术语，不加解释。",
                },
                {"role": "user", "content": term},
            ],
            tier="flash",
            max_tokens=30,
            temperature=0.1,
        ).strip().strip("'\"")
    except Exception as e:
        logger.warning(f"LLM翻译失败: {term} - {e}")
        return ""


# 在 dataclass 定义完成后初始化缓存（_build_mesh_cache 中引用了 MeSHResult）
_MESH_CACHE = _build_mesh_cache()


def lookup_mesh(term: str, api_key: str = "", email: str = "") -> tuple[Optional[MeSHResult], bool]:
    """Look up a MeSH descriptor by name via NCBI eSearch + eFetch.

    Checks a local cache of common medical terms first to skip API calls.
    If term contains Chinese characters, attempts LLM translation before lookup.
    Returns (MeSHResult or None, lookup_failed: bool).
    lookup_failed=True means API/network error; False means no match found.
    """
    # 中文检测与 LLM 翻译
    if any("\u4e00" <= c <= "\u9fff" for c in term):
        translated = _translate_chinese_term_llm(term)
        if translated:
            logger.info(f"  中文术语翻译: {term} → {translated}")
            term = translated
        else:
            logger.warning(f"  中文术语翻译失败: {term}，尝试直接查找")

    cached = _MESH_CACHE.get(term.lower())
    if cached is not None:
        logger.info("  MeSH cache hit: %s → %s (%s)", term, cached.descriptor_name, cached.descriptor_ui)
        return cached, False

    params = {"db": "mesh", "term": f"{term}[MeSH Terms]", "retmax": "1"}
    if api_key:
        params["api_key"] = api_key
    if email:
        params["email"] = email

    root = _get_xml(_ESEARCH_URL, params)
    if root is None:
        return None, True  # API/network failure

    count_el = root.find("Count")
    if count_el is None or count_el.text == "0":
        return None, False  # No matching descriptor

    uid_el = root.find(".//IdList/Id")
    if uid_el is None or not uid_el.text:
        return None, False

    fetch_params = {"db": "mesh", "id": uid_el.text, "rettype": "full"}
    if api_key:
        fetch_params["api_key"] = api_key
    fetch_root = _get_xml(_EFETCH_URL, fetch_params)
    if fetch_root is None:
        return None, True  # API failure on fetch

    name = ""
    name_el = fetch_root.find(".//DescriptorName/String")
    if name_el is not None and name_el.text:
        name = name_el.text

    ui = ""
    ui_el = fetch_root.find(".//DescriptorUI")
    if ui_el is not None and ui_el.text:
        ui = ui_el.text

    entry_terms = []
    for concept in fetch_root.findall(".//Concept"):
        for term_el in concept.findall(".//Term/String"):
            if term_el.text and term_el.text != name:
                entry_terms.append(term_el.text)

    tree_numbers = []
    for tn_el in fetch_root.findall(".//TreeNumber"):
        if tn_el.text:
            tree_numbers.append(tn_el.text)

    return MeSHResult(
        descriptor_name=name,
        descriptor_ui=ui,
        entry_terms=entry_terms[:10],
        tree_numbers=tree_numbers,
    ), False


def _split_query_into_concepts(query: str) -> list[str]:
    """Split a user query into concept phrases.

    Handles quoted phrases, Chinese text, and splits on common delimiters.
    Examples:
        'semaglutide obesity' -> ['semaglutide', 'obesity']
        '"heart failure" treatment' -> ['heart failure', 'treatment']
        'CRISPR AND gene therapy' -> ['CRISPR', 'gene therapy']
        '头痛' -> ['头痛']
        '糖尿病 共病' -> ['糖尿病', '共病']
    """
    # Extract quoted phrases first.
    quoted = re.findall(r'"([^"]+)"', query)
    remainder = re.sub(r'"[^"]+"', '', query)
    relation = re.compile(
        r"\b(?:AND|in|for|with|versus|vs\.?|among|between|on)\b",
        flags=re.IGNORECASE,
    )
    segments = [part.strip(" ,;:-") for part in relation.split(remainder) if part.strip(" ,;:-")]
    generic = {"effect", "effects", "impact", "impacts", "role", "roles", "association", "relationship"}
    segments = [part for part in segments if part.casefold() not in generic]
    if len(segments) >= 2:
        return (quoted + segments)[:2]

    tokens = [token.strip(" ,;:-") for token in remainder.split() if token.strip(" ,;:-")]
    normalized = " ".join(tokens).casefold()
    known_phrases = sorted(
        (term for term in _MESH_CACHE if " " in term and term in normalized),
        key=lambda value: (len(value.split()), len(value)),
        reverse=True,
    )
    if known_phrases:
        phrase = known_phrases[0]
        remaining = re.sub(r"\b%s\b" % re.escape(phrase), " ", normalized, count=1)
        remaining = " ".join(remaining.split())
        concepts = ([remaining] if remaining else []) + [phrase]
        return (quoted + concepts)[:2]
    if len(tokens) <= 2:
        return (quoted + tokens)[:2]
    return (quoted + [" ".join(tokens)])[:2]


def build_search_strategy(
    query: str,
    date_from: str = "",
    date_to: str = "",
    api_key: str = "",
    email: str = "",
) -> dict:
    """Build a formal PubMed search strategy with MeSH terms.

    Returns dict with:
        formal_query: str - the Boolean PubMed query
        concepts: list[dict] - concept blocks with MeSH info
        strategy_text: str - formatted strategy for the report
    """
    # 检测中文输入：直接用 LLM 生成完整 PubMed 检索式（跳过分词+MeSH查找）
    if _has_chinese(query):
        logger.info(f"检测到中文输入，使用 LLM 生成完整检索式: {query}")
        llm_query = _build_pubmed_query_llm(query)
        if llm_query:
            logger.info(f"LLM 生成检索式: {llm_query[:150]}...")
            # 添加日期过滤
            formal_query = llm_query
            if date_from or date_to:
                from datetime import datetime as _dt
                start = f"{date_from}/01/01" if date_from else "1900/01/01"
                if date_to:
                    now = _dt.now()
                    if str(date_to) == str(now.year):
                        end = now.strftime("%Y/%m/%d")
                    else:
                        end = f"{date_to}/12/31"
                else:
                    end = "3000/12/31"
                formal_query += f' AND ("{start}"[Date - Publication] : "{end}"[Date - Publication])'

            return {
                "formal_query": formal_query,
                "concepts": [{"label": query, "free_terms": [], "mesh_descriptor": None,
                               "mesh_ui": None, "entry_terms_used": [], "mesh_lookup_failed": False,
                               "llm_generated": True}],
                "strategy_text": f"**LLM生成的PubMed检索式：**\n\n`{llm_query}`",
                "user_query": query,
            }
        else:
            logger.warning(f"LLM 生成检索式失败，尝试翻译后使用传统方法")
            # LLM 失败时，先翻译成英文再用传统方法
            translated = _translate_chinese_term_llm(query)
            if translated:
                logger.info(f"翻译成功: {query} → {translated}")
                query = translated
            else:
                logger.warning(f"翻译失败，直接使用原查询: {query}")

    # 英文输入或 LLM 失败：使用传统 MeSH 查找方法
    concepts_raw = _split_query_into_concepts(query)
    logger.info("Search concepts: %s", concepts_raw)

    blocks: list[ConceptBlock] = []
    for concept in concepts_raw:
        # 中文概念先翻译
        original_concept = concept
        if any("\u4e00" <= c <= "\u9fff" for c in concept):
            translated = _translate_chinese_term_llm(concept)
            if translated:
                logger.info(f"  概念翻译: {concept} → {translated}")
                concept = translated

        block = ConceptBlock(label=original_concept, free_terms=[concept] if not any("\u4e00" <= c <= "\u9fff" for c in concept) else [])
        mesh, lookup_failed = lookup_mesh(concept, api_key=api_key, email=email)
        if mesh:
            block.mesh = mesh
            # Add top entry terms as synonyms
            for et in mesh.entry_terms[:5]:
                if et.lower() != concept.lower():
                    block.free_terms.append(et)
            logger.info("  MeSH found: %s → %s (%s)",
                        concept, mesh.descriptor_name, mesh.descriptor_ui)
        elif lookup_failed:
            block.mesh_lookup_failed = True
            logger.info("  MeSH lookup failed: %s (API/network error, using free-text)", concept)
        else:
            logger.info("  MeSH not found: %s (no matching descriptor, using free-text)", concept)
        blocks.append(block)

    # Compile Boolean query
    formal_query = _compile_query(blocks, date_from, date_to)

    # Build strategy report
    strategy_text = _format_strategy(blocks, formal_query, date_from, date_to)

    # Serialize concept info
    concepts_info = []
    for b in blocks:
        info = {
            "label": b.label,
            "free_terms": b.free_terms,
            "mesh_descriptor": b.mesh.descriptor_name if b.mesh else None,
            "mesh_ui": b.mesh.descriptor_ui if b.mesh else None,
            "entry_terms_used": b.mesh.entry_terms[:5] if b.mesh else [],
            "mesh_lookup_failed": b.mesh_lookup_failed,
        }
        concepts_info.append(info)

    return {
        "formal_query": formal_query,
        "concepts": concepts_info,
        "strategy_text": strategy_text,
        "user_query": query,
    }


def _compile_query(
    blocks: list[ConceptBlock],
    date_from: str = "",
    date_to: str = "",
) -> str:
    """Compile concept blocks into a PubMed Boolean query."""
    block_parts = []
    for block in blocks:
        clauses = []
        # MeSH term with explosion
        if block.mesh:
            clauses.append(f'"{block.mesh.descriptor_name}"[MeSH Terms]')
        # Free-text terms in title/abstract
        for ft in block.free_terms:
            clauses.append(f'"{ft}"[Title/Abstract]')

        if clauses:
            inner = " OR ".join(clauses)
            block_parts.append(f"({inner})")

    query = " AND ".join(block_parts)

    # Date filter
    if date_from or date_to:
        from datetime import datetime as _dt
        start = f"{date_from}/01/01" if date_from else "1900/01/01"
        if date_to:
            # 如果 date_to 是当前年份，用实际当前日期而非 12/31
            now = _dt.now()
            if str(date_to) == str(now.year):
                end = now.strftime("%Y/%m/%d")
            else:
                end = f"{date_to}/12/31"
        else:
            end = "3000/12/31"
        query += f' AND ("{start}"[Date - Publication] : "{end}"[Date - Publication])'

    return query


def _format_strategy(
    blocks: list[ConceptBlock],
    formal_query: str,
    date_from: str,
    date_to: str,
) -> str:
    """Format the search strategy for display in the report."""
    lines = []

    for i, block in enumerate(blocks, 1):
        lines.append(f"**Concept {i}: {block.label}**")
        if block.mesh:
            lines.append(
                f"- MeSH descriptor: {block.mesh.descriptor_name} "
                f"({block.mesh.descriptor_ui})"
            )
            if block.mesh.entry_terms[:5]:
                terms = ", ".join(block.mesh.entry_terms[:5])
                lines.append(f"- Entry terms: {terms}")
        elif block.mesh_lookup_failed:
            lines.append("- MeSH descriptor: lookup failed (API/network error; free-text search used)")
        else:
            lines.append("- MeSH descriptor: no matching descriptor found (free-text search used)")
        ft_str = ", ".join(f'"{t}"' for t in block.free_terms)
        lines.append(f"- Free-text terms: {ft_str}")
        lines.append("")

    lines.append("**Boolean combination:** Concept blocks combined with AND")
    if date_from or date_to:
        lines.append(
            f"**Date filter:** {date_from or 'inception'} to {date_to or 'present'}"
        )
    lines.append(f"\n**Full search string:**\n\n`{formal_query}`")

    return "\n".join(lines)
