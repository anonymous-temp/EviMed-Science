"""Fixtures of the social tests (contract 1.5.0). Every provider is faked (``social_fakes``): no test reaches SocialData,
Dajiala or the GEO crawler, and no key file holds a real key."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

HERE = str(Path(__file__).resolve().parent)
if HERE not in sys.path:
    sys.path.insert(0, HERE)


@pytest.fixture()
def social_settings(settings, tmp_path):
    """The database settings with key files (fake keys), a media directory and the GEO crawler address."""
    from dataclasses import replace

    socialdata = tmp_path / "socialdata.api-key"
    socialdata.write_text("fake-socialdata-key\n")
    dajiala = tmp_path / "dajiala.api-key"
    dajiala.write_text("fake-dajiala-key\n")
    media = tmp_path / "media"
    media.mkdir()
    return replace(settings, socialdata_key_file=str(socialdata), dajiala_key_file=str(dajiala), media_dir=str(media),
                   social_crawl_url="http://crawler.test:9966")
