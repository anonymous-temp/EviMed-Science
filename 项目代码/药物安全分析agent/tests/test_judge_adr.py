import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from safety_agent.normalize import adr
from safety_agent.normalize.types import NormalizationResult


def test_judge_term_must_be_candidate_and_openfda_confirmed(monkeypatch):
    monkeypatch.setattr(adr, 'normalize_adr', lambda q: NormalizationResult(query=q,normalized=None,candidates=[],confidence=0,method='unresolved'))
    monkeypatch.setattr(adr, 'load_vocabulary', lambda: SimpleNamespace(candidates=lambda *a,**k:[('myalgia',.8)]))
    judged = AsyncMock(return_value={'termId':'outside'})
    checked = AsyncMock(return_value=False)
    monkeypatch.setattr(adr,'judge_ask_async',judged)
    monkeypatch.setattr(adr,'confirmed_by_openfda',checked)
    assert asyncio.run(adr.normalize_adr_async('sore muscles')).normalized is None
    judged.return_value={'termId':'myalgia'}
    assert asyncio.run(adr.normalize_adr_async('sore muscles')).normalized is None
    checked.side_effect=[False,True]
    result = asyncio.run(adr.normalize_adr_async('sore muscles'))
    assert result.normalized == 'myalgia'
    assert result.method == 'judge-openfda-confirmed'
