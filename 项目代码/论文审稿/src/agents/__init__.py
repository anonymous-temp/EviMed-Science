"""
Agent implementations for the Medical SCI Paper Review System

Plan-Retrieve-Argue Architecture:
- ReviewPlannerAgent: Strategic review planning
- MaterialEngineAgent: Neutral evidence gathering
- EditorSynthesizerAgent: Evidence-gated report synthesis
"""
from .document_analyzer import DocumentAnalyzerAgent
from .integrity_guard import IntegrityEthicsGuard
from .rubric_orchestrator import RubricOrchestrator
from .methodology_reviewer import MethodologyReviewerAgent, MaterialEngineAgent
from .statistician_reviewer import StatisticianReviewerAgent
from .cognitive_reviewer import CognitiveReviewerAgent
from .editor_synthesizer import EditorSynthesizerAgent
from .review_planner import ReviewPlannerAgent

__all__ = [
    # Core agents
    "DocumentAnalyzerAgent",
    "IntegrityEthicsGuard",
    "RubricOrchestrator",
    "MethodologyReviewerAgent",
    "StatisticianReviewerAgent",
    "CognitiveReviewerAgent",
    "EditorSynthesizerAgent",
    # Plan-Retrieve-Argue agents
    "ReviewPlannerAgent",
    "MaterialEngineAgent",
]
