import importlib.util
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SERVER_FILE = ROOT / "server.py"


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_drug_assessment_test", SERVER_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def source(identifier="label-1", evidence_access="full_text"):
    return {
        "id": identifier,
        "title": "Observed evidence",
        "url": "https://evidence.test/%s" % identifier,
        "source": "test-evidence",
        "retrievedAt": "2026-07-20T00:00:00Z",
        "evidenceAccess": evidence_access,
    }


class DrugAssessmentCompilerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def test_off_label_compilation_keeps_four_decision_axes_separate(self):
        result = self.server.call_tool("offlabel_evidence_packet", {
            "action": "compile",
            "drug": "observed-drug",
            "proposedUse": "observed-use",
            "dose": "20 mg daily",
            "jurisdiction": "China",
            "sourceInventory": [source()],
            "labelComparisons": [
                {
                    "dimension": "indication",
                    "status": "mismatch",
                    "jurisdiction": "China",
                    "evidenceIds": ["label-1"],
                    "rationale": "The current observed label does not list the proposed indication.",
                },
                {
                    "dimension": "dose",
                    "status": "match",
                    "jurisdiction": "China",
                    "evidenceIds": ["label-1"],
                    "rationale": "The numeric dose and frequency match the observed label.",
                },
            ],
        })
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["classification"], "potentially_off_label")
        self.assertEqual(result["data"]["mismatchDimensions"], ["indication"])
        self.assertEqual(
            set(result["data"]["independentAxes"]),
            {
                "regulatoryLabelStatus",
                "evidenceSupport",
                "clinicalAppropriateness",
                "workflowAuthorization",
            },
        )
        self.assertTrue(result["data"]["audit"]["humanReviewRequired"])
        self.assertFalse(result["data"]["audit"]["automaticDecision"])

    def test_requirements_returns_one_structured_gap_list_without_blocking_retrieval(self):
        result = self.server.call_tool("drug_selection_evaluation", {
            "action": "requirements",
            "candidateDrugs": ["drug-a", "drug-b"],
            "indication": "observed-indication",
            "selectionDomains": ["effectiveness", "economics"],
        })
        self.assertEqual(result["status"], "warning")
        self.assertTrue(result["data"]["canRetrieve"])
        self.assertEqual(result["data"]["networkRetrievalDefault"], "enabled_via_managed_gateway")
        fields = set(result["data"]["requestedFields"])
        self.assertIn("scoringRubric", fields)
        self.assertIn("economicContext", fields)
        self.assertIn("jurisdiction", fields)
        self.assertTrue(any("must remain withheld" in item for item in result["warnings"]))

    def test_off_label_requirements_clear_supplied_label_dimensions(self):
        result = self.server.call_tool("offlabel_evidence_packet", {
            "action": "requirements",
            "drug": "observed-drug",
            "product": "observed-product",
            "proposedUse": "observed-use",
            "population": "observed-population",
            "dose": "10 mg",
            "route": "oral",
            "frequency": "daily",
            "duration": "7 days",
            "formulation": "tablet",
            "jurisdiction": "China",
            "decisionDate": "2026-07-20",
        })
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["requestedFields"], [])

    def test_off_label_compilation_fails_closed_for_unknown_evidence(self):
        result = self.server.call_tool("offlabel_evidence_packet", {
            "action": "compile",
            "drug": "observed-drug",
            "proposedUse": "observed-use",
            "sourceInventory": [source()],
            "labelComparisons": [{
                "dimension": "indication",
                "status": "match",
                "jurisdiction": "China",
                "evidenceIds": ["invented-source"],
                "rationale": "Unsupported reference.",
            }],
        })
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "invalid_assessment")
        self.assertNotIn("data", result)

    def test_off_label_compilation_rejects_cross_jurisdiction_label_rows(self):
        result = self.server.call_tool("offlabel_evidence_packet", {
            "action": "compile",
            "drug": "observed-drug",
            "proposedUse": "observed-use",
            "jurisdiction": "China",
            "sourceInventory": [source()],
            "labelComparisons": [{
                "dimension": "indication",
                "status": "match",
                "jurisdiction": "United States",
                "evidenceIds": ["label-1"],
                "rationale": "The source belongs to a different jurisdiction.",
            }],
        })
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "invalid_assessment")

    def test_off_label_compilation_never_classifies_without_a_target_jurisdiction(self):
        result = self.server.call_tool("offlabel_evidence_packet", {
            "action": "compile",
            "drug": "observed-drug",
            "proposedUse": "observed-use",
            "sourceInventory": [source()],
            "labelComparisons": [{
                "dimension": "indication",
                "status": "mismatch",
                "jurisdiction": "United States",
                "evidenceIds": ["label-1"],
                "rationale": "An observed label mismatch without a target jurisdiction.",
            }],
        })
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["classification"], "insufficient_for_label_classification")

    def test_selection_ranking_requires_explicit_comparable_rules(self):
        rows = []
        values = {
            "drug-a": {"effectiveness": 8, "safety": 7},
            "drug-b": {"effectiveness": 6, "safety": 5},
        }
        for candidate, domains in values.items():
            for domain, score_value in domains.items():
                rows.append({
                    "candidate": candidate,
                    "domain": domain,
                    "status": "favorable",
                    "evidenceIds": ["evidence-1"],
                    "rationale": "Observed comparative evidence.",
                    "score": score_value,
                    "scaleMin": 0,
                    "scaleMax": 10,
                    "direction": "higher_is_better",
                    "weight": 1,
                    "scoreOrigin": "institutional_rubric",
                    "ruleVersion": "hospital-policy-1",
                })
        result = self.server.call_tool("drug_selection_evaluation", {
            "action": "compile",
            "candidateDrugs": ["drug-a", "drug-b"],
            "indication": "observed-indication",
            "selectionDomains": ["effectiveness", "safety"],
            "sourceInventory": [source("evidence-1")],
            "domainAssessments": rows,
        })
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["ranking"]["topCandidate"], "drug-a")
        self.assertTrue(result["data"]["ranking"]["topRankStableUnderLeaveOneDomainOut"])
        self.assertEqual(result["data"]["rankingWithheldReasons"], [])

    def test_selection_withholds_economic_ranking_without_context(self):
        rows = []
        for candidate, value in (("drug-a", 10), ("drug-b", 20)):
            rows.append({
                "candidate": candidate,
                "domain": "economics",
                "status": "favorable",
                "evidenceIds": ["price-1"],
                "rationale": "Observed acquisition cost.",
                "score": value,
                "scaleMin": 0,
                "scaleMax": 100,
                "direction": "lower_is_better",
                "weight": 1,
                "scoreOrigin": "institutional_rubric",
                "ruleVersion": "hospital-policy-1",
            })
        result = self.server.call_tool("drug_selection_evaluation", {
            "action": "compile",
            "candidateDrugs": ["drug-a", "drug-b"],
            "indication": "observed-indication",
            "selectionDomains": ["economics"],
            "sourceInventory": [source("price-1")],
            "domainAssessments": rows,
        })
        self.assertIsNone(result["data"]["ranking"])
        self.assertTrue(any("Economics is not comparable" in item for item in result["data"]["rankingWithheldReasons"]))

    def test_selection_withholds_scores_without_a_validated_origin_and_rule_version(self):
        rows = [{
            "candidate": candidate,
            "domain": "effectiveness",
            "status": "favorable",
            "evidenceIds": ["study-1"],
            "rationale": "Observed evidence with an ungoverned numeric interpretation.",
            "score": value,
            "scaleMin": 0,
            "scaleMax": 10,
            "direction": "higher_is_better",
            "weight": 1,
        } for candidate, value in (("drug-a", 8), ("drug-b", 6))]
        result = self.server.call_tool("drug_selection_evaluation", {
            "action": "compile",
            "candidateDrugs": ["drug-a", "drug-b"],
            "indication": "observed-indication",
            "selectionDomains": ["effectiveness"],
            "sourceInventory": [source("study-1")],
            "domainAssessments": rows,
        })
        self.assertIsNone(result["data"]["ranking"])
        self.assertTrue(any("score" in item and "rule" in item for item in result["data"]["rankingWithheldReasons"]))

    def test_comprehensive_compilation_does_not_map_design_to_recommendation(self):
        rows = [
            {
                "domain": domain,
                "status": "mixed",
                "evidenceIds": ["study-1"],
                "rationale": "Observed domain evidence requires reviewer interpretation.",
            }
            for domain in ("effectiveness", "safety", "applicability")
        ]
        result = self.server.call_tool("comprehensive_drug_evaluation", {
            "action": "compile",
            "drug": "observed-drug",
            "indication": "observed-indication",
            "sourceInventory": [source("study-1")],
            "domainAssessments": rows,
        })
        self.assertEqual(result["status"], "warning")
        self.assertTrue(result["data"]["coreDomainCoverage"]["complete"])
        self.assertIsNone(result["data"]["compositeScore"])
        self.assertEqual(result["data"]["recommendationStrength"], "not_automatically_determined")

    def test_comprehensive_core_domain_is_not_complete_when_present_but_unassessed(self):
        rows = [{
            "domain": domain,
            "status": "not_assessed" if domain == "safety" else "mixed",
            "evidenceIds": [] if domain == "safety" else ["study-1"],
            "rationale": "No adequate safety evidence was available." if domain == "safety" else "Observed evidence.",
        } for domain in ("effectiveness", "safety", "applicability")]
        result = self.server.call_tool("comprehensive_drug_evaluation", {
            "action": "compile",
            "drug": "observed-drug",
            "indication": "observed-indication",
            "sourceInventory": [source("study-1")],
            "domainAssessments": rows,
        })
        self.assertFalse(result["data"]["coreDomainCoverage"]["complete"])
        self.assertEqual(result["data"]["coreDomainCoverage"]["unresolved"], ["safety"])

    def test_comprehensive_rejects_bibliographic_metadata_as_observed_domain_evidence(self):
        result = self.server.call_tool("comprehensive_drug_evaluation", {
            "action": "compile",
            "drug": "observed-drug",
            "indication": "observed-indication",
            "sourceInventory": [source("metadata-1", "bibliographic_only")],
            "domainAssessments": [{
                "domain": domain,
                "status": "mixed",
                "evidenceIds": ["metadata-1"],
                "rationale": "A directional claim inferred from a title-only record.",
            } for domain in ("effectiveness", "safety", "applicability")],
        })
        self.assertEqual(result["status"], "error")
        self.assertIn("Bibliographic-only source", result["error"]["message"])

    def test_comprehensive_rejects_abstract_only_formal_certainty_rating(self):
        rows = [{
            "domain": domain,
            "status": "mixed",
            "certainty": "high" if domain == "effectiveness" else "not_rated",
            "certaintyBasis": "A randomized design was visible in the abstract.",
            "evidenceIds": ["study-1"],
            "rationale": "Observed domain evidence.",
        } for domain in ("effectiveness", "safety", "applicability")]
        result = self.server.call_tool("comprehensive_drug_evaluation", {
            "action": "compile",
            "drug": "observed-drug",
            "indication": "observed-indication",
            "sourceInventory": [source("study-1")],
            "domainAssessments": rows,
        })
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "invalid_assessment")
        self.assertIn("otherwise use certainty=not_rated", result["error"]["message"])

    def test_comprehensive_accepts_traceable_formal_certainty_assessment(self):
        judgments = {
            "riskOfBias": "Assessed with the supplied RoB 2 record.",
            "inconsistency": "No important unexplained heterogeneity was identified.",
            "indirectness": "Population, intervention, comparator, and outcomes were direct.",
            "imprecision": "The confidence interval met the supplied decision threshold.",
            "publicationBias": "Small-study effects were assessed in the supplied review.",
        }
        rows = [{
            "domain": domain,
            "status": "mixed",
            "certainty": "moderate" if domain == "effectiveness" else "not_rated",
            "certaintyOrigin": "user_supplied_formal_assessment" if domain == "effectiveness" else None,
            "certaintyFramework": "GRADE" if domain == "effectiveness" else None,
            "certaintyBasis": "The supplied formal assessment downgraded once for residual risk of bias." if domain == "effectiveness" else None,
            "certaintyJudgments": judgments if domain == "effectiveness" else None,
            "fullTextEvidenceIds": ["study-1"] if domain == "effectiveness" else None,
            "evidenceIds": ["study-1"],
            "rationale": "Observed domain evidence.",
        } for domain in ("effectiveness", "safety", "applicability")]
        for row in rows:
            for key in [key for key, value in row.items() if value is None]:
                del row[key]
        result = self.server.call_tool("comprehensive_drug_evaluation", {
            "action": "compile",
            "drug": "observed-drug",
            "indication": "observed-indication",
            "sourceInventory": [source("study-1")],
            "domainAssessments": rows,
        })
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["audit"]["compilerVersion"], "1.4.0")

    def test_off_label_compiles_traceable_evidence_support_by_type(self):
        result = self.server.call_tool("offlabel_evidence_packet", {
            "action": "compile",
            "drug": "observed-drug",
            "product": "observed-product",
            "proposedUse": "observed-use",
            "jurisdiction": "China",
            "sourceInventory": [source("label-1"), source("review-1")],
            "labelComparisons": [{
                "dimension": "indication",
                "status": "mismatch",
                "jurisdiction": "China",
                "evidenceIds": ["label-1"],
                "rationale": "The proposed indication is absent from the observed label.",
            }],
            "evidenceSupportAssessments": [{
                "evidenceType": "systematic_review",
                "status": "supports",
                "applicability": "direct",
                "qualityAppraisalTool": "amstar_2",
                "qualityRating": "moderate",
                "evidenceIds": ["review-1"],
                "rationale": "The observed review directly addresses the proposed population and use.",
            }, {
                "evidenceType": "evidence_database",
                "status": "not_assessed",
                "applicability": "not_assessed",
                "evidenceIds": [],
                "rationale": "The licensed database was unavailable and no user export was supplied.",
            }],
        })
        support = result["data"]["evidenceSupport"]
        self.assertEqual(support["status"], "assessed_by_evidence_type")
        self.assertEqual(support["supportingEvidenceTypes"], ["systematic_review"])
        self.assertEqual(support["unresolvedEvidenceTypes"], ["evidence_database"])
        self.assertEqual(support["overallGrade"], "not_automatically_determined")
        self.assertEqual(result["data"]["independentAxes"]["workflowAuthorization"], "out_of_scope_for_scoring_agent")

    def test_comprehensive_quantitative_score_requires_and_uses_supplied_rubric(self):
        scores = {
            "effectiveness": (8, 50),
            "safety": (6, 30),
            "applicability": (9, 20),
        }
        rows = [{
            "domain": domain,
            "status": "favorable",
            "evidenceIds": ["study-1"],
            "rationale": "Observed item-level evidence was scored under the supplied rubric.",
            "score": score_value,
            "scaleMin": 0,
            "scaleMax": 10,
            "direction": "higher_is_better",
            "weight": weight,
            "scoreOrigin": "institutional_rubric",
            "ruleVersion": "published-rubric-v1",
        } for domain, (score_value, weight) in scores.items()]
        result = self.server.call_tool("comprehensive_drug_evaluation", {
            "action": "compile",
            "drug": "observed-drug",
            "indication": "observed-indication",
            "quantitativeScoringRequested": True,
            "evaluationDomains": list(scores),
            "scoringRubric": "Published item-level rubric with declared scales, weights, and missing-data rules.",
            "scoringPolicyVersion": "published-rubric-v1",
            "sourceInventory": [source("study-1")],
            "domainAssessments": rows,
        })
        self.assertEqual(result["data"]["scoreStatus"], "computed")
        self.assertEqual(result["data"]["compositeScore"]["percentageScore"], 76.0)
        self.assertEqual(result["data"]["scoreWithheldReasons"], [])
        self.assertEqual(result["data"]["recommendationStrength"], "not_automatically_determined")

    def test_comprehensive_requirements_requests_quantitative_scoring_contract(self):
        result = self.server.call_tool("comprehensive_drug_evaluation", {
            "action": "requirements",
            "drug": "observed-drug",
            "indication": "observed-indication",
            "quantitativeScoringRequested": True,
            "evaluationDomains": ["effectiveness", "economics"],
        })
        fields = set(result["data"]["requestedFields"])
        self.assertIn("scoringRubric", fields)
        self.assertIn("scoringPolicyVersion", fields)
        self.assertIn("economicContext", fields)
        self.assertNotIn("evaluationDomains", fields)

    def test_non_finite_scores_are_rejected_by_the_published_schema(self):
        result = self.server.call_tool("drug_selection_evaluation", {
            "action": "compile",
            "candidateDrugs": ["drug-a"],
            "indication": "observed-indication",
            "selectionDomains": ["effectiveness"],
            "sourceInventory": [source("study-1")],
            "domainAssessments": [{
                "candidate": "drug-a",
                "domain": "effectiveness",
                "status": "favorable",
                "evidenceIds": ["study-1"],
                "rationale": "Observed.",
                "score": float("nan"),
            }],
        })
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "invalid_input")


if __name__ == "__main__":
    unittest.main()
