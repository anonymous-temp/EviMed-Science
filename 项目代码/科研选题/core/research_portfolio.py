"""Export validated agenda candidates without filling scientific design gaps."""

from copy import deepcopy
import json

from core.research_context import validate_research_context


DESIGN_FIELDS = {
    "hypothesis": "hypothesis",
    "studyDesign": "study_design",
    "estimand": "estimand",
    "dataRequirements": "data_requirements",
    "falsification": "falsification",
    "feasibility": "feasibility",
    "noveltyBasis": "novelty_basis",
}


def _description(value):
    """Preserve a supplied JSON description; numbers and empty containers are gaps."""
    if isinstance(value, str):
        return value if value.strip() else None
    if isinstance(value, (dict, list)) and value:
        try:
            json.dumps(value, allow_nan=False)
        except (TypeError, ValueError):
            return None
        return deepcopy(value)
    return None


def build_research_portfolio(direction, context, topics, opportunities, evidence_records):
    """Only export candidate lineages that resolve to the preserved evidence set."""
    opportunity_ids = [
        item.get("opportunity_id")
        for item in opportunities
        if isinstance(item, dict) and item.get("opportunity_id")
    ]
    if len(opportunity_ids) != len(set(opportunity_ids)):
        raise ValueError("duplicate opportunity id in research portfolio")
    sources = {item["opportunity_id"]: item for item in opportunities}
    evidence = {record.pmid: record for record in evidence_records if record.pmid}
    candidates = []
    candidate_ids = set()
    for topic in topics:
        source_id = topic.get("source_opportunity_id")
        source = sources.get(source_id)
        if source is None:
            raise ValueError("portfolio candidate has an unknown source opportunity")
        pmids = source.get("evidence_pmids", [])
        if not pmids or any(pmid not in evidence for pmid in pmids):
            raise ValueError("portfolio opportunity has missing or unknown evidence")
        retracted = [pmid for pmid in pmids if evidence[pmid].publication_status == "retracted"]
        if retracted:
            raise ValueError(
                "portfolio candidate cannot use retracted evidence: " + ", ".join(retracted)
            )
        if topic.get("source_evidence_pmids") != pmids or topic.get("support_level") != source.get("support_level"):
            raise ValueError("portfolio candidate did not inherit its source evidence and support level")
        candidate_id = topic.get("topic_id") or f"R-{source_id}"
        if candidate_id in candidate_ids:
            raise ValueError("duplicate candidate id in research portfolio")
        candidate_ids.add(candidate_id)
        candidate = {
            "candidateId": candidate_id,
            "title": topic.get("title") or source.get("title"),
            "sourceOpportunityId": source_id,
            "sourceEvidenceIds": [evidence[pmid].id for pmid in pmids],
            "sourceEvidencePmids": list(pmids),
            "supportLevel": source.get("support_level"),
            "supportRationale": source.get("support_rationale") or None,
        }
        missing = set(topic.get("design_gaps", []))
        for output, field in DESIGN_FIELDS.items():
            candidate[output] = None if field in missing else _description(topic.get(field))
        candidate["gaps"] = [field for field in DESIGN_FIELDS if candidate[field] is None]
        candidates.append(candidate)
    return {
        "schemaVersion": "1.0.0",
        "researchDirection": direction,
        "researchContext": validate_research_context(context),
        "candidates": candidates,
    }
