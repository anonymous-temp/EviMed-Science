from types import SimpleNamespace
from services import task_service, internal_db_service


def test_judge_relevance_only_removes_clearly_unrelated(monkeypatch):
    record=SimpleNamespace(title='Dialysis adherence study',abstract='Adult missed dialysis sessions',keywords=[],mesh_terms=[])
    cls=task_service.TaskService
    monkeypatch.setattr(cls,'_required_concept_groups',classmethod(lambda cls,q: []))
    monkeypatch.setattr(task_service,'judge_ask',lambda *args:None)
    assert cls._filter_relevant_records([record],{},'dialysis adherence') == [record]
    monkeypatch.setattr(task_service,'judge_ask',lambda *args:{'relation':'related'})
    assert cls._filter_relevant_records([record],{},'dialysis adherence') == [record]
    monkeypatch.setattr(task_service,'judge_ask',lambda *args:{'relation':'unrelated'})
    assert cls._filter_relevant_records([record],{},'dialysis adherence') == []


def test_study_design_keeps_authoritative_metadata(monkeypatch):
    monkeypatch.setattr(internal_db_service,'judge_ask',lambda *args:{'studyType':'RCT'})
    assert internal_db_service._normalize_study_design('Meta-analysis') == 'Meta-analysis'
    assert internal_db_service._normalize_study_design('',title='Randomized trial') == 'RCT'
    monkeypatch.setattr(internal_db_service,'judge_ask',lambda *args:{'studyType':'not-a-label'})
    assert internal_db_service._normalize_study_design('RCT') == 'RCT'
