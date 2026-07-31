"""A refused OpenGWAS credential must not look like an empty result set.

OpenGWAS has required a JWT since 1 May 2024 and they expire. Before this, a
401 was caught by a broad handler, retried three times, and finally reported as
"no GWAS data matched your exposure or outcome" — which sends the user to
rewrite their research question when the problem is the token.
"""
import pytest

from mr_agent.tools import gwas


class _Response:
    def __init__(self, status_code):
        self.status_code = status_code

    def raise_for_status(self):
        raise AssertionError("the auth check must run before the generic status check")

    def json(self):
        raise AssertionError("a refused response has no usable body")


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_credential_raises_immediately(monkeypatch, status):
    attempts = []

    def fake_post(*args, **kwargs):
        attempts.append(1)
        return _Response(status)

    monkeypatch.setattr(gwas, "_gwas_db_cache", None, raising=False)
    monkeypatch.setattr(gwas.requests, "post", fake_post)

    with pytest.raises(gwas.OpenGwasAuthError) as raised:
        gwas._get_gwas_db()

    # Retrying an expired token cannot help, so it must not be retried.
    assert len(attempts) == 1, f"a refused credential was retried {len(attempts)} times"
    message = str(raised.value)
    assert "OPENGWAS_JWT" in message
    assert "api.opengwas.io" in message


def test_an_ordinary_failure_is_still_retried(monkeypatch):
    attempts = []

    def fake_post(*args, **kwargs):
        attempts.append(1)
        raise gwas.requests.RequestException("connection reset")

    monkeypatch.setattr(gwas, "_gwas_db_cache", None, raising=False)
    monkeypatch.setattr(gwas.requests, "post", fake_post)
    monkeypatch.setattr(gwas.time, "sleep", lambda _seconds: None)

    assert gwas._get_gwas_db() is None
    assert len(attempts) == gwas._OPENGWAS_RETRIES
