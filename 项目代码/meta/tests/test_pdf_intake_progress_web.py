from __future__ import annotations

from pathlib import Path

import pytest

from start import META_ROOT, _attach_fulltext_upload_payload, _run_phase2_inner, _run_phase2_sync
from new_meta.core.pdf_intake import PDFIntakeManifest, PDFIntakeRecord
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol


class StopAfterPdfIntake(RuntimeError):
    pass


class StopAfterAutomaticFulltext(RuntimeError):
    pass


def _protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Do SGLT2 inhibitors improve heart failure outcomes?",
        pico=PICO(
            population="adults with heart failure",
            intervention="SGLT2 inhibitors",
            comparator="placebo",
            outcome_primary="composite cardiovascular death or heart failure hospitalization",
        ),
        effect_measure="HR",
    )


def test_phase2_pushes_pdf_intake_progress_events_before_screening(tmp_path: Path, monkeypatch) -> None:
    project = Project("pdf intake progress", output_dir=tmp_path / "project")
    pdf = tmp_path / "12345.pdf"
    pdf.write_bytes(b"%PDF fake")
    pushes: list[tuple[str, object]] = []

    def fake_parse_user_pdfs(pdf_paths, cache_dir, **kwargs):
        record = PDFIntakeRecord(
            filename="12345.pdf",
            local_path=str(pdf),
            file_size_bytes=9,
            sha256="abc",
            parse_status="ok",
            parser_used="pdf_parser",
            parser_cache_version="test-v1",
            cache_hit=False,
            page_count=8,
            text_chars=12000,
            table_count=3,
            requires_user_review=False,
        )
        progress_cb = kwargs.get("progress_cb")
        if progress_cb:
            progress_cb(record)
        manifest = PDFIntakeManifest(
            session_id=kwargs.get("session_id") or "session-1",
            created_at="2026-05-22T12:00:00+00:00",
            files=[record],
        )
        return manifest, {
            str(pdf): {
                "full_text": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
                "abstract": "",
                "sections": {},
                "tables": [],
                "page_map": [{"page_number": 1, "start_char": 0, "end_char": 70}],
            }
        }

    def stop_after_intake(self, papers, protocol, parsed_papers, project):
        raise StopAfterPdfIntake("stop after pdf intake")

    monkeypatch.setattr("new_meta.core.pdf_intake.parse_user_pdfs", fake_parse_user_pdfs)
    monkeypatch.setattr("new_meta.agents.screening_agent.ScreeningAgent.screen_full_text", stop_after_intake)

    phase1_state = {
        "ta_included": [
            {
                "pmid": "12345",
                "doi": "",
                "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
                "abstract": "",
                "authors": [],
                "year": 2021,
            }
        ],
        "protocol": _protocol(),
        "search_query": '"heart failure"[tiab]',
        "project_dir": str(project.base_dir),
        "ctx": {},
        "parent_id": "session-1",
        "topic": "SGLT2 inhibitors for HFpEF",
    }

    with pytest.raises(StopAfterPdfIntake):
        _run_phase2_inner(
            phase1_state,
            str(tmp_path),
            lambda kind, payload: pushes.append((kind, payload)),
            [str(pdf)],
        )

    events = [payload for kind, payload in pushes if kind == "pdf_intake"]
    assert len(events) == 1
    event = events[0]
    assert event["type"] == "pdf_intake"
    assert event["stage"] == "phase2_pdf_intake"
    assert event["session_id"] == "session-1"
    assert event["current"] == 1
    assert event["total"] == 1
    assert event["file"]["filename"] == "12345.pdf"
    assert event["file"]["parse_status"] == "ok"
    assert event["file"]["text_chars"] == 12000
    assert event["file"]["table_count"] == 3
    assert event["file"]["requires_user_review"] is False
    assert project.is_step_done("pdf_download") is True
    assert project.is_step_done("pdf_parsing") is True


def test_phase2_blocks_without_any_fulltext_before_fulltext_screening(tmp_path: Path, monkeypatch) -> None:
    project = Project("web no full text", output_dir=tmp_path / "project")
    pushes: list[tuple[str, object]] = []

    def fail_if_screening_runs(self, papers, protocol, parsed_papers, project):
        raise AssertionError("full-text screening should not run without full-text sources")

    monkeypatch.setattr("new_meta.agents.screening_agent.ScreeningAgent.screen_full_text", fail_if_screening_runs)
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.PaperRetriever.download_pdfs",
        lambda self, papers, project: ([], papers),
    )

    phase1_state = {
        "ta_included": [
            {
                "pmid": "12345",
                "doi": "",
                "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
                "abstract": "abstract-only candidate",
                "authors": [],
                "year": 2021,
            }
        ],
        "protocol": _protocol(),
        "search_query": '"heart failure"[tiab]',
        "project_dir": str(project.base_dir),
        "ctx": {},
        "parent_id": "session-no-fulltext",
        "topic": "SGLT2 inhibitors for HFpEF",
    }

    with pytest.raises(RuntimeError, match="Full text sources are required"):
        _run_phase2_inner(
            phase1_state,
            str(tmp_path),
            lambda kind, payload: pushes.append((kind, payload)),
            [],
        )

    warnings = project.load_json("pipeline_warnings.json")
    assert warnings[-1]["code"] == "no_full_text_sources"
    assert warnings[-1]["severity"] == "error"
    assert warnings[-1]["context"]["screened_records"] == 1


def test_phase2_attempts_automatic_fulltext_before_requesting_upload(tmp_path: Path, monkeypatch) -> None:
    project = Project("web automatic full text", output_dir=tmp_path / "project")
    fulltext = project.get_path("12345.fulltext.txt", subdir="papers")
    fulltext.write_text("Results\n" + "verified full text " * 200, encoding="utf-8")
    calls = {"download": 0}

    def fake_download(self, papers, project_arg):
        calls["download"] += 1
        paper = dict(papers[0])
        paper.update({
            "fulltext_path": str(fulltext),
            "fulltext_available": True,
            "fulltext_source": "europe_pmc_fulltext",
        })
        return [paper], []

    def stop_after_retrieval(self, papers, protocol, parsed_papers, project_arg):
        assert papers[0]["fulltext_path"] == str(fulltext)
        assert "verified full text" in parsed_papers["12345"]["full_text"]
        raise StopAfterAutomaticFulltext("automatic full text reached screening")

    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.PaperRetriever.download_pdfs",
        fake_download,
    )
    monkeypatch.setattr(
        "new_meta.agents.screening_agent.ScreeningAgent.screen_full_text",
        stop_after_retrieval,
    )
    phase1_state = {
        "ta_included": [{
            "pmid": "12345",
            "doi": "",
            "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
            "abstract": "abstract-only candidate",
            "authors": [],
            "year": 2021,
        }],
        "protocol": _protocol(),
        "search_query": '"heart failure"[tiab]',
        "project_dir": str(project.base_dir),
        "ctx": {},
        "parent_id": "session-auto-fulltext",
        "topic": "SGLT2 inhibitors for HFpEF",
    }

    with pytest.raises(StopAfterAutomaticFulltext):
        _run_phase2_inner(
            phase1_state,
            str(tmp_path),
            lambda kind, payload: None,
            [],
        )

    assert calls["download"] == 1


def test_phase2_rejects_missing_phase1_project_dir(tmp_path: Path) -> None:
    missing_project_dir = tmp_path / "missing-project"
    phase1_state = {
        "ta_included": [
            {
                "pmid": "12345",
                "doi": "",
                "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
                "abstract": "abstract-only candidate",
                "authors": [],
                "year": 2021,
            }
        ],
        "protocol": _protocol(),
        "search_query": '"heart failure"[tiab]',
        "project_dir": str(missing_project_dir),
        "ctx": {},
        "parent_id": "session-missing-project",
        "topic": "SGLT2 inhibitors for HFpEF",
    }

    with pytest.raises(ValueError, match="phase1 project_dir does not exist"):
        _run_phase2_inner(
            phase1_state,
            str(tmp_path),
            lambda kind, payload: None,
            [],
        )

    assert not missing_project_dir.exists()


def test_phase2_sync_pushes_structured_fulltext_required_event(tmp_path: Path, monkeypatch) -> None:
    project = Project("web no full text sync", output_dir=tmp_path / "project")
    pushes: list[tuple[str, object]] = []

    def fail_if_screening_runs(self, papers, protocol, parsed_papers, project):
        raise AssertionError("full-text screening should not run without full-text sources")

    monkeypatch.setattr("new_meta.agents.screening_agent.ScreeningAgent.screen_full_text", fail_if_screening_runs)
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.PaperRetriever.download_pdfs",
        lambda self, papers, project: ([], papers),
    )

    phase1_state = {
        "ta_included": [
            {
                "pmid": "12345",
                "doi": "",
                "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
                "abstract": "abstract-only candidate",
                "authors": [],
                "year": 2021,
            }
        ],
        "protocol": _protocol(),
        "search_query": '"heart failure"[tiab]',
        "project_dir": str(project.base_dir),
        "ctx": {},
        "parent_id": "session-no-fulltext-sync",
        "topic": "SGLT2 inhibitors for HFpEF",
    }

    with pytest.raises(RuntimeError, match="Full text sources are required"):
        _run_phase2_sync(
            phase1_state,
            str(tmp_path),
            push=lambda kind, payload: pushes.append((kind, payload)),
            user_pdf_paths=[],
        )

    events = [payload for kind, payload in pushes if kind == "fulltext_required"]
    assert len(events) == 1
    assert events[0]["type"] == "fulltext_required"
    assert events[0]["project_dir"] == str(project.base_dir)
    assert events[0]["screened_records"] == 1
    assert events[0]["suggested_upload"]["type"] == "fulltext_upload"
    assert events[0]["suggested_upload"]["project_dir"] == str(project.base_dir)


def test_fulltext_upload_payload_forwards_pdf_intake_progress_callback(tmp_path: Path, monkeypatch) -> None:
    project = Project("post run upload progress", output_dir=META_ROOT / "output" / "pytest_fulltext_upload_progress")
    pdf = tmp_path / "34449189.pdf"
    pdf.write_bytes(b"%PDF fake")
    events = []

    def fake_attach(project_arg, pdf_paths, **kwargs):
        assert project_arg.base_dir == project.base_dir
        assert pdf_paths == [str(pdf)]
        progress_cb = kwargs.get("progress_cb")
        assert progress_cb is not None
        progress_cb(
            PDFIntakeRecord(
                filename="34449189.pdf",
                local_path=str(pdf),
                parse_status="ok",
                text_chars=14000,
                table_count=2,
                page_count=10,
            )
        )
        return {
            "ok": True,
            "project_dir": str(project.base_dir),
            "uploaded": 1,
            "matched": 1,
            "unmatched": 0,
        }

    monkeypatch.setattr("new_meta.core.fulltext_uploads.attach_user_fulltexts_to_project", fake_attach)

    result = _attach_fulltext_upload_payload(
        {"project_dir": str(project.base_dir)},
        [str(pdf)],
        parent_id="session-2",
        user_id="tester",
        progress_cb=lambda record: events.append(record.model_dump()),
    )

    assert result["ok"] is True
    assert result["updated_by"] == "tester"
    assert len(events) == 1
    assert events[0]["filename"] == "34449189.pdf"
    assert events[0]["parse_status"] == "ok"
    assert events[0]["text_chars"] == 14000
