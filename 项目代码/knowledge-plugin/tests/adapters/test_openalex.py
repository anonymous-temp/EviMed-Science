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
SOURCES = {row.source.id: row.source for row in load_registry(ROOT / 'registry/sources.json')}
NOW = datetime(2026, 9, 30, tzinfo=timezone.utc)


@pytest.mark.parametrize('sid', ['openalex-medicine-newest', 'openalex-medicine-most-cited-30d'])
def test_openalex_real_bounded_medical_work_lists(sid):
    source = SOURCES[sid]
    body = gzip.decompress((ROOT / f'tests/fixtures/source-expansion-20260930/{sid}-bounded.body.gz').read_bytes())
    payload = json.loads(body)
    result = FetchResult(RequestSpec(source.config['url']), source.config['url'], 200, {'content-type': 'application/json'}, body, NOW)
    assert not REGISTRY['json-api'].validate_config(source)
    entries = REGISTRY['json-api'].parse(result, source, NOW).entries
    assert len(entries) == 50
    assert entries[0].title == payload['results'][0]['title']
    assert entries[-1].external_key == payload['results'][-1]['id']
    assert all(entry.published_at <= NOW for entry in entries)
    assert all(entry.url.startswith(('https://doi.org/', 'https://openalex.org/W')) for entry in entries)


def test_openalex_refuses_non_work_identity_and_unexpected_response_shapes():
    source = SOURCES['openalex-medicine-newest']
    def parse(payload):
        body = json.dumps(payload).encode()
        result = FetchResult(RequestSpec('https://api.openalex.org/works'), None, 200, {'content-type': 'application/json'}, body, NOW)
        return REGISTRY['json-api'].parse(result, source, NOW)
    assert not parse({'results': [{'id': 'https://127.0.0.1/private', 'title': 'Wrong identity'}]}).entries
    with pytest.raises(FetchError, match='records_missing'):
        parse({'error': 'not works'})
