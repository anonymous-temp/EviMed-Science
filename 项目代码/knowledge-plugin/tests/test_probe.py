"""The production probe reads through each source's own exit and writes nothing."""

from __future__ import annotations

import io
import json

from knowledge_plugin.probe import probe


async def test_relay_sources_are_refused_by_name_without_a_node(plain_settings):
    out = io.StringIO()
    code = await probe(plain_settings, egress="relay", source_ids=[], limit=3, out=out)
    lines = [json.loads(line) for line in out.getvalue().splitlines()]
    assert len(lines) == 3 and code == 1
    assert all(line["egress"] == "relay" and line["detail"] == "egress_unavailable" for line in lines)
