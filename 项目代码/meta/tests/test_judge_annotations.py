from new_meta.tools import multi_search
from new_meta.agents import screening_agent


def test_same_trial_is_annotation_never_merge(monkeypatch):
    monkeypatch.setattr(multi_search,'judge_ask',lambda *args:{'relation':'same_trial'})
    papers=[{'title':'A randomized trial of blood pressure treatment results','doi':'one'}, {'title':'A randomized trial of blood pressure treatment secondary results','doi':'two'}]
    unique=multi_search._deduplicate_by_doi_pmid_title(papers)
    multi_search._annotate_trial_pairs(unique)
    assert len(unique) == 2
    assert unique[0]['suspected_same_trial'] == ['two']
    assert unique[1]['suspected_same_trial'] == ['one']


def test_evidence_role_uses_only_closed_roles(monkeypatch):
    monkeypatch.setattr(screening_agent,'judge_ask',lambda *args:{'role':'secondary_analysis'})
    classify=screening_agent.ScreeningAgent._classify_full_text_evidence_role
    assert classify({'title':'Primary trial report'}) == 'secondary_analysis'
    monkeypatch.setattr(screening_agent,'judge_ask',lambda *args:{'role':'excluded'})
    assert classify({'title':'Primary trial report'}) == 'primary_publication'


def test_pair_limit_is_explicit_and_never_drops_records(monkeypatch):
    from unittest.mock import Mock
    judge=Mock(return_value={'relation':'different'})
    monkeypatch.setattr(multi_search,'judge_ask',judge)
    papers=[{'title':f'Randomized trial blood pressure treatment primary result variant {index}','doi':str(index)} for index in range(12)]
    multi_search._annotate_trial_pairs(papers)
    assert judge.call_count == 40
    assert len(papers) == 12
    assert all(paper['trial_linkage_review']['status'] == 'incomplete' for paper in papers)
