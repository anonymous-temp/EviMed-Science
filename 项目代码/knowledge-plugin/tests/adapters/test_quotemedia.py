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
SOURCE = next(row.source for row in load_registry(ROOT / 'registry/sources.json') if row.source.id == 'moderna-news')
SOURCE = replace(SOURCE, config={**SOURCE.config, 'family': 'quotemedia-headlines', 'link_hosts': ['api.quotemedia.com']})
URL = 'https://www.accesswire.com/qm/data/getHeadlines.json?topics=MRNA'
NOW = datetime(2026, 9, 30, tzinfo=timezone.utc)


def test_publisher_linked_quote_media_feed_preserves_dates_distributor_and_excerpt_limits():
    body = gzip.decompress((ROOT / 'tests/fixtures/source-expansion-20260930/moderna-public-headlines.body.gz').read_bytes())
    result = FetchResult(RequestSpec(URL), URL, 200, {'content-type': 'application/json'}, body, NOW)
    assert not REGISTRY['json-api'].validate_config(SOURCE)
    entries = REGISTRY['json-api'].parse(result, SOURCE, NOW).entries
    assert len(entries) == 5
    assert entries[0].title == 'Moderna Announces Late-Breaking Data to be Presented at ESMO Congress 2026'
    assert entries[0].published_at == datetime(2026, 9, 21, 14, 12, tzinfo=timezone.utc)
    assert entries[0].summary.startswith('ACCESS Newswire via QuoteMedia:')
    assert 'truncated-summary' in entries[0].defects
    assert len({entry.external_key for entry in entries}) == 5


def test_quote_media_malformed_response_and_off_host_links_are_not_records():
    payload = {'results': {'news': [{'newsitem': [{'newsid': 1, 'headline': 'Wrong origin', 'storyurl': 'http://127.0.0.1/private'}]}]}}
    response = FetchResult(RequestSpec(URL), URL, 200, {'content-type': 'application/json'}, json.dumps(payload).encode(), NOW)
    assert not REGISTRY['json-api'].parse(response, SOURCE, NOW).entries
    with pytest.raises(FetchError, match='records_missing'):
        REGISTRY['json-api'].parse(replace(response, body=b'{}'), SOURCE, NOW)
