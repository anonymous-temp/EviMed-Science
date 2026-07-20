"""Product-level contracts for the topic-to-article interaction surface."""

from __future__ import annotations

import inspect

import new_meta.main as main_module
import start


def test_cli_attempts_automatic_fulltext_before_requesting_a_directory() -> None:
    source = inspect.getsource(main_module.main)

    automatic = source.index("attempting auto text retrieval")
    fallback_prompt = source.index(
        "Automatic full-text retrieval found no usable sources"
    )

    assert automatic < fallback_prompt
    assert "Provide directory with user-uploaded PDFs?" not in source


def test_web_conversation_does_not_pause_for_pdf_before_automatic_phase2() -> None:
    source = inspect.getsource(start._handle_session)

    assert 'session_ctx["pdf_waiting"] = True' not in source
    assert "正在自动获取可用全文并继续分析" in source


def test_web_method_route_respects_interactive_vs_full_auto_uncertainty() -> None:
    source = inspect.getsource(start._run_phase2_inner)

    assert "auto_resolve_uncertainty=bool(phase1_state.get(\"skip_confirm\"))" in source
    assert "method_delivery.phase.data" in source
    assert 'method_delivery.decisions' in source
    assert source.count('return ""  # wait for the selected method option') == 2


def test_web_progress_stream_forwards_fulltext_and_method_options() -> None:
    source = inspect.getsource(start._handle_session)

    assert 'elif kind == "fulltext_retrieval"' in source
    assert 'elif kind == "fulltext_required"' in source
    assert 'elif kind == "method_decision_required"' in source
    assert '"type": "method_decision_required"' in source


def test_cli_does_not_pause_for_protocol_or_sparse_evidence_confirmation() -> None:
    source = inspect.getsource(main_module.main)

    assert "Confirm protocol?" not in source
    assert "_interactive_checkpoint(" not in source
    assert "Only {len(included_papers)} study(ies) after full-text screening" in source
    assert "Generating narrative systematic review instead" in source
    assert 'choice = input("\\n  Choose [1/2]: ")' not in source


def test_cli_zero_evidence_paths_still_write_an_article() -> None:
    source = inspect.getsource(main_module.main)

    assert source.count("complete_zero_record_review(") == 2
    assert "No papers found after the automatic retry. Cannot proceed without evidence records." not in source
    assert "No papers passed title/abstract screening after the automatic retry." not in source


def test_web_zero_evidence_paths_still_return_an_article() -> None:
    source = inspect.getsource(start._run_phase1_inner)

    assert source.count("complete_zero_record_review(") == 2
    assert 'raise ValueError("未检索到相关文献，无法继续分析")' not in source
    assert 'raise ValueError("标题摘要筛选后无纳入文献，无法继续分析")' not in source
