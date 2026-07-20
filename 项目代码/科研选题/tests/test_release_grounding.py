import asyncio

from core.new_report_generator import ReportGenerator
from models.schemas import EvidenceStats, LiteratureRecord
from modules.new_analysis_modules import (
    M4_ScientificContradictionModule,
    M5_BreakthroughOpportunityModule,
    M6_ResearchAgendaModule,
)
from services.internal_db_service import _map_record, _normalize_study_design
from services.pubmed_service import PubMedSearchService
from evimed_runner import (
    _build_run_details,
    _normalize_report_certainty,
    _normalize_unbound_measurements,
    _sanitize_module_artifact,
    _unbound_measurements,
)


def _record(identifier: str, *, pmid=None, doi=None, source="internal"):
    return LiteratureRecord(
        id=f"{source}_{identifier}",
        pmid=pmid,
        doi=doi,
        title="Model-informed precision dosing in critically ill adults",
        abstract="A clinical review of therapeutic drug monitoring and patient outcomes.",
        publication_year=2025,
        study_design="Review",
    )


def test_internal_compound_identifier_is_not_labeled_as_pmid():
    record = _map_record(
        {
            "id": "1_162_69aaa886c72273a2c4f23318",
            "title": "Precision dosing review",
            "abstract": "A review discussing clinical and animal evidence.",
            "doi": "10.1000/example",
        },
        0,
    )

    assert record is not None
    assert record.pmid is None
    assert record.id == "internal_1_162_69aaa886c72273a2c4f23318"


def test_review_discussing_animal_evidence_is_not_an_animal_study():
    design = _normalize_study_design(
        "",
        title="Current knowledge on precision dosing: a narrative review",
        abstract="This review discusses animal models and critically ill patients.",
    )

    assert design == "Review"


def test_deduplication_keeps_doi_only_evidence_and_prefers_pubmed_metadata():
    internal = _record("internal", doi="10.1000/same")
    pubmed = _record("42", pmid="42", doi="10.1000/same", source="pubmed")
    doi_only = LiteratureRecord(
        id="internal_other",
        doi="10.1000/other",
        title="A distinct DOI-only article",
    )

    records = asyncio.run(PubMedSearchService().deduplicate_records([internal, doi_only, pubmed]))

    assert [record.id for record in records] == ["pubmed_42", "internal_other"]


def test_breakthrough_opportunities_require_real_evidence_and_label_speculation():
    records = [_record("42", pmid="42", source="pubmed")]
    validated = M5_BreakthroughOpportunityModule._validate_opportunities(
        [
            {"opportunity_id": "BOM1", "title": "Causal validation", "evidence_pmids": ["42"], "support_level": "direct"},
            {"opportunity_id": "BOM2", "title": "肠-肾轴机制", "evidence_pmids": ["42"], "support_level": "direct"},
            {"opportunity_id": "BOM3", "title": "New biomarker", "evidence_pmids": ["42"], "support_level": "speculative"},
        ],
        records,
    )

    assert [item["opportunity_id"] for item in validated] == ["BOM1", "BOM3"]
    assert validated[0]["support_level"] == "indirect"
    assert validated[0]["support_rationale"]
    assert validated[1]["title"].startswith("待验证假说：")


def test_breakthrough_support_is_downgraded_when_proposed_technology_is_absent():
    records = [_record("42", pmid="42", source="pubmed")]
    validated = M5_BreakthroughOpportunityModule._validate_opportunities(
        [{
            "opportunity_id": "BOM1",
            "title": "强化学习闭环自适应给药",
            "evidence_pmids": ["42"],
            "support_level": "direct",
            "scientific_innovation": "首次用deep Q网络改写指南",
            "validation_pathway": "使用既有样本训练模型。",
            "expected_impact": {"clinical": "将风险降低30%，并提前48小时预警。"},
        }],
        records,
    )

    assert validated[0]["support_level"] == "speculative"
    assert validated[0]["title"].startswith("待验证假说：")
    assert "reinforcement_learning" in validated[0]["missing_evidence_concepts"]
    assert "首次" not in validated[0]["scientific_innovation"]
    assert "改写指南" not in validated[0]["scientific_innovation"]
    assert "降低30%" not in validated[0]["expected_impact"]["clinical"]
    assert "预设达标率" in validated[0]["expected_impact"]["clinical"]
    assert "核对数据与样本可用性" in validated[0]["validation_pathway"]


def test_breakthrough_plan_removes_single_point_sample_counts_and_binds_narrative_pmids():
    records = [
        _record("42", pmid="420001", source="pubmed"),
        _record("43", pmid="430001", source="pubmed"),
    ]
    validated = M5_BreakthroughOpportunityModule._validate_opportunities(
        [{
            "opportunity_id": "BOM1",
            "title": "多中心验证",
            "evidence_pmids": ["420001"],
            "support_level": "indirect",
            "validation_pathway": "使用PMID 430001数据开展观察研究（120例）和RCT（200例）。",
        }],
        records,
    )

    assert validated[0]["evidence_pmids"] == ["420001", "430001"]
    assert "120例" not in validated[0]["validation_pathway"]
    assert "200例" not in validated[0]["validation_pathway"]
    assert "例数待基于预注册主要结局" in validated[0]["validation_pathway"]


def test_breakthrough_plan_rejects_unknown_narrative_pmid():
    records = [_record("42", pmid="420001", source="pubmed")]

    validated = M5_BreakthroughOpportunityModule._validate_opportunities(
        [{
            "opportunity_id": "BOM1",
            "title": "多中心验证",
            "evidence_pmids": ["420001"],
            "validation_pathway": "使用未知的PMID 999999数据。",
        }],
        records,
    )

    assert validated == []


def test_contradictions_require_two_disjoint_known_evidence_sides():
    records = [_record("42", pmid="42", source="pubmed"), _record("43", pmid="43", source="pubmed")]
    validated = M4_ScientificContradictionModule._validate_contradictions(
        [
            {"title": "候选冲突", "evidence_A_pmids": ["42"], "evidence_B_pmids": ["43"]},
            {"title": "伪冲突", "evidence_A_pmids": ["42"], "evidence_B_pmids": ["42"]},
        ],
        records,
    )

    assert len(validated) == 1
    assert validated[0]["title"].startswith("待复核证据冲突：")
    assert validated[0]["support_level"] == "candidate_conflict"


def test_research_topics_inherit_opportunity_evidence_exactly():
    opportunities = [{
        "opportunity_id": "BOM1",
        "title": "Target trial emulation",
        "evidence_pmids": ["42"],
        "support_level": "indirect",
    }]
    topics = M6_ResearchAgendaModule._validate_topics(
        [{
            "title": "Evaluate TDM",
            "source_opportunity_id": "BOM1",
            "source_evidence_pmids": ["fabricated"],
        }],
        opportunities,
    )

    assert topics[0]["source_evidence_pmids"] == ["42"]
    assert topics[0]["source_opportunity_title"] == "Target trial emulation"
    assert topics[0]["hypothesis"].startswith("待验证：")


def test_fallback_opportunities_carry_release_grounding_fields():
    fallback = M5_BreakthroughOpportunityModule._fallback_opportunities(
        [_record("42", pmid="42", source="pubmed")],
        "precision dosing",
    )

    assert len(fallback) == 2
    assert all(item["support_level"] == "indirect" for item in fallback)
    assert all(item["support_rationale"] for item in fallback)
    assert all(item["missing_evidence_concepts"] for item in fallback)


def test_adult_fallback_prefers_adult_only_evidence_over_mixed_pediatric_records():
    mixed = LiteratureRecord(
        id="pubmed_mixed",
        pmid="41",
        title="Precision dosing in Pediatrics and young adults",
        abstract="An ICU pharmacometric study including young adults.",
        study_design="Pharmacometric Study",
    )
    adult = LiteratureRecord(
        id="pubmed_adult",
        pmid="42",
        title="Model-informed precision dosing in critically ill adults",
        abstract="An adult multicentre cohort evaluating dose models and monitoring.",
        study_design="Cohort",
    )

    fallback = M5_BreakthroughOpportunityModule._fallback_opportunities(
        [mixed, adult],
        "Critical Illness, Adult, Precision Dosing",
    )

    assert all(item["evidence_pmids"] == ["42"] for item in fallback)


def test_research_topic_fallback_preserves_one_to_one_grounding():
    opportunities = [{
        "opportunity_id": "BOM1",
        "title": "多中心精准给药验证",
        "evidence_pmids": ["42"],
        "support_level": "indirect",
        "support_rationale": "相邻方法学证据",
        "missing_evidence_concepts": ["multicenter_validation"],
    }]

    topics = M6_ResearchAgendaModule._validate_topics([], opportunities)

    assert len(topics) == 1
    assert topics[0]["source_opportunity_id"] == "BOM1"
    assert topics[0]["source_evidence_pmids"] == ["42"]
    assert topics[0]["hypothesis"].startswith("待验证：")
    assert topics[0]["sample_size"]["estimated_n"].startswith("待基于先导数据")
    assert topics[0]["publication_strategy"]["expected_impact_factor"].startswith("不预设")


def test_topic_planning_labels_hypotheses_sample_size_and_journal_metrics():
    topics = M6_ResearchAgendaModule._validate_topics(
        [{
            "title": "精准给药试验",
            "source_opportunity_id": "BOM1",
            "hypothesis": "干预可改善结局",
            "sample_size": {"estimated_n": "400例", "calculation_basis": "假设事件率40%"},
            "publication_strategy": {"expected_impact_factor": "30-50"},
        }],
        [{
            "opportunity_id": "BOM1",
            "title": "精准给药",
            "evidence_pmids": ["42"],
            "support_level": "indirect",
            "support_rationale": "相邻方法支持",
        }],
    )

    assert topics[0]["hypothesis"].startswith("待验证：")
    assert topics[0]["sample_size"]["estimated_n"].startswith("待基于先导数据")
    assert topics[0]["sample_size"]["calculation_basis"].startswith("规划性假设")
    assert "400" not in topics[0]["sample_size"]["estimated_n"]
    assert topics[0]["publication_strategy"]["expected_impact_factor"].startswith("不预设")
    assert "阳性发现" in topics[0]["publication_strategy"]["key_selling_points"][0]


def test_executive_summary_is_structured_and_traceable_without_llm(monkeypatch):
    async def should_not_run(*args, **kwargs):
        raise AssertionError("summary must not call the LLM")

    monkeypatch.setattr("core.new_report_generator.llm_service.complete", should_not_run)
    materials = {
        "all_key_insights": [],
        "module_data": {
            "M4_SCIENTIFIC_CONTRADICTION": {"key_insights": ["TDM causal uncertainty"]},
            "M5_BREAKTHROUGH_OPPORTUNITY": {
                "raw_opportunities": [{
                    "title": "Target trial emulation",
                    "support_level": "indirect",
                    "evidence_pmids": ["42"],
                }]
            },
            "M6_RESEARCH_AGENDA": {"raw_topics": [{"title": "A multicenter emulation study"}]},
        },
        "evidence_stats_summary": {
            "total_papers": 1,
            "clinical_ratio": 1.0,
            "earliest_year": 2025,
            "latest_year": 2025,
            "design_distribution": {"Review": 1},
        },
    }
    stats = EvidenceStats(evidence_count=1, clinical_ratio=1.0, design_distribution={"Review": 1})

    summary = asyncio.run(ReportGenerator()._generate_executive_summary("precision dosing", materials, stats))

    assert "PMID 42" in summary
    assert "不代表已证实的因果关系" in summary
    assert "模拟其三是" not in summary


def test_comprehensive_conclusion_is_structured_and_does_not_call_llm(monkeypatch):
    async def should_not_run(*args, **kwargs):
        raise AssertionError("conclusion must not call the LLM")

    monkeypatch.setattr("core.new_report_generator.llm_service.complete", should_not_run)
    materials = {
        "module_data": {
            "M4_SCIENTIFIC_CONTRADICTION": {"key_insights": ["待复核证据冲突：替代终点"]},
            "M5_BREAKTHROUGH_OPPORTUNITY": {"raw_opportunities": [{
                "title": "目标试验模拟", "support_level": "indirect", "evidence_pmids": ["42"],
            }]},
            "M6_RESEARCH_AGENDA": {"raw_topics": [{
                "title": "待验证选题", "source_opportunity_id": "BOM1",
            }]},
        },
        "evidence_stats_summary": {
            "total_papers": 10, "clinical_ratio": 0.6, "earliest_year": 2022, "latest_year": 2026,
        },
    }
    stats = EvidenceStats(evidence_count=10, clinical_ratio=0.6, earliest_year=2022, latest_year=2026)

    conclusion = asyncio.run(ReportGenerator()._generate_conclusion("precision dosing", materials, stats))

    assert "10条证据记录" in conclusion
    assert "PMID 42" in conclusion
    assert "不是已证实的临床结论" in conclusion


def test_report_certainty_normalizer_downgrades_promotional_claim_classes():
    content = (
        "该研究可首次为实践提供证据，极大增强可信度，"
        "成功实施将推动临床实践指南的更新，并精准估计效应。"
        "现有研究一致否定该路径，存在根本性的断裂，将开启新纪元。"
    )

    normalized = _normalize_report_certainty(content)

    assert "首次" not in normalized
    assert "极大" not in normalized
    assert "成功实施" not in normalized
    assert "推动临床实践指南的更新" not in normalized
    assert "为后续指南评估提供待验证证据" in normalized
    assert "估计效应" in normalized
    assert "一致否定" not in normalized
    assert "根本性的断裂" not in normalized
    assert "新纪元" not in normalized


def test_structured_sanitizer_removes_publication_hype_and_detects_missing_technology():
    raw = M5_BreakthroughOpportunityModule._sanitize_generated_value({
        "claim": "全球首个里程碑式系统，已完成开发，具有高引用潜力",
    })

    assert "全球首个" not in raw["claim"]
    assert "里程碑式" not in raw["claim"]
    assert "已完成" not in raw["claim"]
    assert "高引用潜力" not in raw["claim"]
    concepts = M5_BreakthroughOpportunityModule._concept_families(
        "数字孪生与微流控电化学传感器驱动模型预测控制"
    )
    assert {"digital_twin", "biosensor", "model_predictive_control"}.issubset(concepts)


def test_structured_sanitizer_removes_pseudo_precision_and_causal_overstatement():
    raw = M5_BreakthroughOpportunityModule._sanitize_generated_value({
        "hypothesis": "该方案能显著降低误差并提供明确的临床指导",
        "rationale": "RCT是金标准，可提供最高级别的证据",
        "timeline": "先导研究纳入20–30例",
        "intervention": "整合至少10个以上模型后开源发布",
        "validation": "开展观察研究（120例）、RCT（200例）与50例外部验证",
    })

    serialized = str(raw)
    assert "能可能" not in serialized
    assert "明确的临床指导" not in serialized
    assert "金标准" not in serialized
    assert "最高级别的证据" not in serialized
    assert "20–30例" not in serialized
    assert "120例" not in serialized
    assert "200例" not in serialized
    assert "50例" not in serialized
    assert "至少10个以上" not in serialized
    assert "例数待基于预注册主要结局" in serialized


def test_module_artifact_sanitizer_removes_narrow_release_rhetoric():
    artifact = _sanitize_module_artifact({
        "analysis": (
            "该方案颠覆目前范式且将彻底改变实践，尚无应用先例，可实现零延迟，"
            "识别真正的因果效应，提供坚实的因果基础，可直接提升性能，并符合伦理要求。"
        ),
    })

    serialized = artifact["analysis"]
    assert "颠覆" not in serialized
    assert "彻底改变" not in serialized
    assert "真正的因果效应" not in serialized
    assert "坚实的因果基础" not in serialized
    assert "可直接提升" not in serialized
    assert "尚无应用先例" not in serialized
    assert "零延迟" not in serialized
    assert "符合伦理要求" not in serialized
    assert "不等同于领域内无先例" in serialized
    assert "仍需完成伦理审查" in serialized


def test_module_artifact_sanitizer_preserves_sources_and_downgrades_significance_claims():
    artifact = _sanitize_module_artifact({
        "data": {
            "evidence_A": "MIPD可显著降低死亡率。",
            "llm_deep_analysis": "我们首次建立方法，风险已充分缓解。",
        },
        "supporting_evidence": [{
            "title": "First successful implementation",
            "excerpt": "Mortality was lower, but only target attainment was statistically significant.",
        }],
    })

    assert "显著降低死亡率" not in artifact["data"]["evidence_A"]
    assert "统计学显著性须按原文复核" in artifact["data"]["evidence_A"]
    assert "我们首次" not in artifact["data"]["llm_deep_analysis"]
    assert "实际风险仍需验证" in artifact["data"]["llm_deep_analysis"]
    assert artifact["supporting_evidence"][0]["title"] == "First successful implementation"
    assert "statistically significant" in artifact["supporting_evidence"][0]["excerpt"]


def test_reproducibility_artifact_uses_sanitized_public_module_outputs():
    class FakeReport:
        def model_dump(self, mode="json"):
            assert mode == "json"
            return {
                "content": "report",
                "module_outputs": {"M4": {"raw": "彻底改变"}},
            }

    sanitized = {"M4": {"public": "可能拓展"}}
    details = _build_run_details(FakeReport(), sanitized)

    assert details["module_outputs"] == sanitized
    assert "彻底改变" not in str(details)


def test_unbound_measurements_are_removed_but_source_supported_values_remain():
    evidence = "A cefepime dose of 6 g/day was used with creatinine clearance 60-90 mL/min."
    generated = "方案使用6 g/day，并预设谷浓度>35 mg/L为安全阈值。"

    normalized = _normalize_unbound_measurements(generated, evidence)

    assert "6 g/day" in normalized
    assert ">35 mg/L" not in normalized
    assert "须按原文和预注册方案复核" in normalized
    assert _unbound_measurements(normalized, evidence) == []


def test_derived_percentages_remain_but_unbound_percent_thresholds_are_removed():
    generated = "The clinical-record share was 71.9%, while NSE >25% was required."

    normalized = _normalize_unbound_measurements(generated, "No percentage threshold was reported.")

    assert "71.9%" in normalized
    assert ">25%" not in normalized
    assert "须按原文和预注册方案复核" in normalized


def test_module_sanitizer_removes_broader_promotion_and_unbound_thresholds():
    artifact = _sanitize_module_artifact(
        {
            "analysis": "实现根本性突破与根本性变革，开辟全新方向，有望显著提升结局。",
            "plan": "使用谷浓度>35 mg/L阈值。",
            "supporting_evidence": [{"excerpt": "The source says >35 mg/L verbatim."}],
        },
        _evidence_text="No numeric threshold was reported.",
    )

    assert "根本性突破" not in artifact["analysis"]
    assert "根本性变革" not in artifact["analysis"]
    assert "全新方向" not in artifact["analysis"]
    assert "有望显著提升" not in artifact["analysis"]
    assert ">35 mg/L" not in artifact["plan"]
    assert ">35 mg/L" in artifact["supporting_evidence"][0]["excerpt"]


def test_module_sanitizer_removes_first_claims_and_pseudo_precise_site_counts():
    artifact = _sanitize_module_artifact({
        "innovation": "首创方法并推动范式飞跃，为其他药物树立范例。",
        "resources": "需要至少8-10家三甲医院，亟需建立联盟。唯有如此才能执行。",
    })

    serialized = str(artifact)
    assert "首创" not in serialized
    assert "范式飞跃" not in serialized
    assert "树立范例" not in serialized
    assert "至少8-10家" not in serialized
    assert "亟需" not in serialized
    assert "唯有如此" not in serialized
