import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from src.agents import methodology_reviewer as review


def test_consort_batches_and_injection_disables_judge(monkeypatch):
    monkeypatch.setenv('EVIMED_JUDGE_GATEWAY_URL','http://internal.test')
    monkeypatch.setenv('EVIMED_JUDGE_GATEWAY_TOKEN','scoped-test')
    reviewer = review.MethodologyReviewerAgent.__new__(review.MethodologyReviewerAgent)
    reviewer.llm=SimpleNamespace(call_with_json_response=AsyncMock(return_value={'parsed_json':{'safe':True}}))
    reviewer._get_evidence_context=lambda *args: ('anchored quote','exact','exact_path')
    items=[SimpleNamespace(item_id='1',checklist_name='CONSORT 2010',question='Randomized?',evaluation_criteria='Reported'),SimpleNamespace(item_id='2',checklist_name='CONSORT 2010',question='Blinded?',evaluation_criteria='Reported')]
    block=SimpleNamespace(items=items)
    document=SimpleNamespace(model_dump_json=lambda:'{"text":"manuscript"}')
    judge=AsyncMock(return_value={'items':[{'id':'1','decision':'pass','confidence':.95},{'id':'2','decision':'other','confidence':1}]})
    monkeypatch.setattr(review,'judge_ask_async',judge)
    assert asyncio.run(reviewer._prepare_consort(block,document,None)) == {'1':.95}
    assert len(judge.call_args.args[1]['criteria']) == 2
    assert judge.await_count == 1
    reviewer.llm.call_with_json_response.return_value={'parsed_json':{'safe':False}}
    assert asyncio.run(reviewer._prepare_consort(block,document,None)) == {}
    assert judge.await_count == 1


def test_drift_callback_calls_original_evaluator_with_judge_disabled(monkeypatch):
    monkeypatch.setenv('EVIMED_JUDGE_GATEWAY_URL', 'http://internal.test')
    monkeypatch.setenv('EVIMED_JUDGE_GATEWAY_TOKEN', 'scoped-test')
    reviewer = review.MethodologyReviewerAgent.__new__(review.MethodologyReviewerAgent)
    reviewer.llm = SimpleNamespace(call_with_json_response=AsyncMock(return_value={'parsed_json': {'safe': True}}))
    reviewer._get_evidence_context = lambda *args: ('quote', 'exact', 'exact_path')
    reviewer._evaluate_item = AsyncMock(return_value=SimpleNamespace(verdict=review.VerdictType.PASS))
    item = SimpleNamespace(item_id='1', checklist_name='CONSORT', question='Randomized?', evaluation_criteria='Reported')
    block = SimpleNamespace(items=[item], block_name='CONSORT')
    document = SimpleNamespace(model_dump_json=lambda: '{"text":"manuscript"}')
    captured = {}
    async def ask(site, data, **kwargs):
        captured['baseline'] = kwargs['baseline']
        return {'items': [{'id': '1', 'decision': 'pass', 'confidence': .95}]}
    monkeypatch.setattr(review, 'judge_ask_async', ask)
    assert asyncio.run(reviewer._prepare_consort(block, document, None, 'zh')) == {'1': .95}
    assert reviewer._evaluate_item.await_count == 0
    assert asyncio.run(captured['baseline']()) == {'items': [{'id': '1', 'decision': 'pass'}]}
    assert reviewer._evaluate_item.call_args.kwargs == {'skip_judge': True}
    assert reviewer._evaluate_item.call_args.args[3:] == ('zh', 'CONSORT')
