"""Society lists must preserve real records and describe their actual coverage."""
from dataclasses import replace
from datetime import datetime, timezone
import gzip
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from knowledge_plugin.adapters import REGISTRY
from knowledge_plugin.model import FetchResult, RequestSpec
from knowledge_plugin.registry import load_registry

ROOT = Path(__file__).resolve().parents[2]
ROWS = {row.source.id: row for row in load_registry(ROOT / 'registry/sources.json')}
NOW = datetime(2026, 9, 30, tzinfo=timezone.utc)


def replay(sid):
    source = ROWS[sid].source
    body = gzip.decompress((ROOT / f'tests/fixtures/source-expansion-20260930/{sid}-direct-0.body.gz').read_bytes())
    response = FetchResult(RequestSpec(source.config['url']), source.config['url'], 200, {'content-type': 'text/html'}, body, NOW)
    return REGISTRY[source.access].parse(response, source, NOW)


def test_csco_captured_columns_are_not_conference_or_news_records():
    entries = replay('csco-annual-meeting').entries
    assert len(entries) == 106
    assert all(urlsplit(entry.url).path.endswith('/ncontent.aspx') for entry in entries)
    assert all(parse_qs(urlsplit(entry.url).query).get('oid', [''])[0].isdigit() for entry in entries)
    assert all('nlist.aspx' not in entry.url for entry in entries)
    assert entries[0].url.endswith('ncontent.aspx?oid=9359')


def test_ash_uses_the_nonempty_record_anchor_and_both_publisher_date_formats():
    output = replay('ash-annual-meeting')
    entries = output.entries
    assert len(entries) == 30
    assert entries[0].title == 'ASH Sets New Standards for Diagnosing Iron Deficiency'
    assert entries[0].url.endswith('/2026/ash-sets-new-standards-for-diagnosing-iron-deficiency')
    assert entries[0].published_at == datetime(2026, 9, 16, tzinfo=timezone.utc)
    may = next(entry for entry in entries if entry.title.startswith('New Approach Could Lead to Earlier Diagnosis'))
    assert may.published_at == datetime(2026, 5, 20, tzinfo=timezone.utc)
    assert all(entry.published_at is not None for entry in entries)
    assert not any(note.startswith(('html_list_dropped_title=', 'html_list_dates_empty')) for note in output.notes)


@pytest.mark.parametrize('sid, name, homepage', [
    ('csco-annual-meeting', 'CSCO 中国临床肿瘤学会动态', 'https://www.csco.org.cn/cn/index.aspx'),
    ('ash-annual-meeting', '美国血液学会 ASH 新闻室', 'https://www.hematology.org/newsroom'),
    ('escmid-global', '欧洲临床微生物与感染病学会 ESCMID 动态', 'https://www.escmid.org/'),
])
def test_legacy_conference_ids_describe_their_verified_society_news_coverage(sid, name, homepage):
    row = ROWS[sid]
    assert row.source.name == name
    assert row.source.homepage == homepage
    assert row.source.lane == 'mixed'
    assert row.source.source_type == 'evidence-body'
    assert row.category == 'medical-society-news'


def test_date_format_candidates_are_a_bounded_list_of_actual_formats():
    source = ROWS['ash-annual-meeting'].source
    for formats in ('%b. %d, %Y', [None], ['%Y'] * 5):
        invalid = replace(source, config={**source.config, 'date_formats': formats})
        assert REGISTRY[source.access].validate_config(invalid)
