"""Replaying upstream answers inside the container, on the same key the server uses.

Hidden knowledge: there are two places a research request can leave this system
-- the control plane's public-source gateway, and this MCP server when a
deployment runs without that gateway -- and a paired evaluation has to hold both
still. Two fixture stores keyed differently would mean an evaluation that is
reproducible on one path and live on the other, which is the failure mode that
looks like a working corpus.

So the key is the *upstream* request, never the envelope that carries it:

    sha256(METHOD + "\\n" + url + "\\n" + body)

For a gateway call, that is the URL named inside the gateway payload rather than
the gateway's own URL. `apps/server/src/recordedGateway.mjs` derives the same
triple, and a test hashes one triple on both sides and compares.

A miss is a failure, never a fall-through to the network. "Replay if we have it,
otherwise fetch" produces a run that is mostly reproducible, and nobody can say
which half.
"""

import hashlib
import io
import json
import os


FIXTURE_MISSING_STATUS = 599
FIXTURE_MISSING_CODE = "fixture_missing"


def fixtures_dir():
    """The replay directory, or None when this process is not replaying."""
    value = str(os.environ.get("EVIMED_MCP_FIXTURES", "")).strip()
    return value or None


def fixture_key(method, url, body=""):
    """The shared key. `body` is the request body as sent, or "" for a GET."""
    if body is None:
        body = ""
    if not isinstance(body, str):
        body = json.dumps(body, sort_keys=True, separators=(",", ":"))
    payload = "%s\n%s\n%s" % (str(method or "GET").upper(), str(url or ""), body)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class FixtureResponse(io.BytesIO):
    """Enough of an HTTPResponse for the connectors that read one.

    Deliberately minimal: the connectors call `.read()`, `.status`, `.headers`
    and use it as a context manager. Anything they do not use is absent rather
    than faked, so a connector that starts relying on more fails loudly here
    instead of quietly reading a default.
    """

    def __init__(self, status, headers, body):
        super().__init__(body)
        self.status = status
        self.code = status
        self.headers = headers or {}

    def info(self):
        return self.headers

    def getcode(self):
        return self.status

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()
        return False


class FixtureMissing(Exception):
    """Raised when replay is on and nothing covers this request."""

    def __init__(self, key, method, url):
        super().__init__("No recorded response for %s %s (key %s)." % (method, url, key))
        self.key = key
        self.method = method
        self.url = url
        self.code = FIXTURE_MISSING_CODE
        self.status = FIXTURE_MISSING_STATUS


def load_fixture(method, url, body=""):
    """Return a FixtureResponse, or raise FixtureMissing. Caller checks fixtures_dir() first."""
    directory = fixtures_dir()
    key = fixture_key(method, url, body)
    path = os.path.join(directory, "%s.json" % key)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            record = json.load(handle)
    except (OSError, ValueError):
        raise FixtureMissing(key, method, url)
    payload = record.get("body", "")
    if record.get("encoding") == "base64":
        import base64

        data = base64.b64decode(payload)
    else:
        data = str(payload).encode("utf-8")
    return FixtureResponse(int(record.get("status", 200)), record.get("headers") or {}, data)
