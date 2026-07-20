# [IN] intent.py, slots.py, models.py
# [OUT] Dialog responses, state transitions
# [POS] mr_agent/dialog/manager.py - Dialog flow control
"""Dialog manager - controls conversation flow and state transitions."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from mr_agent.dialog.intent import is_affirmative, is_negative, recognize_intent
from mr_agent.dialog.slots import (
    format_confirmation,
    get_clarification,
    update_slots_from_intent,
)
from mr_agent.llm.client import LLMClient
from mr_agent.llm.prompts import SYSTEM_DIALOG
from mr_agent.models import Intent, SessionPhase, SessionState
from mr_agent.output.figures import format_summary_card

logger = logging.getLogger(__name__)

# Paper intent: requires a "topic" word AND an "action" word to avoid false positives
_PAPER_NOUNS = {"论文", "paper", "manuscript", "稿"}
_PAPER_VERBS = {"生成", "generate", "write", "撰写", "写", "帮我"}
# These short phrases are unambiguous on their own
_PAPER_EXACT = {"生成论文", "写论文", "generate paper", "write paper", "撰写论文"}


def _is_paper_intent(msg: str) -> bool:
    """Check if message clearly requests paper generation."""
    m = msg.strip().lower()
    # Exact short phrases
    if m in _PAPER_EXACT:
        return True
    # Must contain both a noun and a verb to match
    has_noun = any(kw in m for kw in _PAPER_NOUNS)
    has_verb = any(kw in m for kw in _PAPER_VERBS)
    return has_noun and has_verb


@dataclass
class DialogResponse:
    message: str
    next_phase: SessionPhase
    should_execute: bool = False
    metadata: dict | None = None


class DialogManager:
    """Manages conversation flow and phase transitions."""

    def __init__(self, llm: LLMClient, language: str = "zh"):
        self.llm = llm
        self.language = language
        self._handlers = {
            SessionPhase.GREETING: self._handle_intent,
            SessionPhase.INTENT_RECOGNITION: self._handle_intent,
            SessionPhase.CLARIFICATION: self._handle_clarification,
            SessionPhase.DATA_CONFIGURATION: self._handle_data_config,
            SessionPhase.RESULTS: self._handle_results_qa,
            SessionPhase.QA: self._handle_results_qa,
            SessionPhase.PAPER_OUTLINE: self._handle_outline,
            SessionPhase.PAPER_GENERATION: self._handle_results_qa,
            SessionPhase.COMPLETED: self._handle_results_qa,
        }

    def process(self, user_msg: str, state: SessionState) -> DialogResponse:
        """Process user message based on current phase."""
        state.add_message("user", user_msg)
        handler = self._handlers.get(state.phase, self._handle_intent)
        return handler(user_msg, state)

    def _handle_intent(self, msg: str, state: SessionState) -> DialogResponse:
        intent_data = recognize_intent(msg, self.llm)
        return self._route_intent(msg, intent_data, state)

    def _route_intent(
        self, msg: str, intent_data: dict, state: SessionState,
    ) -> DialogResponse:
        try:
            intent = Intent(intent_data.get("intent", "unknown"))
        except ValueError:
            intent = Intent.UNKNOWN
        state.slots = update_slots_from_intent(state.slots, intent_data)
        if intent == Intent.MR_ANALYSIS:
            return self._check_slots_and_confirm(state)
        if intent == Intent.GENERATE_PAPER:
            return self._handle_paper_intent(state)
        if intent == Intent.EXPLAIN_RESULTS:
            return self._handle_explain_intent(state)
        if intent == Intent.MODIFY_ANALYSIS:
            return self._handle_modify(msg, state)
        return self._answer_question(msg, state)

    def _check_slots_and_confirm(self, state: SessionState) -> DialogResponse:
        question = get_clarification(state.slots, self.llm, self.language)
        if question:
            return DialogResponse(
                message=question,
                next_phase=SessionPhase.CLARIFICATION,
            )
        confirm_msg = format_confirmation(state.slots, self.language)
        return DialogResponse(
            message=confirm_msg,
            next_phase=SessionPhase.CLARIFICATION,
            metadata={"awaiting_confirmation": True},
        )

    def _handle_clarification(self, msg: str, state: SessionState) -> DialogResponse:
        if is_affirmative(msg) and state.slots.is_complete():
            return DialogResponse(
                message=self._start_msg(),
                next_phase=SessionPhase.DATA_RETRIEVAL,
                should_execute=True,
            )
        if is_negative(msg):
            return DialogResponse(
                message=self._cancel_msg(),
                next_phase=SessionPhase.INTENT_RECOGNITION,
            )
        intent_data = recognize_intent(msg, self.llm)
        state.slots = update_slots_from_intent(state.slots, intent_data)
        return self._check_slots_and_confirm(state)

    def _handle_data_config(self, msg: str, state: SessionState) -> DialogResponse:
        """Handle data source configuration messages."""
        intent_data = recognize_intent(msg, self.llm)
        state.slots = update_slots_from_intent(state.slots, intent_data)
        if state.slots.has_local_sources():
            return self._check_slots_and_confirm(state)
        prompt_msg = (
            "请上传本地数据文件或指定数据来源。" if self.language == "zh"
            else "Please upload local data files or specify data sources."
        )
        return DialogResponse(
            message=prompt_msg,
            next_phase=SessionPhase.DATA_CONFIGURATION,
        )

    def _handle_results_qa(self, msg: str, state: SessionState) -> DialogResponse:
        # P0-3: Fast keyword match for paper generation intent
        if _is_paper_intent(msg):
            return self._handle_paper_intent(state)
        intent_data = recognize_intent(msg, self.llm)
        try:
            intent = Intent(intent_data.get("intent", "unknown"))
        except ValueError:
            intent = Intent.UNKNOWN
        if intent == Intent.GENERATE_PAPER:
            return self._handle_paper_intent(state)
        if intent == Intent.MR_ANALYSIS:
            return self._route_intent(msg, intent_data, state)
        if intent == Intent.MODIFY_ANALYSIS:
            state.slots = update_slots_from_intent(state.slots, intent_data)
            return self._check_slots_and_confirm(state)
        return self._answer_question(msg, state)

    def _handle_paper_intent(self, state: SessionState) -> DialogResponse:
        results = state.analysis_results
        has_valid = results and any(r.n_instruments > 0 for r in results)
        if not has_valid:
            msg = (
                "尚未完成分析，请先执行MR分析。" if self.language == "zh"
                else "No analysis results yet. Please run MR analysis first."
            )
            return DialogResponse(message=msg, next_phase=state.phase)
        return DialogResponse(
            message=self._outline_msg(),
            next_phase=SessionPhase.PAPER_OUTLINE,
            should_execute=True,
            metadata={"action": "generate_outline"},
        )

    def _handle_outline(self, msg: str, state: SessionState) -> DialogResponse:
        """Handle user response to paper outline."""
        stripped = msg.strip()
        is_short_affirmative = is_affirmative(stripped) and len(stripped) <= 10
        if is_short_affirmative:
            return DialogResponse(
                message=self._writing_msg(),
                next_phase=SessionPhase.PAPER_GENERATION,
                should_execute=True,
                metadata={"action": "generate_paper"},
            )
        if is_negative(stripped) and len(stripped) <= 10:
            return DialogResponse(
                message=self._outline_cancel_msg(),
                next_phase=SessionPhase.QA,
            )
        return DialogResponse(
            message=self._outline_revise_msg(),
            next_phase=SessionPhase.PAPER_OUTLINE,
            should_execute=True,
            metadata={"action": "revise_outline", "user_feedback": msg},
        )

    def _handle_modify(self, msg: str, state: SessionState) -> DialogResponse:
        """Handle modify_analysis intent - re-enter clarification."""
        return self._check_slots_and_confirm(state)

    def _handle_explain_intent(self, state: SessionState) -> DialogResponse:
        results = state.analysis_results
        has_valid = results and any(r.n_instruments > 0 for r in results)
        if not has_valid:
            msg = (
                "尚无分析结果可解释。" if self.language == "zh"
                else "No results to explain yet."
            )
            return DialogResponse(message=msg, next_phase=state.phase)
        explanation = self._generate_explanation(state)
        return DialogResponse(
            message=explanation, next_phase=SessionPhase.QA,
        )

    def _generate_explanation(self, state: SessionState) -> str:
        """Generate a natural language explanation of all results."""
        parts = []
        for r in state.analysis_results:
            parts.append(format_summary_card(r, self.language))
            if r.interpretation:
                parts.append(r.interpretation)
        context = "\n\n".join(parts)
        prompt = f"Explain these MR results clearly:\n\n{context}"
        messages = self._build_chat_messages(state)
        messages.append({"role": "user", "content": prompt})
        return self.llm.chat(
            messages=messages,
            system=SYSTEM_DIALOG, max_tokens=2000,
        )

    def _answer_question(self, msg: str, state: SessionState) -> DialogResponse:
        context = self._build_context(state)
        prompt = f"Context:\n{context}\n\nUser question: {msg}"
        messages = self._build_chat_messages(state)
        messages.append({"role": "user", "content": prompt})
        answer = self.llm.chat(
            messages=messages,
            system=SYSTEM_DIALOG, max_tokens=1000,
        )
        return DialogResponse(message=answer, next_phase=state.phase)

    def _build_chat_messages(
        self, state: SessionState, max_turns: int = 10,
    ) -> list[dict[str, str]]:
        """Extract recent conversation history as LLM messages."""
        history = state.conversation_history
        recent = history[-(max_turns * 2):] if len(history) > max_turns * 2 else history
        return [
            {"role": h["role"], "content": h["content"]}
            for h in recent
            if h.get("role") in ("user", "assistant") and h.get("content")
        ]

    def _build_context(self, state: SessionState) -> str:
        parts = []
        if state.slots.exposure:
            parts.append(f"Exposure: {state.slots.exposure}")
        if state.slots.outcome:
            parts.append(f"Outcome: {state.slots.outcome}")
        if state.analysis_results:
            parts.append(
                f"Analysis completed: {len(state.analysis_results)} results",
            )
            for r in state.analysis_results[:3]:
                parts.append(format_summary_card(r, "en"))
                if r.interpretation:
                    parts.append(r.interpretation[:500])
        return "\n".join(parts) if parts else "No analysis context yet."

    def _start_msg(self) -> str:
        if self.language == "zh":
            return "参数确认完毕，开始执行MR分析..."
        return "Parameters confirmed. Starting MR analysis..."

    def _cancel_msg(self) -> str:
        if self.language == "zh":
            return "已取消。请告诉我您想做什么分析？"
        return "Cancelled. What analysis would you like to perform?"

    def _outline_msg(self) -> str:
        if self.language == "zh":
            return "好的，正在生成论文大纲供您确认..."
        return "Generating paper outline for your review..."

    def _writing_msg(self) -> str:
        if self.language == "zh":
            return "大纲确认完毕，开始撰写论文..."
        return "Outline confirmed. Starting paper writing..."

    def _outline_cancel_msg(self) -> str:
        if self.language == "zh":
            return "已取消论文生成。你还可以继续提问或修改分析。"
        return "Paper generation cancelled. You can still ask questions."

    def _outline_revise_msg(self) -> str:
        if self.language == "zh":
            return "好的，我会根据您的意见修改大纲。请稍等..."
        return "I'll revise the outline based on your feedback..."
