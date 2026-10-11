"""With no upstream platform configured the legacy gateway and OSS paths do nothing."""

import asyncio
import sys

from app import main as app_main
from config.settings import settings
from utils import oss_uploader


class _Oss2:
    calls: list = []

    class Auth:
        def __init__(self, *args, **kwargs):
            _Oss2.calls.append("Auth")

    class Bucket:
        def __init__(self, *args, **kwargs):
            _Oss2.calls.append("Bucket")


def test_gateway_client_does_not_start_without_an_upstream_url(monkeypatch):
    monkeypatch.setattr(settings, "JAVA_WS_URL", "")
    monkeypatch.setattr(settings, "JAVA_TOKEN_URL", "")
    assert asyncio.run(asyncio.wait_for(app_main._java_ws_client(), 5)) is None


def test_gateway_client_needs_both_the_socket_and_the_token_endpoint(monkeypatch):
    monkeypatch.setattr(settings, "JAVA_WS_URL", "wss://platform.example.invalid/ws")
    monkeypatch.setattr(settings, "JAVA_TOKEN_URL", "")
    assert asyncio.run(asyncio.wait_for(app_main._java_ws_client(), 5)) is None


def test_report_upload_is_skipped_without_a_bucket_and_public_base_url(monkeypatch):
    _Oss2.calls.clear()
    monkeypatch.setitem(sys.modules, "oss2", _Oss2)
    monkeypatch.setattr(settings, "OSS_ACCESS_KEY_ID", "key-id")
    monkeypatch.setattr(settings, "OSS_ACCESS_KEY_SECRET", "key-secret")
    monkeypatch.setattr(settings, "OSS_BUCKET_NAME", "")
    monkeypatch.setattr(settings, "OSS_PUBLIC_BASE_URL", "")
    assert asyncio.run(oss_uploader.upload_report("# report", "user", "message")) is None
    assert _Oss2.calls == []

