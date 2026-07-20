# [IN] SessionState
# [OUT] Persisted/loaded state
# [POS] mr_agent/core/state.py - Session state persistence
"""Session state management - the single source of truth."""

from __future__ import annotations

import json
import logging
import uuid
from pathlib import Path

from mr_agent.models import SessionState

logger = logging.getLogger(__name__)

STATE_DIR = Path("mr_sessions")


def create_session() -> SessionState:
    """Create a new session with unique ID."""
    session_id = str(uuid.uuid4())[:8]
    state = SessionState(session_id=session_id)
    return state


def save_session(state: SessionState) -> Path:
    """Session persistence disabled — analysis runs in-memory only."""
    return STATE_DIR / f"{state.session_id}.json"


def load_session(session_id: str) -> SessionState | None:
    """Load session state from disk."""
    filepath = STATE_DIR / f"{session_id}.json"
    if not filepath.exists():
        logger.warning(f"Session not found: {session_id}")
        return None
    try:
        data = json.loads(filepath.read_text(encoding="utf-8"))
        return SessionState(**data)
    except Exception as e:
        logger.error(f"Failed to load session {session_id}: {e}")
        return None


def list_sessions() -> list[dict]:
    """List all saved sessions."""
    if not STATE_DIR.exists():
        return []
    sessions = []
    for f in STATE_DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text())
            sessions.append({
                "id": data.get("session_id", f.stem),
                "exposure": data.get("slots", {}).get("exposure") or "",
                "outcome": data.get("slots", {}).get("outcome") or "",
                "phase": data.get("phase", ""),
                "created": data.get("created_at", ""),
            })
        except json.JSONDecodeError:
            continue
    return sessions
