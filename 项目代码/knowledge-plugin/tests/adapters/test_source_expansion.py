"""Source admission is backed by captured protected reads, never adapter availability alone."""
from dataclasses import replace
from datetime import datetime
import gzip
import hashlib
import json
from pathlib import Path

import pytest

from knowledge_plugin.adapters import REGISTRY
from knowledge_plugin.model import FetchError, FetchResult, RequestSpec
from knowledge_plugin.registry import load_registry

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'tests/fixtures/source-expansion-20260929'
EVIDENCE = json.loads((FIXTURES / 'probe-captures.json').read_text())['rows']
READABLE_P1 = [row for row in EVIDENCE if row['group'] == 'p1' and row['outcome'] == 'ok']
SOURCES = {row.source.id: row for row in load_registry(ROOT / 'registry/sources.json')}


def response(record, index=0):
    capture = record['captures'][index]
    body = gzip.decompress((FIXTURES / capture['file']).read_bytes())
    assert hashlib.sha256(body).hexdigest() == capture['sha256']
    at = datetime.fromisoformat(record['at'])
    return FetchResult(RequestSpec(capture['url']), capture['url'], capture['status'], capture['headers'], body, at)


@pytest.mark.parametrize('record', READABLE_P1, ids=lambda row: row['id'])
def test_only_positively_probed_p1_sources_are_enabled_and_replay(record):
    row = SOURCES[record['id']]
    assert row.enabled
    assert not REGISTRY[row.source.access].validate_config(row.source)
    entries = [entry for index in range(len(record['captures'])) for entry in REGISTRY[row.source.access].parse(response(record, index), row.source, datetime.fromisoformat(record['at'])).entries]
    assert len(entries) == record['entries']
    assert entries[0].title == record['samples'][0]['title']


def test_owner_exclusions_are_explicit_for_every_cde_and_fierce_source():
    excluded = [row for name, row in SOURCES.items() if name.startswith(('cde-', 'fierce-'))]
    assert len(excluded) == 6
    assert all(not row.enabled and row.disabled_reason == 'owner_excluded' for row in excluded)


def test_selector_recovery_uses_vetted_dated_candidates_and_keeps_primary_config():
    record = next(row for row in EVIDENCE if row['id'] == 'nice-news-05')
    source = SOURCES['nice-news-05'].source
    original = {'item': '.retired-page-class', 'title': 'h3 a', 'link': 'h3 a@href', 'date': 'time@datetime'}
    fallback = {'item': 'article', 'title': 'h3 a', 'link': 'h3 a@href', 'date': 'time@datetime'}
    configured = replace(source, config={**source.config, 'selectors': original, 'selector_fallbacks': [fallback]})
    parsed = REGISTRY['html-list'].parse(response(record), configured, datetime.fromisoformat(record['at']))
    assert len(parsed.entries) == 6
    assert all(entry.published_at is not None for entry in parsed.entries)
    assert 'html_list_recovered_selector=0' in parsed.notes
    assert configured.config['selectors'] == original
    blocked = replace(response(record), body=b'<html><title>Attention Required! | Cloudflare</title><article><h3><a href="/fake">Fake story</a></h3><time datetime="2026-09-29"></time></article></html>')
    with pytest.raises(FetchError, match='cloudflare'):
        REGISTRY['html-list'].parse(blocked, configured, datetime.fromisoformat(record['at']))


def test_selector_recovery_refuses_undated_navigation_and_unbounded_candidates():
    source = SOURCES['nice-news-05'].source
    fallback = {'item': 'nav li', 'title': 'a', 'link': 'a@href', 'date': 'time@datetime'}
    configured = replace(source, config={**source.config, 'selectors': {'item': '.missing', 'title': 'a', 'link': 'a@href'}, 'selector_fallbacks': [fallback]})
    record = next(row for row in EVIDENCE if row['id'] == 'nice-news-05')
    parsed = REGISTRY['html-list'].parse(response(record), configured, datetime.fromisoformat(record['at']))
    assert not parsed.entries
    too_many = replace(configured, config={**configured.config, 'selector_fallbacks': [fallback] * 4})
    assert REGISTRY['html-list'].validate_config(too_many)


@pytest.mark.parametrize('record', [row for row in EVIDENCE if row.get('enabledAfterProbe')], ids=lambda row: row['id'])
def test_recovered_relay_selectors_match_the_actual_captured_entries(record):
    row = SOURCES[record['id']]
    assert row.enabled
    assert not REGISTRY[row.source.access].validate_config(row.source)
    parsed = REGISTRY[row.source.access].parse(response(record), row.source, datetime.fromisoformat(record['at']))
    assert len(parsed.entries) == record['parsedEntries']
    assert sum(entry.published_at is not None for entry in parsed.entries) == record['parsedDated']
    assert parsed.entries[0].title == record['parsedSamples'][0]['title']
    if record['id'] == 'nice-in-consultation':
        assert all(entry.published_at is None for entry in parsed.entries), 'consultation deadlines are not publication dates'
        assert all(entry.summary.startswith('Consultation closes:') for entry in parsed.entries)


def test_probe_capture_urls_and_body_hashes_are_safe_and_complete():
    from urllib.parse import parse_qs, urlsplit
    assert len(EVIDENCE) == 100
    for record in EVIDENCE:
        for index, capture in enumerate(record['captures']):
            parsed = urlsplit(capture['url'])
            assert parsed.username is None and parsed.password is None
            assert not set(parse_qs(parsed.query)) & {'api_key', 'apikey', 'token', 'password', 'access_token', 'email', 'mailto'}
            response(record, index)


def test_unaccepted_probes_do_not_become_enabled_by_the_expansion():
    later = json.loads((ROOT / 'registry/research/source-expansion-2026-09-30.json').read_text())
    subsequently_verified = {row['id'] for row in later['rows'] if row['decision'] == 'enabled'}
    for record in EVIDENCE:
        if record['id'] in subsequently_verified:
            continue  # The later complete-scope replay suite verifies the replacement representation.
        if record['outcome'] not in ('ok', 'readable') or (record['group'] == 'relay-page' and not record.get('enabledAfterProbe')):
            assert not SOURCES[record['id']].enabled
