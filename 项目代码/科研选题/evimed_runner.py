"""Fixed-argument EviMed adapter for the research-topic specialist."""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import traceback
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent


def _write_result(output_dir: Path, value: dict) -> None:
    (output_dir / "result.json").write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _dump_model(value):
    return value.model_dump(mode="json") if hasattr(value, "model_dump") else value


def _normalize_report_certainty(content: str) -> str:
    """Downgrade promotional certainty while preserving the scientific claim."""
    replacements = (
        (r"可首次", "拟"),
        (r"(?:全球|国际|国内)首个", "拟验证的"),
        (r"首次(?=为|将|在|提出|构建|开发|实现|验证|应用|揭示|证明|报道|建立)", "拟"),
        (r"极大(?:地)?(?:增强|提高|改善)", "可能提高"),
        (r"精准估计", "估计"),
        (r"必然", "可能"),
        (r"彻底改变", "可能改进"),
        (r"颠覆(?:性)?(?:目前|传统|现有)?", "探索改进"),
        (r"真正的?因果效应", "预先定义因果问题下的效应"),
        (r"坚实的因果基础", "待验证的因果框架"),
        (r"可直接提升", "可评估是否改善"),
        (r"成功实施", "若按方案实施"),
        (r"推动[^\n。；]{0,40}指南(?:的)?(?:更新|修订)", "为后续指南评估提供待验证证据"),
        (r"改写指南", "为后续指南评估提供待验证证据"),
        (r"开启[^\n。；]{0,24}新纪元", "形成可验证的新路径"),
        (r"已充分揭示", "现有证据间接提示"),
        (r"明确证实|充分证明|已经证明|已证实", "现有证据提示"),
        (r"一致否定", "现有证据未形成一致支持"),
        (r"根本性的断裂", "证据衔接不足"),
        (r"新纪元", "可验证的新路径"),
        (r"明确的临床指导", "待验证的临床评估依据"),
        (r"全面接纳", "进一步评估"),
        (r"金标准", "常用的因果效应评估设计之一"),
        (r"最高级别的证据", "较高等级的干预证据"),
        (r"近似因果级别的证据", "更贴近预先定义因果问题的估计"),
        (r"最大限度控制混杂", "通过预先定义策略降低已测混杂的影响"),
        (r"直接关联", "用于评估"),
        (r"(?:尚无|没有)应用先例", "当前检索记录未提供直接应用证据（不等同于领域内无先例）"),
        (r"符合伦理要求", "仍需完成伦理审查"),
        (r"根本性突破", "待验证进展"),
        (r"根本性变革", "可能改进"),
        (r"首创", "拟探索"),
        (r"全新方向", "待验证方向"),
        (r"高级别临床证据", "经预先定义方法评价的临床证据"),
        (r"有望显著提升", "需评估是否改善"),
        (r"清晰的逻辑链", "待验证的逻辑链"),
        (r"直接转化为不良的临床结局", "与不良临床结局的关系需独立验证"),
        (r"推动([^\n。；]{0,36})范式(?:从|向|转变|升级)", r"评估\1路径由"),
        (r"范式飞跃", "路径演进"),
        (r"树立范例", "提供可复用的方法学线索"),
        (r"亟需", "可优先考虑"),
        (r"唯有如此", "若能落实上述条件"),
    )
    normalized = content
    for pattern, replacement in replacements:
        normalized = re.sub(pattern, replacement, normalized)
    normalized = normalized.replace("能可能", "可能").replace("可可能", "可能")
    normalized = re.sub(
        r"(?:纳入|每组)?\s*\d+\s*[–—~-]\s*\d+\s*例",
        "纳入先导样本（例数待基于预注册主要结局与可核对先导数据估算）",
        normalized,
    )
    return normalized


_MEASUREMENT_PATTERN = re.compile(
    r"(?:AUC\s*/\s*MIC|Cmin|fT\s*>\s*MIC)?\s*"
    r"(?:[<>≤≥]\s*)?\d+(?:\.\d+)?"
    r"(?:\s*[-–—~]\s*\d+(?:\.\d+)?)?\s*"
    r"(?:mg\s*/\s*L|g\s*/\s*(?:d|day)|mL\s*/\s*min|ng\s*/\s*mL|[µμ]g\s*/\s*mL|mmol\s*/\s*L)",
    flags=re.IGNORECASE,
)
_RATIO_TARGET_PATTERN = re.compile(
    r"(?:AUC\s*/\s*MIC|Cmin|fT\s*>\s*MIC)\s*(?:[<>≤≥]\s*)?"
    r"\d+(?:\.\d+)?(?:\s*[-–—~]\s*\d+(?:\.\d+)?)?",
    flags=re.IGNORECASE,
)
_PERCENT_THRESHOLD_PATTERN = re.compile(
    r"[<>\u2264\u2265]\s*\d+(?:\.\d+)?\s*%",
    flags=re.IGNORECASE,
)


def _measurement_key(value: str) -> str:
    return re.sub(
        r"\s+",
        "",
        value.casefold().replace("–", "-").replace("—", "-").replace("~", "-"),
    )


def _unbound_measurements(content: str, evidence_text: str) -> list[str]:
    evidence_key = _measurement_key(evidence_text)
    matches = []
    # A plain percentage is often a value derived from the retrieved evidence
    # set (for example, the share of records with a clinical endpoint).  Only
    # inequality percentages are treated as externally asserted thresholds.
    for pattern in (_MEASUREMENT_PATTERN, _RATIO_TARGET_PATTERN, _PERCENT_THRESHOLD_PATTERN):
        for match in pattern.finditer(content):
            value = match.group(0).strip()
            if _measurement_key(value) not in evidence_key and value not in matches:
                matches.append(value)
    return matches


def _normalize_unbound_measurements(content: str, evidence_text: str) -> str:
    for value in sorted(_unbound_measurements(content, evidence_text), key=len, reverse=True):
        content = content.replace(value, "数值阈值（须按原文和预注册方案复核）")
    return content


def _sanitize_module_artifact(value, *, _preserve_source: bool = False, _evidence_text: str = ""):
    """Normalize generated narratives without altering source excerpts or metadata."""
    if _preserve_source:
        return value
    if isinstance(value, dict):
        return {
            key: _sanitize_module_artifact(
                item,
                _preserve_source=key in {"supporting_evidence", "evidence_records"},
                _evidence_text=_evidence_text,
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_sanitize_module_artifact(item, _evidence_text=_evidence_text) for item in value]
    if not isinstance(value, str):
        return value
    replacements = (
        (r"(?:我们)?首次(?=为|将|在|提出|构建|开发|实现|验证|应用|揭示|证明|报道|建立)", "本研究拟"),
        (r"(?:全球|国际|国内)首个", "拟验证的"),
        (r"颠覆(?:性)?(?:目前|传统|现有)?", "探索改进"),
        (r"彻底改变", "可能拓展"),
        (r"真正的?因果效应", "预先定义因果问题下的效应"),
        (r"坚实的因果基础", "待验证的因果框架"),
        (r"可直接提升", "可评估是否改善"),
        (r"开创", "探索"),
        (r"零延迟", "低延迟"),
        (r"(?:尚无|没有)应用先例", "当前检索记录未提供直接应用证据（不等同于领域内无先例）"),
        (r"符合伦理要求", "仍需完成伦理审查"),
        (r"一致否定", "现有证据未形成一致支持"),
        (r"根本性的断裂", "证据衔接不足"),
        (r"新纪元", "可验证的新路径"),
        (r"全面的生存获益", "观察到的生存结局数值差异（统计学显著性须按原文复核）"),
        (r"可显著降低([^,，。；;]*)", r"观察到\1数值较低，但统计学显著性须按原文复核"),
        (r"显著降低([^,，。；;]*)", r"观察到\1数值较低，但统计学显著性须按原文复核"),
        (r"可显著提高([^,，。；;]*)", r"观察到\1数值较高，但统计学显著性须按原文复核"),
        (r"显著改善([^,，。；;]*)", r"观察到\1可能改善，但统计学显著性须按原文复核"),
        (r"直接解决", "拟评估是否缓解"),
        (r"泛化性能优异", "泛化性能待验证"),
        (r"其方法论贡献高于具体药物", "其方法学价值需独立评估"),
        (r"已充分缓解", "已制定缓解方案，实际风险仍需验证"),
        (r"该议程一旦完成，将为", "若该议程完成，可为"),
        (r"全新证据基础", "新的待验证证据基础"),
        (r"提供为转化评估提供依据证据", "为转化评估提供依据"),
        (r"根本性突破", "待验证进展"),
        (r"根本性变革", "可能改进"),
        (r"首创", "拟探索"),
        (r"全新方向", "待验证方向"),
        (r"高级别临床证据", "经预先定义方法评价的临床证据"),
        (r"有望显著提升", "需评估是否改善"),
        (r"清晰的逻辑链", "待验证的逻辑链"),
        (r"直接转化为不良的临床结局", "与不良临床结局的关系需独立验证"),
        (r"推动([^\n。；]{0,36})范式(?:从|向|转变|升级)", r"评估\1路径由"),
        (r"范式飞跃", "路径演进"),
        (r"树立范例", "提供可复用的方法学线索"),
        (r"亟需", "可优先考虑"),
        (r"唯有如此", "若能落实上述条件"),
    )
    normalized = value
    for pattern, replacement in replacements:
        normalized = re.sub(pattern, replacement, normalized)
    normalized = re.sub(
        r"至少\s*\d+(?:\s*[-–—~]\s*\d+)?\s*家(?:三甲医院|医院|中心)?",
        "多家符合预设条件的中心",
        normalized,
    )
    return _normalize_unbound_measurements(normalized, _evidence_text)


def _build_run_details(report, module_artifacts: dict) -> dict:
    """Build the reproducibility artifact from the same sanitized public modules."""
    details = report.model_dump(mode="json") if hasattr(report, "model_dump") else {"content": str(report)}
    if isinstance(details, dict) and "module_outputs" in details:
        details["module_outputs"] = module_artifacts
    return details


def _validate_release(completed, content: str, direction: str = "", module_artifacts=None) -> None:
    """Fail closed on identifiers, traceability, and broken prose."""
    if re.search(r"PMID:\s*[^0-9\s]", content, flags=re.IGNORECASE) or re.search(
        r"PMID:\s*[0-9]+[_-]", content, flags=re.IGNORECASE
    ):
        raise RuntimeError("research-topic report contains a non-PubMed identifier labeled as PMID")
    broken_transitions = (
        "模拟其三是", "构建其三是", "验证其三是", "评估其三是",
        "the third is the third", "TODO", "[repository URL]",
    )
    if any(marker in content for marker in broken_transitions):
        raise RuntimeError("research-topic report contains truncated or placeholder prose")
    unsupported_certainty = (
        "一致否定", "必然", "根本性的断裂", "改写指南",
        "新纪元", "已充分揭示", "彻底改变", "颠覆", "成功实施",
    )
    certainty_marker = next((marker for marker in unsupported_certainty if marker in content), None)
    first_claim = re.search(
        r"可首次|(?:全球|国际|国内)首个|首次(?=为|将|在|提出|构建|开发|实现|验证|应用|揭示|证明|报道|建立)", content
    )
    guideline_claim = re.search(r"推动[^\n。；]{0,40}指南(?:的)?(?:更新|修订)", content)
    if certainty_marker:
        raise RuntimeError(f"research-topic report contains unsupported certainty class: {certainty_marker}")
    if first_claim:
        raise RuntimeError("research-topic report contains unsupported certainty class: novelty-first")
    if guideline_claim:
        raise RuntimeError("research-topic report contains unsupported certainty class: guideline-promotion")
    if module_artifacts is not None:
        module_text = json.dumps(module_artifacts, ensure_ascii=False)
        if re.search(
            r"颠覆|彻底改变|真正的?因果效应|坚实的因果基础|可直接提升|"
            r"(?:尚无|没有)应用先例|零延迟|符合伦理要求",
            module_text,
        ):
            raise RuntimeError("research-topic module artifact contains unsupported promotional certainty")

    valid_pmids = {record.pmid for record in completed.evidence_records if record.pmid}
    evidence_text = "\n".join(
        (record.title or "") + "\n" + (record.abstract or "")
        for record in completed.evidence_records
    )
    if _unbound_measurements(content, evidence_text):
        raise RuntimeError("research-topic report contains an unbound numeric measurement")
    if module_artifacts is not None and _unbound_measurements(
        json.dumps(module_artifacts, ensure_ascii=False), evidence_text
    ):
        raise RuntimeError("research-topic module artifact contains an unbound numeric measurement")
    m4 = completed.module_outputs.get("M4_SCIENTIFIC_CONTRADICTION")
    m5 = completed.module_outputs.get("M5_BREAKTHROUGH_OPPORTUNITY")
    m6 = completed.module_outputs.get("M6_RESEARCH_AGENDA")
    contradictions = (m4.data.get("identified_contradictions", []) if m4 else [])
    for contradiction in contradictions:
        side_a = contradiction.get("evidence_A_pmids", [])
        side_b = contradiction.get("evidence_B_pmids", [])
        if (
            not side_a or not side_b
            or any(str(pmid) not in valid_pmids for pmid in [*side_a, *side_b])
            or set(side_a).intersection(side_b)
        ):
            raise RuntimeError("research-topic contradiction lacks two disjoint traceable evidence sides")
        if not str(contradiction.get("title") or "").startswith("待复核证据冲突："):
            raise RuntimeError("research-topic contradiction is not visibly labeled for full-text review")
    opportunities = (m5.data.get("opportunities", []) if m5 else [])
    if m5 and not opportunities:
        raise RuntimeError("research-topic report has no evidence-traceable breakthrough opportunity")
    opportunity_by_id = {}
    for opportunity in opportunities:
        pmids = opportunity.get("evidence_pmids", [])
        if not pmids or any(str(pmid) not in valid_pmids for pmid in pmids):
            raise RuntimeError("research-topic opportunity contains missing or unknown evidence PMID")
        level = opportunity.get("support_level")
        if level not in {"direct", "indirect", "speculative"}:
            raise RuntimeError("research-topic opportunity has an invalid support level")
        if not opportunity.get("support_rationale"):
            raise RuntimeError("research-topic opportunity omitted its support rationale")
        if level == "speculative" and "待验证" not in str(opportunity.get("title") or ""):
            raise RuntimeError("speculative research-topic opportunity is not visibly labeled")
        opportunity_by_id[str(opportunity.get("opportunity_id"))] = opportunity

    topics = (m6.data.get("research_topics", []) if m6 else [])
    structured = json.dumps([*opportunities, *topics], ensure_ascii=False)
    structured_match = re.search(
        r"全球首个|国际首个|国内首个|里程碑式|高引用潜力|已完成|"
        r"预计需\s*\d+|每组\s*\d+例|\d+\s*例|(?:纳入|每组)?\s*\d+\s*[–—~-]\s*\d+\s*例|"
        r"至少\s*\d+\s*个(?:以上)?|能可能|可可能|金标准|最高级别的证据|近似因果级别的证据|明确的临床指导",
        structured,
    )
    if structured_match:
        marker = structured_match.group(0)
        diagnostic_class = (
            "sample-size"
            if re.search(r"\d", marker) and ("例" in marker or "个" in marker or "预计需" in marker)
            else "evidence-overstatement"
            if marker in {"金标准", "最高级别的证据", "近似因果级别的证据", "明确的临床指导"}
            else "promotion"
        )
        raise RuntimeError(
            "research-topic structured plan contains unsupported claim class: "
            + diagnostic_class
        )
    if m6 and len(topics) != len(opportunity_by_id):
        raise RuntimeError("research-topic agenda is not one-to-one with breakthrough opportunities")
    for topic in topics:
        source = opportunity_by_id.get(str(topic.get("source_opportunity_id")))
        if not source:
            raise RuntimeError("research topic has no valid source opportunity")
        if topic.get("source_evidence_pmids") != source.get("evidence_pmids"):
            raise RuntimeError("research topic did not inherit source evidence exactly")
        if topic.get("support_level") != source.get("support_level"):
            raise RuntimeError("research topic did not inherit source support level exactly")
        if not str(topic.get("hypothesis") or "").startswith("待验证："):
            raise RuntimeError("research topic hypothesis is not visibly labeled as unvalidated")
        sample_size = topic.get("sample_size") or {}
        if sample_size and not str(sample_size.get("estimated_n") or "").startswith("待基于先导数据"):
            raise RuntimeError("research topic sample size is presented as an authoritative calculation")
        publication = topic.get("publication_strategy") or {}
        if publication and not str(publication.get("expected_impact_factor") or "").startswith("不预设"):
            raise RuntimeError("research topic presents an unsupported impact-factor forecast")

    if re.search(r"\badults?\b", direction.casefold()) or any(
        marker in direction for marker in ("成人", "成年人", "老年")
    ):
        from services.task_service import TaskService

        pediatric_only = []
        for record in completed.evidence_records:
            if TaskService._is_pediatric_dominant(record):
                pediatric_only.append(record.pmid or record.doi or record.id)
        if pediatric_only:
            raise RuntimeError("adult-scoped research-topic evidence retained pediatric-only records")


async def _analyze_with_service(request: dict, output_dir: Path, service) -> dict:
    direction = str(request.get("researchDirection") or "").strip()
    if not direction:
        raise ValueError("researchDirection is required")

    from models.schemas import TaskStatus
    task = await service.create_task(direction)
    completed = await service.process_task(task.task_id)
    if completed.status != TaskStatus.COMPLETED or completed.report is None:
        raise RuntimeError(completed.error_message or "research-topic pipeline did not complete")
    invalid_modules = []
    for module_id, module_output in completed.module_outputs.items():
        serialized = json.dumps(module_output.data, ensure_ascii=False, default=str)
        if module_output.status != "success" or any(
            marker in serialized for marker in ("分析失败", "生成失败", "使用默认输出")
        ):
            invalid_modules.append(module_id)
    if invalid_modules:
        raise RuntimeError(
            "research-topic pipeline contains failed analysis modules: "
            + ", ".join(sorted(invalid_modules))
        )
    evidence_text = "\n".join(
        (record.title or "") + "\n" + (record.abstract or "")
        for record in completed.evidence_records
    )
    module_artifacts = {
        module_id: _sanitize_module_artifact(
            _dump_model(value),
            _evidence_text=evidence_text,
        )
        for module_id, value in completed.module_outputs.items()
    }
    report = completed.report
    content = report.content if hasattr(report, "content") else str(report)
    content = _normalize_report_certainty(content)
    content = _normalize_unbound_measurements(content, evidence_text)
    if hasattr(report, "content"):
        report.content = content
    if len(content.strip()) < 100:
        raise RuntimeError("research-topic pipeline produced an empty report")
    _validate_release(completed, content, direction, module_artifacts)
    report_path = output_dir / "research-topic-report.md"
    report_path.write_text(content, encoding="utf-8")
    details = _build_run_details(report, module_artifacts)
    (output_dir / "research-topic-run.json").write_text(
        json.dumps(details, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    evidence_path = output_dir / "evidence-records.json"
    evidence_path.write_text(
        json.dumps([_dump_model(record) for record in completed.evidence_records], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    stats_path = output_dir / "evidence-stats.json"
    stats_path.write_text(
        json.dumps(_dump_model(completed.evidence_stats), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    modules_path = output_dir / "module-outputs.json"
    modules_path.write_text(
        json.dumps(
            module_artifacts,
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return {
        "status": "succeeded",
        "taskId": task.task_id,
        "report": report_path.name,
        "evidenceCount": len(completed.evidence_records),
        "artifacts": [
            report_path.name,
            "research-topic-run.json",
            evidence_path.name,
            stats_path.name,
            modules_path.name,
        ],
    }


def revalidate_existing(output_dir: Path, direction: str) -> dict:
    """Reapply deterministic release rules to a completed, auditable job."""
    from models.schemas import LiteratureRecord, ModuleOutput

    evidence_path = output_dir / "evidence-records.json"
    modules_path = output_dir / "module-outputs.json"
    report_path = output_dir / "research-topic-report.md"
    run_path = output_dir / "research-topic-run.json"
    required = (evidence_path, modules_path, report_path, run_path)
    if any(not path.is_file() or path.is_symlink() for path in required):
        raise RuntimeError("research-topic revalidation requires complete regular-file artifacts")
    evidence_records = [
        LiteratureRecord.model_validate(item)
        for item in json.loads(evidence_path.read_text(encoding="utf-8"))
    ]
    raw_modules = json.loads(modules_path.read_text(encoding="utf-8"))
    evidence_text = "\n".join(
        (record.title or "") + "\n" + (record.abstract or "")
        for record in evidence_records
    )
    module_artifacts = {
        module_id: _sanitize_module_artifact(value, _evidence_text=evidence_text)
        for module_id, value in raw_modules.items()
    }
    content = _normalize_unbound_measurements(
        _normalize_report_certainty(report_path.read_text(encoding="utf-8")),
        evidence_text,
    )
    completed = SimpleNamespace(
        evidence_records=evidence_records,
        module_outputs={
            module_id: ModuleOutput.model_validate(value)
            for module_id, value in module_artifacts.items()
        },
    )
    _validate_release(completed, content, direction, module_artifacts)
    details = json.loads(run_path.read_text(encoding="utf-8"))
    details["content"] = content
    details["module_outputs"] = module_artifacts
    report_path.write_text(content, encoding="utf-8")
    modules_path.write_text(
        json.dumps(module_artifacts, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    run_path.write_text(json.dumps(details, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "status": "succeeded",
        "evidenceCount": len(evidence_records),
        "moduleCount": len(module_artifacts),
        "report": report_path.name,
    }


async def _analyze(request: dict, output_dir: Path) -> dict:
    from services.task_service import TaskService

    service = TaskService()
    try:
        return await _analyze_with_service(request, output_dir, service)
    finally:
        await service.close()


def run(request_path: Path, output_dir: Path) -> int:
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
        result = asyncio.run(_analyze(request, output_dir))
        _write_result(output_dir, result)
        return 0
    except Exception as error:
        traceback.print_exc()
        _write_result(output_dir, {"status": "failed", "error": str(error)})
        return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--revalidate-existing", action="store_true")
    parser.add_argument("--research-direction", default="")
    args = parser.parse_args()
    if args.revalidate_existing:
        result = revalidate_existing(args.output_dir, args.research_direction)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.request is None:
        parser.error("--request is required unless --revalidate-existing is used")
    return run(args.request, args.output_dir)


if __name__ == "__main__":
    raise SystemExit(main())
