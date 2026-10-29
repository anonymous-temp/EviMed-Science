"""The media store (contract 1.5.0): the images social posts carry, kept so the reader never hot-links a platform.

An image is fetched once, through the protected fetch (X's ``pbs.twimg.com`` through the Tokyo relay when this deployment
has one — Beijing does not reach it —, everything else direct), **re-encoded** and stored under its own sha256:

- Re-encoding is the only way an upstream file becomes a stored one. It proves the bytes are an image (a decoder read
  them), drops every metadata block (a photo's EXIF can carry where it was taken), turns the first frame of an animation
  into a still, bounds the size (longest side 2,048 px, at most 1.5 MB: lower JPEG quality, then smaller, until it fits)
  and refuses decompression bombs (over 40 megapixels). What a decoder cannot read, or what cannot be made to fit, is
  recorded in ``media_failures`` and not fetched again for a day; the entry is delivered without it.
- The id is the sha256 of the stored bytes, so the same image reached by two addresses is one file, and the platform's
  proxy can cache it by its id for ever.
- The files live under ``KNOWLEDGE_PLUGIN_MEDIA_DIR`` (a volume: the plugin's root filesystem is read-only), named
  ``<id[0:2]>/<id>``, written to a temporary name and renamed, so a reader never sees half a file. Unset, there is no
  store: posts are delivered without media.
- The store has a cap (``KNOWLEDGE_PLUGIN_MEDIA_CAP_MB``, 3 GB). Past it the least recently served files go first
  (an image never served counts from when it was stored). Eviction removes the file and keeps the row, so an entry that
  names the image keeps naming it — with its original address — and ``/v1/media/{id}`` answers 404 for it.
"""

from __future__ import annotations

import hashlib
import io
import logging
import os
import re
import warnings
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

from ..model import MEDIA_ALT_MAX, URL_MAX, FetchError, RequestSpec

log = logging.getLogger("knowledge_plugin.social.media")

MAX_BYTES = 1_572_864            # 1.5 MiB after the re-encode (contract 1.5.0)
MAX_SIDE = 2048
MAX_PIXELS = 40_000_000
FAILURE_RETRY = timedelta(days=1)
EVICT_BATCH = 200
RELAY_HOSTS = ("pbs.twimg.com", "video.twimg.com", "abs.twimg.com")
_ID = re.compile(r"^[a-f0-9]{64}$")
_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "GIF": "image/gif"}


class MediaRefused(ValueError):
    """The bytes are not an image this store keeps; ``reason`` is a short code."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def reencode(data: bytes) -> tuple[bytes, str, int, int]:
    """``(bytes, content type, width, height)`` of the stored form of an upstream image (module docstring)."""
    from PIL import Image, ImageOps

    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            probe = Image.open(io.BytesIO(data))
            if probe.format not in _FORMATS:
                raise MediaRefused("unsupported_format")
            if probe.width * probe.height > MAX_PIXELS:
                raise MediaRefused("too_many_pixels")
            probe.verify()
            image = Image.open(io.BytesIO(data))
            image.seek(0)
            image.load()
        except MediaRefused:
            raise
        except (Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise MediaRefused("too_many_pixels") from None
        except Exception:
            raise MediaRefused("not_an_image") from None
    source_format = image.format
    image = ImageOps.exif_transpose(image)
    alpha = image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info)
    image.thumbnail((MAX_SIDE, MAX_SIDE))
    if alpha and source_format in ("PNG", "WEBP", "GIF"):
        rgba = image.convert("RGBA")
        out = io.BytesIO()
        rgba.save(out, format="PNG", optimize=True)
        if out.tell() <= MAX_BYTES:
            return out.getvalue(), "image/png", rgba.width, rgba.height
        flat = Image.new("RGB", rgba.size, (255, 255, 255))
        flat.paste(rgba, mask=rgba.getchannel("A"))
        image = flat
    rgb = image.convert("RGB")
    for _ in range(6):
        for quality in (85, 75, 65, 50):
            out = io.BytesIO()
            rgb.save(out, format="JPEG", quality=quality, optimize=True, progressive=True)
            if out.tell() <= MAX_BYTES:
                return out.getvalue(), "image/jpeg", rgb.width, rgb.height
        if min(rgb.size) < 64:
            break
        rgb = rgb.resize((max(1, int(rgb.width * 0.75)), max(1, int(rgb.height * 0.75))))
    raise MediaRefused("too_large_after_reencode")


def media_egress(url: str, relay_configured: bool) -> str:
    """X's image hosts go through the Tokyo relay when the deployment has one; everything else, and they without one, direct."""
    host = (urlsplit(url).hostname or "").lower()
    return "relay" if relay_configured and host in RELAY_HOSTS else "direct"


class MediaStore:
    def __init__(self, settings, pool, *, fetcher=None, clock) -> None:
        self._settings = settings
        self._pool = pool
        self._fetcher = fetcher
        self._clock = clock
        self.counters = {"stored": 0, "reused": 0, "refused": 0, "failed": 0, "evicted": 0}

    @property
    def configured(self) -> bool:
        return bool(self._settings.media_dir)

    def _path(self, media_id: str) -> Path:
        return Path(self._settings.media_dir) / media_id[:2] / media_id

    async def ensure(self, url: str, *, kind: str = "image", alt: str | None = None,
                     width: int | None = None, height: int | None = None) -> dict | None:
        """The contract media item for an upstream image, storing it first when it is new; ``None`` when there is no store,
        the address is unusable, or the image could not be stored (the entry is then delivered without it)."""
        if not self.configured or self._fetcher is None:
            return None
        url = (url or "").strip()
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname or len(url) > URL_MAX:
            return None
        now = self._clock()
        async with self._pool.connection() as conn:
            known = await (await conn.execute(
                """SELECT id, width, height FROM evimed_knowledge.media WHERE original_url = %s
                    ORDER BY stored_at DESC LIMIT 1""", (url,))).fetchone()
            if known:
                self.counters["reused"] += 1
                return _item(known["id"], kind, known["width"], known["height"], alt, url)
            failed = await (await conn.execute(
                "SELECT failed_at FROM evimed_knowledge.media_failures WHERE original_url = %s", (url,))).fetchone()
        if failed and now - failed["failed_at"] < FAILURE_RETRY:
            return None
        egress = media_egress(url, self._fetcher.egress_configured("relay"))
        try:
            result = await self._fetcher.fetch(RequestSpec(url=url, conditional=False, api=True,
                                                           headers={"Accept": "image/avif,image/webp,image/*;q=0.9"}),
                                               source_id="media", egress=egress, allowed_hosts=[parts.hostname])
            content, content_type, stored_width, stored_height = reencode(result.body)
        except MediaRefused as error:
            self.counters["refused"] += 1
            await self._failed(url, error.reason, now)
            return None
        except FetchError as error:
            self.counters["failed"] += 1
            await self._failed(url, f"{error.outcome}:{error.detail}", now)
            return None
        media_id = hashlib.sha256(content).hexdigest()
        await self._write(media_id, content)
        async with self._pool.connection() as conn:
            await conn.execute(
                """INSERT INTO evimed_knowledge.media (id, content_type, bytes, width, height, original_url, stored_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (id) DO UPDATE SET evicted_at = NULL, stored_at = EXCLUDED.stored_at""",
                (media_id, content_type, len(content), stored_width, stored_height, url, now))
            await conn.execute("DELETE FROM evimed_knowledge.media_failures WHERE original_url = %s", (url,))
        self.counters["stored"] += 1
        return _item(media_id, kind, stored_width, stored_height, alt, url)

    async def _failed(self, url: str, reason: str, now: datetime) -> None:
        async with self._pool.connection() as conn:
            await conn.execute(
                """INSERT INTO evimed_knowledge.media_failures (original_url, failed_at, reason) VALUES (%s, %s, %s)
                   ON CONFLICT (original_url) DO UPDATE SET failed_at = EXCLUDED.failed_at, reason = EXCLUDED.reason""",
                (url, now, reason[:200]))

    async def _write(self, media_id: str, content: bytes) -> None:
        path = self._path(media_id)
        if path.exists() and path.stat().st_size == len(content):
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{media_id}.{os.getpid()}.tmp")
        temporary.write_bytes(content)
        os.replace(temporary, path)

    async def read(self, media_id: str) -> tuple[bytes, str] | None:
        """A stored image's bytes and content type, or ``None`` (unknown, evicted, or no store); marks it served."""
        if not self.configured or not _ID.match(media_id or ""):
            return None
        async with self._pool.connection() as conn:
            row = await (await conn.execute(
                """UPDATE evimed_knowledge.media SET last_served_at = %s WHERE id = %s AND evicted_at IS NULL
                   RETURNING content_type, bytes""", (self._clock(), media_id))).fetchone()
        if row is None:
            return None
        try:
            content = self._path(media_id).read_bytes()
        except OSError:
            return None
        return (content, row["content_type"]) if len(content) == row["bytes"] else None

    async def evict(self) -> int:
        """Remove the least recently served files until the store is under its cap; returns how many went."""
        if not self.configured:
            return 0
        cap = self._settings.media_cap_mb * 1024 * 1024
        evicted = 0
        async with self._pool.connection() as conn:
            total = int((await (await conn.execute(
                "SELECT coalesce(sum(bytes), 0) AS n FROM evimed_knowledge.media WHERE evicted_at IS NULL")).fetchone())["n"])
            while total > cap:
                rows = await (await conn.execute(
                    """SELECT id, bytes FROM evimed_knowledge.media WHERE evicted_at IS NULL
                        ORDER BY coalesce(last_served_at, stored_at), id LIMIT %s""", (EVICT_BATCH,))).fetchall()
                if not rows:
                    break
                gone: list[str] = []
                for row in rows:
                    if total <= cap:
                        break
                    try:
                        self._path(row["id"]).unlink(missing_ok=True)
                    except OSError as error:
                        log.warning("could not remove media file %s: %s", row["id"][:12], type(error).__name__)
                        continue
                    gone.append(row["id"])
                    total -= int(row["bytes"])
                if not gone:
                    break
                await conn.execute("UPDATE evimed_knowledge.media SET evicted_at = %s WHERE id = ANY(%s)",
                                   (self._clock(), gone))
                evicted += len(gone)
        self.counters["evicted"] += evicted
        if evicted:
            log.info("media store over its cap: %s files evicted", evicted)
        return evicted


def _item(media_id: str, kind: str, width, height, alt, url: str) -> dict:
    item: dict = {"id": media_id, "kind": kind if kind in ("image", "video-poster") else "image"}
    if isinstance(width, int) and width > 0:
        item["width"] = width
    if isinstance(height, int) and height > 0:
        item["height"] = height
    if alt and alt.strip():
        item["alt"] = alt.strip()[:MEDIA_ALT_MAX]
    item["original_url"] = url
    return item
