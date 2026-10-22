"""Fakes of the social tests (contract 1.5.0): the protected fetch answering from a table, and a real image.

Every provider is faked: no test reaches SocialData, Dajiala or the GEO crawler, and no key file holds a real key.
"""

from __future__ import annotations

import io
import json
from datetime import datetime, timezone


from knowledge_plugin.model import FetchError, FetchResult


def png_bytes(size=(64, 48), color=(200, 30, 30), *, mode="RGB", exif=False) -> bytes:
    from PIL import Image

    image = Image.new(mode, size, color if mode == "RGB" else (*color, 128))
    out = io.BytesIO()
    if exif:
        tags = Image.Exif()
        tags[0x010F] = "PhoneMaker"            # Make
        tags[0x0110] = "Model X"               # Model
        image.convert("RGB").save(out, format="JPEG", exif=tags.tobytes())
    else:
        image.save(out, format="PNG")
    return out.getvalue()


class FakeFetcher:
    """The protected fetch, answering from a table: ``routes[(method, url-prefix)] = callable(spec) -> (status, body)``.
    Records every call (method, url, egress, headers, body)."""

    def __init__(self, routes=None, *, relay=False) -> None:
        self.routes = routes or {}
        self.calls: list[dict] = []
        self.relay = relay

    def egress_configured(self, egress: str) -> bool:
        return egress != "relay" or self.relay

    async def fetch(self, spec, *, source_id=None, egress="direct", allowed_hosts=None, **_):
        self.calls.append({"method": spec.method, "url": spec.url, "egress": egress, "headers": dict(spec.headers),
                           "body": spec.body, "source_id": source_id})
        for (method, prefix), answer in self.routes.items():
            if spec.method.upper() == method and spec.url.startswith(prefix):
                status, body, *rest = answer(spec)
                headers = rest[0] if rest else {"content-type": "application/json"}
                if status == 429:
                    raise FetchError("http-error", "rate_limited_429", status=429, retry_after_s=60)
                if status in (401, 403):
                    raise FetchError("blocked", f"http_{status}", status=status)
                if status >= 400 and not (spec.api and status == 404 and body):
                    raise FetchError("http-error", f"http_{status}", status=status)
                if isinstance(body, (dict, list)):
                    body = json.dumps(body).encode("utf-8")
                return FetchResult(request=spec, final_url=spec.url, status=status, headers=headers, body=body,
                                   fetched_at=datetime.now(timezone.utc))
        raise FetchError("http-error", "connect_failed")

    def count(self, prefix: str) -> int:
        return sum(1 for call in self.calls if call["url"].startswith(prefix))




# ------------------------------------------------------------------------------------ the contract, for schema checks

def contract_validator():
    """``assert_schema(body, name)`` against the plugin's own contract copy (as ``tests/test_api_contract.py`` does)."""
    from pathlib import Path

    import yaml
    from jsonschema import Draft202012Validator, FormatChecker
    from referencing import Registry, Resource
    from referencing.jsonschema import DRAFT202012

    spec = yaml.safe_load((Path(__file__).resolve().parents[2] / "contract" / "knowledge-plugin-openapi.yaml").read_text())
    formats = FormatChecker(formats=())

    @formats.checks("date-time", raises=ValueError)
    def _date_time(value) -> bool:
        if isinstance(value, str) and datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is None:
            raise ValueError("date-time without an offset")
        return True

    @formats.checks("uri", raises=ValueError)
    def _uri(value) -> bool:
        if isinstance(value, str) and not value.startswith(("http://", "https://")):
            raise ValueError("not an absolute http(s) URI")
        return True

    registry = Registry().with_resource("urn:contract", Resource.from_contents(spec, default_specification=DRAFT202012))

    def assert_schema(body, name: str) -> None:
        validator = Draft202012Validator({"$ref": f"urn:contract#/components/schemas/{name}"}, registry=registry,
                                         format_checker=formats)
        errors = sorted(validator.iter_errors(body), key=lambda e: list(e.path))
        assert not errors, "; ".join(f"{list(e.path)}: {e.message}" for e in errors[:5])

    return spec, assert_schema
