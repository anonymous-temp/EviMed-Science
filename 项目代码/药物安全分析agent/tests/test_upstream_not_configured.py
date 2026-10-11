"""With no upstream platform configured the legacy gateway and OSS paths do nothing."""

import asyncio
import sys
from types import SimpleNamespace

from pydantic import SecretStr

from safety_agent.api.oss import upload_markdown
from safety_agent.api.ws_client import ws_client_loop
from safety_agent.core.config import Settings


class _Oss2:
    calls: list = []

    class Auth:
        def __init__(self, *args, **kwargs):
            _Oss2.calls.append("Auth")

    class Bucket:
        def __init__(self, *args, **kwargs):
            _Oss2.calls.append("Bucket")


def test_gateway_and_storage_settings_default_to_empty():
    defaults = Settings.model_construct()
    assert defaults.java_ws_url == ""
    assert defaults.java_token_url == ""
    assert defaults.oss_bucket_name == ""
    assert defaults.oss_public_base_url == ""


def test_gateway_client_does_not_start_without_an_upstream_url():
    service = SimpleNamespace(settings=SimpleNamespace(java_ws_url="", java_token_url=""))
    assert asyncio.run(asyncio.wait_for(ws_client_loop(service), 5)) is None


def test_gateway_client_needs_both_the_socket_and_the_token_endpoint():
    service = SimpleNamespace(settings=SimpleNamespace(
        java_ws_url="wss://platform.example.invalid/ws", java_token_url=""))
    assert asyncio.run(asyncio.wait_for(ws_client_loop(service), 5)) is None


def test_report_upload_is_skipped_without_a_bucket_and_public_base_url(monkeypatch):
    _Oss2.calls.clear()
    monkeypatch.setitem(sys.modules, "oss2", _Oss2)
    settings = SimpleNamespace(
        oss_access_key_id=SecretStr("key-id"),
        oss_access_key_secret=SecretStr("key-secret"),
        oss_endpoint="https://oss.example.invalid",
        oss_bucket_name="bucket",
        oss_public_base_url="",
    )
    assert asyncio.run(upload_markdown(
        "# report", settings, user_id="user", message_id="message", agent_type="drug-safety-analysis")) is None
    assert _Oss2.calls == []
