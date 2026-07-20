from bibliometric.pubmed import search_strategy


class _FakeClient:
    available = True
    calls = []
    outputs = []

    def complete(self, messages, **kwargs):
        type(self).calls.append((messages, kwargs))
        return type(self).outputs.pop(0)


def test_pubmed_query_generation_uses_flash(monkeypatch):
    _FakeClient.calls = []
    _FakeClient.outputs = [
        '("Diabetes Mellitus"[MeSH Terms] OR "diabetes"[Title/Abstract])'
    ]
    monkeypatch.setattr("bibliometric.llm.client.DeepSeekClient", _FakeClient)

    result = search_strategy._build_pubmed_query_llm("糖尿病")

    assert "[MeSH Terms]" in result
    assert _FakeClient.calls[0][1]["tier"] == "flash"
    assert _FakeClient.calls[0][1]["temperature"] == 0


def test_medical_term_translation_uses_flash(monkeypatch):
    _FakeClient.calls = []
    _FakeClient.outputs = ["Diabetes Mellitus"]
    monkeypatch.setattr("bibliometric.llm.client.DeepSeekClient", _FakeClient)

    result = search_strategy._translate_chinese_term_llm("糖尿病")

    assert result == "Diabetes Mellitus"
    assert _FakeClient.calls[0][1]["tier"] == "flash"


def test_invalid_llm_query_falls_back_to_empty(monkeypatch):
    _FakeClient.outputs = ["not a PubMed query"]
    monkeypatch.setattr("bibliometric.llm.client.DeepSeekClient", _FakeClient)
    assert search_strategy._build_pubmed_query_llm("糖尿病") == ""


def test_natural_language_topic_keeps_two_clinical_concepts():
    concepts = search_strategy._split_query_into_concepts(
        "SGLT2 inhibitors in chronic kidney disease"
    )
    assert concepts == ["SGLT2 inhibitors", "chronic kidney disease"]
    assert "in" not in concepts


def test_known_multiword_term_is_not_split_into_mandatory_tokens():
    concepts = search_strategy._split_query_into_concepts("heart failure treatment")
    assert concepts == ["treatment", "heart failure"]
