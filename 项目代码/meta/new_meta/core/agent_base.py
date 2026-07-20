"""Base agent class for all MetaAgent agents."""
from __future__ import annotations

import logging
from pydantic import BaseModel

from new_meta.core.llm import LLMClient


class BaseAgent:
    """Base class providing LLM access and logging for all agents."""

    def __init__(self, name: str, system_prompt: str, model: str = None):
        self.name = name
        self.system_prompt = system_prompt
        self.llm = LLMClient(model=model)
        self.logger = logging.getLogger(f"metaagent.{name}")

    def run(self, **kwargs):
        raise NotImplementedError

    def call_llm(self, query: str, temperature: float = None, max_tokens: int = None) -> str:
        """Call LLM with system prompt + user query."""
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": query},
        ]
        result = self.llm.chat(messages, temperature=temperature, max_tokens=max_tokens)
        return result or ""

    def call_llm_structured(
        self, query: str, schema: type[BaseModel], temperature: float = None, max_tokens: int = None
    ) -> BaseModel:
        """Call LLM and parse response into a Pydantic model."""
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": query},
        ]
        return self.llm.structured_output(messages, schema, temperature=temperature, max_tokens=max_tokens)

    def call_llm_with_context(
        self, messages: list[dict], temperature: float = None, max_tokens: int = None
    ) -> str:
        """Call LLM with full message history (for multi-turn)."""
        full = [{"role": "system", "content": self.system_prompt}] + messages
        return self.llm.chat(full, temperature=temperature, max_tokens=max_tokens)

    def call_llm_vision(
        self, query: str, images: list[str], temperature: float = None, max_tokens: int = None
    ) -> str:
        """Call LLM with images for vision tasks."""
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": query},
        ]
        return self.llm.vision(messages, images, temperature=temperature, max_tokens=max_tokens)

    def log(self, message: str, level: str = "info"):
        getattr(self.logger, level)(f"[{self.name}] {message}")
