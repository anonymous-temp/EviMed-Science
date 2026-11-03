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


def test_full_iso_date_range_is_not_expanded_twice(monkeypatch):
    monkeypatch.setattr(
        search_strategy,
        "lookup_mesh",
        lambda term, **kwargs: (None, False),
    )

    strategy = search_strategy.build_search_strategy(
        "GLP-1 receptor agonists obesity",
        date_from="2023-01-01",
        date_to="2024-06-30",
    )

    assert '"2023/01/01"[Date - Publication]' in strategy["formal_query"]
    assert '"2024/06/30"[Date - Publication]' in strategy["formal_query"]
    assert "2023-01-01/01/01" not in strategy["formal_query"]


def test_invalid_date_boundary_fails_closed():
    try:
        search_strategy._pubmed_date_boundary("2024-13-40", end=True)
    except ValueError as error:
        assert "invalid" in str(error).lower() or "month" in str(error).lower()
    else:
        raise AssertionError("invalid PubMed date boundary was accepted")


def test_mesh_lookup_reads_ncbi_full_text_and_prefers_descriptor(monkeypatch):
    search = '''<?xml version="1.0"?><eSearchResult><Count>2</Count><IdList>
    <Id>2028264</Id><Id>2027927</Id></IdList></eSearchResult>'''
    action = '''\n1: Sodium-Glucose Transporter 2 Inhibitors [Pharmacological Action]\n\nTree Number(s): D000077203\ndapagliflozin (Supplementary Concept)\n'''
    descriptor = '''\n1: Sodium-Glucose Transporter 2 Inhibitors\nCompounds that inhibit the transporter.\nYear introduced: 2019\n\nTree Number(s): D27.505.519.936, D27.505.696.422.750\nEntry Terms:\n    Sodium Glucose Transporter 2 Inhibitors\n    SGLT-2 Inhibitors\n    SGLT2 Inhibitor\n    Gliflozins\n\n    All MeSH Categories\n        Chemicals and Drugs Category\n'''

    class Response:
        def __init__(self, text): self.text = text
        def raise_for_status(self): pass

    def get(url, params, timeout):
        if url.endswith('esearch.fcgi'):
            return Response(search)
        return Response({'2028264': action, '2027927': descriptor}[params['id']])

    monkeypatch.setattr(search_strategy, '_rate_limit', lambda: None)
    monkeypatch.setattr(search_strategy.requests, 'get', get)
    result, failed = search_strategy.lookup_mesh('SGLT2 inhibitors')
    assert not failed
    assert result.descriptor_name == 'Sodium-Glucose Transporter 2 Inhibitors'
    assert 'SGLT2 Inhibitor' in result.entry_terms
    assert 'dapagliflozin' not in result.entry_terms
    assert result.tree_numbers == ['D27.505.519.936', 'D27.505.696.422.750']


def test_mesh_lookup_does_not_label_pharmacological_action_as_descriptor(monkeypatch):
    search = '<eSearchResult><Count>1</Count><IdList><Id>1</Id></IdList></eSearchResult>'
    action = '\n1: Example [Pharmacological Action]\n\nTree Number(s): D012345\nExample drug (Supplementary Concept)\n'

    class Response:
        def __init__(self, text): self.text = text
        def raise_for_status(self): pass

    monkeypatch.setattr(search_strategy, '_rate_limit', lambda: None)
    monkeypatch.setattr(search_strategy.requests, 'get', lambda url, params, timeout: Response(search if url.endswith('esearch.fcgi') else action))
    result, failed = search_strategy.lookup_mesh('Example')
    assert result is None
    assert not failed


def test_mesh_lookup_reads_normal_descriptor_entry_terms(monkeypatch):
    search = '<eSearchResult><Count>1</Count><IdList><Id>1</Id></IdList></eSearchResult>'
    descriptor = '\n1: Atrial Flutter\nDefinition.\n\nTree Number(s): C14.280.067.248\nEntry Terms:\n    Atrial Flutters\n    Flutter, Atrial\n\n    All MeSH Categories\n'

    class Response:
        def __init__(self, text): self.text = text
        def raise_for_status(self): pass

    monkeypatch.setattr(search_strategy, '_rate_limit', lambda: None)
    monkeypatch.setattr(search_strategy.requests, 'get', lambda url, params, timeout: Response(search if url.endswith('esearch.fcgi') else descriptor))
    result, failed = search_strategy.lookup_mesh('atrial flutter')
    assert not failed
    assert result.descriptor_name == 'Atrial Flutter'
    assert result.entry_terms == ['Atrial Flutters', 'Flutter, Atrial']
    assert result.tree_numbers == ['C14.280.067.248']


def test_mesh_lookup_refuses_unrelated_descriptor_after_action(monkeypatch):
    search = '<eSearchResult><Count>2</Count><IdList><Id>1</Id><Id>2</Id></IdList></eSearchResult>'
    records = {'1': '\n1: Example [Pharmacological Action]\n', '2': '\n1: Unrelated Descriptor\n'}

    class Response:
        def __init__(self, text): self.text = text
        def raise_for_status(self): pass

    monkeypatch.setattr(search_strategy, '_rate_limit', lambda: None)
    monkeypatch.setattr(search_strategy.requests, 'get', lambda url, params, timeout: Response(search if url.endswith('esearch.fcgi') else records[params['id']]))
    assert search_strategy.lookup_mesh('Example') == (None, False)


def test_mesh_lookup_marks_malformed_full_record_as_failed(monkeypatch):
    search = '<eSearchResult><Count>1</Count><IdList><Id>1</Id></IdList></eSearchResult>'

    class Response:
        def __init__(self, text): self.text = text
        def raise_for_status(self): pass

    monkeypatch.setattr(search_strategy, '_rate_limit', lambda: None)
    monkeypatch.setattr(search_strategy.requests, 'get', lambda url, params, timeout: Response(search if url.endswith('esearch.fcgi') else 'not a MeSH record'))
    assert search_strategy.lookup_mesh('Example') == (None, True)


def test_search_strategy_does_not_invent_or_emit_empty_descriptor_id():
    mesh = search_strategy.MeSHResult(descriptor_name='Atrial Flutter', entry_terms=['Atrial Flutters'])
    block = search_strategy.ConceptBlock(label='atrial flutter', mesh=mesh, free_terms=['atrial flutter'])
    text = search_strategy._format_strategy([block], 'test query', '', '')
    assert 'MeSH descriptor: Atrial Flutter' in text
    assert 'Atrial Flutter ()' not in text
