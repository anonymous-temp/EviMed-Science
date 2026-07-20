"""MeSH term lookup, PubChem drug synonyms, and abbreviation expansion.

Provides functions to look up, expand, validate, and suggest MeSH
(Medical Subject Headings) descriptors via the NCBI Entrez API.
Also provides PubChem synonym lookup for drugs/chemicals and a
curated mapping of common medical abbreviations.
"""

import logging
import os
import time
import urllib.parse
import xml.etree.ElementTree as ET
from typing import Optional

import requests

from new_meta.config import PUBMED_API_KEY, PUBMED_EMAIL

logger = logging.getLogger("metaagent.mesh")

# --- Constants ----------------------------------------------------------------

_EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
_ESEARCH_URL = f"{_EUTILS_BASE}/esearch.fcgi"
_EFETCH_URL = f"{_EUTILS_BASE}/efetch.fcgi"
_ESPELL_URL = f"{_EUTILS_BASE}/espell.fcgi"

_PUBCHEM_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
_PUBCHEM_TIMEOUT = 10  # seconds

_REQUEST_TIMEOUT = float(os.getenv("MESH_REQUEST_TIMEOUT", "5"))  # seconds
_MESH_API_DISABLED = os.getenv("MESH_API_DISABLED", "").strip().lower() in {"1", "true", "yes"}
_MAX_CONSECUTIVE_ERRORS = int(os.getenv("MESH_MAX_CONSECUTIVE_ERRORS", "2"))
_consecutive_mesh_errors: int = 0
_mesh_circuit_open_logged = False

# Rate-limiting: NCBI allows 10 req/s with an API key, 3 req/s without.
_RATE_LIMIT_WITH_KEY = 0.1
_RATE_LIMIT_WITHOUT_KEY = 0.34
_last_request_time: float = 0.0


# --- Helpers ------------------------------------------------------------------

def _rate_limit() -> None:
    """Sleep if necessary to respect the NCBI rate limit."""
    global _last_request_time
    delay = _RATE_LIMIT_WITH_KEY if PUBMED_API_KEY else _RATE_LIMIT_WITHOUT_KEY
    elapsed = time.time() - _last_request_time
    if elapsed < delay:
        time.sleep(delay - elapsed)
    _last_request_time = time.time()


def _build_params(**kwargs: str) -> dict[str, str]:
    """Build query parameters, injecting email and api_key when available."""
    params: dict[str, str] = {}
    if PUBMED_EMAIL:
        params["email"] = PUBMED_EMAIL
    if PUBMED_API_KEY:
        params["api_key"] = PUBMED_API_KEY
    params.update(kwargs)
    return params


def _get_xml(url: str, params: dict[str, str]) -> Optional[ET.Element]:
    """Perform a GET request and return the parsed XML root, or *None*."""
    global _consecutive_mesh_errors, _mesh_circuit_open_logged
    if _MESH_API_DISABLED:
        logger.warning("MeSH API disabled by MESH_API_DISABLED; skipping %s", url)
        return None
    if _consecutive_mesh_errors >= _MAX_CONSECUTIVE_ERRORS:
        if not _mesh_circuit_open_logged:
            logger.warning(
                "MeSH API circuit open after %d consecutive errors; skipping remaining MeSH lookups",
                _consecutive_mesh_errors,
            )
            _mesh_circuit_open_logged = True
        return None

    _rate_limit()
    try:
        resp = requests.get(url, params=params, timeout=_REQUEST_TIMEOUT)
        resp.raise_for_status()
        text = resp.text.lstrip("﻿ \t\n\r")
        if not text.startswith("<"):
            logger.error("Non-XML response from %s (first 200 chars): %s",
                         url, text[:200])
            _consecutive_mesh_errors += 1
            return None
        root = ET.fromstring(text)
        _consecutive_mesh_errors = 0
        _mesh_circuit_open_logged = False
        return root
    except requests.RequestException as exc:
        _consecutive_mesh_errors += 1
        logger.error("HTTP error querying %s: %s", url, exc)
        return None
    except ET.ParseError as exc:
        _consecutive_mesh_errors += 1
        logger.error("XML parse error for %s: %s", url, exc)
        return None


def _parse_docsum(el: ET.Element) -> Optional[dict]:
    """Parse a docsum XML record. Accepts <eSummaryResult> root or <DocSum>."""
    doc = el if el.tag == "DocSum" else el.find(".//DocSum")
    if doc is None:
        return None
    uid = (doc.find("Id").text or "") if doc.find("Id") is not None else ""
    entry_terms: list[str] = []
    mesh_item = doc.find('.//Item[@Name="DS_MeshTerms"]')
    if mesh_item is not None:
        for sub in mesh_item.findall('.//Item[@Name="string"]'):
            if sub.text:
                entry_terms.append(sub.text)
    descriptor_name = entry_terms[0] if entry_terms else ""
    tree_numbers: list[str] = []
    idx_item = doc.find('.//Item[@Name="DS_IdxLinks"]')
    if idx_item is not None:
        for tn in idx_item.findall('.//Item[@Name="TreeNum"]'):
            if tn.text:
                tree_numbers.append(tn.text)
    return {
        "descriptor_name": descriptor_name,
        "descriptor_ui": uid,
        "entry_terms": [t for t in entry_terms if t != descriptor_name],
        "tree_numbers": tree_numbers,
    }


# --- Public API ---------------------------------------------------------------

def lookup_mesh_term(term: str) -> Optional[dict]:
    """Look up a MeSH descriptor by name.

    Queries NCBI eSearch on the *mesh* database, then fetches the full
    descriptor record via eFetch.

    Returns
    -------
    dict or None
        A dictionary with keys ``descriptor_name``, ``descriptor_ui``,
        ``entry_terms`` (list of synonyms), and ``tree_numbers``; or
        *None* when the term is not found or a network error occurs.
    """
    search_params = _build_params(
        db="mesh",
        term=f"{term}[MeSH Terms]",
        retmax="1",
    )
    logger.debug("eSearch MeSH for '%s'", term)
    root = _get_xml(_ESEARCH_URL, search_params)
    if root is None:
        return None

    count_el = root.find("Count")
    if count_el is None or count_el.text == "0":
        logger.info("MeSH term '%s' not found.", term)
        return None

    id_el = root.find(".//IdList/Id")
    if id_el is None or not id_el.text:
        logger.warning("eSearch returned count > 0 but no ID for '%s'.", term)
        return None

    uid = id_el.text

    # eFetch via docsum (returns XML; "full" returns plain text)
    fetch_params = _build_params(db="mesh", id=uid, rettype="docsum")
    logger.debug("eFetch MeSH UID %s (docsum)", uid)
    fetch_root = _get_xml(_EFETCH_URL, fetch_params)
    if fetch_root is None:
        return None

    return _parse_docsum(fetch_root)


def expand_mesh_term(term: str) -> list[str]:
    """Return all entry-term synonyms for a MeSH descriptor.

    Parameters
    ----------
    term : str
        The MeSH descriptor name to look up.

    Returns
    -------
    list[str]
        A (possibly empty) list of synonym strings.
    """
    result = lookup_mesh_term(term)
    if result is None:
        return []
    return result["entry_terms"]


def validate_mesh_terms(terms: list[str]) -> dict[str, bool]:
    """Batch-validate a list of strings against the MeSH database.

    For each term an eSearch query is issued; the term is considered valid
    when at least one result is returned.

    Returns
    -------
    dict[str, bool]
        Mapping of each input term to *True* (valid) or *False* (not found).
    """
    validation: dict[str, bool] = {}
    for term in terms:
        params = _build_params(
            db="mesh",
            term=f"{term}[MeSH Terms]",
            retmax="0",
        )
        logger.debug("Validating MeSH term '%s'", term)
        root = _get_xml(_ESEARCH_URL, params)
        if root is None:
            validation[term] = False
            continue

        count_el = root.find("Count")
        validation[term] = count_el is not None and count_el.text not in (
            None,
            "0",
        )
    return validation


def suggest_mesh_terms(concept: str) -> list[str]:
    """Suggest MeSH descriptors for a free-text concept.

    Uses the NCBI eSpell API to obtain a spelling-corrected query, then
    searches the MeSH database for matching descriptors.

    Returns
    -------
    list[str]
        Up to 10 MeSH descriptor names.
    """
    # Step 1: spell-check / correct the concept via eSpell
    spell_params = _build_params(db="mesh", term=concept)
    logger.debug("eSpell for concept '%s'", concept)
    spell_root = _get_xml(_ESPELL_URL, spell_params)

    search_term = concept  # fallback to original
    if spell_root is not None:
        corrected_el = spell_root.find("CorrectedQuery")
        if corrected_el is not None and corrected_el.text:
            search_term = corrected_el.text
            logger.info(
                "eSpell corrected '%s' -> '%s'", concept, search_term
            )

    # Step 2: search MeSH with the (possibly corrected) term
    search_params = _build_params(
        db="mesh",
        term=search_term,
        retmax="10",
    )
    logger.debug("eSearch MeSH for suggestions: '%s'", search_term)
    root = _get_xml(_ESEARCH_URL, search_params)
    if root is None:
        return []

    uids = [el.text for el in root.findall(".//IdList/Id") if el.text]
    if not uids:
        return []

    # Step 3: fetch descriptor names for each UID (docsum returns XML)
    suggestions: list[str] = []
    ids_str = ",".join(uids)
    fetch_params = _build_params(db="mesh", id=ids_str, rettype="docsum")
    logger.debug("eFetch MeSH UIDs: %s", ids_str)
    fetch_root = _get_xml(_EFETCH_URL, fetch_params)
    if fetch_root is None:
        return []

    for doc in fetch_root.findall(".//DocSum"):
        parsed = _parse_docsum(doc)
        if parsed and parsed["descriptor_name"]:
            suggestions.append(parsed["descriptor_name"])

    return suggestions[:10]


# --- PubChem Drug Synonym Lookup ----------------------------------------------

def pubchem_synonyms(drug_name: str, max_synonyms: int = 15) -> list[str]:
    """Look up synonyms for a drug/chemical via the PubChem REST API.

    Queries PubChem by compound name and returns synonyms. Useful for
    expanding intervention terms with generic/brand name variants.

    Returns
    -------
    list[str]
        Up to *max_synonyms* synonym strings, excluding the input itself.
    """
    encoded = urllib.parse.quote(drug_name, safe="")
    url = f"{_PUBCHEM_BASE}/compound/name/{encoded}/synonyms/JSON"

    try:
        resp = requests.get(url, timeout=_PUBCHEM_TIMEOUT)
        if resp.status_code == 404:
            logger.debug("PubChem: compound '%s' not found.", drug_name)
            return []
        resp.raise_for_status()
        data = resp.json()
    except (requests.RequestException, ValueError) as exc:
        logger.warning("PubChem query for '%s' failed: %s", drug_name, exc)
        return []

    try:
        all_synonyms = data["InformationList"]["Information"][0]["Synonym"]
    except (KeyError, IndexError):
        return []

    # Filter: keep human-readable names, skip long SMILES/InChI
    name_lower = drug_name.lower()
    results: list[str] = []
    for syn in all_synonyms:
        if syn.lower() == name_lower:
            continue
        # Skip chemical notation (InChI, SMILES, etc.)
        if syn.startswith("InChI") or len(syn) > 80:
            continue
        # Skip purely numeric identifiers
        if syn.replace("-", "").replace(" ", "").isdigit():
            continue
        results.append(syn)
        if len(results) >= max_synonyms:
            break

    logger.debug("PubChem: '%s' → %d synonyms", drug_name, len(results))
    return results


# --- Common Medical Abbreviation Mappings ------------------------------------

COMMON_ABBREVIATIONS: dict[str, list[str]] = {
    # Diseases
    "T2DM": ["Type 2 Diabetes Mellitus", "Type 2 Diabetes", "Non-Insulin-Dependent Diabetes"],
    "T1DM": ["Type 1 Diabetes Mellitus", "Type 1 Diabetes", "Insulin-Dependent Diabetes"],
    "DM": ["Diabetes Mellitus"],
    "CKD": ["Chronic Kidney Disease", "Chronic Renal Disease"],
    "COPD": ["Chronic Obstructive Pulmonary Disease"],
    "CHF": ["Congestive Heart Failure", "Heart Failure"],
    "HF": ["Heart Failure"],
    "MI": ["Myocardial Infarction", "Heart Attack"],
    "ACS": ["Acute Coronary Syndrome"],
    "CAD": ["Coronary Artery Disease", "Coronary Heart Disease"],
    "CVD": ["Cardiovascular Disease"],
    "AF": ["Atrial Fibrillation"],
    "DVT": ["Deep Vein Thrombosis", "Deep Venous Thrombosis"],
    "PE": ["Pulmonary Embolism"],
    "VTE": ["Venous Thromboembolism"],
    "NAFLD": ["Non-Alcoholic Fatty Liver Disease"],
    "NASH": ["Non-Alcoholic Steatohepatitis"],
    "CLD": ["Chronic Liver Disease"],
    "IBD": ["Inflammatory Bowel Disease"],
    "UC": ["Ulcerative Colitis"],
    "CD": ["Crohn's Disease", "Crohn Disease"],
    "RA": ["Rheumatoid Arthritis"],
    "SLE": ["Systemic Lupus Erythematosus", "Lupus"],
    "OA": ["Osteoarthritis"],
    "MS": ["Multiple Sclerosis"],
    "ALS": ["Amyotrophic Lateral Sclerosis"],
    "PD": ["Parkinson's Disease", "Parkinson Disease"],
    "AD": ["Alzheimer's Disease", "Alzheimer Disease"],
    "ADHD": ["Attention Deficit Hyperactivity Disorder"],
    "MDD": ["Major Depressive Disorder", "Major Depression"],
    "GAD": ["Generalized Anxiety Disorder"],
    "PTSD": ["Post-Traumatic Stress Disorder"],
    "OCD": ["Obsessive-Compulsive Disorder"],
    "ASD": ["Autism Spectrum Disorder"],
    "ARDS": ["Acute Respiratory Distress Syndrome"],
    "NSCLC": ["Non-Small Cell Lung Cancer"],
    "SCLC": ["Small Cell Lung Cancer"],
    "HCC": ["Hepatocellular Carcinoma"],
    "CRC": ["Colorectal Cancer"],
    "AML": ["Acute Myeloid Leukemia"],
    "ALL": ["Acute Lymphoblastic Leukemia"],
    "CML": ["Chronic Myeloid Leukemia"],
    "NHL": ["Non-Hodgkin Lymphoma"],
    "RCC": ["Renal Cell Carcinoma"],
    "GBM": ["Glioblastoma Multiforme", "Glioblastoma"],
    "HIV": ["Human Immunodeficiency Virus", "HIV Infection"],
    "AIDS": ["Acquired Immunodeficiency Syndrome"],
    "HCV": ["Hepatitis C Virus", "Hepatitis C"],
    "HBV": ["Hepatitis B Virus", "Hepatitis B"],
    "TB": ["Tuberculosis"],
    "UTI": ["Urinary Tract Infection"],
    "PCOS": ["Polycystic Ovary Syndrome"],
    "BPH": ["Benign Prostatic Hyperplasia"],
    "OSA": ["Obstructive Sleep Apnea"],
    "IBS": ["Irritable Bowel Syndrome"],
    "GERD": ["Gastroesophageal Reflux Disease"],
    "AUD": ["Alcohol Use Disorder"],
    "SUD": ["Substance Use Disorder"],
    # Outcomes / Measures
    "BMI": ["Body Mass Index"],
    "HbA1c": ["Glycated Hemoglobin", "Hemoglobin A1c", "Glycosylated Hemoglobin"],
    "BP": ["Blood Pressure"],
    "SBP": ["Systolic Blood Pressure"],
    "DBP": ["Diastolic Blood Pressure"],
    "HR": ["Heart Rate"],
    "LDL": ["Low-Density Lipoprotein", "LDL Cholesterol"],
    "HDL": ["High-Density Lipoprotein", "HDL Cholesterol"],
    "eGFR": ["Estimated Glomerular Filtration Rate"],
    "GFR": ["Glomerular Filtration Rate"],
    "ALT": ["Alanine Aminotransferase", "Alanine Transaminase"],
    "AST": ["Aspartate Aminotransferase", "Aspartate Transaminase"],
    "CRP": ["C-Reactive Protein"],
    "ESR": ["Erythrocyte Sedimentation Rate"],
    "FEV1": ["Forced Expiratory Volume in 1 Second"],
    "FVC": ["Forced Vital Capacity"],
    "QoL": ["Quality of Life"],
    "HRQoL": ["Health-Related Quality of Life"],
    "OS": ["Overall Survival"],
    "PFS": ["Progression-Free Survival"],
    "DFS": ["Disease-Free Survival"],
    "ORR": ["Overall Response Rate", "Objective Response Rate"],
    "CR": ["Complete Response", "Complete Remission"],
    "PR": ["Partial Response", "Partial Remission"],
    "AE": ["Adverse Event", "Adverse Effect"],
    "SAE": ["Serious Adverse Event"],
    "NNT": ["Number Needed to Treat"],
    "NNH": ["Number Needed to Harm"],
    # Study design / methodology
    "RCT": ["Randomized Controlled Trial"],
    "CCT": ["Controlled Clinical Trial"],
    "ITT": ["Intention-to-Treat", "Intention to Treat"],
    "PP": ["Per Protocol"],
    "SR": ["Systematic Review"],
    "MA": ["Meta-Analysis"],
    # Drug classes
    "SSRI": ["Selective Serotonin Reuptake Inhibitor"],
    "SNRI": ["Serotonin-Norepinephrine Reuptake Inhibitor"],
    "TCA": ["Tricyclic Antidepressant"],
    "NSAID": ["Non-Steroidal Anti-Inflammatory Drug", "Nonsteroidal Anti-Inflammatory"],
    "ACEi": ["ACE Inhibitor", "Angiotensin-Converting Enzyme Inhibitor"],
    "ARB": ["Angiotensin Receptor Blocker", "Angiotensin II Receptor Blocker"],
    "PPI": ["Proton Pump Inhibitor"],
    "GLP-1 RA": ["GLP-1 Receptor Agonist", "Glucagon-Like Peptide-1 Receptor Agonist"],
    "SGLT2i": ["SGLT2 Inhibitor", "Sodium-Glucose Co-Transporter 2 Inhibitor"],
    "DPP-4i": ["DPP-4 Inhibitor", "Dipeptidyl Peptidase-4 Inhibitor"],
    "ICI": ["Immune Checkpoint Inhibitor"],
    "TKI": ["Tyrosine Kinase Inhibitor"],
    "mAb": ["Monoclonal Antibody"],
}


def expand_abbreviations(term: str) -> list[str]:
    """Expand a medical abbreviation into its full forms.

    Case-insensitive matching against COMMON_ABBREVIATIONS.

    Returns
    -------
    list[str]
        Full-form expansions, or an empty list if not recognized.
    """
    # Exact match (case-insensitive)
    for abbr, expansions in COMMON_ABBREVIATIONS.items():
        if term.strip().lower() == abbr.lower():
            return expansions

    return []


# --- Fuzzy MeSH matching via eSearch -----------------------------------------

def fuzzy_mesh_search(term: str, max_results: int = 5) -> list[dict]:
    """Search MeSH using free-text (no field restriction) for fuzzy matching.

    Unlike ``lookup_mesh_term`` which requires exact [MeSH Terms] match,
    this performs a broad search that can find related descriptors.

    Returns
    -------
    list[dict]
        Each dict has ``descriptor_name``, ``descriptor_ui``, ``confidence``
        (1.0 for first result, decaying for subsequent).
    """
    params = _build_params(
        db="mesh",
        term=term,
        retmax=str(max_results),
    )
    root = _get_xml(_ESEARCH_URL, params)
    if root is None:
        return []

    uids = [el.text for el in root.findall(".//IdList/Id") if el.text]
    if not uids:
        return []

    ids_str = ",".join(uids)
    fetch_params = _build_params(db="mesh", id=ids_str, rettype="docsum")
    fetch_root = _get_xml(_EFETCH_URL, fetch_params)
    if fetch_root is None:
        return []

    results: list[dict] = []
    for i, doc in enumerate(fetch_root.findall(".//DocSum")):
        parsed = _parse_docsum(doc)
        if parsed and parsed["descriptor_name"]:
            parsed["confidence"] = round(1.0 - i * 0.15, 2)
            results.append(parsed)

    return results
