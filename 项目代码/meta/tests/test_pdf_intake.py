from __future__ import annotations

from pathlib import Path

from new_meta.core.pdf_intake import (
    PDF_PARSE_CACHE_VERSION,
    parse_file_with_cache,
    parse_user_pdfs,
    save_pdf_intake_manifest,
)


def test_pdf_intake_manifest_records_parse_summary_and_cache(tmp_path: Path) -> None:
    pdf = tmp_path / "study.pdf"
    pdf.write_bytes(b"%PDF fake content")

    calls = {"n": 0}

    def fake_parse(path: str) -> dict:
        calls["n"] += 1
        return {
            "full_text": "[PAGE 1]\nA useful result table",
            "abstract": "",
            "sections": {},
            "tables": ["| A | B |\n| - | - |\n| 1 | 2 |"],
            "page_map": [{"page_number": 1, "start_char": 0, "end_char": 28}],
        }

    manifest, parsed = parse_user_pdfs([str(pdf)], tmp_path, session_id="session-1", parse_func=fake_parse)
    record = manifest.files[0]

    assert calls["n"] == 1
    assert manifest.session_id == "session-1"
    assert record.filename == "study.pdf"
    assert record.parse_status == "ok"
    assert record.cache_hit is False
    assert record.parser_cache_version == PDF_PARSE_CACHE_VERSION
    assert record.text_chars > 0
    assert record.table_count == 1
    assert parsed[str(pdf)]["full_text"].startswith("[PAGE 1]")

    second_manifest, second_parsed = parse_user_pdfs(
        [str(pdf)],
        tmp_path,
        parse_func=lambda _: (_ for _ in ()).throw(AssertionError("cache should be used")),
    )
    second_record = second_manifest.files[0]

    assert second_record.cache_hit is True
    assert second_record.parse_status == "ok"
    assert second_record.parser_cache_version == PDF_PARSE_CACHE_VERSION
    assert second_parsed[str(pdf)]["full_text"].startswith("[PAGE 1]")


def test_pdf_intake_cache_is_invalidated_by_parser_version(tmp_path: Path) -> None:
    pdf = tmp_path / "study.pdf"
    pdf.write_bytes(b"%PDF fake content")
    calls = {"n": 0}

    def fake_parse(path: str) -> dict:
        calls["n"] += 1
        return {
            "full_text": f"[PAGE 1]\nparse version call {calls['n']}",
            "abstract": "",
            "sections": {},
            "tables": [],
            "page_map": [{"page_number": 1, "start_char": 0, "end_char": 29}],
        }

    first_manifest, _ = parse_user_pdfs(
        [str(pdf)],
        tmp_path,
        parse_func=fake_parse,
        parser_version="parser-v1",
    )
    second_manifest, second_parsed = parse_user_pdfs(
        [str(pdf)],
        tmp_path,
        parse_func=fake_parse,
        parser_version="parser-v2",
    )
    third_manifest, third_parsed = parse_user_pdfs(
        [str(pdf)],
        tmp_path,
        parse_func=lambda _: (_ for _ in ()).throw(AssertionError("v2 cache should be used")),
        parser_version="parser-v2",
    )

    assert calls["n"] == 2
    assert first_manifest.files[0].cache_hit is False
    assert second_manifest.files[0].cache_hit is False
    assert second_manifest.files[0].parser_cache_version == "parser-v2"
    assert second_parsed[str(pdf)]["full_text"].endswith("2")
    assert third_manifest.files[0].cache_hit is True
    assert third_parsed[str(pdf)]["full_text"].endswith("2")


def test_parse_file_with_cache_reuses_hash_and_parser_version(tmp_path: Path) -> None:
    fulltext = tmp_path / "article.html"
    fulltext.write_text("<html>trial text</html>", encoding="utf-8")
    calls = {"n": 0}

    def fake_parse(path: str) -> dict:
        calls["n"] += 1
        return {
            "full_text": f"trial text call {calls['n']}",
            "abstract": "",
            "sections": {},
            "tables": [],
            "page_map": [{"page_number": 1, "start_char": 0, "end_char": 16}],
        }

    first, first_hit = parse_file_with_cache(
        fulltext,
        tmp_path,
        parse_func=fake_parse,
        parser_used="html_parser",
        parser_version="html-v1",
    )
    second, second_hit = parse_file_with_cache(
        fulltext,
        tmp_path,
        parse_func=lambda _: (_ for _ in ()).throw(AssertionError("cache should be used")),
        parser_used="html_parser",
        parser_version="html-v1",
    )

    assert calls["n"] == 1
    assert first_hit is False
    assert second_hit is True
    assert first["_source_sha256"] == second["_source_sha256"]
    assert second["_parser_used"] == "html_parser"
    assert second["full_text"].endswith("1")


def test_pdf_intake_manifest_records_failures_and_saves(tmp_path: Path) -> None:
    pdf = tmp_path / "broken.pdf"
    pdf.write_bytes(b"not a real pdf")

    manifest, parsed = parse_user_pdfs(
        [str(pdf)],
        tmp_path,
        parse_func=lambda _: (_ for _ in ()).throw(RuntimeError("parse failed")),
    )
    record = manifest.files[0]

    assert record.parse_status == "failed"
    assert record.parse_error == "parse failed"
    assert record.requires_user_review is True
    assert parsed[str(pdf)]["full_text"] == ""

    output_path = save_pdf_intake_manifest(manifest, tmp_path / "project")
    assert output_path.exists()
    assert "broken.pdf" in output_path.read_text(encoding="utf-8")
