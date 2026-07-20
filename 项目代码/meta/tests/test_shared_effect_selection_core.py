import inspect

import new_meta.main as main_module
from new_meta.core import effect_selection
from new_meta.core.pipeline_runner import PipelineRunner


def test_main_and_runner_share_the_same_effect_selection_implementation() -> None:
    assert main_module._build_paper_source_lookup is effect_selection.build_paper_source_lookup
    assert main_module._build_rob_lookup is effect_selection.build_rob_lookup
    assert main_module._compute_study_effect is effect_selection.compute_study_effect
    assert main_module._dedupe_primary_effect_candidates is effect_selection.dedupe_primary_effect_candidates
    assert main_module._effect_is_poolable is effect_selection.effect_is_poolable
    assert main_module._primary_candidate_rank is effect_selection.primary_candidate_rank
    assert main_module._primary_candidate_block_reason is effect_selection.primary_candidate_block_reason
    assert main_module._primary_population_rank is effect_selection.primary_population_rank
    assert main_module._rob_for_study is effect_selection.rob_for_study
    assert main_module._source_record_for_study is effect_selection.source_record_for_study
    assert (
        main_module._filter_benchmark_reference_primary_candidates
        is effect_selection.filter_benchmark_reference_primary_candidates
    )


def test_pipeline_runner_does_not_import_private_main_helpers() -> None:
    source = inspect.getsource(PipelineRunner.compute_primary_effect_selection)

    assert "from new_meta.main import" not in source
    assert "new_meta.core.effect_selection" in source
    assert "filter_benchmark_reference_primary_candidates" in source
