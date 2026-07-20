# [IN] tools/*, llm/client.py, models.py
# [OUT] MRAnalysisResult list
# [POS] mr_agent/analysis/pipeline.py - MR analysis orchestration
"""MR analysis pipeline - orchestrates the complete workflow."""

from __future__ import annotations

import logging
import re
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable

from mr_agent.core.state import save_session
from mr_agent.llm.client import LLMClient
from mr_agent.llm.prompts import (
    EXTRACT_EO_PAIRS,
    EO_PAIRS_SCHEMA,
    GWAS_ID_SELECT,
    GWAS_ID_SCHEMA,
    MR_EXISTS_CHECK,
    MR_EXISTS_SCHEMA,
    MR_INTERPRET,
    SYSTEM_MR_SCIENTIST,
    TERM_TRANSLATE,
)
from mr_agent.models import (
    AnalysisMode,
    AnalysisSlots,
    DataSource,
    DataSourceType,
    ExposureOutcome,
    GWASEntry,
    MRAnalysisResult,
    MRMethod,
    SessionState,
)
from mr_agent.tools import gwas, pubmed, umls
from mr_agent.tools.gwas import sanitize_gwas_id
from mr_agent.tools.mr_executor import (
    check_r_environment,
    run_mr_analysis, run_mr_local, run_mr_moe, run_mr_mrlap, run_mr_mvmr,
    run_summary_forest,
)

logger = logging.getLogger(__name__)

ProgressCallback = Callable[..., None]

_CJK_RE = re.compile(r'[\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af'
                      r'\u3040-\u309f\u30a0-\u30ff]')


def _contains_cjk(text: str) -> bool:
    """Check if text contains CJK characters."""
    return bool(_CJK_RE.search(text))


class MRPipeline:
    """Orchestrates the complete MR analysis workflow."""

    def __init__(
        self,
        llm: LLMClient,
        state: SessionState,
        on_progress: ProgressCallback | None = None,
        language: str = "en",
    ):
        self.llm = llm
        self.state = state
        self.on_progress = on_progress or (lambda *args: None)
        self.language = language

    def run(self) -> list[MRAnalysisResult]:
        """Execute the full MR pipeline.

        Steps: 1=identify_pairs, 2=check_existing, 3=data_retrieval,
               4=build_and_execute, 5=complete
        Completed step number is persisted so we can resume after crash.
        """
        slots = self.state.slots
        if not self._validate_slots(slots):
            return []
        # P2-3: R environment check
        r_ok, r_msg = check_r_environment()
        if not r_ok:
            logger.error(f"R environment check failed: {r_msg}")
            self.state.errors.append(r_msg)
            self.on_progress(r_msg, 0.0)
            return []
        # P0-2: Translate CJK terms to English
        self._translate_terms(slots)
        output_dir = self._ensure_output_dir()
        self.on_progress("开始MR分析流程...", 0.0)
        if slots.has_local_sources():
            return self._run_local_path(slots, output_dir)

        done = self.state.last_completed_step

        # Step 1: identify pairs
        if done >= 1:
            eo_pairs = self.state.eo_pairs
        else:
            eo_pairs = self._step1_identify_pairs(slots)
            self.state.eo_pairs = eo_pairs
            self.state.last_completed_step = 1
            save_session(self.state)

        # Step 2: check existing MR studies
        if done < 2:
            self.on_progress("检查已有MR研究...", 0.10)
            eo_pairs = self._step2_check_existing(eo_pairs)
            self._report_existing_studies(eo_pairs)
            self.state.last_completed_step = 2
            save_session(self.state)

        # Step 3: data retrieval (synonyms, GWAS search, GWAS selection)
        if done >= 3:
            merged = self.state.selected_gwas_ids
        else:
            merged = self._run_data_retrieval(eo_pairs, slots)
            self.state.selected_gwas_ids = merged
            self.state.last_completed_step = 3
            save_session(self.state)

        # Step 4: build pairs + execute MR + interpret
        pairs = self._build_pairs(eo_pairs, merged)
        if not pairs:
            return []
        results = self._run_mr_and_interpret(pairs, output_dir, slots)
        self.state.analysis_results = results
        self.state.last_completed_step = 5
        save_session(self.state)
        self.on_progress("MR分析完成!", 1.0)
        return results

    def _run_local_path(
        self, slots: AnalysisSlots, output_dir: Path,
    ) -> list[MRAnalysisResult]:
        """Run pipeline with local data (skips GWAS search steps)."""
        self.on_progress("使用本地数据执行MR分析...", 0.10)
        exp_source = slots.exposure_source or DataSource(
            source_type=DataSourceType.OPENGWAS,
            trait_name=slots.exposure or "",
        )
        out_source = slots.outcome_source or DataSource(
            source_type=DataSourceType.OPENGWAS,
            trait_name=slots.outcome or "",
        )
        self.on_progress("执行MR分析...", 0.30)
        result = self._run_single_with_sources(
            exp_source, out_source, output_dir, slots,
        )
        result.exposure_name = slots.exposure or exp_source.trait_name
        result.outcome_name = slots.outcome or out_source.trait_name
        results = [result]
        results = self._local_bidirectional(
            results, out_source, exp_source, output_dir, slots,
        )
        self.on_progress("解读分析结果...", 0.80)
        results = self._step9_interpret(results)
        self.state.analysis_results = results
        self.on_progress("MR分析完成!", 1.0)
        return results

    def _local_bidirectional(
        self, results, out_source, exp_source, output_dir, slots,
    ) -> list[MRAnalysisResult]:
        """Run reverse MR if bidirectional enabled (local path)."""
        if not slots.bidirectional:
            return results
        self.on_progress("反向分析...", 0.60)
        rev = self._run_single_with_sources(
            out_source, exp_source, output_dir, slots,
        )
        rev.exposure_name = slots.outcome or out_source.trait_name
        rev.outcome_name = slots.exposure or exp_source.trait_name
        results.append(rev)
        return results

    def _run_single_with_sources(
        self, exp_source: DataSource, out_source: DataSource,
        output_dir: Path, slots: AnalysisSlots,
    ) -> MRAnalysisResult:
        """Run MR for a single pair using DataSource objects."""
        pair_dir = output_dir / f"{exp_source.display_id()}_{out_source.display_id()}"
        return run_mr_local(
            exposure_source=exp_source,
            outcome_source=out_source,
            output_dir=pair_dir,
            gwas_token=slots.gwas_token or "",
        )

    def _validate_slots(self, slots: AnalysisSlots) -> bool:
        """Validate that required slots are filled."""
        if not slots.exposure or not slots.outcome:
            logger.error("Missing exposure or outcome in slots")
            self.state.errors.append("暴露变量或结局变量缺失，无法执行分析。")
            return False
        return True

    def _translate_terms(self, slots: AnalysisSlots) -> None:
        """Translate CJK terms to English for GWAS search compatibility."""
        if slots.exposure and _contains_cjk(slots.exposure):
            slots.exposure = self._translate_single(slots.exposure)
        if slots.outcome and _contains_cjk(slots.outcome):
            slots.outcome = self._translate_single(slots.outcome)
        translated = []
        for o in slots.additional_outcomes:
            translated.append(self._translate_single(o) if _contains_cjk(o) else o)
        slots.additional_outcomes = translated

    def _translate_single(self, term: str) -> str:
        """Translate a single term from CJK to English via LLM."""
        try:
            prompt = TERM_TRANSLATE.format(term=term)
            result = self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                system=SYSTEM_MR_SCIENTIST,
                max_tokens=100,
                model_tier="flash",
            )
            translated = result.strip().strip('"').strip("'")
            if translated:
                self.on_progress(f"翻译: {term} → {translated}", 0.02)
                return translated
        except Exception as e:
            logger.warning(f"Translation failed for '{term}': {e}")
        return term

    def _run_data_retrieval(
        self, eo_pairs: list[ExposureOutcome], slots: AnalysisSlots,
    ) -> dict[str, list[str]]:
        """Steps 3-5: synonyms, GWAS search, GWAS selection."""
        self.on_progress("扩展同义词...", 0.20)
        synonyms = self._step3_expand_synonyms(eo_pairs, slots)
        self.on_progress("检索GWAS数据...", 0.30)
        gwas_map = self._step4_check_gwas(synonyms)
        self.on_progress("选择最佳GWAS ID...", 0.40)
        selected = self._step5_select_gwas(gwas_map)
        return self._merge_synonym_ids(selected, synonyms)

    def _build_pairs(
        self, eo_pairs: list[ExposureOutcome], merged: dict[str, list[str]],
    ) -> list[tuple[str, str, str, str]]:
        """Step 6: generate pairs or handle empty."""
        self.on_progress("生成分析对...", 0.50)
        pairs = self._step6_generate_pairs(eo_pairs, merged)
        if not pairs:
            self._handle_no_pairs(merged)
        return pairs

    def _run_mr_and_interpret(
        self, pairs, output_dir: Path, slots: AnalysisSlots,
    ) -> list[MRAnalysisResult]:
        """Steps 7-9: execute MR, bidirectional, interpret, summary forest."""
        self.on_progress("执行MR分析...", 0.55)
        results = self._step7_execute_mr(pairs, output_dir, slots)
        self.on_progress("双向分析...", 0.75)
        results = self._step8_bidirectional(results, pairs, output_dir, slots)
        self.on_progress("解读分析结果...", 0.85)
        results = self._step9_interpret(results)
        if len(results) >= 2:
            self.on_progress("生成汇总Forest Plot...", 0.95)
            run_summary_forest(results, output_dir)
        return results

    def _ensure_output_dir(self) -> Path:
        import tempfile
        tmp = Path(tempfile.mkdtemp(prefix="mr_analysis_"))
        self.state.output_dir = tmp
        return tmp

    def _step1_identify_pairs(self, slots: AnalysisSlots) -> list[ExposureOutcome]:
        """Step 1: Identify E-O pairs (validation or discovery mode)."""
        if slots.mode == AnalysisMode.DISCOVERY:
            return self._discover_pairs(slots)
        # Generate pairs for all outcomes (primary + additional)
        return [
            ExposureOutcome(exposure=slots.exposure, outcome=outcome)
            for outcome in slots.all_outcomes()
        ]

    def _discover_pairs(self, slots: AnalysisSlots) -> list[ExposureOutcome]:
        """Discovery mode: mine literature for E-O pairs."""
        keyword = slots.outcome or slots.exposure
        papers = pubmed.search_papers(keyword, max_results=20)
        pairs = []
        for paper in papers:
            prompt = EXTRACT_EO_PAIRS.format(title=paper.title, abstract=paper.abstract)
            result = self.llm.chat_structured(
                prompt=prompt, schema=EO_PAIRS_SCHEMA, system=SYSTEM_MR_SCIENTIST,
                model_tier="flash",
            )
            for p in result.get("pairs", []):
                pairs.append(ExposureOutcome(
                    exposure=p.get("exposure", ""),
                    outcome=p.get("outcome", ""),
                    source_paper=paper.title,
                ))
        return pairs if pairs else [ExposureOutcome(exposure=slots.exposure, outcome=slots.outcome)]

    def _step2_check_existing(self, pairs: list[ExposureOutcome]) -> list[ExposureOutcome]:
        """Step 2: Check if MR studies already exist."""
        for pair in pairs:
            pair.mr_exists = self._check_mr_exists(pair)
        return pairs

    def _check_mr_exists(self, pair: ExposureOutcome) -> bool:
        """Check PubMed for existing MR studies."""
        papers = pubmed.search_mr_studies(pair.exposure, pair.outcome, 10)
        if not papers:
            return False
        papers_text = "\n".join(f"- {p.title} ({p.year})" for p in papers)
        prompt = MR_EXISTS_CHECK.format(
            exposure=pair.exposure, outcome=pair.outcome, papers=papers_text,
        )
        result = self.llm.chat_structured(
            prompt=prompt, schema=MR_EXISTS_SCHEMA, system=SYSTEM_MR_SCIENTIST,
        )
        pair.mr_exists = result.get("mr_exists", False)
        pair.mr_study_title = result.get("study_title")
        return pair.mr_exists

    def _report_existing_studies(self, pairs: list[ExposureOutcome]) -> None:
        """Report any existing MR studies found to user via on_progress."""
        existing = [p for p in pairs if p.mr_exists and p.mr_study_title]
        if not existing:
            return
        for p in existing:
            msg = (
                f"注意：已有MR研究：「{p.mr_study_title}」"
                f"（{p.exposure} → {p.outcome}），分析仍将继续。"
            )
            logger.info(msg)
            self.on_progress(msg, 0.10)

    def _step3_expand_synonyms(
        self, pairs: list[ExposureOutcome], slots: AnalysisSlots,
    ) -> dict[str, list[str]]:
        """Step 3: Expand medical synonyms (limit to 3 per term to avoid excessive searches)."""
        if not slots.use_synonyms:
            return {}
        all_terms = set()
        for p in pairs:
            all_terms.add(p.exposure)
            all_terms.add(p.outcome)
        syn_map = {}
        for term in all_terms:
            if not term or not term.strip():
                continue
            syns = umls.get_synonyms_umls(term)
            if not syns:
                syns = umls.get_synonyms_llm(term, self.llm)
            # 只取前3个同义词，避免产生过多 GWAS 搜索请求
            syn_map[term] = syns[:3]
        return syn_map

    def _step4_check_gwas(self, synonyms: dict[str, list[str]]) -> dict[str, list[GWASEntry]]:
        """Step 4: Check GWAS data availability (concurrent searches)."""
        gwas_map: dict[str, list[GWASEntry]] = {}
        slots = self.state.slots
        all_terms: set[str] = set()
        if slots.exposure:
            all_terms.add(slots.exposure)
        if slots.outcome:
            all_terms.add(slots.outcome)
        for term_syns in synonyms.values():
            all_terms.update(s for s in term_syns if s)

        valid_terms = [t for t in all_terms if t and t.strip()]
        logger.info(f"GWAS搜索词列表({len(valid_terms)}): {valid_terms}")
        self.on_progress(f"并发搜索 {len(valid_terms)} 个词的GWAS数据...", 0.30)

        def _search_one(term: str) -> tuple[str, list[GWASEntry]]:
            try:
                results = gwas.search_gwas_ids(term, max_pages=3)
                logger.info(f"GWAS搜索 '{term}' → {len(results)} 条")
                return term, results
            except Exception as e:
                logger.warning(f"GWAS search failed for '{term}': {e}")
                return term, []

        with ThreadPoolExecutor(max_workers=5) as pool:
            futures = {pool.submit(_search_one, t): t for t in valid_terms}
            for future in as_completed(futures):
                term, entries = future.result()
                self.on_progress(f"正在搜索 {term} 的GWAS数据...", 0.30)
                if entries:
                    gwas_map[term] = entries
                else:
                    logger.warning(f"GWAS搜索 '{term}' 返回0条结果，该词将被跳过")

        self.state.gwas_entries = gwas_map
        return gwas_map

    def _step5_select_gwas(self, gwas_map: dict[str, list[GWASEntry]]) -> dict[str, list[str]]:
        """Step 5: LLM selects best GWAS IDs."""
        selected: dict[str, list[str]] = {}
        for term, entries in gwas_map.items():
            if not entries:
                continue
            formatted = gwas.format_gwas_for_llm(entries)
            prompt = GWAS_ID_SELECT.format(trait=term, datasets=formatted)
            result = self.llm.chat_structured(
                prompt=prompt, schema=GWAS_ID_SCHEMA, system=SYSTEM_MR_SCIENTIST,
            )
            logger.info(f"GWAS ID选择 '{term}': LLM返回={result}")
            raw_ids = (
                result.get("selected_ids")
                or result.get("selected_gwas_ids")
                or []
            )
            ids = self._validate_selected_ids(raw_ids)
            logger.info(f"GWAS ID选择 '{term}': 有效IDs={ids}")
            if ids:
                selected[term] = ids
                self.on_progress(f"已选择 {term} 的GWAS: {', '.join(ids)}", 0.40)
        return selected

    def _validate_selected_ids(self, ids: list) -> list[str]:
        """Validate and sanitize selected GWAS IDs."""
        valid = []
        for gid in ids:
            try:
                valid.append(sanitize_gwas_id(str(gid)))
            except ValueError:
                logger.warning(f"Skipping invalid GWAS ID: {gid}")
        return valid

    def _merge_synonym_ids(
        self, selected: dict[str, list[str]],
        synonyms: dict[str, list[str]],
    ) -> dict[str, list[str]]:
        """Merge GWAS IDs from synonyms back to original terms."""
        merged = dict(selected)
        for original, syns in synonyms.items():
            if original not in merged:
                merged[original] = []
            for syn in syns:
                self._merge_syn_ids(merged, original, syn, selected)
        return merged

    def _merge_syn_ids(self, merged, original, syn, selected) -> None:
        """Merge IDs from a single synonym into the merged dict."""
        if syn not in selected or syn == original:
            return
        for gid in selected[syn]:
            if gid not in merged[original]:
                merged[original].append(gid)

    def _step6_generate_pairs(
        self, eo_pairs: list[ExposureOutcome], selected: dict[str, list[str]],
    ) -> list[tuple[str, str, str, str]]:
        """Step 6: Generate (exp_id, out_id, exp_name, out_name) pairs."""
        pairs = []
        seen: set[tuple[str, str]] = set()
        for eo in eo_pairs:
            exp_ids = selected.get(eo.exposure, [])
            out_ids = selected.get(eo.outcome, [])
            if not exp_ids or not out_ids:
                continue
            # Use best outcome ID; try up to 3 exposure IDs as fallback candidates.
            # All are appended — _step7 runs them in parallel and keeps valid results.
            oid = out_ids[0]
            for eid in exp_ids[:3]:
                if eid == oid:
                    continue
                key = (eid, oid)
                if key in seen:
                    continue
                seen.add(key)
                pairs.append((eid, oid, eo.exposure, eo.outcome))
        return pairs

    def _handle_no_pairs(self, selected: dict[str, list[str]]) -> None:
        """Log and record error when no valid GWAS pairs found."""
        exp = self.state.slots.exposure
        out = self.state.slots.outcome
        exp_found = exp in selected
        out_found = out in selected
        msg = f"无法找到有效的GWAS数据对。"
        if not exp_found:
            msg += f" 暴露变量'{exp}'无匹配GWAS数据。"
        if not out_found:
            msg += f" 结局变量'{out}'无匹配GWAS数据。"
        logger.error(msg)
        self.state.errors.append(msg)

    def _step7_execute_mr(
        self, pairs: list[tuple[str, str, str, str]],
        output_dir: Path, slots: AnalysisSlots,
    ) -> list[MRAnalysisResult]:
        """Step 7: Execute MR analysis for each pair.

        Pairs may include fallback IDs for the same E-O combination.
        Stop trying alternatives once a valid result (n_instruments > 0) is found.
        """
        results = []
        total = len(pairs)
        succeeded: set[tuple[str, str]] = set()  # (exp_name, out_name) already done
        for i, (eid, oid, exp_name, out_name) in enumerate(pairs):
            eo_key = (exp_name, out_name)
            if eo_key in succeeded:
                logger.info(f"跳过备选 {eid}→{oid}，同E-O对已有有效结果")
                continue
            pct = 0.55 + (0.2 * (i / max(total, 1)))
            self.on_progress(f"分析 {eid} → {oid} ({i+1}/{total})", pct)
            result = self._run_single(eid, oid, exp_name, out_name, output_dir, slots)
            if result.n_instruments > 0:
                self.on_progress(f"{eid} → {oid}: {result.n_instruments} IVs", pct)
                succeeded.add(eo_key)
            results.append(result)
        return results

    def _step8_bidirectional(
        self, results: list[MRAnalysisResult],
        pairs: list[tuple[str, str, str, str]],
        output_dir: Path, slots: AnalysisSlots,
    ) -> list[MRAnalysisResult]:
        """Step 8: Run reverse MR if bidirectional is enabled."""
        if not slots.bidirectional:
            return results
        total = len(pairs)
        for i, (eid, oid, exp_name, out_name) in enumerate(pairs):
            pct = 0.75 + (0.1 * (i / max(total, 1)))
            self.on_progress(f"反向分析 {oid} → {eid} ({i+1}/{total})", pct)
            rev = self._run_single(oid, eid, out_name, exp_name, output_dir, slots)
            results.append(rev)
        return results

    def _run_single(
        self, eid: str, oid: str, exp_name: str, out_name: str,
        output_dir: Path, slots: AnalysisSlots,
    ) -> MRAnalysisResult:
        """Run MR for a single exposure-outcome GWAS ID pair."""
        pair_dir = output_dir / f"{eid}_{oid}"
        if slots.mr_method == MRMethod.MVMR:
            logger.warning(
                "MVMR requires multiple exposures; falling back to standard MR "
                f"for single pair {eid} → {oid}"
            )
            result = run_mr_analysis(
                exposure_id=eid, outcome_id=oid,
                output_dir=pair_dir, gwas_token=slots.gwas_token or "",
            )
        elif slots.mr_method == MRMethod.MRLAP:
            result = run_mr_mrlap(
                exposure_id=eid, outcome_id=oid,
                output_dir=pair_dir, gwas_token=slots.gwas_token or "",
            )
        elif slots.mr_method == MRMethod.MOE:
            result = run_mr_moe(
                exposure_id=eid, outcome_id=oid,
                output_dir=pair_dir, gwas_token=slots.gwas_token or "",
            )
        else:
            result = run_mr_analysis(
                exposure_id=eid, outcome_id=oid,
                output_dir=pair_dir, gwas_token=slots.gwas_token or "",
            )
        result.exposure_name = exp_name
        result.outcome_name = out_name
        result.exposure_metadata = self._metadata_for_gwas_id(eid)
        result.outcome_metadata = self._metadata_for_gwas_id(oid)
        result.sample_size_exposure = result.exposure_metadata.get("sample_size")
        result.sample_size_outcome = result.outcome_metadata.get("sample_size")
        return result

    def _metadata_for_gwas_id(self, gwas_id: str) -> dict:
        for entries in self.state.gwas_entries.values():
            for entry in entries:
                if entry.gwas_id == gwas_id:
                    return entry.model_dump(mode="json")
        return {"gwas_id": gwas_id}

    def _step9_interpret(self, results: list[MRAnalysisResult]) -> list[MRAnalysisResult]:
        """Step 9: LLM interprets each result."""
        for r in results:
            if not r.mr_results:
                r.interpretation = (
                    "分析未产生有效结果，可能原因：工具变量不足或数据不可用。"
                    if self.language == "zh"
                    else "Analysis produced no valid results — insufficient instruments or data unavailable."
                )
                continue
            try:
                r.interpretation = self._interpret_single(r)
            except Exception as e:
                logger.warning(f"Interpretation failed for {r.exposure_id}→{r.outcome_id}: {e}")
                r.interpretation = (
                    "结果解读生成失败，请查看原始数据。"
                    if self.language == "zh"
                    else "Interpretation generation failed — please review the raw data."
                )
        return results

    def _interpret_single(self, r: MRAnalysisResult) -> str:
        """Get LLM interpretation of a single MR result."""
        from mr_agent.llm.prompts import LANGUAGE_INSTRUCTION
        mr_text = _format_mr_for_prompt(r)
        het_text = _format_het_for_prompt(r)
        plt_text = _format_plt_for_prompt(r)
        prompt = MR_INTERPRET.format(
            exposure=r.exposure_name, outcome=r.outcome_name,
            mr_results=mr_text or "No results",
            heterogeneity=het_text or "N/A", pleiotropy=plt_text,
            n_ivs=r.n_instruments,
            f_stat=f"{r.f_statistic_mean:.2f}" if r.f_statistic_mean else "N/A",
        )
        lang_instr = LANGUAGE_INSTRUCTION.get(self.language, "")
        if lang_instr:
            prompt += lang_instr
        if self.language == "zh":
            system = (
                SYSTEM_MR_SCIENTIST
                + "\n\n【强制语言要求】请用中文撰写解读内容，"
                "统计方法缩写（IVW、OR、CI、MR-Egger、SNP等）保留英文。"
            )
        else:
            system = (
                SYSTEM_MR_SCIENTIST
                + "\n\nLANGUAGE REQUIREMENT: Write ENTIRELY in English. No Chinese characters."
            )
        return self.llm.chat(
            messages=[{"role": "user", "content": prompt}],
            system=system, max_tokens=2000,
        )


def _format_mr_for_prompt(r: MRAnalysisResult) -> str:
    """Format MR results for the interpretation prompt."""
    lines = []
    for m in r.mr_results:
        line = f"{m.method}: beta={m.beta:.4f}, SE={m.se:.4f}, p={m.pval:.2e}"
        if m.or_value is not None:
            ci_lo = f"{m.ci_lower:.3f}" if m.ci_lower is not None else "?"
            ci_hi = f"{m.ci_upper:.3f}" if m.ci_upper is not None else "?"
            line += f", OR={m.or_value:.3f} [{ci_lo}-{ci_hi}]"
        lines.append(line)
    return "\n".join(lines)


def _format_het_for_prompt(r: MRAnalysisResult) -> str:
    """Format heterogeneity for the interpretation prompt."""
    return "\n".join(
        f"{h.method}: Q={h.q:.2f}, df={h.q_df}, p={h.q_pval:.4f}"
        for h in r.heterogeneity
    )


def _format_plt_for_prompt(r: MRAnalysisResult) -> str:
    """Format pleiotropy for the interpretation prompt."""
    if not r.pleiotropy:
        return "N/A"
    p = r.pleiotropy
    return f"Intercept={p.egger_intercept:.4f}, SE={p.se:.4f}, p={p.pval:.4f}"
