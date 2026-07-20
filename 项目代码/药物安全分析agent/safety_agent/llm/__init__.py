"""DeepSeek LLM client (interpretation only, never statistics)."""

from .client import DeepSeekClient
from .fallbacks import DeepSeekNameTranslator, contains_cjk

__all__ = ["DeepSeekClient", "DeepSeekNameTranslator", "contains_cjk"]
