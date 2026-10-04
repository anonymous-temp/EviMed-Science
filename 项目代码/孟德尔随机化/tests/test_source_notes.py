"""An optional source that was not used is said, with why, and not only logged.

UMLS expands the search terms of a text-based MR run. With no key it used to write
one log line and fall back to the language model, and the result read as if UMLS
had been used. The three words are the same in every engine: not_configured,
refused, unreachable.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
import requests

import evimed_runner
from mr_agent import source_notes
from mr_agent.analysis.pipeline import MRPipeline
from mr_agent.models import AnalysisSlots, ExposureOutcome, SessionState
from mr_agent.tools import umls


class _Answer:
    def __init__(self, status=200, text="", payload=None):
        self.status_code = status
        self.ok = 200 <= status < 300
        self.text = text
        self._payload = payload

    def json(self):
        return self._payload

    def raise_for_status(self):
        if not self.ok:
            raise requests.HTTPError(f"http {self.status_code}")


TGT_FORM = '<form action="https://utslogin.nlm.nih.gov/cas/v1/tickets/TGT-1" method="post"></form>'


def _umls(monkeypatch, *, post, get=None):
    monkeypatch.setenv("UMLS_API_KEY", "synthetic-key")
    monkeypatch.setattr(umls.requests, "post", post)
    monkeypatch.setattr(umls.requests, "get", get or (lambda *a, **k: pytest.fail("not reached")))


def test_without_a_key_umls_says_not_configured(monkeypatch):
    monkeypatch.delenv("UMLS_API_KEY", raising=False)
    assert umls.lookup_synonyms_umls("obesity") == ([], "not_configured")
    assert umls.get_synonyms_umls("obesity") == []


def test_a_refused_key_is_refused_and_an_unanswering_service_is_unreachable(monkeypatch):
    _umls(monkeypatch, post=lambda *a, **k: _Answer(401))
    assert umls.lookup_synonyms_umls("obesity") == ([], "refused")

    def down(*args, **kwargs):
        raise requests.ConnectionError("no route")

    _umls(monkeypatch, post=down)
    assert umls.lookup_synonyms_umls("obesity") == ([], "unreachable")

    # A ticket that is granted and then not honoured is a service that did not answer.
    _umls(monkeypatch, post=lambda url, **k: _Answer(200, TGT_FORM) if "api-key" in url else _Answer(500))
    assert umls.lookup_synonyms_umls("obesity") == ([], "unreachable")

    # So is an answer that is not a ticket at all.
    _umls(monkeypatch, post=lambda *a, **k: _Answer(200, "<html></html>"))
    assert umls.lookup_synonyms_umls("obesity") == ([], "unreachable")


def test_the_search_being_refused_is_refused(monkeypatch):
    _umls(monkeypatch, post=lambda url, **k: _Answer(200, TGT_FORM) if "api-key" in url else _Answer(200, "ST-1"),
          get=lambda *a, **k: _Answer(403, payload={}))
    assert umls.lookup_synonyms_umls("obesity") == ([], "refused")


def test_an_answer_is_not_a_lost_source_even_when_it_has_no_match(monkeypatch):
    post = lambda url, **k: _Answer(200, TGT_FORM) if "api-key" in url else _Answer(200, "ST-1")
    _umls(monkeypatch, post=post, get=lambda *a, **k: _Answer(200, payload={"result": {"results": []}}))
    assert umls.lookup_synonyms_umls("a term nobody has") == ([], None)

    def answers(url, **kwargs):
        if url.endswith("/search/current"):
            return _Answer(200, payload={"result": {"results": [{"ui": "C0028754"}]}})
        return _Answer(200, payload={"result": [{"name": "Obesity"}, {"name": "Adiposity"}]})

    _umls(monkeypatch, post=post, get=answers)
    synonyms, why_not = umls.lookup_synonyms_umls("obesity")
    assert why_not is None and sorted(synonyms) == ["Adiposity", "Obesity"]


def test_the_pipeline_records_each_unused_source_once_and_still_expands_with_the_model(monkeypatch):
    monkeypatch.delenv("UMLS_API_KEY", raising=False)
    monkeypatch.setattr(umls, "get_synonyms_llm", lambda term, llm: [f"{term} (model synonym)"])
    pairs = [ExposureOutcome(exposure="obesity", outcome="coronary artery disease")]
    stand_in = SimpleNamespace(state=SessionState(), llm=object())

    expanded = MRPipeline._step3_expand_synonyms(stand_in, pairs, AnalysisSlots())

    assert expanded["obesity"] == ["obesity (model synonym)"], "the search still gets its terms"
    assert stand_in.state.source_notes == [{"source": "umls", "label": "UMLS", "status": "not_configured",
                                            "module": "umlsSynonyms", "fallback": "llm"}], "two terms, one note"


def test_the_result_ledger_and_the_methods_sentence_carry_the_note():
    note = source_notes.row("umls", "UMLS", "not_configured", "umlsSynonyms", "llm")
    assert source_notes.sentence([note], "en") == (
        "Optional data sources that could not be used: UMLS (not configured); the language model was used instead.")
    assert source_notes.sentence([note], "zh") == "未能使用的可选数据来源：UMLS（未配置），改用语言模型。"
    assert source_notes.sentence([], "en") == ""
    modules = evimed_runner._module_ledger([], False, [note])
    assert modules["umlsSynonyms"] == {"status": "degraded", "reason": "UMLS not configured; the language model was used instead"}
    assert "umlsSynonyms" not in evimed_runner._module_ledger([], False)
    with pytest.raises(ValueError):
        source_notes.row("umls", "UMLS", "gone_fishing", "umlsSynonyms")
