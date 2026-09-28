"""Offline stand-in for ``requests.get`` used by the full-text retrieval tests.

Routes are matched by URL prefix; anything unrouted answers 404 so a test
fails loudly on a request it did not expect only when it asserts on ``calls``.
"""
from __future__ import annotations

import json as _json

PDF_BYTES = b"%PDF-1.7\n" + (b"0" * 2048)


class FakeResponse:
    def __init__(self, status=200, body=b"", headers=None, url="", json_data=None):
        self.status_code = status
        if isinstance(body, str):
            body = body.encode("utf-8")
        if json_data is not None:
            body = _json.dumps(json_data).encode("utf-8")
        self._body = body
        self.headers = dict(headers or {})
        self.url = url
        self._json = json_data
        self.closed = False

    @property
    def text(self) -> str:
        return self._body.decode("utf-8", errors="replace")

    @property
    def content(self) -> bytes:
        return self._body

    def iter_content(self, chunk_size=65536):
        for index in range(0, len(self._body), chunk_size):
            yield self._body[index:index + chunk_size]

    def json(self):
        if self._json is not None:
            return self._json
        return _json.loads(self.text)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def close(self):
        self.closed = True


def pdf(url=""):
    return FakeResponse(200, PDF_BYTES, {"Content-Type": "application/pdf"}, url=url)


def html(body, url=""):
    return FakeResponse(200, body, {"Content-Type": "text/html; charset=utf-8"}, url=url)


def cloudflare_403(url=""):
    return FakeResponse(
        403,
        "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>challenge-platform</body></html>",
        {"Content-Type": "text/html", "Server": "cloudflare", "cf-mitigated": "challenge"},
        url=url,
    )


def plain_403(url=""):
    return FakeResponse(403, "<html><body>Forbidden</body></html>", {"Content-Type": "text/html"}, url=url)


def not_found(url=""):
    return FakeResponse(404, "", {}, url=url)


def epmc_search(record: dict | None):
    return FakeResponse(200, json_data={"resultList": {"result": [record] if record else []}})


def jats_xml(text="Randomized trial full text with blood loss outcomes. "):
    return FakeResponse(
        200,
        "<article><body><sec><p>" + (text * 60) + "</p></sec></body></article>",
        {"Content-Type": "application/xml"},
    )


class FakeWeb:
    """URL-prefix router; every request is appended to ``calls``."""

    def __init__(self, routes: dict | None = None):
        self.routes: dict = dict(routes or {})
        self.calls: list[str] = []
        self.kwargs: list[dict] = []

    def get(self, url, params=None, **kwargs):
        full = url
        if params:
            full = url + "?" + "&".join(f"{k}={v}" for k, v in params.items())
        self.calls.append(full)
        self.kwargs.append({"params": params, **kwargs})
        for prefix in sorted(self.routes, key=len, reverse=True):
            if full.startswith(prefix) or url.startswith(prefix):
                handler = self.routes[prefix]
                response = handler(full) if callable(handler) else handler
                if isinstance(response, FakeResponse) and not response.url:
                    response.url = url
                return response
        return not_found(url)

    def hosts_called(self, host: str) -> list[str]:
        return [call for call in self.calls if host in call]
