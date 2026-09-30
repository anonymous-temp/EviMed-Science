"""Every omitted source has protected evidence and a reviewable disposition."""
from datetime import datetime
import gzip
import hashlib
import json
from pathlib import Path

import pytest

from knowledge_plugin.adapters import REGISTRY
from knowledge_plugin.model import FetchResult, RequestSpec
from knowledge_plugin.normalize import prepare
from knowledge_plugin.registry import load_registry

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / 'registry/research/source-expansion-2026-09-30.json').read_text())
ROWS = {row.source.id: row for row in load_registry(ROOT / 'registry/sources.json')}
ADMITTED = [row for row in MANIFEST['rows'] if row['decision'] == 'enabled']


@pytest.mark.parametrize('record', ADMITTED, ids=lambda record: record['id'])
def test_admitted_source_replays_real_entries_from_its_protected_capture(record):
    row = ROWS[record['id']]
    assert row.enabled
    assert not REGISTRY[row.source.access].validate_config(row.source)
    evidence = next(item for item in record['evidence'] if item['group'] == record['captureGroup'])
    entries = []
    for capture in evidence['captures']:
        path = ROOT / 'tests/fixtures/source-expansion-20260930' / capture['file']
        body = gzip.decompress(path.read_bytes())
        assert hashlib.sha256(body).hexdigest() == capture['sha256']
        at = datetime.fromisoformat(evidence['at'])
        response = FetchResult(RequestSpec(capture['url']), capture['url'], capture['status'], capture['headers'], body, at)
        entries.extend(REGISTRY[row.source.access].parse(response, row.source, at).entries)
    assert len(entries) == record['entries']
    assert sum(entry.published_at is not None for entry in entries) == record['dated']
    for sample in record['samples']:
        entry = entries[sample['index']]
        assert entry.title == sample['title']
        assert entry.url == sample['url']
        assert (entry.published_at.isoformat() if entry.published_at else None) == sample['date']
        assert entry.summary == sample['summary']
    prepared = [prepare(entry, row.source) for entry in entries]
    assert len({entry.entry_id for entry in prepared}) == len(entries)
    if record['kind'] == 'canonical-document':
        assert len(entries) == 1
        assert entries[0].summary and len(entries[0].summary) > 50
        assert entries[0].published_at is None
    if record['id'] == 'fda-novel-drug-approvals':
        assert len({entry.identity_key for entry in prepared}) == 44


def test_every_omitted_p1_and_readable_overseas_source_has_a_recorded_disposition():
    assert len(MANIFEST['rows']) == 183
    direct = {row['id'] for row in MANIFEST['rows'] if any(item['group'] == 'direct' for item in row['evidence'])}
    assert len(direct) == 155
    assert all(ROWS[sid].source.launch_tier == 'P1' for sid in direct)
    assert all(row.disabled_reason not in ('selectors_missing', 'launch_tier_P1')
               for row in ROWS.values() if row.source.launch_tier == 'P1' and not row.enabled)
    for record in MANIFEST['rows']:
        if record['decision'] == 'deferred':
            assert not ROWS[record['id']].enabled
            assert ROWS[record['id']].disabled_reason == record['reason']
            assert record['evidence'] and record['detail']
    for sid, row in ROWS.items():
        if sid.startswith(('cde-', 'fierce-')):
            assert not row.enabled and row.disabled_reason == 'owner_excluded'
