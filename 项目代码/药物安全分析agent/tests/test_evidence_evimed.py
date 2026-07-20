"""EviMed evidence retrieval client tests (contract per 接口文档 V1.0)."""

from __future__ import annotations

import httpx
import pytest
import respx

from safety_agent.core.config import Settings
from safety_agent.core.exceptions import EvidenceSearchError
from safety_agent.evidence.evimed import EviMedEvidenceClient

BASE = "https://www.evimed.com/api-evimed/medicine-api/ai-api"


def _client() -> EviMedEvidenceClient:
    return EviMedEvidenceClient(BASE, "test-key-not-real")


def test_disabled_when_unconfigured():
    assert EviMedEvidenceClient("", "").enabled is False
    assert EviMedEvidenceClient(BASE, "").enabled is False
    assert _client().enabled is True


def test_client_loads_api_key_from_owner_only_file(tmp_path):
    secret = tmp_path / "evimed.api-key"
    secret.write_text("file-backed-test-key\n", encoding="utf-8")
    secret.chmod(0o600)
    settings = Settings(
        _env_file=None,
        evimed_evidence_search_url=BASE,
        evimed_evidence_search_key_file=secret,
    )
    client = EviMedEvidenceClient.from_settings(settings)
    assert client.enabled is True
    assert client._client.headers["Authorization"] == "Bearer file-backed-test-key"


@pytest.mark.skipif(__import__("os").name == "nt", reason="POSIX permission contract")
def test_client_rejects_group_readable_api_key_file(tmp_path):
    secret = tmp_path / "evimed.api-key"
    secret.write_text("unsafe-test-key\n", encoding="utf-8")
    secret.chmod(0o640)
    settings = Settings(
        _env_file=None,
        evimed_evidence_search_url=BASE,
        evimed_evidence_search_key_file=secret,
    )
    with pytest.raises(ValueError, match="owner-only"):
        EviMedEvidenceClient.from_settings(settings)


@respx.mock
async def test_search_guidelines_happy_path():
    route = respx.post(f"{BASE}/review/api/guide").mock(
        return_value=httpx.Response(
            200,
            json={
                "code": 200,
                "msg": "success",
                "data": {
                    "total": 2,
                    "list": [
                        {"title": "指南甲", "publisher": "NCCN", "year": 2023, "url": "https://x"},
                        {"title": "指南乙", "organization": "中华医学会", "publishYear": 2021},
                        {"noTitle": "malformed entry is skipped"},
                    ],
                },
            },
        )
    )
    client = _client()
    items = await client.search_guidelines("阿托伐他汀 肌病", count=5)
    request = route.calls[0].request
    assert request.headers["Authorization"] == "Bearer test-key-not-real"
    body = request.content.decode()
    assert '"query": "阿托伐他汀 肌病"' in body or "阿托伐他汀" in body
    assert [i.title for i in items] == ["指南甲", "指南乙"]
    assert items[0].publisher == "NCCN" and items[0].year == 2023
    assert items[1].publisher == "中华医学会" and items[1].year == 2021


@respx.mock
async def test_non_200_business_code_raises():
    respx.post(f"{BASE}/review/api/guide").mock(
        return_value=httpx.Response(200, json={"code": 40301, "msg": "account disabled"})
    )
    with pytest.raises(EvidenceSearchError, match="40301"):
        await _client().search_guidelines("x")


@respx.mock
async def test_http_401_raises():
    respx.post(f"{BASE}/review/api/guide").mock(return_value=httpx.Response(401, text="unauthorized"))
    with pytest.raises(EvidenceSearchError, match="HTTP 401"):
        await _client().search_guidelines("x")


@respx.mock
async def test_missing_data_list_raises_not_keyerror():
    respx.post(f"{BASE}/review/api/guide").mock(
        return_value=httpx.Response(200, json={"code": 200, "msg": "success", "data": {}})
    )
    with pytest.raises(EvidenceSearchError, match="data.list"):
        await _client().search_guidelines("x")


async def test_unconfigured_client_rejects_calls():
    with pytest.raises(EvidenceSearchError, match="not configured"):
        await EviMedEvidenceClient("", "").search_guidelines("x")
