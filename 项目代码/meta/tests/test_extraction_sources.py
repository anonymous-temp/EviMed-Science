"""Exact source-reference transport without models, OCR repair, or edited evidence."""
from copy import deepcopy
import hashlib

import pytest

from new_meta.core.extraction_sources import source_catalogue, resolve_reference_payload, source_prompt


def catalogue(text, **kwargs):
    return source_catalogue(text, hashlib.sha256(text.encode()).hexdigest(), **kwargs)


def reference(catalog, first=0, last=None):
    return {"source_id": catalog["sources"][first]["source_id"],
            "end_source_id": catalog["sources"][first if last is None else last]["source_id"]}


def resolve(text, catalog, support):
    return resolve_reference_payload(text, catalog, {"primary_analysis_alignment": [
        {"outcome_index": 0, "outcome": {"status": "match", "rationale": "Reported.", **support}}]})


@pytest.mark.parametrize("text", [
    'A "quoted" value uses a \\ literal.\nSecond sentence.',
    '原文🙂：HR 0.38，95% CI 0.12–1.22。\tUnchanged Unicode.',
    'The albumin-to-\r\ncreatinine and cal-\nculated values.\nFinal "quote".',
])
def test_compact_prompt_losslessly_renders_ordered_original_spans(text):
    import json
    catalog = catalogue(text)
    original_catalog = deepcopy(catalog)
    rendered = source_prompt(text, catalog)
    lines = rendered.split("\n")
    assert len(lines) == len(catalog["sources"])
    for line, source in zip(lines, catalog["sources"]):
        identifier, quoted = line.split(" ", 1)
        assert identifier == f"[{source['source_id']}]"
        assert json.loads(quoted) == text[source["start"]:source["end"]]
        assert quoted == json.dumps(text[source["start"]:source["end"]], ensure_ascii=False)
        assert source["source_location"] not in line
    assert catalog == original_catalog


@pytest.mark.parametrize("text", [
    "Risk was cal-\nculated using the max-\nimum value.",
    "The albumin-to-\ncreatinine ratio and end-\npoint were reported.",
    "🙂 The HR was 0.38 (95% CI 0.12 to 1.22).\r\nDose 100 mg; 10² units.",
    "Renal-specific composite\n153/2202 0.66 (0.53 to 0.81)\nof ESRD, doubling of creatinine, or renal death.",
])
def test_contiguous_ranges_restore_exact_original_text(text):
    catalog = catalogue(text)
    resolved, errors, metadata = resolve(text, catalog, reference(catalog, 0, -1))
    assert errors == []
    assert resolved["primary_analysis_alignment"][0]["outcome"]["quote"] == text
    assert metadata[0]["start_byte"] == 0
    assert metadata[0]["end_byte"] == len(text.encode())


@pytest.mark.parametrize("damage", ["other_source", "unknown", "catalogue", "reverse", "quoted_fallback"])
def test_bad_references_never_turn_into_supplied_quotes(damage):
    text = "First complete sentence.\nSecond complete sentence."
    catalog = catalogue(text)
    support = reference(catalog)
    if damage == "other_source": support = reference(catalogue(text + " Different."))
    if damage == "unknown": support["source_id"] = "unknown"
    if damage == "catalogue": catalog["sources"][0]["start"] = 1
    if damage == "reverse": support = reference(catalog, -1, 0)
    if damage == "quoted_fallback": support.update(quote=text, source_location="Page 1")
    _, errors, _ = resolve(text, catalog, support)
    assert errors


def test_appended_tables_do_not_inherit_the_last_article_page():
    body = "[PAGE 7]\nArticle text."
    text = body + "\n\n## EXTRACTED TABLES\n\nUnknown-page table HR 0.38."
    catalog = catalogue(text, body_end=len(body), page_map=[{"page_number": 7, "start_char": 9, "end_char": len(body)}])
    result, errors, _ = resolve(text, catalog, reference(catalog, -1))
    assert not errors
    location = result["primary_analysis_alignment"][0]["outcome"]["source_location"]
    assert "Page 7" not in location and "Extracted tables" in location


def test_only_reference_fields_change_during_resolution():
    text = "Renal HR 0.38 and CI 0.12 to 1.22."
    catalog = catalogue(text)
    payload = {"data_issues": [{"outcome_index": 0, "field": "hr_ci_upper", "kind": "source_conflict",
        "rationale": "Uncertain source.", **reference(catalog)}], "score": 1,
        "primary_analysis_alignment": []}
    original = deepcopy(payload)
    resolved, errors, _ = resolve_reference_payload(text, catalog, payload)
    assert not errors and payload == original
    assert resolved["data_issues"][0]["kind"] == "source_conflict"
    assert resolved["score"] == 1


def test_meta6e_credence_table_keeps_the_actual_reading_order():
    # Exact contiguous checked-text fragment from Meta6e PMID 30990260.
    text = "End-stage\nkidney\ndisease,\ndoubling\nof\nserum\ncreatinine\n153/2202\n224/2199\n27.0\n40.4\n0.66\n(0.53–0.81)\n<0.001\nlevel,\nor\nrenal\ndeath"
    catalog = catalogue(text)
    result, errors, _ = resolve(text, catalog, reference(catalog, 0, -1))
    assert not errors
    quote = result["primary_analysis_alignment"][0]["outcome"]["quote"]
    assert quote == text
    from new_meta.core.extraction_verification import quote_is_anchored, numeric_value_in_quote
    assert quote_is_anchored(quote, "Table", text)
    assert numeric_value_in_quote(0.66, quote, "hazard_ratio")
    assert not quote_is_anchored("End-stage kidney disease, doubling of serum creatinine level, or renal death 153/2202", "Table", text)


def test_meta6e_japan_keeps_both_broken_words_and_compound_hyphens():
    # Exact checked-text excerpt from PMID 35861630; never dehyphenated.
    text = "hemoglobin (HbA1c) level of ≥6.5% and ≤12.0%, eGFR (as cal-\nculated by the equation for estimating Japanese GFR11) of ≥30\nand <90 mL/min/1.73 m2, and a median urinary albumin-to-\ncreatinine ratio (UACR) of ≥300 and ≤5,000 mg/g creatinine."
    catalog = catalogue(text)
    result, errors, _ = resolve(text, catalog, reference(catalog, 0, -1))
    assert not errors
    assert result["primary_analysis_alignment"][0]["outcome"]["quote"] == text
    assert all(not text[item["start"]:item["end"]].endswith(("cal-", "albumin-to-")) for item in catalog["sources"])


def test_meta6e_trial_acronym_cannot_authorize_an_invented_full_name():
    from extraction_source_fixture import wire_payload
    from new_meta.agents.data_extraction_agent import ExtractionCheckResult
    from new_meta.core.extraction_verification import validate_check_batch
    from test_extraction_verification import SOURCE, checked_row, study, protocol
    text = SOURCE + " The CREDENCE trial was mentioned for comparison."
    row = checked_row()
    row["verification"]["trial_units"] = [{"registry_id": "", "trial_name": "Canagliflozin and Renal Events in Diabetes with Established Nephropathy Clinical Evaluation",
        "role": "mentioned_only", "quote": "The CREDENCE trial was mentioned for comparison.", "source_location": "Discussion"}]
    catalog = catalogue(text)
    wire = wire_payload({"score": 9, "data_issues": [], "primary_analysis_alignment": [row]}, text, catalog)
    resolved, errors, _ = resolve_reference_payload(text, catalog, wire)
    assert not errors
    checked = ExtractionCheckResult.model_validate(resolved, strict=True)
    assert checked.primary_analysis_alignment[0].verification.trial_units[0].trial_name == row["verification"]["trial_units"][0]["trial_name"]
    assert any(error["code"] == "trial_identifier_not_anchored" for error in validate_check_batch(
        study(), [0], checked.primary_analysis_alignment, text, protocol()))


@pytest.mark.parametrize("damage", ["missing_receipt", "missing_raw", "raw_content", "source", "protocol", "row", "catalogue", "version", "resolved_status", "legacy_marker"])
def test_new_proofs_replay_bound_observations_and_never_downgrade(tmp_path, monkeypatch, damage):
    import json
    from new_meta.core.primary_analysis_alignment import alignment_status, _store_proof
    from test_extraction_raw_observations import run_provider, payload
    from test_extraction_verification import protocol
    project, result, _, _ = run_provider(tmp_path, monkeypatch, [json.dumps(payload())])
    proof = result.outcomes[0].primary_analysis_alignment
    assert proof.assessor == "extraction-check-sources-v3"
    assert alignment_status(project, protocol(), result, 0)["status"] == "match"
    reference = proof.source_reference.model_dump(mode="json")
    receipt = json.loads((project.base_dir / reference["path"]).read_text())
    if damage == "missing_receipt":
        (project.base_dir / reference["path"]).unlink()
    elif damage == "missing_raw":
        (project.base_dir / receipt["raw_record"]["path"]).unlink()
    else:
        def store(kind, record):
            raw = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
            checksum = hashlib.sha256(raw).hexdigest()
            location = f"extraction/verification/{kind}/{checksum}.json"
            (project.base_dir / location).write_bytes(raw)
            return {"path": location, "sha256": checksum}
        raw_record = json.loads((project.base_dir / receipt["raw_record"]["path"]).read_text())
        if damage == "raw_content": raw_record["raw_response"]["content"] = "{}"
        if damage == "source": raw_record["source_sha256"] = "a" * 64
        if damage == "protocol": raw_record["protocol_sha256"] = "a" * 64
        if damage == "row": raw_record["row_sha256"]["0"] = "a" * 64
        if damage == "catalogue":
            catalog = json.loads((project.base_dir / raw_record["catalogue"]["path"]).read_text())
            catalog["sources"][0]["start_byte"] += 1
            raw_record["catalogue"] = store("sources", catalog)
        if damage == "version": receipt["version"] = 99
        if damage == "resolved_status": receipt["resolved_response"]["primary_analysis_alignment"][0]["outcome"]["status"] = "mismatch"
        receipt["raw_record"] = store("raw", raw_record)
        reference = store("resolved", receipt)
        altered = proof.model_dump(mode="json", exclude={"proof_id"})
        altered["source_reference"] = reference
        if damage == "legacy_marker": altered["assessor"] = "extraction-check-v2"
        _store_proof(project, result, 0, altered)
        project.save_json("trial-paper.json", result, subdir="extraction")
    assert alignment_status(project, protocol(), result, 0)["status"] == "unknown"


def test_actual_response_is_durable_before_resolution_failure(tmp_path, monkeypatch):
    import json
    import new_meta.core.extraction_sources as sources
    from test_extraction_raw_observations import run_provider, payload
    from new_meta.core.primary_analysis_alignment import alignment_status
    from test_extraction_verification import protocol
    def fail(*_args):
        records = list(tmp_path.rglob("extraction/verification/raw/*.json"))
        assert len(records) == 1
        assert json.loads(records[0].read_text())["raw_response"]["content"] == raw
        raise RuntimeError("Synthetic resolution failure")
    raw = json.dumps(payload())
    monkeypatch.setattr(sources, "resolve_reference_payload", fail)
    project, result, calls, _ = run_provider(tmp_path, monkeypatch, [raw, raw])
    assert len(calls) == 1
    assert alignment_status(project, protocol(), result, 0)["status"] == "unknown"


@pytest.mark.parametrize("dimension", ["contrast", "population", "outcome"])
def test_bad_reference_cannot_hide_another_valid_negative(tmp_path, monkeypatch, dimension):
    import json
    from test_extraction_raw_observations import run_provider, payload
    from new_meta.core.primary_analysis_alignment import recover_issue_history
    first = payload()
    row = first["primary_analysis_alignment"][0]
    row[dimension]["status"] = "mismatch"
    row["verification"]["numeric_findings"][0]["source_id"] = "unknown-source"
    raw = json.dumps(first)
    project, result, calls, observations = run_provider(tmp_path, monkeypatch, [raw, json.dumps(payload())])
    assert len(calls) == 1
    assert recover_issue_history(project, result, 0)[1] is False
    assert any(item.get("retained_clinical_judgments") for item in observations)
    records = list((project.base_dir / "extraction/verification/raw").glob("*.json"))
    resolutions = list((project.base_dir / "extraction/verification/resolved").glob("*.json"))
    assert len(records) == len(resolutions) == 1
    assert json.loads(records[0].read_text())["raw_response"]["content"] == raw


def test_resolved_range_is_bounded_without_clipping_source():
    text = "Sentence with numeric 0.38 and qualifier.\n" * 300
    catalog = catalogue(text)
    _, errors, _ = resolve(text, catalog, reference(catalog, 0, -1))
    assert errors == [{"code": "verification_source_range_invalid", "path": "primary_analysis_alignment/0/outcome"}]
