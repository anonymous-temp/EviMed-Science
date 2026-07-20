"""OSS report upload (same contract as the other EviMed Python agents).

Uploads the report markdown to Aliyun OSS via oss2 and returns the public
URL. Failures degrade to None (the caller then falls back to a base64 data
URL) — every failure is logged, never swallowed. oss2 is imported lazily
so the package loads without the dependency in test environments.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import time

from safety_agent.core.config import Settings
from safety_agent.core.logging import get_logger

logger = get_logger(__name__)


def _object_key_component(value: str) -> str:
    original = str(value).strip()
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", original).strip("._-")
    if not cleaned:
        cleaned = "unknown"
    cleaned = cleaned[:96]
    if cleaned != original:
        cleaned = f"{cleaned}-{hashlib.sha256(original.encode('utf-8')).hexdigest()[:12]}"
    return cleaned


async def upload_markdown(
    content: str,
    settings: Settings,
    *,
    user_id: str,
    message_id: str,
    agent_type: str,
) -> str | None:
    """Upload report markdown; returns the public URL or None on failure."""
    key_id = settings.oss_access_key_id.get_secret_value()
    key_secret = settings.oss_access_key_secret.get_secret_value()
    if not key_id or not key_secret or not settings.oss_bucket_name:
        logger.warning("OSS credentials not configured; skipping upload")
        return None
    remote_path = "/".join(
        (
            _object_key_component(agent_type),
            _object_key_component(user_id),
            _object_key_component(message_id),
            f"{int(time.time() * 1000)}.md",
        )
    )
    data = content.encode("utf-8")

    def _upload_sync() -> None:
        import oss2

        auth = oss2.Auth(key_id, key_secret)
        bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket_name)
        for attempt in range(3):
            try:
                bucket.put_object(remote_path, data)
                logger.info("OSS upload succeeded (attempt %d): %s", attempt + 1, remote_path)
                return
            except Exception as exc:  # oss2 raises broad exception types
                logger.warning("OSS upload failed (attempt %d): %s", attempt + 1, exc)
                if attempt < 2:
                    time.sleep(2**attempt)
                else:
                    raise

    try:
        await asyncio.get_running_loop().run_in_executor(None, _upload_sync)
    except Exception as exc:
        logger.error("OSS upload failed permanently, degrading to base64: %s", exc)
        return None
    base = settings.oss_public_base_url.rstrip("/")
    return f"{base}/{remote_path}" if base else None
