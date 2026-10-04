"""The recorded wire: responses captured from the live APIs, and the gateway's view of the ones that failed.

`wire/manifest.json` lists every file with the request it answers, its status, the
time it was recorded and its origin: `live` (recorded from the provider's API, the
only kind written before a test is) or `constructed` (written from the provider's
documentation, marked so and never presented as recorded). `wire/record.py`
re-records the live ones, through the gateway when run from a deployment, so the
controller can refresh them against the production wire.

A test that serves a recorded answer checks it answers the request it was recorded
for (`same_ids`), so a fixture cannot quietly stand in for a different question.
"""

from __future__ import annotations

import io
import json
import pathlib
import urllib.error
import urllib.parse
from email.message import Message

DIRECTORY = pathlib.Path(__file__).resolve().parent / "wire"


def manifest():
    return json.loads((DIRECTORY / "manifest.json").read_text(encoding="utf-8"))


def entry(name):
    for record in manifest()["files"]:
        if record["file"] == name:
            return record
    raise KeyError("%s is not in wire/manifest.json" % name)


def body(name):
    return (DIRECTORY / name).read_bytes()


def json_body(name):
    return json.loads(body(name).decode("utf-8"))


def recorded_query(name):
    """The query parameters of the request a file was recorded for."""
    request = entry(name)["request"].split(" ", 1)[1]
    return urllib.parse.parse_qs(urllib.parse.urlsplit(request).query)


def same_ids(name, key, asked, *, fold=False):
    """Whether the ids asked are the ids the recording answers (as a set)."""
    recorded = recorded_query(name)[key][0].split(",")
    normalize = (lambda value: value.casefold()) if fold else (lambda value: value)
    return {normalize(value) for value in recorded} == {normalize(value) for value in asked}


class Response(io.BytesIO):
    """An HTTP response as the connectors read one."""

    def __init__(self, data, content_type, status=200, **headers):
        super().__init__(data)
        self.status = status
        self.headers = Message()
        self.headers["Content-Type"] = content_type
        self.headers["Content-Length"] = str(len(data))
        for name, value in headers.items():
            self.headers[name.replace("_", "-")] = value

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def ok(name, content_type=None):
    """A recorded 2xx answer."""
    record = entry(name)
    assert 200 <= record["status"] < 300, "%s was recorded with status %s; use through_gateway" % (name, record["status"])
    return Response(body(name), (content_type or record["contentType"]).split(";")[0].strip().lower(), record["status"])


def derived(data, content_type="application/json", status=200):
    """An answer whose body a test derived from a recorded one (a list filtered to the ids asked, say)."""
    return Response(data if isinstance(data, bytes) else json.dumps(data).encode("utf-8"), content_type, status)


def through_gateway(name, retry_after=None):
    """What the runtime receives when the gateway relays a recorded non-2xx answer.

    Mirrors `publicSourceGateway.mjs`: 404 stays 404, 429 is `..._rate_limited` with
    the source's Retry-After when it sent one, 401/403 are `..._upstream_denied` (HTTP
    400), another 4xx is 400 `..._upstream_error`, and any 5xx is 502 `..._upstream_error`.
    The envelope carries the status the source itself answered.
    """
    status = entry(name)["status"]
    if status == 404:
        code, shown = "public_source_gateway_upstream_error", 404
    elif status == 429:
        code, shown = "public_source_gateway_rate_limited", 429
    elif status in (401, 403):
        code, shown = "public_source_gateway_upstream_denied", 400
    elif 400 <= status < 500:
        code, shown = "public_source_gateway_upstream_error", 400
    else:
        code, shown = "public_source_gateway_upstream_error", 502
    envelope = {"code": code, "message": "The official public source returned HTTP %d." % status, "upstreamStatus": status}
    if retry_after is not None:
        envelope["retryAfterSeconds"] = retry_after
    headers = Message()
    headers["Content-Type"] = "application/json; charset=utf-8"
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    return urllib.error.HTTPError(
        "https://gateway.invalid/internal/sources/v1/fetch", shown, "error", headers,
        io.BytesIO(json.dumps({"error": envelope}).encode("utf-8")),
    )
