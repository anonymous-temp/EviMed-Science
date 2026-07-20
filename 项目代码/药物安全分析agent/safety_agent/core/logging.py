"""Logging setup: one named logger tree, configured once.

Modules use ``logging.getLogger(__name__)``; call ``configure_logging()``
at process start (CLI, tests, or the future FastAPI entry point).
"""

from __future__ import annotations

import logging

_CONFIGURED = False


def configure_logging(level: str = "INFO") -> None:
    """Install a single stderr handler on the ``safety_agent`` logger tree.

    Idempotent: repeated calls only update the level, never add handlers.
    """
    global _CONFIGURED
    root = logging.getLogger("safety_agent")
    if not _CONFIGURED:
        handler = logging.StreamHandler()
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
        )
        root.addHandler(handler)
        root.propagate = False
        _CONFIGURED = True
    root.setLevel(level.upper())


def get_logger(name: str) -> logging.Logger:
    """Return a logger under the ``safety_agent`` namespace."""
    if name == "safety_agent" or name.startswith("safety_agent."):
        return logging.getLogger(name)
    return logging.getLogger(f"safety_agent.{name}")
