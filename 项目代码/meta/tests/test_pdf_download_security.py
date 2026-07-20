from pathlib import Path

import pytest

from start import _safe_child_path, _safe_pdf_filename, _validate_download_url


def test_safe_pdf_filename_strips_path_components() -> None:
    name = _safe_pdf_filename("../../trial table.pdf", "fallback.pdf")

    assert name == "trial_table.pdf"
    assert "/" not in name
    assert "\\" not in name


def test_safe_child_path_rejects_traversal(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        _safe_child_path(tmp_path, "../escape.pdf")


def test_validate_download_url_blocks_local_addresses() -> None:
    with pytest.raises(ValueError):
        _validate_download_url("https://127.0.0.1/paper.pdf")
    with pytest.raises(ValueError):
        _validate_download_url("https://localhost/paper.pdf")
    with pytest.raises(ValueError):
        _validate_download_url("http://example.org/paper.pdf")
