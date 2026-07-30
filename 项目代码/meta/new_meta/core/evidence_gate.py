"""EvidenceGate — rule-based evidence validity check before RoB / effect sizes.

Runs AFTER data extraction, BEFORE RoB assessment and effect size computation.
All checks are deterministic (no LLM). Returns a GateResult that determines
whether the pipeline proceeds with meta-analysis, falls back to narrative,
or terminates with "evidence invalid".
"""
from __future__ import annotations

import logging
import re
from difflib import SequenceMatcher
from enum import Enum

from pydantic import BaseModel, ConfigDict

logger = logging.getLogger("metaagent.evidence_gate")


# ─────────────── Data Models ───────────────

class OutcomeTier(str, Enum):
    OUTCOME_EXTRACTABLE = "outcome_extractable"
    OUTCOME_REPORTED_NOT_EXTRACTABLE = "outcome_reported_but_not_extractable"
    OUTCOME_MISMATCH = "outcome_mismatch"
    OUTCOME_ABNORMAL_OR_UNCERTAIN = "outcome_abnormal_or_uncertain"


class EvidenceTier(str, Enum):
    DIRECT_ELIGIBLE_STUDY = "direct_eligible_study"
    ANALYZABLE_PRIMARY_OUTCOME = "analyzable_primary_outcome"
    META_ELIGIBLE_STUDY = "meta_eligible_study"
    INDIRECT_EVIDENCE = "indirect_evidence"
    EXCLUDED = "excluded"


class GateDecision(str, Enum):
    META = "meta"
    NARRATIVE = "narrative"
    EVIDENCE_GAP = "evidence_gap"


class StudyFlag(BaseModel):
    study_id: str
    study_label: str
    flag_type: str      # "indirect_evidence" | "anomaly" | "follow_up_short" | "sample_size_small"
    severity: str       # "warning" | "error"
    detail: str


class GateResult(BaseModel):
    decision: GateDecision
    reasons: list[str] = []
    flagged_studies: list[StudyFlag] = []
    meta_eligible_studies: list[str] = []
    evidence_classes: dict[str, str] = {}  # study_id → evidence_class (design-based)
    outcome_tiers: dict[str, str] = {}     # study_id → OutcomeTier value
    evidence_tiers: dict[str, str] = {}    # study_id → EvidenceTier value
    prisma_counts: dict[str, int] = {}     # 5 key numbers
    poolability_notes: list[str] = []
    summary: str = ""


class ReportState(BaseModel):
    """Read-only snapshot of all key numbers for manuscript generation.

    Populated once after GateResult is finalized. All report sections must
    read from this object — no LLM-generated counts allowed.
    """
    model_config = ConfigDict(frozen=True)

    report_type: str  # "meta" | "narrative" | "evidence_gap"

    # Three-tier study counts
    n_direct_eligible: int = 0
    n_analyzable_primary: int = 0
    n_meta_eligible: int = 0

    # PRISMA flow numbers (single source of truth)
    prisma_records_identified: int = 0
    prisma_after_dedup: int = 0
    prisma_not_screened: int = 0
    prisma_screened: int = 0
    prisma_full_text_assessed: int = 0
    prisma_studies_included: int = 0

    # PRISMA source breakdown
    prisma_source_database: int = 0
    prisma_source_user_upload: int = 0

    # Search metadata
    search_end_year: int | None = None

    # Classified study ID lists
    direct_eligible_ids: list[str] = []
    meta_eligible_ids: list[str] = []

    # Sample size (summed from direct_eligible only; None if incomplete)
    total_sample_size: int | None = None

    # Full classification data (for consistency checks)
    evidence_classes: dict[str, str] = {}
    evidence_tiers: dict[str, str] = {}
    outcome_tiers: dict[str, str] = {}


def build_report_state(
    gate_result: GateResult,
    extracted_studies: list,
    prisma_data: dict,
    date_range: str = "",
) -> ReportState:
    """Build a read-only manuscript fact state from EvidenceGate output."""
    evidence_tiers = gate_result.evidence_tiers or {}
    direct_ids = [sid for sid, tier in evidence_tiers.items() if tier == EvidenceTier.DIRECT_ELIGIBLE_STUDY.value]
    meta_ids = list(gate_result.meta_eligible_studies or [])

    total_n: int | None = 0
    direct_set = set(direct_ids)
    for study in extracted_studies or []:
        characteristics = getattr(study, "characteristics", None)
        sid = (
            getattr(characteristics, "pmid", None)
            or getattr(characteristics, "study_id", None)
            or getattr(characteristics, "doi", None)
        )
        if sid in direct_set:
            n = getattr(characteristics, "total_sample_size", None)
            if n is not None and total_n is not None:
                total_n += n
            else:
                total_n = None

    prisma = prisma_data or {}
    identification = prisma.get("identification", {}) if isinstance(prisma.get("identification", {}), dict) else {}
    eligibility = prisma.get("eligibility", {}) if isinstance(prisma.get("eligibility", {}), dict) else {}
    included = prisma.get("included", {}) if isinstance(prisma.get("included", {}), dict) else {}
    screening = prisma.get("screening", {}) if isinstance(prisma.get("screening", {}), dict) else {}

    search_end_year = _parse_date_range_end(date_range) if date_range else None
    if search_end_year is None:
        import datetime
        search_end_year = datetime.datetime.now().year

    return ReportState(
        report_type=gate_result.decision.value,
        n_direct_eligible=len(direct_ids),
        n_analyzable_primary=sum(
            1
            for tier in evidence_tiers.values()
            if tier in (
                EvidenceTier.DIRECT_ELIGIBLE_STUDY.value,
                EvidenceTier.ANALYZABLE_PRIMARY_OUTCOME.value,
            )
        ),
        n_meta_eligible=len(meta_ids),
        prisma_records_identified=identification.get("records_identified", 0),
        prisma_after_dedup=identification.get("records_after_dedup", 0),
        prisma_not_screened=identification.get("records_not_screened", 0),
        prisma_screened=screening.get("title_abstract_screened", 0),
        prisma_full_text_assessed=eligibility.get("full_text_assessed", 0),
        prisma_studies_included=included.get("studies_included", 0),
        prisma_source_database=identification.get("records_from_database", 0),
        prisma_source_user_upload=identification.get("records_from_user_upload", 0),
        search_end_year=search_end_year,
        direct_eligible_ids=direct_ids,
        meta_eligible_ids=meta_ids,
        total_sample_size=total_n if total_n else None,
        evidence_classes=dict(gate_result.evidence_classes or {}),
        evidence_tiers=dict(evidence_tiers),
        outcome_tiers=dict(gate_result.outcome_tiers or {}),
    )


# ─────────────── Helper functions (migrated from start.py) ───────────────

_OUTCOME_KEY_TERMS: dict[str, set[str]] = {
    "hba1c": {"hba1c", "hba₁c", "glycated hemoglobin", "glycated haemoglobin",
              "glycosylated hemoglobin", "糖化血红蛋白", "a1c"},
    "fpg": {"fpg", "fasting plasma glucose", "fasting blood glucose", "fbg", "空腹血糖"},
    "sbp": {"sbp", "systolic blood pressure", "收缩压"},
    "dbp": {"dbp", "diastolic blood pressure", "舒张压"},
    "bmi": {"bmi", "body mass index", "体质指数"},
    "weight": {"body weight", "body weight change", "weight loss", "weight change", "体重变化", "体重"},
    "cholesterol": {"total cholesterol", "总胆固醇"},
    "ldl": {"ldl", "ldl-c", "low density lipoprotein", "低密度脂蛋白", "ldl cholesterol"},
    "hdl": {"hdl", "hdl-c", "high density lipoprotein", "高密度脂蛋白", "hdl cholesterol"},
    "tg": {"triglyceride", "tg", "甘油三酯", "triglycerides"},
    "crp": {"crp", "c-reactive protein", "c反应蛋白"},
    "insulin": {"insulin", "insulin resistance", "胰岛素抵抗", "fasting insulin", "空腹胰岛素"},
    "homa_ir": {"homa-ir", "homa ir", "homeostasis model assessment"},
    "creatinine": {"creatinine", "肌酐", "serum creatinine"},
    "egfr": {"egfr", "estimated glomerular filtration rate", "肾小球滤过率"},
    "mortality": {"mortality", "death", "all-cause mortality", "死亡率", "survival"},
    "heart_failure_hospitalization": {
        "heart failure hospitalization", "heart failure hospitalisation",
        "hospitalization for heart failure", "hospitalisation for heart failure",
        "worsening heart failure", "hf hospitalization", "hf hospitalisation",
        "心衰住院", "心力衰竭住院",
    },
    "adverse": {"adverse event", "adverse events", "adverse reaction", "不良反应", "side effect", "safety"},
    "qol": {"quality of life", "qol", "生活质量"},
    "delirium": {"delirium", "postoperative delirium", "pod", "谵妄", "术后谵妄"},
    "cognitive_dysfunction": {
        "cognitive dysfunction", "postoperative cognitive dysfunction", "pocd",
        "认知功能障碍", "术后认知功能障碍",
    },
}


def _normalize_for_matching(text: str) -> str:
    """Normalize Unicode subscripts/superscripts for matching."""
    replacements = str.maketrans("₁₂₃₄₅₆₇₈₉₀⁰¹²³⁴⁵⁶⁷⁸⁹", "12345678900123456789")
    return text.translate(replacements)


def _outcome_key_groups(text: str) -> set[str]:
    """Extract which clinical key-term groups a text mentions."""
    t = _normalize_for_matching(text.lower())
    groups = set()
    for group_name, aliases in _OUTCOME_KEY_TERMS.items():
        for alias in aliases:
            if alias in t:
                groups.add(group_name)
                break
    return groups


# Patterns for extracting key abbreviations/codes from outcome text.
# E.g. "SRI-4", "HbA1c", "SLEDAI", "BILAG", "PGA" etc.
_OUTCOME_CODE_RE = re.compile(
    r'(?:^|[\s（(，,/|])'            # word boundary
    r'([a-z][\w/-]*[\d][\w/-]*'     # letter-started with digits: sri-4, hba1c
    r'|[a-z]{2,}-[a-z0-9]+)'        # hyphenated: sledai-2k, sri-4
    r'(?:$|[\s）)，,/|])',
    re.IGNORECASE,
)
# Known clinical abbreviations that serve as strong matching anchors
_CLINICAL_ABBREV = {
    "hba1c", "a1c",
    "fpg", "fbg",
    "sbp", "dbp",
    "bmi",
    "ldl-c", "hdl-c", "ldl", "hdl",
    "egfr",
}


def _keyword_crossmatch(name_lower: str, target_lower: str) -> bool:
    """Check if outcome_name and target share clinically significant abbreviations.

    Handles cases like:
      target: "SLE反应指数（SRI-4）应答率" → extracts "sri4"
      name:   "SRI4 response rate at Week 52" → extracts "sri4"
    Both normalize to "sri4" → match.
    """
    def _extract_codes(text):
        codes = set()
        for m in _OUTCOME_CODE_RE.finditer(text):
            code = m.group(1).lower().replace("-", "").replace("_", "")
            codes.add(code)
        # Also check for known abbreviations directly in text
        for abbrev in _CLINICAL_ABBREV:
            if abbrev in text:
                codes.add(abbrev.replace("-", "").replace("_", ""))
        return codes

    name_codes = _extract_codes(name_lower)
    target_codes = _extract_codes(target_lower)

    if not name_codes or not target_codes:
        return False

    # If they share any clinically significant code, it's a match
    shared = name_codes & target_codes
    return bool(shared)


def _has_mortality_concept(text: str) -> bool:
    return any(term in text for term in ("mortality", "death", "deaths", "survival"))


def _is_cause_specific_mortality(text: str) -> bool:
    cause_markers = (
        "cardiovascular", "cardiac", "cancer-specific", "disease-specific",
        "infection-related", "covid-related", "stroke", "non-cardiovascular",
    )
    return "all-cause" not in text and any(marker in text for marker in cause_markers)


def _is_composite_with_mortality(text: str) -> bool:
    if "composite" in text and _has_mortality_concept(text):
        return True
    composite_markers = (
        " or death", "death or ", "mortality or ", "or mortality",
        "mechanical ventilation or death", "death or mechanical ventilation",
        "respiratory support or death", "organ support or death",
        "cardiovascular death or ", " or cardiovascular death",
        "icu admission", "intensive care admission", "non-invasive ventilation",
        "niv", "receipt of invasive mechanical ventilation",
    )
    return _has_mortality_concept(text) and any(marker in text for marker in composite_markers)


def outcome_matches(outcome_name: str, target: str, threshold: float = 0.75) -> bool:
    """Check if an outcome name matches the target (fuzzy + clinical key-term)."""
    name_lower = outcome_name.strip().lower()
    target_lower = target.strip().lower()
    if not name_lower or not target_lower:
        return False
    name_days = set(re.findall(r"\b(\d+)\s*[- ]?\s*day", name_lower))
    target_days = set(re.findall(r"\b(\d+)\s*[- ]?\s*day", target_lower))
    if name_days and target_days and name_days.isdisjoint(target_days):
        return False
    if name_lower == target_lower:
        return True
    if target_lower in name_lower or name_lower in target_lower:
        return True
    if _has_mortality_concept(name_lower) and _has_mortality_concept(target_lower):
        if _is_composite_with_mortality(name_lower) and not _is_composite_with_mortality(target_lower):
            return False
        if "all-cause" in target_lower and _is_cause_specific_mortality(name_lower):
            return False
        if "all-cause" in name_lower or "all-cause" in target_lower or "mortality" in name_lower:
            return True
    # Clinical key-term matching: same clinical indicator → match
    name_groups = _outcome_key_groups(name_lower)
    target_groups = _outcome_key_groups(target_lower)
    if name_groups and target_groups:
        if name_groups & target_groups:
            return True
        # Both have key groups but none shared → strong negative signal, skip fuzzy
        return False
    # Keyword cross-match: extract key abbreviations/codes from both strings
    # Handles long target with definitions vs short outcome_name
    if _keyword_crossmatch(name_lower, target_lower):
        return True
    # Fuzzy fallback — only when no key groups exist for at least one side
    return SequenceMatcher(None, name_lower, target_lower).ratio() >= threshold


def is_outcome_meta_extractable(outcome, effect_measure: str) -> bool:
    """Check if outcome has sufficient raw data for effect size computation."""
    ot = (outcome.outcome_type or "").lower()

    if outcome.effect_size is not None and outcome.ci_lower is not None and outcome.ci_upper is not None:
        return True
    if outcome.hazard_ratio is not None and outcome.hr_ci_lower is not None:
        return True
    if outcome.events is not None and outcome.total_n is not None and outcome.total_n > 0:
        return True
    if outcome.correlation_r is not None and outcome.correlation_n is not None:
        return True

    if "dichot" in ot or effect_measure in ("OR", "RR", "RD"):
        has_i = (outcome.events_intervention is not None
                 and outcome.total_intervention is not None
                 and outcome.total_intervention > 0)
        has_c = (outcome.events_control is not None
                 and outcome.total_control is not None
                 and outcome.total_control > 0)
        if has_i and has_c:
            return True

    if "contin" in ot or effect_measure in ("MD", "SMD"):
        has_i = (outcome.mean_intervention is not None
                 and outcome.sd_intervention is not None
                 and outcome.n_intervention is not None
                 and outcome.n_intervention > 0)
        has_c = (outcome.mean_control is not None
                 and outcome.sd_control is not None
                 and outcome.n_control is not None
                 and outcome.n_control > 0)
        has_i_median = (outcome.median_intervention is not None
                        and outcome.n_intervention is not None
                        and outcome.n_intervention > 0
                        and ((outcome.q1_intervention is not None and outcome.q3_intervention is not None)
                             or (outcome.min_intervention is not None and outcome.max_intervention is not None)))
        has_c_median = (outcome.median_control is not None
                        and outcome.n_control is not None
                        and outcome.n_control > 0
                        and ((outcome.q1_control is not None and outcome.q3_control is not None)
                             or (outcome.min_control is not None and outcome.max_control is not None)))
        if has_i and has_c:
            return True
        if has_i_median and has_c_median:
            return True

    has_dichot = (outcome.events_intervention is not None and outcome.total_intervention is not None
                  and outcome.events_control is not None and outcome.total_control is not None
                  and outcome.total_intervention > 0 and outcome.total_control > 0)
    has_cont = (outcome.mean_intervention is not None and outcome.sd_intervention is not None
                and outcome.n_intervention is not None and outcome.n_control is not None
                and outcome.mean_control is not None and outcome.sd_control is not None
                and outcome.n_intervention > 0 and outcome.n_control > 0)
    has_cont_median = (
        outcome.median_intervention is not None
        and outcome.median_control is not None
        and outcome.n_intervention is not None and outcome.n_intervention > 0
        and outcome.n_control is not None and outcome.n_control > 0
        and ((outcome.q1_intervention is not None and outcome.q3_intervention is not None)
             or (outcome.min_intervention is not None and outcome.max_intervention is not None))
        and ((outcome.q1_control is not None and outcome.q3_control is not None)
             or (outcome.min_control is not None and outcome.max_control is not None))
    )
    return has_dichot or has_cont or has_cont_median


def assess_poolability(meta_eligible: list, classes: dict, protocol) -> tuple[bool, list[str]]:
    """Assess whether studies can be meaningfully pooled.

    Returns (can_pool, notes).
    """
    notes: list[str] = []
    if len(meta_eligible) < 2:
        notes.append(f"仅 {len(meta_eligible)} 项研究满足Meta条件（需≥2）")
        return False, notes

    outcome_types: set[str] = set()
    for s in meta_eligible:
        for o in s.outcomes:
            if o.outcome_type:
                outcome_types.add(o.outcome_type.lower())
    if len(outcome_types) > 1 and "dichotomous" in outcome_types and "continuous" in outcome_types:
        notes.append("研究间结局类型混合（二分类+连续型），需分亚组分析")

    compatible, reason = check_intervention_compatibility(meta_eligible, protocol)
    if not compatible:
        notes.append(f"干预措施不兼容: {reason}")
        return False, notes

    return True, notes


_SKIP_WORDS = {
    "mg", "ml", "g", "mcg", "iu", "units", "%", "mg/kg", "mcg/kg",
    "day", "days", "week", "weeks", "month", "months", "year", "years",
    "hour", "hours", "minute", "minutes", "time", "times",
    "daily", "weekly", "monthly", "annually", "once", "twice",
    "once-daily", "once-weekly", "twice-daily", "twice-weekly",
    "three-times", "three-times-weekly",
    "oral", "iv", "im", "sc", "po", "topical", "inhaled", "sublingual",
    "intravenous", "intramuscular", "subcutaneous",
    "tablet", "capsule", "injection", "solution", "cream", "ointment",
    "gel", "patch", "powder", "syrup", "drops", "spray",
    "tablets", "capsules", "injections",
    "bid", "tid", "qid", "qd", "qod", "prn", "stat",
    "dose", "doses", "dosage", "amount", "concentration",
    "milligram", "microgram", "gram",
    "standard", "placebo", "control", "active", "high", "low",
    "treatment", "therapy", "regimen", "course", "cycle", "duration",
    "period", "follow-up", "followup", "versus", "vs", "compared",
    "plus", "and", "with", "for", "the", "per", "each", "every",
    "patients", "participants", "subjects", "group", "arm", "received",
    "given", "administered", "randomly", "assigned", "based", "using",
    "combined", "alone", "only", "both", "either", "neither", "not",
    "including", "excluding", "without", "within", "after", "before",
    "during", "over", "under", "from", "into", "about", "between",
    "through", "among", "across", "along", "also", "been", "being",
    "can", "could", "had", "has", "have", "more", "most", "much",
    "must", "new", "nor", "other", "our", "same", "shall", "should",
    "still", "such", "than", "that", "them", "then", "there", "these",
    "they", "this", "those", "very", "was", "were", "what", "when",
    "where", "which", "while", "who", "will", "would", "your",
    "total", "mean", "median", "average", "range", "approximately",
    "respectively", "significantly", "compared",
}

_DRUG_CLASS_SUFFIXES = [
    "glutide", "tide", "mab", "nib", "statin", "pril", "artan", "sartan",
    "dipine", "olol", "floxacin", "cillin", "cycline", "vir", "zosin",
]

_INTERVENTION_SYNONYMS: list[set[str]] = [
    {
        "corticosteroid", "corticosteroids", "systemic corticosteroid", "systemic corticosteroids",
        "glucocorticoid", "glucocorticoids", "steroid", "steroids",
        "hydrocortisone", "dexamethasone", "methylprednisolone", "prednisolone", "prednisone",
    },
]

# Disease synonym groups — terms within each group refer to the same condition.
# Used for PICO population matching: if both protocol and study mention any term
# from the same group, the population is considered matching.
_DISEASE_SYNONYMS: list[set[str]] = [
    {"covid-19", "covid19", "covid", "sars-cov-2", "sars cov 2", "sars-cov2",
     "sars cov2", "coronavirus disease 2019", "2019-ncov", "severe covid-19",
     "critical covid-19", "critical covid", "severe acute respiratory syndrome coronavirus 2"},
    {"type 2 diabetes", "type ii diabetes", "t2dm", "type 2 diabetes mellitus",
     "type ii diabetes mellitus", "niddm", "non-insulin-dependent diabetes",
     "adult-onset diabetes", "2型糖尿病", "二型糖尿病"},
    {"type 1 diabetes", "type i diabetes", "t1dm", "type 1 diabetes mellitus",
     "iddm", "insulin-dependent diabetes", "juvenile diabetes", "1型糖尿病"},
    {"hypertension", "high blood pressure", "essential hypertension",
     "高血压", "原发性高血压"},
    {"obesity", "obese", "adiposity", "肥胖", "肥胖症"},
    {"heart failure", "cardiac failure", "congestive heart failure", "chf",
     "心力衰竭", "充血性心力衰竭"},
    {"coronary artery disease", "cad", "coronary heart disease", "chd",
     "ischemic heart disease", "ischaemic heart disease", "冠心病", "冠状动脉疾病"},
    {"chronic kidney disease", "ckd", "chronic renal failure",
     "慢性肾脏病", "慢性肾衰竭"},
    {"non-alcoholic fatty liver disease", "nafld", "fatty liver",
     "非酒精性脂肪肝", "脂肪肝"},
    {"osteoarthritis", "oa", "degenerative joint disease", "骨关节炎"},
    {"depression", "major depressive disorder", "mdd", "抑郁", "抑郁症"},
    {"systemic lupus erythematosus", "sle", "lupus", "系统性红斑狼疮", "红斑狼疮",
     "disseminated lupus erythematosus", "红斑性狼疮"},
]


def _population_disease_match(study_pop: str, protocol_pop: str) -> bool:
    """Check if study and protocol populations refer to the same disease.

    Uses static synonym groups first, then falls back to fuzzy title overlap.
    """
    s = study_pop.lower()
    p = protocol_pop.lower()

    # 1. Static synonym groups
    for group in _DISEASE_SYNONYMS:
        s_hit = any(term in s for term in group)
        p_hit = any(term in p for term in group)
        if s_hit and p_hit:
            return True

    # 2. Dynamic fuzzy fallback: extract key health terms (>=3 chars) and check overlap
    _STOP = {"with", "from", "that", "this", "were", "have", "been", "their", "which",
             "patients", "subjects", "participants", "adults", "children", "among",
             "between", "treated", "receiving", "diagnosed", "history", "without",
             "the", "and", "for", "was", "are", "all", "who", "had", "has", "not", "per",
             "any", "age", "old", "new", "one", "two", "set"}
    s_terms = {w for w in re.findall(r'[a-z]{3,}', s) if w not in _STOP}
    p_terms = {w for w in re.findall(r'[a-z]{3,}', p) if w not in _STOP}
    overlap = s_terms & p_terms
    if len(overlap) >= 2:
        return True

    # 3. Extract disease abbreviations (3+ chars, lowercase) from both and check overlap
    s_abbr = set(re.findall(r'[（(]\s*([a-z]{2,})\s*[）)]', s))
    p_abbr = set(re.findall(r'[（(]\s*([a-z]{2,})\s*[）)]', p))
    if s_abbr and p_abbr and (s_abbr & p_abbr):
        return True

    # 4. SequenceMatcher fallback for short/specific disease names
    if SequenceMatcher(None, s, p).ratio() > 0.5:
        return True

    return False


def _intervention_class_match(study_intervention: str, protocol_intervention: str, title: str = "") -> bool:
    """Check whether a named intervention belongs to the protocol intervention class."""
    text = " ".join([study_intervention or "", title or ""]).lower()
    protocol = (protocol_intervention or "").lower()
    for group in _INTERVENTION_SYNONYMS:
        if any(term in protocol for term in group) and any(term in text for term in group):
            return True
    return False


def check_intervention_compatibility(extracted_studies: list, protocol) -> tuple[bool, str]:
    """Check whether studies are clinically compatible for pooling."""
    if not extracted_studies:
        return False, "无纳入研究"

    interventions = []
    for study in extracted_studies:
        c = study.characteristics
        desc = (c.intervention_description or "").strip().lower()
        if desc:
            interventions.append(desc)

    if not interventions:
        return True, ""

    core_terms = set()
    for desc in interventions:
        words = desc.replace(",", " ").replace(";", " ").replace("+", " ").replace("-", " ").split()
        for w in words:
            w_clean = w.strip("()[]{}.")
            if len(w_clean) >= 3 and w_clean not in _SKIP_WORDS:
                try:
                    float(w_clean)
                    continue
                except ValueError:
                    pass
                core_terms.add(w_clean)
                break

    if not core_terms or len(core_terms) <= 1:
        return True, ""

    terms_list = list(core_terms)

    # Check 1: All terms in protocol intervention
    if protocol and hasattr(protocol, 'pico') and hasattr(protocol.pico, 'intervention'):
        proto_intervention = (protocol.pico.intervention or "").lower()
        if all(term in proto_intervention for term in terms_list):
            return True, ""

    # Check 2: Same drug class by suffix
    for suffix in _DRUG_CLASS_SUFFIXES:
        matching = sum(1 for t in terms_list if t.endswith(suffix) and len(t) > len(suffix))
        if matching >= len(terms_list) / 2 and matching >= 2:
            return True, ""

    # Check 3: Common prefix
    if len(terms_list) >= 2:
        prefixes = set(t[:4].lower() for t in terms_list if len(t) >= 4)
        if len(prefixes) == 1:
            return True, ""

    return False, f"检测到不同类别干预措施: {', '.join(core_terms)}，临床异质性较大，不宜合并"


# ─────────────── Correlated outcome pairs for anomaly detection ───────────────

_CORRELATED_PAIRS = [
    ({"hba1c", "glycated hemoglobin", "糖化血红蛋白", "glycated haemoglobin", "a1c"},
     {"fpg", "fasting plasma glucose", "空腹血糖", "fasting blood glucose", "fbg"}),
    ({"sbp", "systolic blood pressure", "收缩压"},
     {"dbp", "diastolic blood pressure", "舒张压"}),
    ({"total cholesterol", "tc", "总胆固醇"},
     {"ldl", "ldl-c", "低密度脂蛋白", "ldl cholesterol"}),
]


# ─────────────── Evidence classification rules ───────────────

_EXCLUDED_DESIGNS_WORDS = {
    "case report", "case reports", "meta-analysis", "systematic review",
    "narrative review", "scoping review", "editorial", "comment",
    "letter", "news", "animal study", "in vitro", "basic research",
    "case series", "preclinical", "network meta-analysis",
}

# Use word-boundary regex for excluded designs to avoid substring false positives
_EXCLUDED_DESIGNS_REGEX = re.compile(
    r"\b(" + "|".join(re.escape(w) for w in _EXCLUDED_DESIGNS_WORDS) + r")\b",
    re.IGNORECASE,
)

# Special checks for "review" and "overview" and "animal" — need context awareness
def _is_excluded_design(design_lower: str) -> bool:
    if _EXCLUDED_DESIGNS_REGEX.search(design_lower):
        return True
    # "review" / "overview" only if NOT "peer-reviewed" or "reviewed"
    if re.search(r"\breview\b", design_lower) and not re.search(r"peer.?review", design_lower):
        return True
    if re.search(r"\boverview\b", design_lower):
        return True
    # "animal" only as standalone or "animal study" / "animal model"
    if re.search(r"\banimal\b", design_lower):
        return True
    return False

_OBSERVATIONAL_DESIGNS = {
    "cohort", "cohort study", "case-control", "case-control study",
    "cross-sectional", "cross-sectional study", "observational study",
    "prospective", "retrospective", "registry", "real-world", "real world",
    # Chinese equivalents
    "队列", "病例对照", "横断面", "观察性", "前瞻性", "回顾性",
}

_RCT_DESIGNS = {
    "rct", "randomized controlled trial", "randomised controlled trial",
    "randomized", "randomised", "controlled clinical trial",
    # Chinese equivalents
    "随机对照", "随机化",
}

# Regex patterns for RCT detection — word-boundary to prevent "non-randomized" false match
_RCT_PATTERN = re.compile(
    r"(?:^|\b)(?:" + "|".join(re.escape(w) for w in _RCT_DESIGNS) + r")(?:\b|$)",
    re.IGNORECASE,
)

# Explicit NON-randomized patterns — exclude these before RCT check
_NON_RANDOMIZED_PATTERN = re.compile(
    r"\bnon[\s-]?randomi[sz]ed\b",
    re.IGNORECASE,
)

_POSTHOC_KEYWORDS = {
    "post-hoc", "post hoc", "posthoc", "secondary analysis", "pooled analysis",
    "integrated analysis", "sub-study", "substudy",
}


def _classify_study_design(design: str) -> str:
    """Classify study design into detailed categories.

    Priority: RCT identification comes BEFORE post-hoc detection.
    A study that is randomized gets classified as direct_eligible_rct
    even if it also mentions post-hoc or subgroup analysis.
    """
    d = (design or "").strip().lower()
    if not d:
        return "untraceable"

    # Check excluded first (most restrictive)
    if _is_excluded_design(d):
        if "meta-analysis" in d or "systematic review" in d or "scoping review" in d:
            return "systematic_review_or_nma"
        if "case report" in d or "case series" in d:
            return "case_report"
        if "animal" in d or "in vitro" in d or "preclinical" in d or "basic research" in d:
            return "basic_or_preclinical"
        return "excluded"

    # Check RCT FIRST — but exclude "non-randomized" patterns
    if _NON_RANDOMIZED_PATTERN.search(d):
        pass  # fall through to observational / indirect checks
    elif _RCT_PATTERN.search(d):
        return "direct_eligible_rct"
    elif any(cn in d for cn in ("随机对照", "随机化")):
        return "direct_eligible_rct"

    # Check real-world
    if "real-world" in d or "real world" in d or "registry" in d:
        return "real_world_evidence"

    # Check post-hoc / secondary analysis (only for non-RCT studies)
    for ph in _POSTHOC_KEYWORDS:
        if ph in d:
            return "posthoc_or_secondary"

    # Check clinical trial (may not be randomized)
    if "clinical trial" in d or "clinical study" in d:
        return "indirect_clinical"

    # Check observational (includes Chinese terms)
    for obs in _OBSERVATIONAL_DESIGNS:
        if obs in d:
            return "observational"

    # Comparative or quasi-experimental
    if "comparative" in d or "quasi" in d or "non-randomized" in d:
        return "indirect_clinical"

    return "indirect_clinical"


def _parse_date_range_end(date_range: str) -> int | None:
    """Parse end year from date range string, clamped to current year."""
    import datetime
    now_year = datetime.datetime.now().year
    if not date_range:
        return None
    m = re.search(r'(\d{4})\s*[-–]\s*(\d{4})', date_range)
    if m:
        return min(int(m.group(2)), now_year)
    m = re.search(r'to\s+(\d{4})', date_range, re.IGNORECASE)
    if m:
        return min(int(m.group(1)), now_year)
    m = re.search(r'至\s*(\d{4})', date_range)
    if m:
        return min(int(m.group(1)), now_year)
    return None


def _first_author_lastname(authors) -> str:
    if not authors:
        return "Unknown"
    first = authors[0] if isinstance(authors, list) else str(authors)
    return first.split()[0] if first else "Unknown"


def _parse_follow_up_weeks(dur: str) -> float | None:
    dur_lower = (dur or "").lower().replace(" ", "")
    weeks_match = re.search(r'(\d+(?:\.\d+)?)\s*(?:周|week|wk)', dur_lower)
    if weeks_match:
        return float(weeks_match.group(1))
    months_match = re.search(r'(\d+(?:\.\d+)?)\s*(?:月|month|mo)', dur_lower)
    if months_match:
        return float(months_match.group(1)) * 4.33
    return None


def _extract_min_follow_up_weeks(criteria_text: str) -> float | None:
    for pat, unit in [
        (r'(?:>=?|≥|at\s+least|至少|不少于)\s*(\d+(?:\.\d+)?)\s*(?:周|week|wk)', "week"),
        (r'(?:>=?|≥|at\s+least|至少|不少于)\s*(\d+(?:\.\d+)?)\s*(?:月|month|mo)', "month"),
    ]:
        m = re.search(pat, criteria_text, re.IGNORECASE)
        if m:
            val = float(m.group(1))
            return val * 4.33 if unit == "month" else val
    return None


def _extract_min_sample_size(criteria_text: str) -> int | None:
    m = re.search(
        r'(?:sample\s*size|样本量|participants|受试者|subjects).{0,20}?'
        r'(?:>=?|≥|at\s+least|至少|不少于)\s*(\d+)',
        criteria_text, re.IGNORECASE,
    )
    return int(m.group(1)) if m else None


# ─────────────── EvidenceGate ───────────────

class EvidenceGate:
    """Rule-based gate: meta / narrative / evidence_gap."""

    def __init__(self, protocol):
        self.protocol = protocol
        self.primary_outcome = protocol.pico.outcome_primary
        self.effect_measure = protocol.effect_measure

    def evaluate(self, studies: list) -> GateResult:
        flags: list[StudyFlag] = []
        reasons: list[str] = []

        # Step 1: Outcome matching (3-tier)
        matched, indirect, outcome_tiers = self._match_outcomes(studies, flags)

        # Step 2: Evidence classification (study design filtering)
        classes: dict[str, str] = {}
        matched, excluded_design = self._classify_evidence(matched, flags, classes, outcome_tiers)
        indirect = [s for s in indirect if (s.characteristics.pmid or s.characteristics.study_id) not in excluded_design]

        # Step 3: Year filtering
        matched, year_excluded = self._filter_by_year(matched, flags)
        indirect = [s for s in indirect if (s.characteristics.pmid or s.characteristics.study_id) not in year_excluded]

        # Step 4: PICO matching (downgrade direct_eligible → indirect_clinical if mismatch)
        self._check_pico_match(matched, flags, classes)

        # Step 5: Anomaly detection
        anomaly_ids = self._detect_anomalies(matched, flags)

        # Step 5b: Downgrade outcome tier for anomalous studies
        for sid in anomaly_ids:
            if outcome_tiers.get(sid) == OutcomeTier.OUTCOME_EXTRACTABLE:
                outcome_tiers[sid] = OutcomeTier.OUTCOME_ABNORMAL_OR_UNCERTAIN

        # Step 6: Inclusion criteria (warning-only)
        self._check_inclusion_criteria(matched, flags)

        # Step 7: Computable effect sizes
        computable_ids = self._count_computable(matched, anomaly_ids, flags, classes, outcome_tiers)

        # Step 8: Intervention compatibility
        direct_studies = [s for s in matched if classes.get(s.characteristics.pmid or s.characteristics.study_id) == "direct_eligible_rct"]
        compatible, compat_reason = check_intervention_compatibility(direct_studies, self.protocol)

        return self._assemble_decision(
            studies, matched, indirect, computable_ids,
            compatible, compat_reason, flags, reasons, classes,
            outcome_tiers=outcome_tiers,
        )

    # ── Step 1: Outcome matching ──

    def _match_outcomes(self, studies, flags) -> tuple[list, list, dict[str, OutcomeTier]]:
        matched, indirect = [], []
        outcome_tiers: dict[str, OutcomeTier] = {}

        for study in studies:
            c = study.characteristics
            sid = c.pmid or c.study_id
            label = f"{_first_author_lastname(c.authors)} {c.year}"

            best_outcome = None
            for o in study.outcomes:
                if outcome_matches(o.outcome_name, self.primary_outcome):
                    best_outcome = o
                    break

            if best_outcome is None:
                # Check if extraction itself failed (0 outcomes or EXTRACTION_FAILED marker)
                if not study.outcomes:
                    # Extraction failed — classify as reported_not_extractable, not mismatch
                    matched.append(study)
                    outcome_tiers[sid] = OutcomeTier.OUTCOME_REPORTED_NOT_EXTRACTABLE
                    flags.append(StudyFlag(
                        study_id=sid, study_label=label,
                        flag_type="extraction_failed", severity="warning",
                        detail=f"数据提取失败（无结局数据），无法判断结局匹配性",
                    ))
                else:
                    indirect.append(study)
                    outcome_tiers[sid] = OutcomeTier.OUTCOME_MISMATCH
                    reported = ", ".join(o.outcome_name for o in study.outcomes[:5] if o.outcome_name) or "(无)"
                    flags.append(StudyFlag(
                        study_id=sid, study_label=label,
                        flag_type="indirect_evidence", severity="warning",
                        detail=f"未报告主要结局 {self.primary_outcome}，报告: {reported}",
                    ))
            elif is_outcome_meta_extractable(best_outcome, self.effect_measure):
                matched.append(study)
                outcome_tiers[sid] = OutcomeTier.OUTCOME_EXTRACTABLE
            else:
                matched.append(study)
                outcome_tiers[sid] = OutcomeTier.OUTCOME_REPORTED_NOT_EXTRACTABLE
                flags.append(StudyFlag(
                    study_id=sid, study_label=label,
                    flag_type="outcome_reported_not_extractable", severity="warning",
                    detail=f"报告了主要结局但数据不完整，无法计算效应量",
                ))

        n_ext = sum(1 for t in outcome_tiers.values() if t == OutcomeTier.OUTCOME_EXTRACTABLE)
        n_rne = sum(1 for t in outcome_tiers.values() if t == OutcomeTier.OUTCOME_REPORTED_NOT_EXTRACTABLE)
        n_mm = sum(1 for t in outcome_tiers.values() if t == OutcomeTier.OUTCOME_MISMATCH)
        logger.info(f"Outcome 3层分类: extractable={n_ext}, reported_not_extractable={n_rne}, mismatch={n_mm}")
        return matched, indirect, outcome_tiers

    # ── Step 2: Evidence classification ──

    def _classify_evidence(self, matched, flags, classes, outcome_tiers: dict[str, OutcomeTier]) -> tuple[list, set[str]]:
        """Classify studies by design. Returns filtered matched list and excluded IDs."""
        excluded_ids: set[str] = set()
        filtered = []
        for study in matched:
            c = study.characteristics
            sid = c.pmid or c.study_id
            label = f"{_first_author_lastname(c.authors)} {c.year}"
            ev_class = _classify_study_design(c.study_design)
            if (
                ev_class == "untraceable"
                and outcome_tiers.get(sid) == OutcomeTier.OUTCOME_EXTRACTABLE
                and self._protocol_targets_direct_rct()
            ):
                ev_class = "direct_eligible_rct"
                c.study_design = c.study_design or self._protocol_study_design_label()
                flags.append(StudyFlag(
                    study_id=sid,
                    study_label=label,
                    flag_type="design_inferred_from_protocol",
                    severity="warning",
                    detail=(
                        "研究设计字段缺失；因协议目标设计为随机对照试验且该研究主要结局可提取，"
                        "按协议设计作为报告期 fallback。"
                    ),
                ))
            classes[sid] = ev_class

            if ev_class == "excluded" or ev_class == "untraceable":
                excluded_ids.add(sid)
                flags.append(StudyFlag(
                    study_id=sid, study_label=label,
                    flag_type="design_excluded", severity="error",
                    detail=f"研究设计 '{c.study_design}' 不符合纳入标准（非目标设计）",
                ))
            elif ev_class in ("systematic_review_or_nma", "case_report", "basic_or_preclinical"):
                excluded_ids.add(sid)
                flags.append(StudyFlag(
                    study_id=sid, study_label=label,
                    flag_type=f"design_{ev_class}", severity="error",
                    detail=f"研究设计 '{c.study_design}' 属于{ev_class}，不计入直接RCT证据",
                ))
            else:
                filtered.append(study)

        if excluded_ids:
            logger.warning(f"证据分类: {len(excluded_ids)} 项研究因设计类型被排除")
        logger.info(f"证据分类: direct_rct={sum(1 for v in classes.values() if v == 'direct_eligible_rct')}, "
                     f"posthoc={sum(1 for v in classes.values() if v == 'posthoc_or_secondary')}, "
                     f"indirect={sum(1 for v in classes.values() if v == 'indirect_clinical')}, "
                     f"observational={sum(1 for v in classes.values() if v == 'observational')}")
        return filtered, excluded_ids

    def _protocol_targets_direct_rct(self) -> bool:
        design_values = [getattr(self.protocol, "study_design", "") or ""]
        design_values.extend(getattr(self.protocol, "study_designs", []) or [])
        return any(_classify_study_design(value) == "direct_eligible_rct" for value in design_values)

    def _protocol_study_design_label(self) -> str:
        design = str(getattr(self.protocol, "study_design", "") or "").strip()
        if design:
            return design
        for value in getattr(self.protocol, "study_designs", []) or []:
            value = str(value or "").strip()
            if value:
                return value
        return "Randomized Controlled Trial"

    # ── Step 3: Year filtering ──

    def _filter_by_year(self, matched, flags) -> tuple[list, set[str]]:
        """Exclude studies published after the search end date."""
        end_year = _parse_date_range_end(self.protocol.date_range)
        if not end_year:
            return matched, set()

        excluded_ids: set[str] = set()
        filtered = []
        for study in matched:
            c = study.characteristics
            sid = c.pmid or c.study_id
            if c.year > end_year:
                label = f"{_first_author_lastname(c.authors)} {c.year}"
                excluded_ids.add(sid)
                flags.append(StudyFlag(
                    study_id=sid, study_label=label,
                    flag_type="year_exceeded", severity="error",
                    detail=f"发表年份 {c.year} 晚于检索截止年份 {end_year}",
                ))
            else:
                filtered.append(study)

        if excluded_ids:
            logger.warning(f"年份过滤: 排除 {len(excluded_ids)} 项研究（>{end_year}年）")
        return filtered, excluded_ids

    # ── Step 4: PICO matching ──

    def _check_pico_match(self, matched, flags, classes: dict[str, str]):
        """Downgrade direct_eligible to indirect_clinical if PICO doesn't match."""
        proto = self.protocol.pico
        for study in matched:
            c = study.characteristics
            sid = c.pmid or c.study_id
            if classes.get(sid) != "direct_eligible_rct":
                continue

            label = f"{_first_author_lastname(c.authors)} {c.year}"
            downgrade_reasons = []

            # Population check (fuzzy + disease synonym)
            if proto.population and c.population_description:
                pop_lower = c.population_description.lower()
                proto_pop_lower = proto.population.lower()
                pop_match = (
                    proto_pop_lower in pop_lower
                    or pop_lower in proto_pop_lower
                    or SequenceMatcher(None, pop_lower, proto_pop_lower).ratio() > 0.45
                    or _population_disease_match(pop_lower, proto_pop_lower)
                )
                if not pop_match:
                    downgrade_reasons.append(f"人群不匹配: 研究'{pop_lower[:50]}' vs 协议'{proto_pop_lower[:50]}'")

            # Intervention check (fuzzy + title fallback)
            # Allow combination therapy: if protocol intervention appears ANYWHERE in
            # the study intervention (e.g., "metformin" in "metformin + sitagliptin")
            if proto.intervention and c.intervention_description:
                intv_lower = c.intervention_description.lower()
                proto_intv_lower = proto.intervention.lower()
                _bracket_norm = lambda s: s.replace("（", " ").replace("）", " ").replace("(", " ").replace(")", " ").replace(",", " ").replace(";", " ").replace("、", " ")
                proto_words = set(_bracket_norm(proto_intv_lower).split())
                intv_words = set(_bracket_norm(intv_lower).split())
                proto_core = {w for w in proto_words if len(w) >= 3 and w not in _SKIP_WORDS}
                intv_core = {w for w in intv_words if len(w) >= 3 and w not in _SKIP_WORDS}
                if proto_core and intv_core:
                    overlap = proto_core & intv_core
                    has_match = bool(overlap)
                    if not has_match:
                        # Substring match: protocol core words in study intervention text
                        has_match = any(pw in intv_lower for pw in proto_core if len(pw) >= 4)
                    if not has_match:
                        # Check title for drug name
                        title_lower = (c.title or "").lower()
                        has_match = any(pw in title_lower for pw in proto_core if len(pw) >= 4)
                    if not has_match:
                        has_match = _intervention_class_match(
                            intv_lower,
                            proto_intv_lower,
                            c.title or "",
                        )
                    if not has_match:
                        # Extract English words and check overlap
                        proto_en = set(re.findall(r'[a-z]{3,}', proto_intv_lower))
                        intv_en = set(re.findall(r'[a-z]{3,}', intv_lower))
                        has_match = bool(proto_en & intv_en)
                    if not has_match:
                        # Final fallback: check all study arms for protocol intervention
                        # Handles combination therapy where intervention is in one arm
                        arms_lower = intv_lower.replace("versus", "|").replace(" vs ", "|").replace("，", "|").replace(",", "|")
                        has_match = any(pw in arms_lower for pw in proto_core if len(pw) >= 4)
                    if not has_match:
                        downgrade_reasons.append(
                            f"干预不匹配: 研究'{intv_lower[:50]}' vs 协议'{proto_intv_lower[:50]}'"
                        )

            if downgrade_reasons:
                classes[sid] = "indirect_clinical"
                for reason in downgrade_reasons:
                    flags.append(StudyFlag(
                        study_id=sid, study_label=label,
                        flag_type="pico_mismatch", severity="warning",
                        detail=reason,
                    ))

    # ── Step 2: Anomaly detection ──

    def _detect_anomalies(self, studies, flags) -> set[str]:
        """Returns set of study_ids with error-severity anomalies (to exclude)."""
        error_ids: set[str] = set()
        for study in studies:
            c = study.characteristics
            sid = c.pmid or c.study_id
            label = f"{_first_author_lastname(c.authors)} {c.year}"

            for outcome in study.outcomes:
                # Check A: Impossible SD=0
                if outcome.sd_intervention is not None and outcome.sd_intervention == 0 \
                   and (outcome.n_intervention or 0) > 1:
                    flags.append(StudyFlag(
                        study_id=sid, study_label=label,
                        flag_type="anomaly", severity="error",
                        detail=f"{outcome.outcome_name}: SD_intervention=0 (N={outcome.n_intervention})",
                    ))
                    error_ids.add(sid)
                if outcome.sd_control is not None and outcome.sd_control == 0 \
                   and (outcome.n_control or 0) > 1:
                    flags.append(StudyFlag(
                        study_id=sid, study_label=label,
                        flag_type="anomaly", severity="error",
                        detail=f"{outcome.outcome_name}: SD_control=0 (N={outcome.n_control})",
                    ))
                    error_ids.add(sid)

                # Check B: Events > totals
                if outcome.events_intervention is not None and outcome.total_intervention is not None:
                    if outcome.events_intervention > outcome.total_intervention:
                        flags.append(StudyFlag(
                            study_id=sid, study_label=label,
                            flag_type="anomaly", severity="error",
                            detail=f"{outcome.outcome_name}: events_i({outcome.events_intervention}) > total_i({outcome.total_intervention})",
                        ))
                        error_ids.add(sid)
                if outcome.events_control is not None and outcome.total_control is not None:
                    if outcome.events_control > outcome.total_control:
                        flags.append(StudyFlag(
                            study_id=sid, study_label=label,
                            flag_type="anomaly", severity="error",
                            detail=f"{outcome.outcome_name}: events_c({outcome.events_control}) > total_c({outcome.total_control})",
                        ))
                        error_ids.add(sid)

            # Check C: Contradictory direction across correlated outcomes
            self._check_cross_outcome_contradiction(study, label, sid, flags)

        if error_ids:
            logger.warning(f"检测到 {len(error_ids)} 项研究存在数据异常")
        return error_ids

    def _check_cross_outcome_contradiction(self, study, label, sid, flags):
        """Flag when correlated outcomes move in opposite directions."""
        outcome_dirs: dict[str, float] = {}
        for o in study.outcomes:
            if o.mean_intervention is not None and o.mean_control is not None:
                diff = o.mean_intervention - o.mean_control
                if diff != 0:
                    name_lower = o.outcome_name.strip().lower()
                    outcome_dirs[name_lower] = diff

        for pair_a, pair_b in _CORRELATED_PAIRS:
            dir_a = None
            dir_b = None
            for name, diff in outcome_dirs.items():
                if any(kw in name for kw in pair_a):
                    dir_a = diff
                if any(kw in name for kw in pair_b):
                    dir_b = diff
            if dir_a is not None and dir_b is not None:
                if (dir_a > 0) != (dir_b > 0):
                    flags.append(StudyFlag(
                        study_id=sid, study_label=label,
                        flag_type="anomaly", severity="warning",
                        detail="相关结局指标方向矛盾（如FPG与HbA1c方向相反），可能存在数据异常",
                    ))

    # ── Step 3: Inclusion criteria ──

    def _check_inclusion_criteria(self, studies, flags):
        criteria_text = " ".join(self.protocol.inclusion_criteria).lower()
        min_weeks = _extract_min_follow_up_weeks(criteria_text)
        min_sample = _extract_min_sample_size(criteria_text)

        for study in studies:
            c = study.characteristics
            sid = c.pmid or c.study_id
            label = f"{_first_author_lastname(c.authors)} {c.year}"

            if min_weeks is not None:
                weeks = _parse_follow_up_weeks(c.follow_up_duration)
                if weeks is not None and weeks < min_weeks:
                    flags.append(StudyFlag(
                        study_id=sid, study_label=label,
                        flag_type="follow_up_short", severity="warning",
                        detail=f"随访 {c.follow_up_duration} ({weeks:.0f}周) < 协议要求 ({min_weeks:.0f}周)",
                    ))

            if min_sample is not None:
                n = c.total_sample_size
                if n is None and c.sample_size_intervention and c.sample_size_control:
                    n = c.sample_size_intervention + c.sample_size_control
                if n is not None and n < min_sample:
                    flags.append(StudyFlag(
                        study_id=sid, study_label=label,
                        flag_type="sample_size_small", severity="warning",
                        detail=f"样本量 {n} < 协议要求 ({min_sample})",
                    ))

    # ── Step 4: Computable effect sizes ──

    def _count_computable(self, matched, anomaly_ids, flags, classes: dict[str, str],
                          outcome_tiers: dict[str, OutcomeTier] | None = None) -> list[str]:
        """Count direct_eligible studies with computable effect sizes."""
        computable = []
        for study in matched:
            c = study.characteristics
            sid = c.pmid or c.study_id
            if sid in anomaly_ids:
                continue
            if classes.get(sid) != "direct_eligible_rct":
                continue
            # Use outcome_tiers if available, otherwise fall back to per-outcome check.
            # A reported-but-not-extractable tier must stay non-computable even if another
            # broad fuzzy match in the same study happens to contain count-like fields.
            if outcome_tiers is not None and sid in outcome_tiers:
                tier = outcome_tiers.get(sid)
                if tier in (OutcomeTier.OUTCOME_EXTRACTABLE, OutcomeTier.OUTCOME_EXTRACTABLE.value):
                    if sid not in computable:
                        computable.append(sid)
                continue
            else:
                for o in study.outcomes:
                    if outcome_matches(o.outcome_name, self.primary_outcome):
                        if is_outcome_meta_extractable(o, self.effect_measure):
                            if sid not in computable:
                                computable.append(sid)
                            break
        direct_count = sum(1 for v in classes.values() if v == "direct_eligible_rct")
        logger.info(f"可计算效应量: {len(computable)}/{direct_count} 项直接证据研究")
        return computable

    # ── Decision assembly ──

    def _assemble_decision(
        self, all_studies, matched, indirect, computable_ids,
        compatible, compat_reason, flags, reasons, classes: dict[str, str],
        outcome_tiers: dict[str, OutcomeTier] | None = None,
    ) -> GateResult:
        outcome_tiers = outcome_tiers or {}

        # Build evidence tiers for ALL studies
        matched_ids = {s.characteristics.pmid or s.characteristics.study_id for s in matched}
        evidence_tiers: dict[str, EvidenceTier] = {}
        for study in all_studies:
            c = study.characteristics
            sid = c.pmid or c.study_id
            design_class = classes.get(sid, "untraceable")

            if design_class in ("excluded", "untraceable", "systematic_review_or_nma",
                                "case_report", "basic_or_preclinical"):
                evidence_tiers[sid] = EvidenceTier.EXCLUDED
            elif sid not in matched_ids:
                evidence_tiers[sid] = EvidenceTier.INDIRECT_EVIDENCE
            elif outcome_tiers.get(sid) == OutcomeTier.OUTCOME_EXTRACTABLE and design_class == "direct_eligible_rct":
                evidence_tiers[sid] = EvidenceTier.DIRECT_ELIGIBLE_STUDY
            elif outcome_tiers.get(sid) in (OutcomeTier.OUTCOME_EXTRACTABLE, OutcomeTier.OUTCOME_REPORTED_NOT_EXTRACTABLE):
                evidence_tiers[sid] = EvidenceTier.ANALYZABLE_PRIMARY_OUTCOME
            else:
                evidence_tiers[sid] = EvidenceTier.INDIRECT_EVIDENCE

        # Count 5 key numbers
        n_full_text_assessed = len(all_studies)
        n_direct_eligible = sum(1 for v in evidence_tiers.values() if v == EvidenceTier.DIRECT_ELIGIBLE_STUDY)
        n_analyzable_primary = sum(1 for v in evidence_tiers.values()
                                   if v in (EvidenceTier.DIRECT_ELIGIBLE_STUDY, EvidenceTier.ANALYZABLE_PRIMARY_OUTCOME))

        # Meta eligible: direct_eligible + extractable + not anomaly
        meta_eligible_ids = []
        for sid in computable_ids:
            if evidence_tiers.get(sid) == EvidenceTier.DIRECT_ELIGIBLE_STUDY and sid not in meta_eligible_ids:
                meta_eligible_ids.append(sid)
        n_meta_eligible = len(meta_eligible_ids)

        # Poolability assessment
        meta_eligible_studies = [s for s in matched
                                 if (s.characteristics.pmid or s.characteristics.study_id) in set(meta_eligible_ids)]
        can_pool, pool_notes = assess_poolability(meta_eligible_studies, classes, self.protocol)

        prisma_counts = {
            "search_results": n_full_text_assessed,
            "full_text_assessed": n_full_text_assessed,
            "direct_eligible": n_direct_eligible,
            "analyzable_primary_outcome": n_analyzable_primary,
            "meta_eligible": n_meta_eligible,
        }

        # Dynamic report type: META > NARRATIVE > EVIDENCE_GAP (never terminates)
        if n_meta_eligible >= 2 and can_pool:
            decision = GateDecision.META
            summary = (f"纳入 {len(all_studies)} 项研究，"
                       f"{n_meta_eligible} 项满足Meta分析条件，进入定量合并分析。")
        elif n_direct_eligible >= 1:
            decision = GateDecision.NARRATIVE
            if not compatible:
                reasons.append(f"干预措施不兼容: {compat_reason}")
            reasons.append(f"{n_direct_eligible} 项直接证据研究不满足定量合并条件")
            summary = (f"纳入 {len(all_studies)} 项研究，"
                       f"{n_direct_eligible} 项直接证据，"
                       f"不满足Meta分析条件（{'; '.join(pool_notes)}），转为叙述性系统评价。")
        elif n_analyzable_primary >= 1:
            # Studies report the primary outcome but data extraction was incomplete
            # (outcome_reported_but_not_extractable) — still eligible for narrative review
            decision = GateDecision.NARRATIVE
            reasons.append(
                f"{n_analyzable_primary} 项研究报告了主要结局但数据提取不完整，"
                f"转为叙述性系统评价"
            )
            summary = (f"纳入 {len(all_studies)} 项研究，"
                       f"{n_analyzable_primary} 项可分析主要结局（数据提取不完整），"
                       f"转为叙述性系统评价。")
        else:
            decision = GateDecision.EVIDENCE_GAP
            summary = (f"纳入 {len(all_studies)} 项研究，"
                       f"无直接证据研究（直接证据={n_direct_eligible}，"
                       f"可分析主要结局={n_analyzable_primary}）。"
                       f"生成证据差距报告，描述现有证据并指出研究空白。")

        # Serialise enum values for JSON compatibility
        outcome_tiers_str = {k: v.value for k, v in outcome_tiers.items()}
        evidence_tiers_str = {k: v.value for k, v in evidence_tiers.items()}

        return GateResult(
            decision=decision,
            reasons=reasons,
            flagged_studies=flags,
            meta_eligible_studies=meta_eligible_ids,
            evidence_classes=classes,
            outcome_tiers=outcome_tiers_str,
            evidence_tiers=evidence_tiers_str,
            prisma_counts=prisma_counts,
            poolability_notes=pool_notes,
            summary=summary,
        )
