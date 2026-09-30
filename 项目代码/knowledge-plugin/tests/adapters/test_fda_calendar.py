"""FDA's own DataTables endpoint; meeting time is not the announcement timestamp."""
from dataclasses import replace
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path

import pytest

from knowledge_plugin.adapters import REGISTRY
from knowledge_plugin.model import FetchError, FetchResult, RequestSpec
from knowledge_plugin.registry import load_registry

ROOT = Path(__file__).resolve().parents[2]
BASE = next(row.source for row in load_registry(ROOT / 'registry/sources.json')
            if row.source.id == 'fda-advisory-committee-calendar')
URL = 'https://www.fda.gov/datatables-json/advisory-committee-calendar-json'
SOURCE = replace(BASE, access='json-api', config={**BASE.config, 'url': URL, 'family': 'fda-advisory-calendar'})


def test_fda_calendar_replays_publisher_json_and_keeps_meeting_dates_in_context():
    body = gzip.decompress((ROOT / 'tests/fixtures/source-expansion-20260930/fda-advisory-calendar-json.body.gz').read_bytes())
    now = datetime(2026, 9, 30, tzinfo=timezone.utc)
    result = FetchResult(RequestSpec(URL), URL, 200, {'content-type': 'application/json'}, body, now)
    assert not REGISTRY['json-api'].validate_config(SOURCE)
    parsed = REGISTRY['json-api'].parse(result, SOURCE, now)
    assert len(parsed.entries) == 197
    first = parsed.entries[0]
    assert first.title.startswith('February 19, 2016: Orthopaedic')
    assert first.url.startswith('https://www.fda.gov/advisory-committees/advisory-committee-calendar/')
    assert first.published_at == datetime(2024, 3, 8, 0, 59, tzinfo=timezone.utc)
    assert '02/19/2016 03:00 AM EST' in first.summary
    assert 'source-modified-time' in parsed.notes


def test_fda_calendar_ignores_offsite_records_and_non_record_payloads():
    now = datetime(2026, 9, 30, tzinfo=timezone.utc)
    for body in (b'[]', json.dumps([{'title': '<a href="https://example.org/fake">Fake announcement</a>'}]).encode()):
        result = FetchResult(RequestSpec(URL), URL, 200, {'content-type': 'application/json'}, body, now)
        assert not REGISTRY['json-api'].parse(result, SOURCE, now).entries
    result = FetchResult(RequestSpec(URL), URL, 200, {'content-type': 'application/json'}, b'{}', now)
    with pytest.raises(FetchError, match='records_missing'):
        REGISTRY['json-api'].parse(result, SOURCE, now)
