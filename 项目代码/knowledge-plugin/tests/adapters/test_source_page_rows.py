"""Stable records in public regulator tables need no invented detail URL."""

from dataclasses import replace
from datetime import datetime, timezone
import gzip
from pathlib import Path

from knowledge_plugin.adapters import REGISTRY
from knowledge_plugin.model import FetchResult, RequestSpec
from knowledge_plugin.registry import load_registry


ROOT = Path(__file__).resolve().parents[2]
SOURCE = next(row.source for row in load_registry(ROOT / 'registry/sources.json')
              if row.source.id == 'fda-novel-drug-approvals')
URL = 'https://www.fda.gov/drugs/development-approval-process-drugs/novel-drug-approvals-2026'
CONFIG = {
    **SOURCE.config,
    'link_to_source_page': True,
    'selectors': {
        'item': 'table tbody tr',
        'id': 'td:nth-child(2)',
        'title': 'td:nth-child(2)',
        'summary': 'td:nth-child(5)',
        'date': 'td:nth-child(4)',
    },
}


def test_regulatory_table_records_keep_real_page_link_and_distinct_stable_keys():
    body = gzip.decompress((ROOT / 'tests/fixtures/source-expansion-20260929/'
                            'fda-novel-drug-approvals-0.body.gz').read_bytes())
    now = datetime(2026, 9, 29, tzinfo=timezone.utc)
    response = FetchResult(RequestSpec(URL), URL, 200, {'content-type': 'text/html'}, body, now)
    source = replace(SOURCE, config=CONFIG)
    assert not REGISTRY['html-list'].validate_config(source)
    output = REGISTRY['html-list'].parse(response, source, now)
    assert len(output.entries) == 44
    assert len({entry.external_key for entry in output.entries}) == 44
    assert all(entry.url == URL for entry in output.entries)
    assert output.entries[0].title == 'Atebrioz'
    assert output.entries[0].published_at == datetime(2026, 9, 25, tzinfo=timezone.utc)
    assert 'heterotopic ossification' in output.entries[0].summary
    assert 'link-derived' in output.entries[0].defects
    assert 'html_list_source_page_links=44' in output.notes


def test_source_page_link_requires_actual_row_identity_and_an_allowed_public_page():
    adapter = REGISTRY['html-list']
    assert adapter.validate_config(replace(SOURCE, config={**CONFIG, 'selectors': {
        key: value for key, value in CONFIG['selectors'].items() if key != 'id'
    }}))
    now = datetime(2026, 9, 29, tzinfo=timezone.utc)
    body = b'<table><tr><td>1</td><td>Example</td><td></td><td>9/25/2026</td><td>Details</td></tr></table>'
    private = 'https://unrelated.example/records'
    response = FetchResult(RequestSpec(private), private, 200, {'content-type': 'text/html'}, body, now)
    assert not adapter.parse(response, replace(SOURCE, config=CONFIG), now).entries
    missing_id = body.replace(b'<td>Example</td>', b'<td></td>')
    response = FetchResult(RequestSpec(URL), URL, 200, {'content-type': 'text/html'}, missing_id, now)
    assert not adapter.parse(response, replace(SOURCE, config=CONFIG), now).entries
