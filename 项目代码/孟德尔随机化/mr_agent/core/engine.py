# [IN] dialog/manager.py, analysis/pipeline.py, paper/generator.py, core/state.py
# [OUT] Complete conversation loop
# [POS] mr_agent/core/engine.py - Main agent engine
"""Main agent engine - the brain that ties everything together."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable

from mr_agent.analysis.pipeline import MRPipeline
from mr_agent.analysis.validators import format_validation_report, validate_result
from mr_agent.core.state import create_session, save_session
from mr_agent.dialog.manager import DialogManager, DialogResponse
from mr_agent.llm.client import LLMClient, get_llm
from mr_agent.models import SessionPhase, SessionState
from mr_agent.output.figures import (
    format_forest_summary,
    format_results_table,
    format_summary_card,
)
from mr_agent.output.report import generate_pdf_report
from mr_agent.paper.generator import PaperGenerator

logger = logging.getLogger(__name__)

MessageCallback = Callable[[str], None]


class MRAgent:
    """Main MR Analysis Agent - conversation-driven MR study automation."""

    def __init__(
        self,
        llm: LLMClient | None = None,
        language: str = "zh",
        on_message: MessageCallback | None = None,
    ):
        self.llm = llm or get_llm()
        self.language = language
        self.on_message = on_message or (lambda msg: None)
        self.state = create_session()
        self.dialog = DialogManager(self.llm, language)

    def greet(self) -> str:
        """Generate initial greeting message."""
        if self.language == "zh":
            msg = self._greet_zh()
        else:
            msg = self._greet_en()
        self.state.add_message("assistant", msg)
        return msg

    def _greet_zh(self) -> str:
        return (
            "你好！我是MR分析助手，可以帮你完成孟德尔随机化分析并生成论文。\n\n"
            "支持的数据来源：\n"
            "- OpenGWAS在线API\n"
            "- 本地GWAS汇总统计数据文件\n"
            "- eQTL数据 (eQTLGen, GTEx)\n"
            "- pQTL数据 (UKB-PPP)\n"
            "- VCF格式文件\n\n"
            "你可以告诉我：\n"
            "- 你想研究什么暴露变量和结局变量之间的因果关系\n"
            "- 例如：「我想研究BMI和冠心病的因果关系」\n"
            "- 例如：「我想用本地GWAS文件分析维生素D和糖尿病」\n\n"
            "请问你想做什么分析？"
        )

    def _greet_en(self) -> str:
        return (
            "Hello! I'm the MR Analysis Agent. I can help you perform "
            "Mendelian Randomization analysis and generate papers.\n\n"
            "Supported data sources:\n"
            "- OpenGWAS online API\n"
            "- Local GWAS summary statistics files\n"
            "- eQTL data (eQTLGen, GTEx)\n"
            "- pQTL data (UKB-PPP)\n"
            "- VCF format files\n\n"
            "Tell me:\n"
            "- What causal relationship you want to study\n"
            "- e.g., 'I want to study the causal effect of BMI on CHD'\n"
            "- e.g., 'Analyze vitamin D and diabetes using my local file'\n\n"
            "What would you like to analyze?"
        )

    def process_message(self, user_msg: str) -> str:
        """Process a user message and return response."""
        response = self.dialog.process(user_msg, self.state)
        self.state.phase = response.next_phase
        if response.should_execute:
            return self._execute_action(response)
        self.state.add_message("assistant", response.message)
        save_session(self.state)
        return response.message

    def _execute_action(self, response: DialogResponse) -> str:
        """Execute analysis, outline, revision, or paper generation."""
        metadata = response.metadata or {}
        action = metadata.get("action", "")
        if action == "generate_outline":
            return self._run_outline_generation()
        if action == "revise_outline":
            feedback = metadata.get("user_feedback", "")
            return self._run_outline_revision(feedback)
        if action == "generate_paper":
            return self._run_paper_generation()
        return self._run_analysis()

    def _run_analysis(self) -> str:
        """Execute MR analysis pipeline."""
        intermediate: list[dict] = []

        def on_progress(msg: str, pct: float, data: dict | None = None) -> None:
            self.on_message(f"[{pct:.0%}] {msg}")
            if data:
                intermediate.append(data)

        pipeline = MRPipeline(self.llm, self.state, on_progress, language=self.language)
        try:
            results = pipeline.run()
        except Exception as e:
            logger.error(f"Pipeline failed: {e}")
            return self._handle_analysis_error(e)

        return self._build_analysis_response(results, intermediate)

    def _handle_analysis_error(self, e: Exception) -> str:
        """Handle and format pipeline error."""
        error_msg = f"分析出错: {e}" if self.language == "zh" else f"Analysis error: {e}"
        self.state.errors.append(str(e))
        self.state.add_message("assistant", error_msg)
        save_session(self.state)
        return error_msg

    def _build_analysis_response(self, results, intermediate) -> str:
        """Build the complete analysis response message."""
        messages = [self._format_results_summary(results)]
        for r in results:
            report = validate_result(r)
            messages.append(format_validation_report(report, self.language))
        if len(results) >= 2:
            messages.append(format_forest_summary(results))
        if intermediate:
            intermediate_text = self._format_intermediate(intermediate)
            if intermediate_text:
                messages.append(intermediate_text)
        messages.append(self._ask_next_step())
        full_msg = "\n\n".join(messages)
        self.state.phase = SessionPhase.RESULTS
        self.state.add_message("assistant", full_msg)
        save_session(self.state)
        return full_msg

    def _format_intermediate(self, data: list[dict]) -> str:
        """Format intermediate analysis data for display."""
        lines = []
        for d in data:
            if "n_instruments" in d:
                lines.append(f"  IVs: {d['n_instruments']}")
                if d.get("f_stat_mean"):
                    lines.append(f"  Mean F: {d['f_stat_mean']:.1f}")
            if "selected_gwas" in d:
                for term, ids in d["selected_gwas"].items():
                    lines.append(f"  {term}: {', '.join(ids)}")
        if not lines:
            return ""
        header = "中间结果:" if self.language == "zh" else "Intermediate:"
        return header + "\n" + "\n".join(lines)

    def _run_outline_generation(self) -> str:
        """Generate paper outline for user confirmation."""
        generator = PaperGenerator(self.llm, self.state, language=self.language)
        try:
            outline = generator.generate_outline()
            outline_text = generator.format_outline(outline)
        except Exception as e:
            logger.error(f"Outline generation failed: {e}")
            msg = f"大纲生成出错: {e}" if self.language == "zh" else f"Outline error: {e}"
            self.state.add_message("assistant", msg)
            save_session(self.state)
            return msg
        if self.language == "zh":
            header = "以下是论文大纲，请确认是否可以开始撰写：\n\n"
            footer = "\n\n确认请回复「好的」，如需修改请直接说明。"
        else:
            header = "Here is the paper outline. Please confirm:\n\n"
            footer = "\n\nReply 'yes' to proceed, or suggest changes."
        msg = header + outline_text + footer
        self.state.phase = SessionPhase.PAPER_OUTLINE
        self.state.add_message("assistant", msg)
        save_session(self.state)
        return msg

    def _run_outline_revision(self, feedback: str) -> str:
        """Revise outline based on user feedback."""
        self.on_message("正在根据反馈修改大纲...")
        generator = PaperGenerator(self.llm, self.state, language=self.language)
        try:
            outline = generator.generate_outline(feedback=feedback)
            outline_text = generator.format_outline(outline)
        except Exception as e:
            logger.error(f"Outline revision failed: {e}")
            msg = f"大纲修改出错: {e}" if self.language == "zh" else f"Outline revision error: {e}"
            self.state.add_message("assistant", msg)
            save_session(self.state)
            return msg
        if self.language == "zh":
            header = "根据您的意见修改后的大纲如下：\n\n"
            footer = "\n\n确认请回复「好的」，如需继续修改请说明。"
        else:
            header = "Revised outline based on your feedback:\n\n"
            footer = "\n\nReply 'yes' to proceed, or suggest more changes."
        msg = header + outline_text + footer
        self.state.phase = SessionPhase.PAPER_OUTLINE
        self.state.add_message("assistant", msg)
        save_session(self.state)
        return msg

    def _run_paper_generation(self) -> str:
        """Execute paper generation."""
        def on_progress(msg: str, pct: float) -> None:
            self.on_message(f"[{pct:.0%}] {msg}")

        generator = PaperGenerator(self.llm, self.state, on_progress, language=self.language)
        try:
            paper = generator.generate()
        except Exception as e:
            logger.error(f"Paper generation failed: {e}")
            err_msg = f"论文生成出错: {e}" if self.language == "zh" else f"Paper generation error: {e}"
            self.state.add_message("assistant", err_msg)
            save_session(self.state)
            return err_msg

        txt_path = self._try_save_paper(generator)
        docx_path = self._try_save_docx(generator)
        pdf_path = self._try_pdf_report()
        msg = self._format_paper_summary(paper, txt_path, docx_path, pdf_path)
        strobe_msg = self._format_strobe_summary(generator)
        if strobe_msg:
            msg += "\n\n" + strobe_msg
        self.state.phase = SessionPhase.COMPLETED
        self.state.add_message("assistant", msg)
        save_session(self.state)
        return msg

    def _try_save_paper(self, generator: PaperGenerator) -> Path | None:
        """Attempt to save paper as text file, return None on failure."""
        try:
            return generator.save_paper()
        except Exception as e:
            logger.warning(f"Paper text save failed: {e}")
            return None

    def _try_save_docx(self, generator: PaperGenerator) -> Path | None:
        """Attempt to save paper as docx, return None on failure."""
        try:
            return generator.save_paper_docx()
        except ImportError:
            logger.info("python-docx not installed, skipping DOCX output")
            return None
        except Exception as e:
            logger.warning(f"DOCX generation failed: {e}")
            return None

    def _try_pdf_report(self) -> Path | None:
        """Attempt PDF report generation, return None on failure."""
        try:
            return generate_pdf_report(self.state)
        except Exception as e:
            logger.warning(f"PDF report failed: {e}")
            return None

    def _format_strobe_summary(self, generator: PaperGenerator) -> str:
        """Format STROBE-MR compliance summary if available."""
        report = generator.strobe_report
        if not report:
            return ""
        from mr_agent.analysis.strobe_mr import format_strobe_report
        return format_strobe_report(report, self.language)

    def _format_results_summary(self, results) -> str:
        """Format analysis results for display."""
        parts = []
        if self.language == "zh":
            parts.append("## MR分析结果\n")
        else:
            parts.append("## MR Analysis Results\n")
        for r in results:
            parts.append(format_summary_card(r, self.language))
            if r.interpretation:
                parts.append(f"\n{r.interpretation}")
        parts.append(format_results_table(results))
        return "\n\n".join(parts)

    def _ask_next_step(self) -> str:
        """Ask user what they want to do next."""
        if self.language == "zh":
            return (
                "分析完成！你可以：\n"
                "1. 让我生成完整论文\n"
                "2. 询问关于结果的任何问题\n"
                "3. 修改参数重新分析\n\n"
                "请问你想做什么？"
            )
        return (
            "Analysis complete! You can:\n"
            "1. Generate a full paper\n"
            "2. Ask questions about the results\n"
            "3. Modify parameters and re-analyze\n\n"
            "What would you like to do?"
        )

    def _format_paper_summary(self, paper, txt_path, docx_path, pdf_path) -> str:
        """Format paper generation summary."""
        if self.language == "zh":
            lines = ["论文已生成！\n"]
            lines.append(f"标题: {paper.get('title', '')}\n")
            if txt_path:
                lines.append(f"文本文件: {txt_path}")
            if docx_path:
                lines.append(f"Word文档: {docx_path}")
            if pdf_path:
                lines.append(f"PDF报告: {pdf_path}")
            lines.append("\n论文包含以下部分:")
            for section in [
                "abstract", "introduction", "methods", "results",
                "discussion", "limitations", "conclusion",
                "table1", "table2",
            ]:
                if paper.get(section):
                    length = len(paper[section])
                    lines.append(f"  - {section}: {length} 字符")
        else:
            lines = ["Paper generated!\n"]
            lines.append(f"Title: {paper.get('title', '')}\n")
            if txt_path:
                lines.append(f"Text file: {txt_path}")
            if docx_path:
                lines.append(f"Word document: {docx_path}")
            if pdf_path:
                lines.append(f"PDF report: {pdf_path}")
        return "\n".join(lines)
