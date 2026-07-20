"""
Job Store — Redis-backed persistent storage for ReviewState objects.

Falls back to in-memory dict when Redis is unavailable, so the service
can still run in a single-process environment without Redis.
"""
import json
import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

# TTL for job data in Redis: 24 hours
_JOB_TTL = int(os.getenv("JOB_STORE_TTL", "86400"))
_KEY_PREFIX = "review:job:"


class JobStore:
    """
    Async-capable job store with Redis backend and in-memory fallback.

    Usage:
        store = JobStore()
        await store.connect()          # call once at startup
        await store.set(job_id, state)
        state = await store.get(job_id)
        await store.delete(job_id)
        await store.close()            # call once at shutdown
    """

    def __init__(self) -> None:
        self._redis = None          # aioredis / redis.asyncio client
        self._memory: dict = {}     # fallback in-memory store
        self._use_redis = False

    # ── lifecycle ────────────────────────────────────────────────────────────

    async def connect(self) -> None:
        """Try to connect to Redis; silently fall back to memory on failure."""
        redis_url = os.getenv("REDIS_URL", os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0"))
        try:
            import redis.asyncio as aioredis
            client = aioredis.from_url(redis_url, decode_responses=True, socket_connect_timeout=3)
            await client.ping()
            self._redis = client
            self._use_redis = True
            logger.info(f"JobStore: connected to Redis ({redis_url})")
        except Exception as exc:
            logger.warning(
                f"JobStore: Redis unavailable ({exc}), using in-memory fallback. "
                "State will be lost on restart."
            )
            self._use_redis = False

    async def close(self) -> None:
        if self._redis:
            await self._redis.aclose()

    # ── CRUD ─────────────────────────────────────────────────────────────────

    async def set(self, job_id: str, state) -> None:
        """Persist a ReviewState (or any Pydantic model) by job_id."""
        if self._use_redis:
            try:
                payload = state.model_dump_json()
                await self._redis.set(_KEY_PREFIX + job_id, payload, ex=_JOB_TTL)
                return
            except Exception as exc:
                logger.error(f"JobStore.set Redis error: {exc}; falling back to memory")
                self._use_redis = False
        self._memory[job_id] = state

    async def get(self, job_id: str):
        """Return the ReviewState for job_id, or None if not found."""
        if self._use_redis:
            try:
                raw = await self._redis.get(_KEY_PREFIX + job_id)
                if raw is None:
                    return None
                from ..schemas.review_state import ReviewState
                return ReviewState.model_validate_json(raw)
            except Exception as exc:
                logger.error(f"JobStore.get Redis error: {exc}; falling back to memory")
                self._use_redis = False
        return self._memory.get(job_id)

    async def delete(self, job_id: str) -> None:
        if self._use_redis:
            try:
                await self._redis.delete(_KEY_PREFIX + job_id)
                return
            except Exception as exc:
                logger.error(f"JobStore.delete Redis error: {exc}")
        self._memory.pop(job_id, None)

    async def exists(self, job_id: str) -> bool:
        if self._use_redis:
            try:
                return bool(await self._redis.exists(_KEY_PREFIX + job_id))
            except Exception as exc:
                logger.error(f"JobStore.exists Redis error: {exc}")
        return job_id in self._memory

    # ── convenience: dict-like in-place mutation helpers ─────────────────────

    async def update_status(self, job_id: str, status) -> None:
        """Fetch, update status, persist. Safe for both Redis and memory."""
        state = await self.get(job_id)
        if state is None:
            return
        state.status = status
        state.update_progress()
        await self.set(job_id, state)

    async def update_failed(self, job_id: str, error_msg: str) -> None:
        from ..schemas.review_state import JobStatus
        state = await self.get(job_id)
        if state is None:
            return
        state.status = JobStatus.FAILED
        state.add_error("9001", error_msg)
        await self.set(job_id, state)

    # ── periodic maintenance ──────────────────────────────────────────────────

    def cleanup_memory(self, max_age_seconds: int = 86400) -> int:
        """Remove in-memory entries older than max_age_seconds. Returns count removed."""
        from datetime import datetime, timezone
        import time
        now = time.time()
        stale = []
        for jid, state in self._memory.items():
            try:
                ts = state.updated_at.timestamp()
                if now - ts > max_age_seconds:
                    stale.append(jid)
            except Exception:
                pass
        for jid in stale:
            del self._memory[jid]
        return len(stale)
