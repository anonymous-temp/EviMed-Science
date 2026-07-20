from __future__ import annotations

import json
from pathlib import Path

from new_meta.core.benchmark_manifest import BenchmarkManifest, evaluate_project_against_benchmark
from new_meta.core.fulltext_uploads import attach_user_fulltexts_to_project
from new_meta.core.project import Project


SGLT2_MANIFEST = Path("docs/benchmarks/sglt2_hfpef_2022.manifest.json")


def _project(tmp_path: Path) -> Project:
    return Project("fulltext upload", output_dir=tmp_path)


def _fake_parsed(title: str) -> dict:
    return {
        "full_text": f"[PAGE 1]\n{title}\nPrimary outcome table with hazard ratio.",
        "abstract": "",
        "sections": {},
        "tables": ["| outcome | HR |\n| - | - |\n| primary | 0.80 |"],
        "page_map": [{"page_number": 1, "start_char": 0, "end_char": len(title) + 50}],
    }


def test_attach_user_fulltext_replaces_abstract_only_primary_source_and_clears_downstream(tmp_path: Path) -> None:
    project = _project(tmp_path)
    pdf = tmp_path / "34449189.pdf"
    pdf.write_bytes(b"%PDF fake")
    paper = {
        "pmid": "34449189",
        "doi": "10.1056/NEJMoa2107038",
        "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
        "text_availability": "abstract_only",
        "fulltext_source": "europe_pmc_abstract",
        "needs_user_full_text": True,
    }
    project.save_json("pdf_download_results.json", [dict(paper)])
    project.save_json("full_text_screening.json", [{"decision": "include", "paper": dict(paper)}], subdir="screening")
    project.save_json("text_source_warnings.json", [dict(paper, warning="abstract only")])
    for step in ["pdf_download", "pdf_parsing", "ft_screening", "extraction", "rob", "effect_sizes", "meta_analysis", "grade", "figures", "manuscript"]:
        project.save_checkpoint(step)

    result = attach_user_fulltexts_to_project(
        project,
        [str(pdf)],
        parse_func=lambda _: _fake_parsed("Empagliflozin in Heart Failure with a Preserved Ejection Fraction"),
    )

    download_rows = project.load_json("pdf_download_results.json")
    ft_rows = project.load_json("full_text_screening.json", subdir="screening")
    parsed_cache = project.load_json("parsed_papers.json", subdir="papers")
    manifest = json.loads((project.base_dir / "pdf_intake_manifest.json").read_text(encoding="utf-8"))

    assert result["matched"] == 1
    assert result["unmatched"] == 0
    assert result["requires_resume"] is True
    assert result["rerun_from_step"] == "pdf_parsing"
    assert result["next_actions"][0]["type"] == "resume_project"
    assert result["cleared_checkpoints"] == [
        "pdf_parsing",
        "ft_screening",
        "extraction",
        "rob",
        "effect_sizes",
        "meta_analysis",
        "grade",
        "figures",
        "manuscript",
    ]
    assert project.is_step_done("pdf_download") is True
    assert project.is_step_done("pdf_parsing") is False
    assert download_rows[0]["text_availability"] == "full_text"
    assert download_rows[0]["fulltext_source"] == "user_upload"
    assert download_rows[0]["user_uploaded_full_text"] is True
    assert "needs_user_full_text" not in download_rows[0]
    assert ft_rows[0]["paper"]["text_availability"] == "full_text"
    assert "34449189" in parsed_cache
    assert project.load_json("text_source_warnings.json") == []
    assert manifest["files"][0]["matched_pmid"] == "34449189"
    assert manifest["files"][0]["match_method"] == "filename_pmid"
    assert Path(manifest["files"][0]["local_path"]).parent == project.base_dir / "user_fulltexts"
    assert download_rows[0]["pdf_path"].startswith(str(project.base_dir / "user_fulltexts"))


def test_attach_user_fulltext_emits_pdf_intake_progress_records(tmp_path: Path) -> None:
    project = _project(tmp_path)
    pdf = tmp_path / "34449189.pdf"
    pdf.write_bytes(b"%PDF fake")
    project.save_json("pdf_download_results.json", [
        {
            "pmid": "34449189",
            "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
            "text_availability": "abstract_only",
        }
    ])
    events = []

    result = attach_user_fulltexts_to_project(
        project,
        [str(pdf)],
        parse_func=lambda _: _fake_parsed("Empagliflozin in Heart Failure with a Preserved Ejection Fraction"),
        progress_cb=lambda record: events.append(record.model_dump()),
    )

    assert result["matched"] == 1
    assert len(events) == 1
    assert events[0]["filename"] == "34449189.pdf"
    assert events[0]["parse_status"] == "ok"
    assert events[0]["text_chars"] > 0
    assert events[0]["table_count"] == 1


def test_attach_user_fulltext_keeps_unmatched_pdf_for_review_without_synthetic_record(tmp_path: Path) -> None:
    project = _project(tmp_path)
    pdf = tmp_path / "unmatched.pdf"
    pdf.write_bytes(b"%PDF fake")
    project.save_json("pdf_download_results.json", [
        {"pmid": "123", "title": "Known Trial", "text_availability": "abstract_only"}
    ])

    result = attach_user_fulltexts_to_project(
        project,
        [str(pdf)],
        parse_func=lambda _: _fake_parsed("Completely Different Uploaded Article"),
    )

    download_rows = project.load_json("pdf_download_results.json")
    manifest = json.loads((project.base_dir / "pdf_intake_manifest.json").read_text(encoding="utf-8"))

    assert result["matched"] == 0
    assert result["unmatched"] == 1
    assert result["requires_resume"] is False
    assert result["next_actions"][0]["type"] == "review_unmatched_uploads"
    assert download_rows == [{"pmid": "123", "title": "Known Trial", "text_availability": "abstract_only"}]
    assert manifest["files"][0]["requires_user_review"] is True
    assert manifest["files"][0]["matched_pmid"] is None


def test_primary_full_text_recall_passes_after_user_uploaded_primary_pdfs(tmp_path: Path) -> None:
    project = _project(tmp_path)
    manifest = BenchmarkManifest.load(SGLT2_MANIFEST)
    papers = [
        {
            "pmid": "34449189",
            "doi": "10.1056/NEJMoa2107038",
            "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
            "text_availability": "abstract_only",
            "fulltext_source": "europe_pmc_abstract",
        },
        {
            "pmid": "36027570",
            "doi": "10.1056/NEJMoa2206286",
            "title": "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction",
            "text_availability": "abstract_only",
            "fulltext_source": "europe_pmc_abstract",
        },
    ]
    project.save_json("full_text_screening.json", [{"decision": "include", "paper": dict(p)} for p in papers], subdir="screening")
    project.save_json("pdf_download_results.json", [dict(p) for p in papers])
    emp = tmp_path / "34449189.pdf"
    dapa = tmp_path / "36027570.pdf"
    emp.write_bytes(b"%PDF emp")
    dapa.write_bytes(b"%PDF dapa")

    before = evaluate_project_against_benchmark(manifest, project.base_dir)
    assert before.primary_full_text_recall is not None
    assert before.primary_full_text_recall.passed is False

    result = attach_user_fulltexts_to_project(
        project,
        [str(emp), str(dapa)],
        parse_func=lambda path: _fake_parsed(
            "Empagliflozin in Heart Failure with a Preserved Ejection Fraction"
            if "34449189" in path else
            "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction"
        ),
    )
    after = evaluate_project_against_benchmark(manifest, project.base_dir)

    assert result["matched"] == 2
    assert after.primary_full_text_recall is not None
    assert after.primary_full_text_recall.passed is True
    assert after.primary_full_text_recall.matched == 2


def test_attach_user_fulltext_prefers_filename_title_over_loose_text_overlap(tmp_path: Path) -> None:
    project = _project(tmp_path)
    dapa = tmp_path / "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction..pdf"
    empa = tmp_path / "Empagliflozin in Heart Failure with a Preserved Ejection Fraction..pdf"
    dapa.write_bytes(b"%PDF dapa")
    empa.write_bytes(b"%PDF empa")
    project.save_json(
        "pdf_download_results.json",
        [
            {
                "pmid": "34449189",
                "doi": "10.1056/NEJMoa2107038",
                "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
                "text_availability": "abstract_only",
            },
            {
                "pmid": "36027570",
                "doi": "10.1056/NEJMoa2206286",
                "title": "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction",
                "text_availability": "abstract_only",
            },
            {
                "pmid": "31227014",
                "doi": "10.1186/s13063-019-3474-5",
                "title": "Empagliflozin outcome trial in patients with chronic heart failure with preserved ejection fraction",
                "text_availability": "full_text",
            },
        ],
    )

    def fake_parse(path: str) -> dict:
        # This text intentionally mentions all candidate titles, mimicking papers
        # that cite adjacent trials. Filename title should still win.
        return _fake_parsed(
            "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction "
            "Empagliflozin in Heart Failure with a Preserved Ejection Fraction "
            "Empagliflozin outcome trial in patients with chronic heart failure with preserved ejection fraction"
        )

    result = attach_user_fulltexts_to_project(
        project,
        [str(dapa), str(empa)],
        parse_func=fake_parse,
    )

    by_file = {item["file"]: item for item in result["matches"]}

    assert result["matched"] == 2
    assert by_file[dapa.name]["pmid"] == "36027570"
    assert by_file[dapa.name]["match_method"] == "filename_title"
    assert by_file[empa.name]["pmid"] == "34449189"
    assert by_file[empa.name]["match_method"] == "filename_title"


def test_attach_user_fulltext_prefers_exact_title_over_subgroup_title(tmp_path: Path) -> None:
    project = _project(tmp_path)
    dapa = tmp_path / "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction..pdf"
    dapa.write_bytes(b"%PDF dapa")
    project.save_json(
        "pdf_download_results.json",
        [
            {
                "pmid": "36029467",
                "doi": "10.1161/circheartfailure.122.010080",
                "title": "Efficacy and Safety of Dapagliflozin in Heart Failure With Mildly Reduced or Preserved Ejection Fraction According to Age: The DELIVER Trial",
                "text_availability": "abstract_only",
            },
            {
                "pmid": "36027570",
                "doi": "10.1056/NEJMoa2206286",
                "title": "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction",
                "text_availability": "abstract_only",
            },
        ],
    )

    result = attach_user_fulltexts_to_project(
        project,
        [str(dapa)],
        parse_func=lambda _: _fake_parsed(
            "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction "
            "10.1056/NEJMoa2206286"
        ),
    )

    assert result["matched"] == 1
    assert result["matches"][0]["pmid"] == "36027570"
    assert result["matches"][0]["match_method"] == "filename_title"
