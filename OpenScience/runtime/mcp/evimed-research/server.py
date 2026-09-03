#!/usr/bin/env python3
"""EviMed Research MCP server.

The process uses newline-delimited JSON-RPC over stdio. Standard output is
reserved for protocol messages; adapters use explicit HTTP boundaries and never
invent evidence when an upstream service is unavailable.
"""

import json
import math
import os
import re
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import PurePosixPath

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import public_sources
import science_connectors
import drug_assessment
import open_access_fulltext
import official_pages
import meta_agent
import specialist_jobs
import source_catalog
import geo_probe
import web_search


SERVER_NAME = "evimed-research"
SERVER_VERSION = "1.6.0"
PROTOCOL_VERSION = "2024-11-05"
MAX_FRAME_BYTES = 1024 * 1024


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _req, _fp, _code, _msg, _headers, _newurl):
        return None


NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirectHandler())
WORKLOAD_TOKEN_MAX_BYTES = 8 * 1024
_ADAPTER_CIRCUITS = {}


def object_schema(properties, required=()):
    schema = {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
    }
    if required:
        schema["required"] = list(required)
    return schema


STRING = {"type": "string", "minLength": 1, "maxLength": 512}
SHORT_STRING = {"type": "string", "minLength": 1, "maxLength": 128}
LONG_STRING = {"type": "string", "minLength": 1, "maxLength": 4000}
NUMBER = {"type": "number"}
LIMIT = {"type": "integer", "minimum": 1, "maximum": 200}
EVIMED_SEARCH_LIMIT = {"type": "integer", "minimum": 1, "maximum": 100}
LABEL_LIMIT = {"type": "integer", "minimum": 1, "maximum": 3}
DATE = {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"}
YEAR = {"type": "integer", "minimum": 1900, "maximum": 2100}
STATUS_WAIT_MAX_SECONDS = 45
STATUS_WAIT_SECONDS = {
    "type": "integer",
    "minimum": 0,
    "maximum": STATUS_WAIT_MAX_SECONDS,
}

ACTION = {"type": "string", "enum": ["requirements", "retrieve", "compile"]}
EVIDENCE_IDS = {
    "type": "array",
    "maxItems": 200,
    "items": SHORT_STRING,
}
FULL_TEXT_EVIDENCE_IDS = {
    "type": "array",
    "minItems": 1,
    "maxItems": 200,
    "items": SHORT_STRING,
}
SOURCE_INVENTORY = {
    "type": "array",
    "minItems": 1,
    "maxItems": 500,
    "items": object_schema(
        {
            "id": SHORT_STRING,
            "title": {"type": "string", "minLength": 1, "maxLength": 2048},
            "url": {"type": "string", "minLength": 1, "maxLength": 2048},
            "source": SHORT_STRING,
            "retrievedAt": {"type": "string", "minLength": 1, "maxLength": 64},
            "evidenceAccess": {
                "type": "string",
                "enum": [
                    "full_text",
                    "abstract",
                    "regulatory_record",
                    "registry_record",
                    "bibliographic_only",
                    "user_provided_full_text",
                    "user_provided_other",
                ],
            },
        },
        ("id", "source", "retrievedAt"),
    ),
}
LABEL_COMPARISONS = {
    "type": "array",
    "minItems": 1,
    "maxItems": 7,
    "items": object_schema(
        {
            "dimension": {"type": "string", "enum": list(drug_assessment.LABEL_DIMENSIONS)},
            "status": {"type": "string", "enum": ["match", "mismatch", "unclear", "not_assessed"]},
            "jurisdiction": SHORT_STRING,
            "product": SHORT_STRING,
            "labelVersion": SHORT_STRING,
            "evidenceIds": EVIDENCE_IDS,
            "rationale": LONG_STRING,
        },
        ("dimension", "status", "jurisdiction", "evidenceIds", "rationale"),
    ),
}
SELECTION_ASSESSMENTS = {
    "type": "array",
    "minItems": 1,
    "maxItems": 400,
    "items": object_schema(
        {
            "candidate": SHORT_STRING,
            "domain": {"type": "string", "enum": list(drug_assessment.SELECTION_DOMAINS)},
            "status": {"type": "string", "enum": ["favorable", "neutral", "unfavorable", "unclear", "not_assessed"]},
            "evidenceIds": EVIDENCE_IDS,
            "rationale": LONG_STRING,
            "score": NUMBER,
            "scaleMin": NUMBER,
            "scaleMax": NUMBER,
            "direction": {"type": "string", "enum": ["higher_is_better", "lower_is_better"]},
            "weight": NUMBER,
            "scoreOrigin": {"type": "string", "enum": ["validated_adapter", "institutional_rubric"]},
            "ruleVersion": SHORT_STRING,
        },
        ("candidate", "domain", "status", "evidenceIds", "rationale"),
    ),
}
COMPREHENSIVE_ASSESSMENTS = {
    "type": "array",
    "minItems": 1,
    "maxItems": 40,
    "items": object_schema(
        {
            "domain": {"type": "string", "enum": list(drug_assessment.COMPREHENSIVE_DOMAINS)},
            "status": {"type": "string", "enum": ["favorable", "mixed", "unfavorable", "unclear", "not_assessed"]},
            "certainty": {"type": "string", "enum": ["high", "moderate", "low", "very_low", "not_rated"]},
            "certaintyBasis": LONG_STRING,
            "certaintyOrigin": {
                "type": "string",
                "enum": ["validated_adapter", "user_supplied_formal_assessment"],
            },
            "certaintyFramework": SHORT_STRING,
            "certaintyJudgments": object_schema(
                {
                    "riskOfBias": LONG_STRING,
                    "inconsistency": LONG_STRING,
                    "indirectness": LONG_STRING,
                    "imprecision": LONG_STRING,
                    "publicationBias": LONG_STRING,
                },
                ("riskOfBias", "inconsistency", "indirectness", "imprecision", "publicationBias"),
            ),
            "fullTextEvidenceIds": FULL_TEXT_EVIDENCE_IDS,
            "evidenceIds": EVIDENCE_IDS,
            "rationale": LONG_STRING,
            "score": NUMBER,
            "scaleMin": NUMBER,
            "scaleMax": NUMBER,
            "direction": {"type": "string", "enum": ["higher_is_better", "lower_is_better"]},
            "weight": NUMBER,
            "scoreOrigin": {"type": "string", "enum": ["validated_adapter", "institutional_rubric"]},
            "ruleVersion": SHORT_STRING,
        },
        ("domain", "status", "evidenceIds", "rationale"),
    ),
}
OFF_LABEL_EVIDENCE_ASSESSMENTS = {
    "type": "array",
    "maxItems": 9,
    "items": object_schema(
        {
            "evidenceType": {"type": "string", "enum": list(drug_assessment.OFF_LABEL_EVIDENCE_TYPES)},
            "status": {"type": "string", "enum": ["supports", "mixed", "does_not_support", "unclear", "not_found", "not_assessed"]},
            "applicability": {"type": "string", "enum": ["direct", "indirect", "not_assessed"]},
            "qualityAppraisalTool": {"type": "string", "enum": list(drug_assessment.QUALITY_APPRAISAL_TOOLS)},
            "qualityRating": SHORT_STRING,
            "externalRatingSystem": SHORT_STRING,
            "effectivenessRating": SHORT_STRING,
            "recommendationRating": SHORT_STRING,
            "evidenceRating": SHORT_STRING,
            "evidenceIds": EVIDENCE_IDS,
            "rationale": LONG_STRING,
        },
        ("evidenceType", "status", "applicability", "evidenceIds", "rationale"),
    ),
}
ECONOMIC_CONTEXT = object_schema(
    {
        "currency": SHORT_STRING,
        "priceDate": DATE,
        "dosageBasis": STRING,
        "treatmentDuration": SHORT_STRING,
        "jurisdiction": SHORT_STRING,
        "perspective": SHORT_STRING,
    }
)


TOOL_DEFINITIONS = [
    {
        "name": "health",
        "description": "Check whether the local EviMed Research MCP process is ready.",
        "inputSchema": object_schema({}),
    },
    {
        "name": "data_source_catalog",
        "description": "Search the audited EviMed data-source registry, including active connectors, credential requirements, licenses, and explicit blockers.",
        "inputSchema": object_schema(
            {
                "query": STRING,
                "domain": SHORT_STRING,
                "status": {
                    "type": "string",
                    "enum": [
                        "connected_public", "skill_guidance", "catalog_only", "ready_credentials",
                        "adapter_credentials_required",
                        "ready_private_adapter", "blocked_license", "blocked_approval", "blocked_no_api",
                    ],
                },
                "accessClass": {
                    "type": "string",
                    "enum": [
                        "public_api", "public_terms", "credentialed_api", "internal", "commercial",
                        "controlled", "website_or_partnership", "skill_or_dataset",
                        "retired_service", "licensed_dataset",
                    ],
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 123},
            }
        ),
    },
    {
        "name": "biomedical_source_search",
        "description": "Query one audited public biomedical source through a bounded, traceable connector. Results are metadata or selected public fields and require primary-record verification.",
        "inputSchema": object_schema(
            {
                "source": {"type": "string", "enum": list(public_sources.QUERYABLE_BIOMEDICAL_SOURCE_IDS)},
                "query": STRING,
                "limit": {"type": "integer", "minimum": 1, "maximum": 50},
            },
            ("source", "query"),
        ),
    },
    {
        "name": "official_page_fetch",
        "description": (
            "Retrieve an allowlisted official medical, guideline, evidence-review, or regulatory HTML document "
            "through the managed gateway and preserve a content-hashed Markdown receipt in the workspace. "
            "Allowed routes are: "
            + ", ".join(
                "https://%s%s" % (host, prefix)
                for host, prefixes in official_pages.OFFICIAL_PATHS.items()
                for prefix in prefixes
            )
        ),
        "inputSchema": object_schema(
            {"url": {"type": "string", "minLength": 1, "maxLength": 2048}},
            ("url",),
        ),
    },
    {
        "name": "web_search",
        "description": "Search the open web through the platform's self-hosted metasearch aggregator. Use for what bibliographic indexes do not carry - funding calls, conference programmes, society pages, registries, methods described only on a group's own site. Results are unreviewed pages: follow one to its primary record before any claim from it enters a report.",
        "inputSchema": object_schema(
            {
                "query": {"type": "string", "minLength": 1, "maxLength": 512},
                "limit": {"type": "integer", "minimum": 1, "maximum": 25},
                "categories": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 5,
                    "items": {"type": "string", "enum": ["general", "science", "news", "it", "files"]},
                },
                "language": {"type": "string", "minLength": 2, "maxLength": 5},
                "timeRange": {"type": "string", "enum": ["day", "week", "month", "year"]},
            },
            ("query",),
        ),
    },
    {
        "name": "geo_visibility_probe",
        "description": (
            "Ask the consumer LLM front-ends (DeepSeek, Doubao, Kimi, Qianwen, Yuanbao) a question the way a patient would, "
            "and record what they answer. This is a measurement with a denominator, not a retrieval: a vendor that failed to "
            "answer is not a vendor that did not mention the product, and a vendor that is not logged in was never asked. "
            "Use op=providers before a batch, op=ask per question, op=screenshot to retrieve the evidence image by name."
        ),
        "inputSchema": object_schema(
            {
                "op": {"type": "string", "enum": ["providers", "ask", "screenshot"]},
                "question": {"type": "string", "minLength": 1, "maxLength": 2000},
                "providers": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 5,
                    "items": {"type": "string", "enum": ["deepseek", "doubao", "kimi", "qianwen", "yuanbao"]},
                },
                "deep": {"type": "integer", "enum": [0, 1]},
                "newChat": {"type": "integer", "enum": [0, 1]},
                "name": {"type": "string", "minLength": 1, "maxLength": 160},
            },
            ("op",),
        ),
    },
    {
        "name": "open_access_full_text",
        "description": "Resolve a PMCID, PMID, or DOI through Europe PMC, retrieve the complete open-access JATS XML, and write bounded Markdown and XML artifacts into the current workspace for direct, paginated reading.",
        "inputSchema": object_schema(
            {"identifier": {"type": "string", "minLength": 1, "maxLength": 512}},
            ("identifier",),
        ),
    },
    {
        "name": "term_normalize",
        "description": "Normalize a medical term using a deterministic bilingual vocabulary.",
        "inputSchema": object_schema(
            {
                "term": STRING,
                "domain": {
                    "type": "string",
                    "enum": ["general", "drug", "disease", "indication", "adverse_event"],
                },
            },
            ("term",),
        ),
    },
    {
        "name": "drug_term_normalize",
        "description": "Normalize a drug name against the public RxNorm vocabulary (curated local table as fallback) and return known deterministic synonyms.",
        "inputSchema": object_schema({"term": STRING}, ("term",)),
    },
    {
        "name": "evidence_deduplicate",
        "description": "Deduplicate evidence records by DOI, PMID, URL, then normalized title.",
        "inputSchema": object_schema(
            {
                "items": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 500,
                    "items": object_schema(
                        {
                            "id": SHORT_STRING,
                            "title": {"type": "string", "minLength": 1, "maxLength": 2048},
                            "doi": SHORT_STRING,
                            "pmid": SHORT_STRING,
                            "url": {"type": "string", "minLength": 1, "maxLength": 2048},
                        },
                        ("title",),
                    ),
                }
            },
            ("items",),
        ),
    },
    {
        "name": "literature_search",
        "description": "Search configured literature sources through the EviMed evidence adapter. Public results are bibliographic metadata unless abstract or full-text fields are explicitly present; never infer study design, evidence level, outcomes, or effect estimates from a title.",
        "inputSchema": object_schema(
            {
                "query": STRING,
                "limit": EVIMED_SEARCH_LIMIT,
                "dateFrom": DATE,
                "dateTo": DATE,
                "articleTypes": {
                    "type": "array",
                    "maxItems": 15,
                    "items": SHORT_STRING,
                },
                "hasPdf": {"type": "boolean"},
                "language": {"type": "string", "enum": ["zh", "en"]},
                "minImpactFactor": {"type": "number", "minimum": 0, "maximum": 10000},
                "maxImpactFactor": {"type": "number", "minimum": 0, "maximum": 10000},
                "journalTiers": {
                    "type": "array",
                    "maxItems": 3,
                    "items": {"type": "string", "enum": ["北大核心", "科技核心", "南大核心"]},
                },
                "databases": {
                    "type": "array",
                    "maxItems": 8,
                    "items": {"type": "string", "enum": ["internal", "pubmed", "crossref"]},
                },
            },
            ("query",),
        ),
    },
    {
        "name": "guideline_search",
        "description": "Search configured clinical-guideline sources.",
        "inputSchema": object_schema(
            {
                "query": STRING,
                "jurisdiction": SHORT_STRING,
                "limit": EVIMED_SEARCH_LIMIT,
                "mode": {"type": "string", "enum": ["records", "blocks"]},
                "language": {"type": "string", "enum": ["zh", "en"]},
                "publisher": SHORT_STRING,
                "startYear": YEAR,
                "endYear": YEAR,
            },
            ("query",),
        ),
    },
    {
        "name": "clinical_trial_search",
        "description": "Search configured clinical-trial registries.",
        "inputSchema": object_schema(
            {
                "query": STRING,
                "recruitmentStatus": SHORT_STRING,
                "limit": EVIMED_SEARCH_LIMIT,
                "registry": {"type": "integer", "minimum": 0, "maximum": 2},
                "startYear": YEAR,
                "endYear": YEAR,
                "status": {"type": "array", "maxItems": 20, "items": SHORT_STRING},
                "phase": {"type": "array", "maxItems": 20, "items": SHORT_STRING},
                "studyType": {"type": "array", "maxItems": 20, "items": SHORT_STRING},
                "hasArticles": {"type": "array", "maxItems": 1, "items": {"type": "integer", "minimum": 0, "maximum": 1}},
                "source": {"type": "string", "enum": ["PubMed", "Embase", "ICTRP", "CT.gov", "CINAHL"]},
                "minSampleSize": {"type": "integer", "minimum": 0, "maximum": 10000000},
                "maxSampleSize": {"type": "integer", "minimum": 0, "maximum": 10000000},
            },
            ("query",),
        ),
    },
    {
        "name": "patent_search",
        "description": "Search traceable EviMed patent records for research-landscape discovery; results are not legal opinions, clinical evidence, or freedom-to-operate conclusions.",
        "inputSchema": object_schema(
            {"query": STRING, "limit": EVIMED_SEARCH_LIMIT},
            ("query",),
        ),
    },
    {
        "name": "pharmacy_reference_search",
        "description": "Search the optional private curated pharmacy reference index. Results are decision-support context, not current clinical authority, and require verification against current official sources.",
        "inputSchema": object_schema(
            {"query": STRING, "limit": {"type": "integer", "minimum": 1, "maximum": 50}},
            ("query",),
        ),
    },
    {
        "name": "drug_label_search",
        "description": "Retrieve exact-product drug-label candidates from configured jurisdictions; indexed copies still require official-current verification.",
        "inputSchema": object_schema(
            {"drug": SHORT_STRING, "product": SHORT_STRING, "jurisdiction": SHORT_STRING, "limit": LABEL_LIMIT},
            ("drug",),
        ),
    },
    {
        "name": "adr_case_query",
        "description": "Query adverse-event cases through the configured pharmacovigilance adapter.",
        "inputSchema": object_schema(
            {
                "drug": SHORT_STRING,
                "adverseEvent": SHORT_STRING,
                "dateFrom": DATE,
                "dateTo": DATE,
                "limit": LIMIT,
            },
            ("drug",),
        ),
    },
    {
        "name": "adr_signal_analysis",
        "description": "Run configured ADR signal analysis and return traceable source evidence.",
        "inputSchema": object_schema(
            {
                "drug": SHORT_STRING,
                "adverseEvent": SHORT_STRING,
                "dateFrom": DATE,
                "dateTo": DATE,
                "metrics": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 4,
                    "items": {"type": "string", "enum": ["ror", "prr", "ic", "ebgm"]},
                },
            },
            ("drug",),
        ),
    },
    {
        "name": "offlabel_evidence_packet",
        "description": "Retrieve an evidence packet or deterministically compile separate label-dimension and evidence-type assessments for a proposed off-label use. Compilation never authorizes use.",
        "inputSchema": object_schema(
            {
                "action": ACTION,
                "drug": SHORT_STRING,
                "product": SHORT_STRING,
                "proposedUse": STRING,
                "population": STRING,
                "dose": SHORT_STRING,
                "route": SHORT_STRING,
                "frequency": SHORT_STRING,
                "duration": SHORT_STRING,
                "formulation": SHORT_STRING,
                "jurisdiction": SHORT_STRING,
                "decisionDate": DATE,
                "sourceInventory": SOURCE_INVENTORY,
                "labelComparisons": LABEL_COMPARISONS,
                "evidenceSupportAssessments": OFF_LABEL_EVIDENCE_ASSESSMENTS,
            },
            ("drug", "proposedUse"),
        ),
    },
    {
        "name": "comprehensive_drug_evaluation",
        "description": "Retrieve comprehensive medicine evidence or deterministically compile traceable domain assessments and, only with a complete supplied rubric, an assisted score without an automatic recommendation.",
        "inputSchema": object_schema(
            {
                "action": ACTION,
                "drug": SHORT_STRING,
                "indication": STRING,
                "comparator": SHORT_STRING,
                "population": STRING,
                "jurisdiction": SHORT_STRING,
                "outcomes": LONG_STRING,
                "careSetting": SHORT_STRING,
                "timeHorizon": SHORT_STRING,
                "decisionDate": DATE,
                "economicContext": ECONOMIC_CONTEXT,
                "quantitativeScoringRequested": {"type": "boolean"},
                "evaluationDomains": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 10,
                    "items": {"type": "string", "enum": list(drug_assessment.COMPREHENSIVE_DOMAINS)},
                },
                "scoringRubric": LONG_STRING,
                "scoringPolicyVersion": SHORT_STRING,
                "sourceInventory": SOURCE_INVENTORY,
                "domainAssessments": COMPREHENSIVE_ASSESSMENTS,
            },
            ("drug", "indication"),
        ),
    },
    {
        "name": "drug_selection_evaluation",
        "description": "Retrieve candidate evidence or deterministically compile a traceable formulary assessment. Ranking is withheld unless every scale, weight, source, and economic context is comparable.",
        "inputSchema": object_schema(
            {
                "action": ACTION,
                "candidateDrugs": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 50,
                    "items": SHORT_STRING,
                },
                "indication": STRING,
                "population": STRING,
                "jurisdiction": SHORT_STRING,
                "selectionCriteria": {
                    "type": "array",
                    "maxItems": 16,
                    "items": SHORT_STRING,
                },
                "selectionDomains": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 8,
                    "items": {"type": "string", "enum": list(drug_assessment.SELECTION_DOMAINS)},
                },
                "budgetContext": STRING,
                "careSetting": SHORT_STRING,
                "productSpecifications": LONG_STRING,
                "scoringRubric": LONG_STRING,
                "scoringPolicyVersion": SHORT_STRING,
                "decisionDate": DATE,
                "economicContext": ECONOMIC_CONTEXT,
                "sourceInventory": SOURCE_INVENTORY,
                "domainAssessments": SELECTION_ASSESSMENTS,
            },
            ("candidateDrugs", "indication"),
        ),
    },
    {
        "name": "meta_analysis",
        "description": "Start or inspect a managed MetaAgent systematic-review and meta-analysis job. The job runs with DeepSeek V4 Pro, writes its auditable package into the current workspace, and preserves release-gate status.",
        "inputSchema": object_schema(
            {
                "action": {"type": "string", "enum": ["capabilities", "start", "status"]},
                "topic": {"type": "string", "minLength": 1, "maxLength": 4000},
                "jobId": {"type": "string", "pattern": r"^meta-[a-z0-9-]{8,80}$"},
                "waitSeconds": STATUS_WAIT_SECONDS,
                "outputLanguage": {"type": "string", "enum": ["zh", "en"]},
                "maxPapers": {"type": "integer", "minimum": 2, "maximum": 200},
                "analysisType": {"type": "string", "enum": ["pairwise", "network"]},
                "userPdfDirectory": {"type": "string", "minLength": 1, "maxLength": 512},
                "ipdData": {"type": "string", "minLength": 1, "maxLength": 512},
            },
            ("action",),
        ),
    },
    {
        "name": "mendelian_randomization",
        "description": "Start or inspect a managed Mendelian-randomization analysis and manuscript job. Statistical results must come from the installed MR engines, never from the language model.",
        "inputSchema": object_schema(
            {
                "action": {"type": "string", "enum": ["capabilities", "start", "status"]},
                "exposure": STRING,
                "outcome": STRING,
                "jobId": {"type": "string", "pattern": r"^mr-[a-z0-9-]{8,80}$"},
                "waitSeconds": STATUS_WAIT_SECONDS,
                "outputLanguage": {"type": "string", "enum": ["zh", "en"]},
                "analysisDirection": {"type": "string", "enum": ["forward", "bidirectional"]},
            },
            ("action",),
        ),
    },
    {
        "name": "bibliometric_analysis",
        "description": "Start or inspect a managed PubMed bibliometric-analysis job with traceable records, networks, figures, and a research-frontier report.",
        "inputSchema": object_schema(
            {
                "action": {"type": "string", "enum": ["capabilities", "start", "status"]},
                "topic": STRING,
                "jobId": {"type": "string", "pattern": r"^bibliometric-[a-z0-9-]{8,80}$"},
                "waitSeconds": STATUS_WAIT_SECONDS,
                "dateFrom": {"type": "string", "pattern": r"^\d{4}$"},
                "dateTo": {"type": "string", "pattern": r"^\d{4}$"},
                "maxRecords": {"type": "integer", "minimum": 20, "maximum": 5000},
                "outputLanguage": {"type": "string", "enum": ["zh", "en"]},
            },
            ("action",),
        ),
    },
    {
        "name": "research_topic_selection",
        "description": "Start or inspect a managed research-topic selection job that retrieves evidence, maps gaps, and proposes testable research directions.",
        "inputSchema": object_schema(
            {
                "action": {"type": "string", "enum": ["capabilities", "start", "status"]},
                "researchDirection": {"type": "string", "minLength": 1, "maxLength": 4000},
                "jobId": {"type": "string", "pattern": r"^topic-[a-z0-9-]{8,80}$"},
                "waitSeconds": STATUS_WAIT_SECONDS,
                "outputLanguage": {"type": "string", "enum": ["zh", "en"]},
            },
            ("action",),
        ),
    },
    {
        "name": "peer_review",
        "description": "Start or inspect a managed multi-rubric peer review for a workspace manuscript. A pipeline error is returned as an error and never disguised as a completed review.",
        "inputSchema": object_schema(
            {
                "action": {"type": "string", "enum": ["capabilities", "start", "status"]},
                "manuscript": {"type": "string", "minLength": 1, "maxLength": 512},
                "jobId": {"type": "string", "pattern": r"^review-[a-z0-9-]{8,80}$"},
                "waitSeconds": STATUS_WAIT_SECONDS,
                "articleType": {"type": "string", "enum": ["original-research", "systematic-review", "case-report", "other"]},
                "outputLanguage": {"type": "string", "enum": ["zh", "en"]},
            },
            ("action",),
        ),
    },
    {
        "name": "drug_safety_analysis",
        "description": "Start or inspect the managed pharmacovigilance specialist. It runs the deterministic signal pipeline, evidence retrieval, and report generation instead of estimating safety metrics in the language model.",
        "inputSchema": object_schema(
            {
                "action": {"type": "string", "enum": ["capabilities", "start", "status"]},
                "drug": SHORT_STRING,
                "reactions": {
                    "type": "array",
                    "maxItems": 50,
                    "items": SHORT_STRING,
                },
                "drugAliases": {"type": "array", "maxItems": 20, "items": SHORT_STRING},
                "suspectRoles": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 4,
                    "items": {"type": "string", "enum": ["PS", "SS", "C", "I"]},
                },
                "administrationRoutes": {"type": "array", "maxItems": 20, "items": SHORT_STRING},
                "studyDateFrom": DATE,
                "studyDateTo": DATE,
                "backgroundDateFrom": DATE,
                "backgroundDateTo": DATE,
                "jobId": {"type": "string", "pattern": r"^safety-[a-z0-9-]{8,80}$"},
                "waitSeconds": STATUS_WAIT_SECONDS,
                "outputLanguage": {"type": "string", "enum": ["zh", "en"]},
            },
            ("action",),
        ),
    },
]

# The seven first-party science connectors, mounted from their own module.
#
# They existed, were tested, and were reachable by nothing: the module ran as a
# standalone stdio bridge that no deployment starts, so every tool in it was
# absent from `tools/list` and therefore from the model. Mounting them here is
# the whole of "reachable" — the outbound path was already correct, since
# `public_sources._open_remote` sends every URL through the server gateway when
# one is configured, and all eight hosts are on its allowlist.
TOOL_DEFINITIONS.extend(science_connectors.tool_definitions())


TOOLS = {tool["name"]: tool for tool in TOOL_DEFINITIONS}

ADAPTER_ENV = {
    "biomedical_source_search": "EVIMED_BIOMEDICAL_SOURCE_SEARCH_URL",
    "literature_search": "EVIMED_LITERATURE_SEARCH_URL",
    "guideline_search": "EVIMED_GUIDELINE_SEARCH_URL",
    "clinical_trial_search": "EVIMED_CLINICAL_TRIAL_SEARCH_URL",
    "patent_search": "EVIMED_PATENT_SEARCH_URL",
    "pharmacy_reference_search": "EVIMED_PHARMACY_REFERENCE_SEARCH_URL",
    "drug_label_search": "EVIMED_DRUG_LABEL_SEARCH_URL",
    "adr_case_query": "EVIMED_ADR_CASE_QUERY_URL",
    "adr_signal_analysis": "EVIMED_ADR_SIGNAL_ANALYSIS_URL",
    "offlabel_evidence_packet": "EVIMED_OFFLABEL_EVIDENCE_PACKET_URL",
    "comprehensive_drug_evaluation": "EVIMED_COMPREHENSIVE_DRUG_EVALUATION_URL",
    "drug_selection_evaluation": "EVIMED_DRUG_SELECTION_EVALUATION_URL",
    "meta_analysis": "EVIMED_META_ANALYSIS_URL",
    "mendelian_randomization": "EVIMED_MR_ANALYSIS_URL",
    "bibliometric_analysis": "EVIMED_BIBLIOMETRIC_ANALYSIS_URL",
    "research_topic_selection": "EVIMED_RESEARCH_TOPIC_SELECTION_URL",
    "peer_review": "EVIMED_PEER_REVIEW_URL",
    "drug_safety_analysis": "EVIMED_DRUG_SAFETY_ANALYSIS_URL",
}

TERM_VOCABULARY = {
    "acetaminophen": ("paracetamol", ["acetaminophen", "paracetamol", "对乙酰氨基酚"]),
    "paracetamol": ("paracetamol", ["acetaminophen", "paracetamol", "对乙酰氨基酚"]),
    "对乙酰氨基酚": ("paracetamol", ["acetaminophen", "paracetamol", "对乙酰氨基酚"]),
    "aspirin": ("aspirin", ["aspirin", "acetylsalicylic acid", "阿司匹林"]),
    "阿司匹林": ("aspirin", ["aspirin", "acetylsalicylic acid", "阿司匹林"]),
    "心肌梗死": ("myocardial infarction", ["myocardial infarction", "heart attack", "心肌梗死"]),
    "myocardial infarction": ("myocardial infarction", ["myocardial infarction", "heart attack", "心肌梗死"]),
}


def disabled_tools():
    """Tools this deployment deliberately does not offer.

    Distinct from an unconfigured adapter, and the difference matters to a run.
    An unconfigured adapter means "this should work and does not" -- the tool is
    advertised, the model reaches for it, and it fails with
    `adapter_unconfigured`, which is the right answer to a misconfiguration. A
    disabled tool means "this deployment does not do that at all", and
    advertising one costs a wasted call and a failure the run then has to
    reason about.

    Base names, comma-separated, in EVIMED_DISABLED_TOOLS. A name nothing
    matches is ignored rather than fatal: the roster is versioned with the image
    and the environment is not, so a stale entry must not stop a container that
    is otherwise correct.
    """
    raw = os.environ.get("EVIMED_DISABLED_TOOLS", "")
    return {name.strip() for name in raw.split(",") if name.strip()}


# Which capabilities a deployment may decline to offer at all.
#
# The environment variable above is what a container reads, and a container is
# right to obey it: a stale entry must not stop a runtime that is otherwise
# correct. But the release gate has the opposite job. `notOffered` is a
# denominator, and "25 of 25 certified" is a different claim from "25 of 26,
# one switched off" -- so an operator must not be able to reach a green audit
# by switching off whatever failed. This list is the reviewed answer to "what
# is this product allowed not to do", it lives in git where a change to it is
# a change somebody approved, and `verify_release_audit.py` refuses any
# `notOffered` set that is not a subset of it.
#
# patent_search: the EviMed ecosystem does not use patent evidence (2026-09-03).
OPTIONAL_TOOLS = frozenset({"patent_search"})


def list_tools():
    disabled = disabled_tools()
    if not disabled:
        return TOOL_DEFINITIONS
    return [tool for tool in TOOL_DEFINITIONS if tool["name"] not in disabled]


def success(summary, **fields):
    return {"status": "success", "summary": summary, **fields}


def warning(summary, warnings, next_actions, **fields):
    return {
        "status": "warning",
        "summary": summary,
        **fields,
        "warnings": warnings,
        "next_actions": next_actions,
    }


def failure(code, message, retryable, stop_reason, next_actions):
    return {
        "status": "error",
        "summary": message,
        "next_actions": next_actions,
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
            "stopReason": stop_reason,
        },
    }


def _validate(value, schema, path):
    expected = schema.get("type")
    if expected == "object":
        if not isinstance(value, dict):
            raise ValueError("%s must be an object" % path)
        properties = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                raise ValueError("%s.%s is required" % (path, key))
        if schema.get("additionalProperties") is False:
            unknown = sorted(set(value) - set(properties))
            if unknown:
                raise ValueError("%s contains unsupported field %s" % (path, unknown[0]))
        for key, item in value.items():
            if key in properties:
                _validate(item, properties[key], "%s.%s" % (path, key))
    elif expected == "array":
        if not isinstance(value, list):
            raise ValueError("%s must be an array" % path)
        if len(value) < schema.get("minItems", 0):
            raise ValueError("%s has too few items" % path)
        if len(value) > schema.get("maxItems", len(value)):
            raise ValueError("%s has too many items" % path)
        for index, item in enumerate(value):
            _validate(item, schema["items"], "%s[%d]" % (path, index))
    elif expected == "string":
        if not isinstance(value, str):
            raise ValueError("%s must be a string" % path)
        if len(value.strip()) < schema.get("minLength", 0):
            raise ValueError("%s must not be empty" % path)
        if len(value) > schema.get("maxLength", len(value)):
            raise ValueError("%s is too long" % path)
        if "enum" in schema and value not in schema["enum"]:
            raise ValueError("%s is not an allowed value" % path)
        if "pattern" in schema and re.match(schema["pattern"], value) is None:
            raise ValueError("%s has an invalid format" % path)
    elif expected == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("%s must be an integer" % path)
        if value < schema.get("minimum", value) or value > schema.get("maximum", value):
            raise ValueError("%s is outside the allowed range" % path)
    elif expected == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError("%s must be a finite number" % path)
        if value < schema.get("minimum", value) or value > schema.get("maximum", value):
            raise ValueError("%s is outside the allowed range" % path)


def _normalize_term(term):
    normalized = " ".join(term.strip().split()).casefold()
    preferred, synonyms = TERM_VOCABULARY.get(normalized, (normalized, [normalized]))
    return {"input": term.strip(), "preferred": preferred, "synonyms": synonyms}


def _normalize_doi(value):
    text = value.strip().casefold()
    text = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", text)
    text = re.sub(r"^doi:\s*", "", text)
    return text


def _normalize_url(value):
    parsed = urllib.parse.urlsplit(value.strip())
    return urllib.parse.urlunsplit(
        (parsed.scheme.casefold(), parsed.netloc.casefold(), parsed.path.rstrip("/"), parsed.query, "")
    )


def _normalize_title(value):
    return " ".join(re.findall(r"[\w]+", value.casefold(), flags=re.UNICODE))


def _usable_identifier(value):
    normalized = value.strip().casefold()
    return normalized not in {"", "-", "n/a", "na", "none", "null", "unknown", "not available"}


def _deduplicate(items):
    unique = []
    duplicates = []
    indexes = {"doi": {}, "pmid": {}, "url": {}, "title": {}}
    for position, item in enumerate(items):
        item_id = item.get("id") or "item-%d" % (position + 1)
        keys = []
        if item.get("doi") and _usable_identifier(item["doi"]):
            keys.append(("doi", _normalize_doi(item["doi"])))
        if item.get("pmid") and _usable_identifier(item["pmid"]):
            keys.append(("pmid", item["pmid"].strip().casefold().removeprefix("pmid:")))
        if item.get("url") and _usable_identifier(item["url"]):
            keys.append(("url", _normalize_url(item["url"])))
        keys.append(("title", _normalize_title(item["title"])))

        match = next(
            ((kind, indexes[kind][key]) for kind, key in keys if key and key in indexes[kind]),
            None,
        )
        if match:
            duplicates.append(
                {"duplicateId": item_id, "canonicalId": match[1], "matchedBy": match[0]}
            )
            continue
        unique.append(item)
        for kind, key in keys:
            if key:
                indexes[kind][key] = item_id
    return {"items": unique, "duplicates": duplicates}


def _scope():
    return {
        "tenantId": os.environ.get("OPEN_SCIENCE_TENANT_ID", os.environ.get("OPEN_SCIENCE_USER_ID", "")),
        "userId": os.environ.get("OPEN_SCIENCE_USER_ID", ""),
        "projectId": os.environ.get("OPEN_SCIENCE_PROJECT_ID", ""),
        "workspaceDir": os.environ.get("OPEN_SCIENCE_WORKSPACE_DIR", ""),
    }


def _validated_sources(value):
    if not isinstance(value, list):
        raise ValueError("sources must be an array")
    output = []
    # `artifactPath` belongs here because the evidence contract already asks
    # for it: a synthesized claim names the preserved file it quotes, and the
    # delivery gate reads the quote back out of that file. The guideline
    # connector preserves a guideline's own prose and hands the path back on
    # the source, which is how the model learns what it may quote -- but the
    # key was missing from this set, so every guideline search that succeeded
    # in preserving text failed the whole call as "sources[0] has an invalid
    # shape". Preserving more made the tool work less.
    allowed = {"id", "title", "url", "source", "retrievedAt", "evidenceAccess", "artifactPath"}
    for index, source in enumerate(value):
        if not isinstance(source, dict) or set(source) - allowed:
            raise ValueError("sources[%d] has an invalid shape" % index)
        if not isinstance(source.get("source"), str) or not source["source"].strip():
            raise ValueError("sources[%d].source is required" % index)
        retrieved_at = source.get("retrievedAt")
        if not isinstance(retrieved_at, str) or not retrieved_at.strip():
            raise ValueError("sources[%d].retrievedAt is required" % index)
        try:
            timestamp = datetime.fromisoformat(retrieved_at.strip().replace("Z", "+00:00"))
        except ValueError:
            raise ValueError("sources[%d].retrievedAt must be an ISO timestamp" % index)
        if "T" not in retrieved_at or timestamp.tzinfo is None:
            raise ValueError("sources[%d].retrievedAt must include a timezone" % index)
        source_id = source.get("id")
        if source_id is not None and (not isinstance(source_id, str) or not source_id.strip()):
            raise ValueError("sources[%d].id must be a non-empty string" % index)
        title = source.get("title")
        if title is not None and (not isinstance(title, str) or not title.strip()):
            raise ValueError("sources[%d].title must be a non-empty string" % index)
        artifact_path = source.get("artifactPath")
        if artifact_path is not None:
            if not isinstance(artifact_path, str) or not artifact_path.strip():
                raise ValueError("sources[%d].artifactPath must be a non-empty string" % index)
            parts = PurePosixPath(artifact_path.replace("\\", "/")).parts
            if artifact_path.startswith("/") or ".." in parts:
                raise ValueError("sources[%d].artifactPath must be workspace-relative" % index)
        evidence_access = source.get("evidenceAccess")
        if evidence_access is not None and evidence_access not in {
            "full_text", "abstract", "regulatory_record", "registry_record",
            "bibliographic_only", "user_provided_full_text", "user_provided_other",
        }:
            raise ValueError("sources[%d].evidenceAccess is invalid" % index)
        source_url = source.get("url")
        valid_url = False
        if source_url is not None:
            if not isinstance(source_url, str) or not source_url.strip():
                raise ValueError("sources[%d].url must be a non-empty string" % index)
            parsed = urllib.parse.urlsplit(source_url)
            valid_url = (
                parsed.scheme in ("http", "https")
                and bool(parsed.netloc)
                and not parsed.username
                and not parsed.password
            )
            if not valid_url:
                raise ValueError("sources[%d].url must be an absolute HTTP(S) URL" % index)
        if not (isinstance(source_id, str) and source_id.strip()) and not valid_url:
            raise ValueError("sources[%d] requires an id or absolute HTTP(S) URL" % index)
        output.append(source)
    return output


def _is_empty_data(data):
    if data is None or data == {} or data == []:
        return True
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        return len(data["items"]) == 0
    return False


def _nonempty_strings(value):
    return (
        isinstance(value, list)
        and len(value) > 0
        and all(isinstance(item, str) and bool(item.strip()) for item in value)
    )


def _adapter_contract_failure(name, detail):
    return failure(
        "adapter_contract_invalid",
        "%s returned an invalid ToolResult contract: %s" % (name, detail),
        False,
        "Stop until the upstream adapter satisfies the EviMed ToolResult contract.",
        ["Correct the adapter response contract before retrying."],
    )


def _data_with_provenance(data, name, arguments, scope):
    provenance = {
        "tool": name,
        "arguments": arguments,
        "scope": scope,
    }
    if isinstance(data, dict):
        return {**data, "provenance": provenance}
    return {"value": data, "provenance": provenance}


def _read_workload_token():
    token_file = os.environ.get("EVIMED_WORKLOAD_TOKEN_FILE", "")
    if not token_file or "\0" in token_file:
        raise ValueError("workload token file is not configured")
    descriptor = None
    try:
        nofollow = getattr(os, "O_NOFOLLOW", None)
        if nofollow is None:
            raise ValueError("this platform cannot enforce no-follow token reads")
        descriptor = os.open(
            token_file,
            os.O_RDONLY | nofollow,
        )
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("workload token path is not a regular file")
        if before.st_size <= 0 or before.st_size > WORKLOAD_TOKEN_MAX_BYTES:
            raise ValueError("workload token file has an invalid size")
        if before.st_mode & 0o077:
            raise ValueError("workload token file permissions are too broad")
        chunks = []
        remaining = WORKLOAD_TOKEN_MAX_BYTES + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(remaining, 4096))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        after = os.fstat(descriptor)
        if (
            len(raw) > WORKLOAD_TOKEN_MAX_BYTES
            or before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
        ):
            raise ValueError("workload token file changed while it was read")
        text = raw.decode("utf-8")
        if text.endswith("\n"):
            text = text[:-1]
            if text.endswith("\r"):
                text = text[:-1]
        if not text or any(character.isspace() for character in text):
            raise ValueError("workload token has an invalid format")
        return text
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _bounded_number(env_name, fallback, minimum, maximum):
    try:
        return min(max(float(os.environ.get(env_name, str(fallback))), minimum), maximum)
    except ValueError:
        return fallback


def _circuit_settings():
    return {
        "threshold": int(_bounded_number("EVIMED_ADAPTER_CIRCUIT_FAILURES", 3, 1, 20)),
        "cooldown": _bounded_number("EVIMED_ADAPTER_CIRCUIT_COOLDOWN_SECONDS", 30, 1, 3600),
    }


def _circuit_snapshot(name, url, now=None):
    now = time.monotonic() if now is None else now
    current = _ADAPTER_CIRCUITS.get(name)
    if current is None or current.get("url") != url:
        return {"state": "closed", "failures": 0, "retryAfterSeconds": 0}
    retry_after = max(0, current.get("openUntil", 0) - now)
    state = current.get("state", "closed")
    if state == "open" and retry_after <= 0:
        state = "half-open"
    return {
        "state": state,
        "failures": current.get("failures", 0),
        "retryAfterSeconds": int(retry_after + 0.999) if retry_after > 0 else 0,
    }


def _circuit_before_call(name, url, display_name=None):
    snapshot = _circuit_snapshot(name, url)
    if snapshot["state"] == "open":
        return failure(
            "adapter_circuit_open",
            "%s is temporarily paused after repeated upstream failures." % (display_name or name),
            True,
            "Stop until the adapter circuit cooldown expires.",
            ["Retry after approximately %d seconds." % snapshot["retryAfterSeconds"]],
        )
    if snapshot["state"] == "half-open":
        current = _ADAPTER_CIRCUITS[name]
        current["state"] = "half-open"
    return None


def _circuit_failure(name, url):
    settings = _circuit_settings()
    current = _ADAPTER_CIRCUITS.get(name)
    if current is None or current.get("url") != url:
        current = {"url": url, "state": "closed", "failures": 0, "openUntil": 0}
    current["failures"] += 1
    if current["state"] == "half-open" or current["failures"] >= settings["threshold"]:
        current["state"] = "open"
        current["openUntil"] = time.monotonic() + settings["cooldown"]
    _ADAPTER_CIRCUITS[name] = current


def _circuit_success(name):
    _ADAPTER_CIRCUITS.pop(name, None)


def _adapter_health():
    adapters = []
    for name, env_name in ADAPTER_ENV.items():
        url = os.environ.get(env_name, "").strip()
        local_meta = name == "meta_analysis" and bool(os.environ.get("EVIMED_META_AGENT_ROOT", "").strip())
        specialist_spec = specialist_jobs.SPECS.get(name)
        local_specialist = bool(
            specialist_spec
            and os.environ.get(specialist_spec["rootEnv"], "").strip()
        )
        public = not url and public_sources.enabled() and public_sources.configured(name)
        circuit_url = url or ("public://%s" % name if public else "")
        snapshot = _circuit_snapshot(name, circuit_url) if circuit_url else {
            "state": "unconfigured", "failures": 0, "retryAfterSeconds": 0
        }
        adapters.append({
            "tool": name,
            "configured": bool(url) or public or local_meta or local_specialist,
            "connector": "private" if url else ("managed-local" if local_meta or local_specialist else ("public" if public else "none")),
            **snapshot,
        })
    return adapters


def _public_adapter_call(name, arguments):
    source_id = arguments.get("source") if name == "biomedical_source_search" else None
    circuit_name = "%s:%s" % (name, source_id) if source_id else name
    circuit_url = "public://%s" % circuit_name
    circuit_error = _circuit_before_call(circuit_name, circuit_url, name)
    if circuit_error is not None:
        return circuit_error
    scope = _scope()
    try:
        body = public_sources.call(name, arguments)
    except public_sources.PublicSourceError as error:
        if error.retryable:
            _circuit_failure(circuit_name, circuit_url)
        return failure(
            error.code,
            str(error),
            error.retryable,
            "Stop after one retry if the public source remains unavailable.",
            ["Retry once or configure the corresponding private EviMed adapter."],
        )
    _circuit_success(circuit_name)
    if not isinstance(body, dict):
        return _adapter_contract_failure(name, "public connector returned non-object JSON")
    if "status" in body:
        return _normalize_tool_result(name, body, arguments, scope)
    ordinary_fields = {"summary", "data", "sources"}
    if set(body) - ordinary_fields:
        return _adapter_contract_failure(name, "public connector returned unsupported fields")
    data = body.get("data")
    try:
        sources = _validated_sources(body.get("sources", []))
    except ValueError as error:
        return _adapter_contract_failure(name, "invalid public source provenance: %s" % error)
    if _is_empty_data(data):
        return warning(
            body.get("summary") or "%s returned no evidence." % name,
            ["The public sources returned an empty evidence set."],
            ["Broaden the query or configure a private EviMed adapter."],
            data=data if data is not None else {"items": []},
            sources=sources,
        )
    if not sources:
        return failure(
            "adapter_missing_provenance",
            "%s returned public evidence without source provenance." % name,
            False,
            "Stop until the connector supplies traceable sources.",
            ["Correct the public connector response before retrying."],
        )
    return success(
        body.get("summary") or "%s returned public evidence." % name,
        data=_data_with_provenance(data, name, arguments, scope),
        sources=sources,
    )


def _adapter_timeout_seconds(arguments):
    try:
        configured = min(
            max(float(os.environ.get("EVIMED_ADAPTER_TIMEOUT_SECONDS", "15")), 1),
            60,
        )
    except ValueError:
        configured = 15
    if arguments.get("action") != "status":
        return configured
    wait_seconds = arguments.get("waitSeconds", 0)
    if type(wait_seconds) is not int or wait_seconds <= 0:
        return configured
    return max(configured, min(wait_seconds + 5, STATUS_WAIT_MAX_SECONDS + 5))


def _adapter_call(name, arguments):
    env_name = ADAPTER_ENV[name]
    url = os.environ.get(env_name, "").strip()
    if not url:
        if public_sources.enabled() and public_sources.supports(name):
            return _public_adapter_call(name, arguments)
        return failure(
            "adapter_unconfigured",
            "%s is not configured for %s." % (env_name, name),
            False,
            "Stop until an operator configures the adapter URL.",
            ["Configure %s and restart the runtime before retrying." % env_name],
        )
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return failure(
            "adapter_url_invalid",
            "%s must be an absolute HTTP(S) URL." % env_name,
            False,
            "Stop until the invalid adapter configuration is corrected.",
            ["Correct %s and restart the runtime." % env_name],
        )

    circuit_error = _circuit_before_call(name, url)
    if circuit_error is not None:
        return circuit_error

    scope = _scope()
    try:
        workload_token = _read_workload_token()
    except (OSError, UnicodeDecodeError, ValueError):
        return failure(
            "adapter_workload_token_unavailable",
            "A valid platform-managed EviMed workload token file is required for adapter calls.",
            False,
            "Stop until the workload token file is restored or refreshed by the server.",
            ["Configure the server workload signing secret and restart this project runtime."],
        )
    payload = json.dumps(arguments, ensure_ascii=False).encode("utf-8")
    headers = {
        "content-type": "application/json",
        "accept": "application/json",
        "Authorization": "Bearer %s" % workload_token,
    }
    request = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    timeout = _adapter_timeout_seconds(arguments)
    try:
        with NO_REDIRECT_OPENER.open(request, timeout=timeout) as response:
            if response.headers.get_content_type() != "application/json":
                raise ValueError("adapter response content type must be application/json")
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise ValueError("adapter response exceeds 4 MiB")
            body = json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as error:
        if 300 <= error.code < 400:
            return failure(
                "adapter_redirect_forbidden",
                "%s returned HTTP %d; adapter redirects are forbidden." % (name, error.code),
                False,
                "Stop until the configured adapter URL responds directly without a redirect.",
                ["Configure the final adapter endpoint URL before retrying."],
            )
        retryable = error.code >= 500 or error.code == 429
        if retryable:
            _circuit_failure(name, url)
        return failure(
            "adapter_http_error",
            "%s returned HTTP %d." % (name, error.code),
            retryable,
            "Stop after one retry if the upstream returns the same HTTP status.",
            ["Retry once after checking upstream readiness."] if retryable else ["Correct the request or adapter configuration before retrying."],
        )
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        reason = getattr(error, "reason", error)
        _circuit_failure(name, url)
        return failure(
            "adapter_unavailable",
            "%s could not reach its upstream adapter: %s" % (name, reason),
            True,
            "Stop after one retry if the adapter remains unreachable.",
            ["Check adapter readiness and network policy, then retry once."],
        )
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        return failure(
            "adapter_invalid_response",
            "%s returned an invalid response: %s" % (name, error),
            False,
            "Stop until the upstream response contract is corrected.",
            ["Validate the adapter response against the EviMed ToolResult contract."],
        )

    if not isinstance(body, dict):
        return failure(
            "adapter_invalid_response",
            "%s returned a non-object JSON response." % name,
            False,
            "Stop until the upstream response contract is corrected.",
            ["Return a JSON object with data and sources."],
        )
    _circuit_success(name)
    if "status" in body:
        return _normalize_tool_result(name, body, arguments, scope)

    ordinary_fields = {"summary", "data", "sources"}
    if set(body) - ordinary_fields:
        return _adapter_contract_failure(name, "ordinary adapter response has unsupported fields")
    if "summary" in body and (
        not isinstance(body["summary"], str) or not body["summary"].strip()
    ):
        return _adapter_contract_failure(name, "summary must be a non-empty string")

    data = body.get("data")
    try:
        sources = _validated_sources(body.get("sources", []))
    except ValueError as error:
        return _adapter_contract_failure(name, "invalid source provenance: %s" % error)
    if _is_empty_data(data):
        return warning(
            "%s returned no evidence." % name,
            ["The configured sources returned an empty evidence set."],
            ["Broaden the query or verify source coverage before drawing a conclusion."],
            data=data if data is not None else {"items": []},
            sources=sources,
        )
    if not sources:
        return failure(
            "adapter_missing_provenance",
            "%s returned evidence without source provenance." % name,
            False,
            "Stop until the adapter supplies traceable sources.",
            ["Return source and retrievedAt for every evidence source."],
        )
    return success(
        body.get("summary") or "%s returned evidence." % name,
        data=_data_with_provenance(data, name, arguments, scope),
        sources=sources,
    )


def _normalize_tool_result(name, body, arguments, scope):
    allowed = {
        "status", "summary", "data", "sources", "warnings", "next_actions", "artifacts", "error"
    }
    if set(body) - allowed:
        return _adapter_contract_failure(name, "ToolResult has unsupported top-level fields")
    status = body.get("status")
    if status not in ("success", "warning", "error"):
        return _adapter_contract_failure(name, "status must be success, warning, or error")
    if not isinstance(body.get("summary"), str) or not body["summary"].strip():
        return _adapter_contract_failure(name, "summary must be a non-empty string")
    if "sources" in body:
        try:
            body = {**body, "sources": _validated_sources(body["sources"])}
        except ValueError as error:
            return _adapter_contract_failure(name, "invalid source provenance: %s" % error)

    sources = body.get("sources", [])
    data_has_evidence = "data" in body and not _is_empty_data(body.get("data"))
    if status == "success":
        if "error" in body:
            return _adapter_contract_failure(name, "success ToolResult must not include error")
        if data_has_evidence and not sources:
            return _adapter_contract_failure(name, "success evidence requires non-empty sources")
        if "warnings" in body and not _nonempty_strings(body["warnings"]):
            return _adapter_contract_failure(name, "warnings must contain non-empty strings")
        if "next_actions" in body and not _nonempty_strings(body["next_actions"]):
            return _adapter_contract_failure(name, "next_actions must contain non-empty strings")
        return {
            **body,
            "data": _data_with_provenance(body.get("data"), name, arguments, scope),
        }

    if status == "warning":
        if "error" in body:
            return _adapter_contract_failure(name, "warning ToolResult must not include error")
        if not _nonempty_strings(body.get("warnings")):
            return _adapter_contract_failure(name, "warning ToolResult requires non-empty warnings")
        if not _nonempty_strings(body.get("next_actions")):
            return _adapter_contract_failure(name, "warning ToolResult requires non-empty next_actions")
        if data_has_evidence and not sources:
            return _adapter_contract_failure(name, "warning evidence requires non-empty sources")
        if "data" in body:
            return {
                **body,
                "data": _data_with_provenance(body.get("data"), name, arguments, scope),
            }
        return body

    if "data" in body or "sources" in body:
        return _adapter_contract_failure(name, "error ToolResult must not include evidence data")
    if not _nonempty_strings(body.get("next_actions")):
        return _adapter_contract_failure(name, "error ToolResult requires non-empty next_actions")
    error = body.get("error")
    if not isinstance(error, dict) or set(error) != {
        "code", "message", "retryable", "stopReason"
    }:
        return _adapter_contract_failure(name, "error object must contain only code, message, retryable, and stopReason")
    if not isinstance(error["code"], str) or not error["code"].strip():
        return _adapter_contract_failure(name, "error.code must be a non-empty string")
    if not isinstance(error["message"], str) or not error["message"].strip():
        return _adapter_contract_failure(name, "error.message must be a non-empty string")
    if not isinstance(error["retryable"], bool):
        return _adapter_contract_failure(name, "error.retryable must be a boolean")
    if not isinstance(error["stopReason"], str) or not error["stopReason"].strip():
        return _adapter_contract_failure(name, "error.stopReason must be a non-empty string")
    return body


def _managed_status_with_wait(status_call, arguments):
    """Bound empty polling without changing the managed-job receipt contract."""
    wait_seconds = int(arguments.get("waitSeconds", 0))
    call_arguments = {key: value for key, value in arguments.items() if key != "waitSeconds"}
    deadline = time.monotonic() + wait_seconds
    while True:
        result = status_call(call_arguments)
        job_status = (result.get("data") or {}).get("jobStatus")
        if job_status not in {"queued", "running"} or time.monotonic() >= deadline:
            return result
        time.sleep(min(1.0, max(0.0, deadline - time.monotonic())))


def call_tool(name, arguments):
    # Refused here as well as hidden from the catalog. A model that remembers a
    # tool from an earlier session, or a caller that hard-codes a name, must get
    # the deployment's answer rather than reach an adapter the deployment turned
    # off -- and it must be told which, because "disabled" and "broken" call for
    # opposite responses.
    if name in disabled_tools():
        return failure(
            "tool_disabled",
            "%s is not offered by this deployment." % name,
            False,
            "Stop and pick a different tool; this one is switched off, not failing.",
            ["Call tools/list for what this deployment does offer."],
        )
    definition = TOOLS.get(name)
    if definition is None:
        return failure(
            "unknown_tool",
            "Unknown EviMed research tool: %s" % name,
            False,
            "Stop and refresh the MCP tool catalog.",
            ["Call tools/list and select a declared tool."],
        )
    if arguments is None:
        arguments = {}
    try:
        _validate(arguments, definition["inputSchema"], "arguments")
    except ValueError as error:
        return failure(
            "invalid_input",
            "Invalid input for %s: %s" % (name, error),
            False,
            "Stop until the tool input matches its published JSON schema.",
            ["Correct the named field and retry with only declared inputs."],
        )

    assessment_tools = {
        "offlabel_evidence_packet",
        "comprehensive_drug_evaluation",
        "drug_selection_evaluation",
    }
    compile_only_fields = {
        "sourceInventory", "labelComparisons", "evidenceSupportAssessments", "domainAssessments",
    }
    if name in assessment_tools:
        action = arguments.get("action", "retrieve")
        if action == "requirements":
            try:
                result = drug_assessment.assess_requirements(name, arguments)
            except drug_assessment.AssessmentInputError as error:
                return failure(
                    "invalid_assessment_requirements",
                    "Cannot assess input requirements for %s: %s" % (name, error),
                    False,
                    "Stop until the declared decision scope is valid.",
                    ["Correct the named scope field and retry."],
                )
            result["data"] = _data_with_provenance(result["data"], name, arguments, _scope())
            return result
        if action == "compile":
            try:
                result = drug_assessment.compile_assessment(name, arguments)
                result["sources"] = _validated_sources(result["sources"])
            except (drug_assessment.AssessmentInputError, ValueError) as error:
                return failure(
                    "invalid_assessment",
                    "Cannot compile %s: %s" % (name, error),
                    False,
                    "Stop until the structured assessment is complete and traceable.",
                    ["Correct the structured rows, evidence references, or decision context and retry."],
                )
            result["data"] = _data_with_provenance(result["data"], name, arguments, _scope())
            return result
        unexpected = sorted(set(arguments) & compile_only_fields)
        if unexpected:
            return failure(
                "invalid_assessment_action",
                "%s requires action=compile when %s is supplied." % (name, unexpected[0]),
                False,
                "Stop until the requested retrieval or compilation action is explicit.",
                ["Set action to compile, or remove structured compilation fields."],
            )
        arguments = {key: value for key, value in arguments.items() if key != "action"}

    if name in science_connectors.TOOL_INDEX:
        connector = science_connectors.TOOL_INDEX[name]
        try:
            payload = science_connectors.direct_query(connector, arguments)
        except ValueError as error:
            # The connector validated its own arguments a second time and
            # refused. Reported as invalid input rather than as a source
            # failure: nothing was asked of the network.
            return failure(
                "invalid_input",
                "Invalid input for %s: %s" % (name, error),
                False,
                "Stop until the tool input matches its published JSON schema.",
                ["Correct the named field and retry with only declared inputs."],
            )
        except public_sources.PublicSourceError as error:
            return failure(
                error.code,
                str(error),
                error.retryable,
                "Stop after one retry if the public source remains unavailable.",
                ["Retry once, then report the source as unavailable rather than substituting another."],
            )
        # The URL the connector actually requested becomes the result's source
        # record, not just prose in the summary. The ToolResult contract
        # refuses success evidence without one, and it is right to: a record
        # whose address a reader cannot recover is not evidence, which is the
        # standard every other source here is held to.
        requested = str(payload.get("source") or "")
        return _normalize_tool_result(
            name,
            success(
                "%s returned a result from %s." % (name, requested or "the connector"),
                data=payload.get("data"),
                sources=[{
                    "id": connector,
                    "source": connector,
                    "url": requested,
                    "retrievedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                }],
            ),
            arguments,
            _scope(),
        )
    if name == "health":
        return success(
            "EviMed Research MCP is ready.",
            data=_data_with_provenance(
                {
                    "service": SERVER_NAME,
                    "version": SERVER_VERSION,
                    "ready": True,
                    "adapters": _adapter_health(),
                    "dataSourceCatalog": {
                        **source_catalog.integration_summary(),
                        "activeConnectorIds": list(source_catalog.active_connector_ids()),
                    },
                },
                name,
                arguments,
                _scope(),
            ),
        )
    if name == "data_source_catalog":
        data = source_catalog.search(arguments)
        if data["matched"] == 0:
            return warning(
                "No data source matched the audited catalog filters.",
                ["An empty catalog match does not establish that no relevant data source exists."],
                ["Broaden the query or remove one catalog filter."],
                data=_data_with_provenance(data, name, arguments, _scope()),
            )
        return success(
            "Matched %d audited data sources." % data["matched"],
            data=_data_with_provenance(data, name, arguments, _scope()),
        )
    if name == "web_search":
        try:
            result = web_search.search(arguments)
        except web_search.WebSearchError as error:
            return failure(
                error.code,
                str(error),
                error.retryable,
                "retry" if error.retryable else "unsupported",
                [
                    "Retry once the backend recovers." if error.retryable
                    else "Continue with the bibliographic channels; do not read an unavailable web search as an empty field.",
                ],
            )
        result["data"] = _data_with_provenance(result["data"], name, arguments, _scope())
        return result
    if name == "geo_visibility_probe":
        try:
            result = geo_probe.probe(arguments)
        except geo_probe.GeoProbeError as error:
            return failure(
                error.code,
                str(error),
                error.retryable,
                "retry" if error.retryable else "unsupported",
                [
                    "Retry the same question; the probe serves one caller at a time and a busy answer is not a result."
                    if error.retryable
                    else "Do not read an unavailable probe as an absence of mentions. Say the channel was not measured.",
                ],
            )
        result["data"] = _data_with_provenance(result["data"], name, arguments, _scope())
        return result
    if name == "open_access_full_text":
        result = open_access_fulltext.fetch(arguments)
        if result["status"] == "success":
            result["data"] = _data_with_provenance(result["data"], name, arguments, _scope())
        return result
    if name == "official_page_fetch":
        return _normalize_tool_result(name, official_pages.fetch(arguments), arguments, _scope())
    if name in ("term_normalize", "drug_term_normalize"):
        normalized_key = " ".join(arguments["term"].strip().split()).casefold()
        rxnorm = None
        if name == "drug_term_normalize" and public_sources.enabled():
            try:
                rxnorm = public_sources.rxnorm_resolve(arguments["term"])
            except public_sources.PublicSourceError:
                rxnorm = None
        if rxnorm is not None:
            data = _data_with_provenance(
                {
                    "input": arguments["term"].strip(),
                    "preferred": rxnorm["preferred"],
                    "synonyms": rxnorm["synonyms"],
                    "domain": "drug",
                    "vocabulary": "rxnorm",
                    "rxcui": rxnorm["rxcui"],
                },
                name,
                arguments,
                _scope(),
            )
            return success("Normalized the supplied term against the RxNorm vocabulary.", data=data)
        data = _normalize_term(arguments["term"])
        if name == "term_normalize":
            data["domain"] = arguments.get("domain", "general")
        else:
            data["domain"] = "drug"
            data["vocabulary"] = "curated-local" if normalized_key in TERM_VOCABULARY else "unresolved"
        data = _data_with_provenance(data, name, arguments, _scope())
        if normalized_key in TERM_VOCABULARY:
            return success("Normalized the supplied term against the curated vocabulary.", data=data)
        return warning(
            "No curated normalization exists for this term; returned the input unchanged.",
            ["The returned preferred term and synonyms are the unmodified input, not an authoritative normalization."],
            ["Verify the term against an authoritative terminology (for example UMLS, RxNorm, or MeSH) before relying on it."],
            data=data,
        )
    if name == "evidence_deduplicate":
        data = _deduplicate(arguments["items"])
        return success(
            "Deduplicated %d evidence records into %d unique records."
            % (len(arguments["items"]), len(data["items"])),
            data=_data_with_provenance(data, name, arguments, _scope()),
        )
    if name == "meta_analysis" and not os.environ.get("EVIMED_META_ANALYSIS_URL", "").strip():
        if arguments.get("action") == "status":
            return _managed_status_with_wait(meta_agent.status_job, arguments)
        return meta_agent.call(arguments)
    if name in specialist_jobs.SPECS and not os.environ.get(ADAPTER_ENV[name], "").strip():
        if arguments.get("action") == "status":
            return _managed_status_with_wait(
                lambda value: specialist_jobs.status_job(name, value), arguments
            )
        return specialist_jobs.call(name, arguments)
    return _adapter_call(name, arguments)


def _rpc_error(request_id, code, message):
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def handle_request(request):
    if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
        return _rpc_error(request.get("id") if isinstance(request, dict) else None, -32600, "Invalid Request")
    method = request.get("method")
    request_id = request.get("id")
    if method == "notifications/initialized":
        return None
    if "id" not in request:
        return None
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        }
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": list_tools()}}
    if method == "tools/call":
        params = request.get("params")
        if not isinstance(params, dict) or not isinstance(params.get("name"), str):
            return _rpc_error(request_id, -32602, "Invalid tools/call parameters")
        result = call_tool(params["name"], params.get("arguments", {}))
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, separators=(",", ":"))}],
                "structuredContent": result,
                "isError": result["status"] == "error",
            },
        }
    return _rpc_error(request_id, -32601, "Method not found")


def process_frame(raw, handler=handle_request):
    request_id = None
    try:
        if not isinstance(raw, bytes):
            raise TypeError("JSON-RPC frames must be bytes")
        request = json.loads(raw.decode("utf-8"))
        if isinstance(request, dict):
            request_id = request.get("id")
        return handler(request)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return _rpc_error(None, -32700, "Parse error")
    except Exception:
        return _rpc_error(request_id, -32603, "Internal error")


def main():
    stream = sys.stdin.buffer
    while True:
        frame = stream.readline(MAX_FRAME_BYTES)
        if not frame:
            break
        if len(frame) == MAX_FRAME_BYTES and not frame.endswith(b"\n"):
            while True:
                remainder = stream.readline(64 * 1024)
                if not remainder or remainder.endswith(b"\n"):
                    break
            response = _rpc_error(None, -32600, "JSON-RPC frame exceeds 1 MiB")
        elif not frame.strip():
            continue
        else:
            response = process_frame(frame)
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
