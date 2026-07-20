# [POS] mr_agent/__init__.py - Package root
"""MR Analysis Agent - Conversational Mendelian Randomization Analysis."""

from mr_agent.core.engine import MRAgent
from mr_agent.llm.client import LLMClient, get_llm

__version__ = "1.0.0"
__all__ = ["MRAgent", "LLMClient", "get_llm"]
