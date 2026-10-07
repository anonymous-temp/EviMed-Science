from types import SimpleNamespace
from unittest.mock import Mock
from mr_agent.analysis import pipeline
from mr_agent.models import GWASEntry, SessionState


def test_judge_ranking_cannot_select_unknown_id(monkeypatch):
    monkeypatch.setattr(pipeline, 'judge_ask', lambda *args, **kwargs: {'candidates':[{'id':'outside','relevance':1}]})
    llm = SimpleNamespace(chat_structured=Mock(return_value={'selected_ids':['outside']}))
    runner = pipeline.MRPipeline(llm, SessionState())
    entries = [GWASEntry(gwas_id='ieu-a-1', trait='Diabetes'), GWASEntry(gwas_id='ieu-a-2',trait='Coronary heart disease')]
    assert runner._step5_select_gwas({'Coronary heart disease':entries}) == {}
    assert runner._step5_select_gwas({'Heart failure':entries}) == {}


def test_settled_known_candidate_bypasses_flash(monkeypatch):
    monkeypatch.setattr(pipeline, 'judge_ask', lambda *args, **kwargs: {'candidates':[{'id':'ieu-a-2','relevance':.97}]})
    llm = SimpleNamespace(chat_structured=Mock(side_effect=AssertionError('Flash should not be called')))
    runner = pipeline.MRPipeline(llm, SessionState())
    entries = [GWASEntry(gwas_id='ieu-a-2',trait='Coronary heart disease')]
    assert runner._step5_select_gwas({'Coronary heart disease':entries}) == {'Coronary heart disease':['ieu-a-2']}


def test_unsubmitted_or_duplicate_judge_ids_fall_back(monkeypatch):
    entries = [GWASEntry(gwas_id=f'ieu-a-{n}', trait='Other') for n in range(1, 52)]
    llm = SimpleNamespace(chat_structured=Mock(return_value={'selected_ids': []}))
    runner = pipeline.MRPipeline(llm, SessionState())
    for rows in ([{'id': 'ieu-a-51', 'relevance': 1}],
                 [{'id': 'ieu-a-2', 'relevance': 1}, {'id': 'ieu-a-2', 'relevance': .95}]):
        monkeypatch.setattr(pipeline, 'judge_ask', lambda *args, **kwargs: {'candidates': rows})
        assert runner._step5_select_gwas({'Target': entries}) == {}
    assert llm.chat_structured.call_count == 2


def test_drift_callback_reuses_original_selector(monkeypatch):
    captured = {}
    def ask(site, data, **kwargs):
        captured['baseline'] = kwargs['baseline']
        return {'candidates': [{'id': 'ieu-a-2', 'relevance': .97}]}
    monkeypatch.setattr(pipeline, 'judge_ask', ask)
    llm = SimpleNamespace(chat_structured=Mock(return_value={'selected_ids': ['ieu-a-2', 'outside']}))
    runner = pipeline.MRPipeline(llm, SessionState())
    entries = [GWASEntry(gwas_id='ieu-a-2', trait='Target')]
    assert runner._step5_select_gwas({'Target': entries}) == {'Target': ['ieu-a-2']}
    assert llm.chat_structured.call_count == 0
    assert captured['baseline']() == {'selectedIds': ['ieu-a-2']}
    assert llm.chat_structured.call_count == 1
