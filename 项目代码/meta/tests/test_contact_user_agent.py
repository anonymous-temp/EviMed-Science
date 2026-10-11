"""The polite-pool contact address is the operator's, or it is not sent at all."""

from new_meta import config
from new_meta.tools import multi_search


def test_user_agent_is_the_product_name_alone_without_a_contact_address(monkeypatch):
    monkeypatch.setattr(config, "PUBMED_EMAIL", "")
    assert config.contact_user_agent("MetaAgent/1.0") == "MetaAgent/1.0"


def test_user_agent_carries_the_operators_contact_address(monkeypatch):
    monkeypatch.setattr(config, "PUBMED_EMAIL", "operator@example.org")
    assert config.contact_user_agent("MetaAgent/1.0") == "MetaAgent/1.0 (mailto:operator@example.org)"


def _capture_openalex_request(monkeypatch, email):
    seen = {}

    class _Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"results": []}

    def fake_get(url, params=None, headers=None, timeout=None):
        seen["params"] = params
        return _Response()

    monkeypatch.setattr(multi_search, "PUBMED_EMAIL", email)
    monkeypatch.setattr(multi_search.requests, "get", fake_get)
    multi_search.search_openalex("sepsis", max_results=5)
    return seen["params"]


def test_openalex_query_names_no_contact_address_when_none_is_configured(monkeypatch):
    assert "mailto" not in _capture_openalex_request(monkeypatch, "")


def test_openalex_query_carries_the_operators_contact_address(monkeypatch):
    assert _capture_openalex_request(monkeypatch, "operator@example.org")["mailto"] == "operator@example.org"
