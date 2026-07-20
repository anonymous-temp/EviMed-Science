"""Deterministic compilers for EviMed drug evidence assessments.

The compilers validate traceability and decision boundaries. They do not
retrieve evidence, rate unobserved studies, or make clinical or procurement
decisions.
"""

import hashlib
import json
import math


COMPILER_VERSION = "1.4.0"

SELECTION_DOMAINS = (
    "pharmaceutical_properties",
    "effectiveness",
    "safety",
    "economics",
    "appropriateness",
    "accessibility",
    "innovation",
    "other",
)
COMPREHENSIVE_DOMAINS = (
    "effectiveness",
    "safety",
    "applicability",
    "economics",
    "hta",
    "evidence_certainty",
    "innovation",
    "accessibility",
    "equity",
    "other",
)
LABEL_DIMENSIONS = (
    "indication",
    "population",
    "dose",
    "route",
    "frequency",
    "duration",
    "formulation",
)
OFF_LABEL_EVIDENCE_TYPES = (
    "origin_country_label",
    "evidence_database",
    "clinical_guideline",
    "systematic_review",
    "randomized_trial",
    "nonrandomized_study",
    "case_report_or_series",
    "reference_work",
    "other",
)
QUALITY_APPRAISAL_TOOLS = (
    "agree_ii",
    "amstar_2",
    "jadad",
    "minors",
    "newcastle_ottawa_scale",
    "rob_2",
    "robins_i",
    "other",
)


class AssessmentInputError(ValueError):
    """Raised when an assessment cannot satisfy deterministic safety rules."""


def _has_value(arguments, field):
    value = arguments.get(field)
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return bool(value)
    return value is not None


def _gap(field, reason, blocking_for):
    return {"field": field, "reason": reason, "blockingFor": blocking_for}


def assess_requirements(tool_name, arguments):
    """Return deterministic, pre-retrieval input gaps for one drug workflow."""
    gaps = []
    if tool_name == "evimed_offlabel_evidence_packet":
        assessment_type = "off_label"
        checks = (
            ("product", "Exact product or manufacturer is needed to bind the correct label.", "exact_product_label_comparison"),
            ("jurisdiction", "Label status is jurisdiction-specific.", "label_classification"),
            ("population", "Population differences may independently make a proposed use off-label.", "population_comparison"),
            ("dose", "Dose must be compared independently with the label.", "dose_comparison"),
            ("route", "Route must be compared independently with the label.", "route_comparison"),
            ("frequency", "Frequency must be compared independently with the label.", "frequency_comparison"),
            ("duration", "Duration must be compared independently with the label.", "duration_comparison"),
            ("formulation", "Formulation must be compared independently with the label.", "formulation_comparison"),
            ("decisionDate", "A decision date is needed to freeze label and evidence versions.", "versioned_reproducibility"),
        )
    elif tool_name == "evimed_drug_selection_evaluation":
        assessment_type = "drug_selection"
        checks = (
            ("population", "Candidate comparability depends on the target population.", "candidate_comparability"),
            ("jurisdiction", "Labels, prices, access, and policy context vary by jurisdiction.", "candidate_comparability"),
            ("selectionDomains", "The scoring domains must be declared before evidence is converted into a scorecard.", "quantitative_scoring"),
            ("scoringRubric", "Item definitions, scales, weights, direction, and missing-data rules must come from a supplied rubric.", "quantitative_scoring"),
            ("scoringPolicyVersion", "A rubric or policy version is needed for reproducible scoring.", "quantitative_scoring"),
            ("decisionDate", "A decision date is needed to freeze evidence, label, and price versions.", "versioned_reproducibility"),
        )
        if "economics" in (arguments.get("selectionDomains") or []) and not _economic_context_complete(arguments.get("economicContext")):
            gaps.append(_gap(
                "economicContext",
                "Economic scoring requires currency, price date, dosage basis, duration, jurisdiction, and perspective.",
                "economic_scoring",
            ))
    elif tool_name == "evimed_comprehensive_drug_evaluation":
        assessment_type = "comprehensive_drug_evaluation"
        checks = (
            ("population", "Applicability cannot be assessed against an undefined population.", "applicability_assessment"),
            ("comparator", "Comparative value requires an explicit comparator or current standard of care.", "comparative_assessment"),
            ("outcomes", "Outcome priorities are needed to avoid post hoc evidence selection.", "effectiveness_and_safety_assessment"),
            ("jurisdiction", "Label, HTA, price, access, and policy context vary by jurisdiction.", "local_applicability"),
            ("timeHorizon", "Effectiveness, harms, and economics may change by time horizon.", "longitudinal_comparability"),
            ("decisionDate", "A decision date is needed to freeze evidence, label, and price versions.", "versioned_reproducibility"),
        )
        if arguments.get("quantitativeScoringRequested"):
            checks += (
                ("evaluationDomains", "Quantitative scoring requires declared evaluation domains.", "quantitative_scoring"),
                ("scoringRubric", "Item definitions, scales, weights, direction, and missing-data rules must come from a supplied rubric.", "quantitative_scoring"),
                ("scoringPolicyVersion", "A rubric or policy version is needed for reproducible scoring.", "quantitative_scoring"),
            )
            if "economics" in (arguments.get("evaluationDomains") or []) and not _economic_context_complete(arguments.get("economicContext")):
                gaps.append(_gap(
                    "economicContext",
                    "Economic scoring requires currency, price date, dosage basis, duration, jurisdiction, and perspective.",
                    "economic_scoring",
                ))
    else:
        raise AssessmentInputError("Unsupported assessment requirements tool %s." % tool_name)
    gaps.extend(_gap(field, reason, blocking_for) for field, reason, blocking_for in checks if not _has_value(arguments, field))
    fields = [item["field"] for item in gaps]
    return {
        "status": "warning" if gaps else "success",
        "summary": (
            "Identified %d user-supplied input gaps before evidence retrieval." % len(gaps)
            if gaps else "The declared decision scope is ready for evidence retrieval."
        ),
        "data": {
            "assessmentType": assessment_type,
            "readiness": "ready_with_declared_gaps" if gaps else "ready_for_retrieval",
            "canRetrieve": True,
            "missingUserInputs": gaps,
            "requestedFields": fields,
            "networkRetrievalDefault": "enabled_via_managed_gateway",
            "scoringRule": "Never convert a missing field or missing evidence item into zero.",
        },
        **({
            "warnings": ["Retrieval may continue, but the listed conclusions or scores must remain withheld until their inputs are supplied."],
            "next_actions": ["Ask the user once for the listed fields; if they decline, continue with explicit gaps and no fabricated score."],
        } if gaps else {}),
    }


def _canonical_hash(arguments):
    try:
        encoded = json.dumps(
            arguments,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise AssessmentInputError("Assessment input must be finite canonical JSON.") from error
    return hashlib.sha256(encoded).hexdigest()


def _audit(arguments):
    return {
        "compiler": "evimed-drug-assessment",
        "compilerVersion": COMPILER_VERSION,
        "inputSha256": _canonical_hash(arguments),
        "automaticDecision": False,
        "humanReviewRequired": True,
    }


def _source_index(arguments):
    inventory = arguments.get("sourceInventory")
    if not isinstance(inventory, list) or not inventory:
        raise AssessmentInputError("sourceInventory is required for action=compile.")
    identifiers = set()
    for source in inventory:
        identifier = source.get("id", "").strip()
        if not identifier:
            raise AssessmentInputError("Every sourceInventory item requires an id.")
        if identifier in identifiers:
            raise AssessmentInputError("sourceInventory contains duplicate id %s." % identifier)
        identifiers.add(identifier)
    return identifiers


def _validate_rows(rows, allowed_domains, source_ids):
    if not isinstance(rows, list) or not rows:
        raise AssessmentInputError("At least one structured assessment row is required.")
    seen = set()
    for row in rows:
        domain = row["domain"]
        if domain not in allowed_domains:
            raise AssessmentInputError("Unsupported assessment domain %s." % domain)
        key = (row.get("candidate", ""), domain)
        if key in seen:
            raise AssessmentInputError("Duplicate assessment row for %s/%s." % key)
        seen.add(key)
        evidence_ids = row.get("evidenceIds", [])
        unknown = sorted(set(evidence_ids) - source_ids)
        if unknown:
            raise AssessmentInputError("Assessment references unknown evidence id %s." % unknown[0])
        if row["status"] not in ("unclear", "not_assessed") and not evidence_ids:
            raise AssessmentInputError(
                "Observed assessment %s requires at least one evidenceIds entry." % domain
            )


def _result(summary, data, arguments, warnings, next_actions):
    return {
        "status": "warning",
        "summary": summary,
        "data": {**data, "audit": _audit(arguments)},
        "sources": arguments["sourceInventory"],
        "warnings": list(dict.fromkeys(warnings)),
        "next_actions": next_actions,
    }


def _compile_off_label(arguments):
    source_ids = _source_index(arguments)
    comparisons = arguments.get("labelComparisons")
    if not isinstance(comparisons, list) or not comparisons:
        raise AssessmentInputError("labelComparisons is required for an off-label compilation.")
    by_dimension = {}
    for comparison in comparisons:
        dimension = comparison["dimension"]
        if dimension in by_dimension:
            raise AssessmentInputError("Duplicate label comparison for %s." % dimension)
        evidence_ids = comparison.get("evidenceIds", [])
        unknown = sorted(set(evidence_ids) - source_ids)
        if unknown:
            raise AssessmentInputError("Label comparison references unknown evidence id %s." % unknown[0])
        if comparison["status"] in ("match", "mismatch") and not evidence_ids:
            raise AssessmentInputError("Label match or mismatch requires traceable label evidence.")
        by_dimension[dimension] = comparison
    if "indication" not in by_dimension:
        raise AssessmentInputError("The indication label dimension must be assessed.")

    supplied = [dimension for dimension in LABEL_DIMENSIONS if arguments.get({
        "indication": "proposedUse",
    }.get(dimension, dimension))]
    missing = [dimension for dimension in supplied if dimension not in by_dimension]
    statuses = {dimension: row["status"] for dimension, row in by_dimension.items()}
    mismatches = sorted(dimension for dimension, status in statuses.items() if status == "mismatch")
    uncertain = sorted(
        set(missing)
        | {dimension for dimension, status in statuses.items() if status in ("unclear", "not_assessed")}
    )
    jurisdiction = arguments.get("jurisdiction", "").strip()
    if jurisdiction:
        incompatible = sorted({
            comparison["jurisdiction"]
            for comparison in comparisons
            if " ".join(comparison["jurisdiction"].casefold().split())
            != " ".join(jurisdiction.casefold().split())
        })
        if incompatible:
            raise AssessmentInputError(
                "Label comparison jurisdiction does not match the requested jurisdiction."
            )
    if not jurisdiction:
        classification = "insufficient_for_label_classification"
    elif mismatches:
        classification = "potentially_off_label"
    elif not uncertain:
        classification = "label_concordant_preliminary"
    else:
        classification = "insufficient_for_label_classification"

    evidence_rows = arguments.get("evidenceSupportAssessments") or []
    seen_evidence_types = set()
    supporting_types = []
    mixed_types = []
    non_supporting_types = []
    unresolved_types = []
    for row in evidence_rows:
        evidence_type = row["evidenceType"]
        if evidence_type in seen_evidence_types:
            raise AssessmentInputError("Duplicate evidence-support row for %s." % evidence_type)
        seen_evidence_types.add(evidence_type)
        evidence_ids = row.get("evidenceIds", [])
        unknown = sorted(set(evidence_ids) - source_ids)
        if unknown:
            raise AssessmentInputError("Evidence-support row references unknown evidence id %s." % unknown[0])
        if row["status"] in ("supports", "mixed", "does_not_support") and not evidence_ids:
            raise AssessmentInputError("An observed evidence-support judgment requires traceable evidenceIds.")
        quality_tool = row.get("qualityAppraisalTool")
        quality_rating = row.get("qualityRating")
        if bool(quality_tool) != bool(quality_rating):
            raise AssessmentInputError("qualityAppraisalTool and qualityRating must be supplied together.")
        target = {
            "supports": supporting_types,
            "mixed": mixed_types,
            "does_not_support": non_supporting_types,
        }.get(row["status"], unresolved_types)
        target.append(evidence_type)

    evidence_support_status = "assessed_by_evidence_type" if evidence_rows else "not_assessed"
    warnings = [
        "Label status, evidence support, clinical appropriateness, and workflow authorization are independent conclusions.",
        "Workflow authorization is out of scope; this compilation cannot authorize prescribing or replace current jurisdictional label verification.",
    ]
    if not jurisdiction:
        warnings.append("Jurisdiction is unspecified; no country's label may be treated as universal.")
    if uncertain:
        warnings.append("One or more supplied label dimensions remain unclear or unassessed.")
    return _result(
        "Compiled a traceable preliminary label-dimension assessment.",
        {
            "assessmentType": "off_label",
            "classification": classification,
            "jurisdiction": jurisdiction or None,
            "mismatchDimensions": mismatches,
            "uncertainDimensions": uncertain,
            "labelComparisons": comparisons,
            "evidenceSupport": {
                "status": evidence_support_status,
                "assessments": evidence_rows,
                "supportingEvidenceTypes": sorted(supporting_types),
                "mixedEvidenceTypes": sorted(mixed_types),
                "nonSupportingEvidenceTypes": sorted(non_supporting_types),
                "unresolvedEvidenceTypes": sorted(unresolved_types),
                "overallGrade": "not_automatically_determined",
            },
            "independentAxes": {
                "regulatoryLabelStatus": classification,
                "evidenceSupport": evidence_support_status,
                "clinicalAppropriateness": "requires_clinical_review",
                "workflowAuthorization": "out_of_scope_for_scoring_agent",
            },
        },
        arguments,
        warnings,
        [
            "Verify the current official product label for the exact product and jurisdiction.",
            "Complete the evidence-support and clinical-appropriateness axes before any use decision.",
        ],
    )


def _economic_context_complete(context):
    required = (
        "currency",
        "priceDate",
        "dosageBasis",
        "treatmentDuration",
        "jurisdiction",
        "perspective",
    )
    return isinstance(context, dict) and all(str(context.get(key, "")).strip() for key in required)


def _ranking(rows, candidates, context, declared_domains):
    reasons = []
    by_candidate = {candidate: {} for candidate in candidates}
    for row in rows:
        candidate = row.get("candidate")
        if candidate not in by_candidate:
            reasons.append("Assessment row references an undeclared candidate.")
            continue
        by_candidate[candidate][row["domain"]] = row
    domain_sets = [set(values) for values in by_candidate.values()]
    domains = sorted(set.intersection(*domain_sets)) if domain_sets else []
    if not domains or any(value != domain_sets[0] for value in domain_sets):
        reasons.append("Candidates do not have the same complete domain set.")
    if set(domains) != set(declared_domains):
        reasons.append("Candidate domain rows do not exactly match selectionDomains.")
    if "economics" in set.union(*domain_sets) and not _economic_context_complete(context):
        reasons.append("Economics is not comparable without currency, price date, dosage basis, duration, jurisdiction, and perspective.")

    domain_rules = {}
    for domain in domains:
        domain_rows = [by_candidate[candidate][domain] for candidate in candidates]
        if any(row["status"] in ("unclear", "not_assessed") for row in domain_rows):
            reasons.append("Domain %s contains unclear or unassessed data." % domain)
            continue
        required = (
            "score", "scaleMin", "scaleMax", "direction", "weight", "scoreOrigin", "ruleVersion"
        )
        if any(any(field not in row for field in required) for row in domain_rows):
            reasons.append(
                "Domain %s lacks an explicit score, scale, direction, weight, validated origin, or rule version."
                % domain
            )
            continue
        rule_fields = (
            "scaleMin", "scaleMax", "direction", "weight", "scoreOrigin", "ruleVersion"
        )
        rule = tuple(domain_rows[0][field] for field in rule_fields)
        if any(tuple(row[field] for field in rule_fields) != rule for row in domain_rows):
            reasons.append("Domain %s uses incompatible scoring rules across candidates." % domain)
            continue
        minimum, maximum, _direction, weight, _origin, _version = rule
        if not all(math.isfinite(float(value)) for value in (minimum, maximum, weight)):
            reasons.append("Domain %s contains a non-finite scoring rule." % domain)
        elif maximum <= minimum or weight < 0:
            reasons.append("Domain %s has an invalid scale or weight." % domain)
        elif any(not minimum <= row["score"] <= maximum for row in domain_rows):
            reasons.append("Domain %s contains a score outside its declared scale." % domain)
        else:
            domain_rules[domain] = rule
    if set(domain_rules) != set(domains) or sum(rule[3] for rule in domain_rules.values()) <= 0:
        reasons.append("A positive, compatible weight is required for every ranked domain.")
    if reasons:
        return None, list(dict.fromkeys(reasons))

    def calculate(excluded=None):
        active = [domain for domain in domains if domain != excluded]
        denominator = sum(domain_rules[domain][3] for domain in active)
        if denominator <= 0:
            return None
        scores = []
        for candidate in candidates:
            total = 0.0
            for domain in active:
                row = by_candidate[candidate][domain]
                minimum, maximum, direction, weight, _origin, _version = domain_rules[domain]
                normalized = (row["score"] - minimum) / (maximum - minimum)
                if direction == "lower_is_better":
                    normalized = 1 - normalized
                total += normalized * weight
            scores.append({"candidate": candidate, "normalizedScore": round(total / denominator, 8)})
        return sorted(scores, key=lambda item: (-item["normalizedScore"], item["candidate"].casefold()))

    ranking = calculate()
    sensitivity = []
    for domain in domains:
        reranked = calculate(domain)
        if reranked:
            reranked_top = [
                item["candidate"]
                for item in reranked
                if item["normalizedScore"] == reranked[0]["normalizedScore"]
            ]
            sensitivity.append({
                "excludedDomain": domain,
                "topCandidate": reranked_top[0] if len(reranked_top) == 1 else None,
                "topCandidates": reranked_top,
                "ranking": reranked,
            })
    top_candidates = [
        item["candidate"]
        for item in ranking
        if item["normalizedScore"] == ranking[0]["normalizedScore"]
    ]
    top_candidate = top_candidates[0] if len(top_candidates) == 1 else None
    sensitivity_stable = None
    if sensitivity:
        sensitivity_stable = all(
            set(item["topCandidates"]) == set(top_candidates) for item in sensitivity
        )
    return {
        "ranking": ranking,
        "method": "weighted_min_max_normalization",
        "topCandidate": top_candidate,
        "topCandidates": top_candidates,
        "topRankStableUnderLeaveOneDomainOut": sensitivity_stable,
        "leaveOneDomainOutSensitivity": sensitivity,
    }, []


def _compile_selection(arguments):
    source_ids = _source_index(arguments)
    rows = arguments.get("domainAssessments")
    _validate_rows(rows, SELECTION_DOMAINS, source_ids)
    candidates = arguments["candidateDrugs"]
    if len({candidate.strip().casefold() for candidate in candidates}) != len(candidates):
        raise AssessmentInputError("candidateDrugs must not contain duplicates.")
    declared_domains = arguments.get("selectionDomains")
    if not isinstance(declared_domains, list) or not declared_domains:
        raise AssessmentInputError("selectionDomains is required for an action=compile selection assessment.")
    if len(set(declared_domains)) != len(declared_domains):
        raise AssessmentInputError("selectionDomains must not contain duplicates.")
    ranking, reasons = _ranking(
        rows, candidates, arguments.get("economicContext"), declared_domains
    )
    warnings = [
        "Evidence coverage counts and language-model judgments are not formulary scores.",
        "The compiler does not make a procurement, formulary, reimbursement, or patient-level treatment decision.",
    ]
    if reasons:
        warnings.append("No ranking was produced because comparability or scoring prerequisites were incomplete.")
    elif ranking and ranking["topCandidate"] is None:
        warnings.append("The highest normalized score is tied; no single top candidate was selected.")
    elif ranking and ranking["topRankStableUnderLeaveOneDomainOut"] is False:
        warnings.append("The top-ranked candidate changes when at least one domain is removed.")
    elif ranking and ranking["topRankStableUnderLeaveOneDomainOut"] is None:
        warnings.append("Leave-one-domain-out sensitivity is not assessable with only one ranked domain.")
    return _result(
        "Compiled a traceable formulary evidence assessment%s." % (
            " with a reproducible conditional ranking" if ranking else " without a ranking"
        ),
        {
            "assessmentType": "drug_selection",
            "domainAssessments": rows,
            "selectionDomains": declared_domains,
            "ranking": ranking,
            "rankingWithheldReasons": reasons,
            "economicContext": arguments.get("economicContext"),
        },
        arguments,
        warnings,
        [
            "Resolve all missing or non-comparable domains and review sensitivity before using the assisted score.",
            "Keep the supplied rubric, item-level evidence, and calculation trace with the result.",
        ],
    )


def _compile_comprehensive(arguments):
    source_ids = _source_index(arguments)
    source_access = {
        source["id"]: source.get("evidenceAccess")
        for source in arguments["sourceInventory"]
    }
    missing_access = sorted(identifier for identifier, access in source_access.items() if not access)
    if missing_access:
        raise AssessmentInputError(
            "Comprehensive assessment source %s requires evidenceAccess."
            % missing_access[0]
        )
    rows = arguments.get("domainAssessments")
    _validate_rows(rows, COMPREHENSIVE_DOMAINS, source_ids)
    for row in rows:
        if row["status"] in ("unclear", "not_assessed"):
            continue
        metadata_only = sorted(
            identifier
            for identifier in row.get("evidenceIds", [])
            if source_access[identifier] == "bibliographic_only"
        )
        if metadata_only:
            raise AssessmentInputError(
                "Bibliographic-only source %s cannot support an observed domain assessment."
                % metadata_only[0]
            )
    by_domain = {row["domain"]: row for row in rows}
    domains = set(by_domain)
    core = {"effectiveness", "safety", "applicability"}
    missing_core = sorted(core - domains)
    unresolved_core = sorted(
        domain
        for domain in core & domains
        if by_domain[domain]["status"] in ("unclear", "not_assessed")
    )
    for row in rows:
        certainty = row.get("certainty")
        if certainty and certainty != "not_rated":
            required_certainty_fields = (
                "certaintyBasis",
                "certaintyOrigin",
                "certaintyFramework",
                "certaintyJudgments",
                "fullTextEvidenceIds",
            )
            missing = [field for field in required_certainty_fields if not row.get(field)]
            if missing:
                raise AssessmentInputError(
                    "A formal certainty rating requires %s; otherwise use certainty=not_rated."
                    % ", ".join(missing)
                )
            full_text_ids = set(row["fullTextEvidenceIds"])
            unknown = sorted(full_text_ids - source_ids)
            if unknown:
                raise AssessmentInputError(
                    "Formal certainty rating references unknown full-text evidence id %s." % unknown[0]
                )
            unlinked = sorted(full_text_ids - set(row.get("evidenceIds", [])))
            if unlinked:
                raise AssessmentInputError(
                    "Formal certainty fullTextEvidenceIds must also appear in the row evidenceIds."
                )
            not_full_text = sorted(
                identifier
                for identifier in full_text_ids
                if source_access[identifier] not in {"full_text", "user_provided_full_text"}
            )
            if not_full_text:
                raise AssessmentInputError(
                    "Formal certainty source %s is not declared as full-text evidence."
                    % not_full_text[0]
                )
    quantitative_requested = bool(arguments.get("quantitativeScoringRequested")) or any(
        "score" in row for row in rows
    )
    composite_score = None
    score_withheld_reasons = []
    if quantitative_requested:
        composite_score, score_withheld_reasons = _comprehensive_score(arguments, rows)

    warnings = [
        "Study design alone does not determine certainty, and certainty does not determine recommendation strength.",
        "No automatic clinical, HTA, reimbursement, or procurement recommendation was produced.",
    ]
    if missing_core:
        warnings.append("Core evaluation domains are missing: %s." % ", ".join(missing_core))
    if unresolved_core:
        warnings.append("Core evaluation domains remain unresolved: %s." % ", ".join(unresolved_core))
    if score_withheld_reasons:
        warnings.append("The requested composite score was withheld because scoring prerequisites were incomplete.")
    return _result(
        "Compiled a traceable domain-by-domain comprehensive drug assessment.",
        {
            "assessmentType": "comprehensive_drug_evaluation",
            "domainAssessments": rows,
            "coreDomainCoverage": {
                "required": sorted(core),
                "missing": missing_core,
                "unresolved": unresolved_core,
                "complete": not missing_core and not unresolved_core,
            },
            "evaluationDomains": arguments.get("evaluationDomains"),
            "compositeScore": composite_score,
            "scoreStatus": (
                "computed" if composite_score else "withheld" if quantitative_requested else "not_requested"
            ),
            "scoreWithheldReasons": score_withheld_reasons,
            "recommendationStrength": "not_automatically_determined",
        },
        arguments,
        warnings,
        [
            "Complete missing core domains and resolve contradictory evidence.",
            "Review certainty, benefit-harm balance, economics, equity, and applicability before using the assisted assessment.",
        ],
    )


def _comprehensive_score(arguments, rows):
    declared_domains = arguments.get("evaluationDomains")
    if not isinstance(declared_domains, list) or not declared_domains:
        return None, ["evaluationDomains is required for quantitative scoring."]
    if len(set(declared_domains)) != len(declared_domains):
        return None, ["evaluationDomains must not contain duplicates."]
    by_domain = {row["domain"]: row for row in rows}
    reasons = []
    if set(by_domain) != set(declared_domains):
        reasons.append("Assessment rows do not exactly match evaluationDomains.")
    if not str(arguments.get("scoringRubric", "")).strip():
        reasons.append("A supplied scoringRubric is required for quantitative scoring.")
    policy_version = str(arguments.get("scoringPolicyVersion", "")).strip()
    if not policy_version:
        reasons.append("A scoringPolicyVersion is required for quantitative scoring.")
    if "economics" in set(by_domain) and not _economic_context_complete(arguments.get("economicContext")):
        reasons.append("Economics is not scoreable without currency, price date, dosage basis, duration, jurisdiction, and perspective.")

    required = ("score", "scaleMin", "scaleMax", "direction", "weight", "scoreOrigin", "ruleVersion")
    contributions = []
    weighted_total = 0.0
    total_weight = 0.0
    for domain in declared_domains:
        row = by_domain.get(domain)
        if not row:
            continue
        if row["status"] in ("unclear", "not_assessed"):
            reasons.append("Domain %s is unclear or not assessed." % domain)
            continue
        if any(field not in row for field in required):
            reasons.append("Domain %s lacks an explicit score, scale, direction, weight, origin, or rule version." % domain)
            continue
        if row["ruleVersion"] != policy_version:
            reasons.append("Domain %s does not use scoringPolicyVersion %s." % (domain, policy_version))
            continue
        minimum = row["scaleMin"]
        maximum = row["scaleMax"]
        weight = row["weight"]
        score = row["score"]
        if not all(math.isfinite(float(value)) for value in (minimum, maximum, weight, score)):
            reasons.append("Domain %s contains a non-finite score or scoring rule." % domain)
            continue
        if maximum <= minimum or weight < 0 or not minimum <= score <= maximum:
            reasons.append("Domain %s has an invalid scale, weight, or score." % domain)
            continue
        normalized = (score - minimum) / (maximum - minimum)
        if row["direction"] == "lower_is_better":
            normalized = 1 - normalized
        contribution = normalized * weight
        weighted_total += contribution
        total_weight += weight
        contributions.append({
            "domain": domain,
            "normalizedScore": round(normalized, 8),
            "weight": weight,
            "weightedContribution": round(contribution, 8),
        })
    if total_weight <= 0:
        reasons.append("A positive weight is required for at least one domain.")
    if reasons:
        return None, list(dict.fromkeys(reasons))
    normalized_score = weighted_total / total_weight
    return {
        "normalizedScore": round(normalized_score, 8),
        "percentageScore": round(normalized_score * 100, 4),
        "method": "weighted_min_max_normalization",
        "ruleVersion": policy_version,
        "domainContributions": contributions,
    }, []


def compile_assessment(tool_name, arguments):
    """Compile one of the three structured drug assessment workflows."""
    if tool_name == "evimed_offlabel_evidence_packet":
        return _compile_off_label(arguments)
    if tool_name == "evimed_drug_selection_evaluation":
        return _compile_selection(arguments)
    if tool_name == "evimed_comprehensive_drug_evaluation":
        return _compile_comprehensive(arguments)
    raise AssessmentInputError("Unsupported assessment compiler tool %s." % tool_name)
