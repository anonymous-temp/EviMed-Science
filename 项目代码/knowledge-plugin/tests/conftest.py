"""Shared fixtures of the core suite (package P1).

Database tests run against a scratch database on the local PostgreSQL — by default
``postgresql://postgres@127.0.0.1:55433`` (this box's pgserver; never 5432), overridable with
``KNOWLEDGE_PLUGIN_TEST_DATABASE_URL`` (a server URL without a database name). The database is
created once per session as ``evimed_test_knowledge_<pid>``, the schema applied with the real
migration, every table truncated before each test, and the database dropped at the end. When no
server answers, the database tests are skipped with the reason, the pure tests still run.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import psycopg
import pytest

from knowledge_plugin.settings import Settings

SERVER_URL = os.environ.get("KNOWLEDGE_PLUGIN_TEST_DATABASE_URL", "postgresql://postgres@127.0.0.1:55433")
TABLES = ("fetches", "entry_texts", "entries", "seen_keys", "sources", "host_counters", "host_state", "meta")
FIXED_NOW = datetime(2026, 9, 22, 8, 0, 0, tzinfo=timezone.utc)


def _server_available() -> str | None:
    try:
        with psycopg.connect(SERVER_URL + "/postgres", connect_timeout=3):
            return None
    except psycopg.Error as error:
        return f"no PostgreSQL at the test server URL ({type(error).__name__})"


@pytest.fixture(scope="session")
def database_name():
    reason = _server_available()
    if reason:
        pytest.skip(reason)
    name = f"evimed_test_knowledge_{os.getpid()}"
    with psycopg.connect(SERVER_URL + "/postgres", autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{name}"')
        conn.execute(f'CREATE DATABASE "{name}"')
    from knowledge_plugin.db import schema_sql
    with psycopg.connect(f"{SERVER_URL}/{name}") as conn:
        with conn.transaction():
            conn.execute(schema_sql())
    yield name
    with psycopg.connect(SERVER_URL + "/postgres", autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@pytest.fixture()
def secret_files(tmp_path: Path):
    token = tmp_path / "token"
    token.write_text("test-token-0123456789\n")
    token.chmod(0o600)
    contact = tmp_path / "contact"
    contact.write_text("crawler-contact@example.org\n")
    return {"token": token, "contact": contact}


@pytest.fixture()
def settings(secret_files, database_name) -> Settings:
    return Settings(database_url=f"{SERVER_URL}/{database_name}", token_file=str(secret_files["token"]),
                    contact_email_file=str(secret_files["contact"]), worker_id="test-worker", tick_s=0.5)


@pytest.fixture()
def plain_settings(secret_files) -> Settings:
    """Settings for tests that never touch a database."""
    return Settings(database_url="postgresql://unused", token_file=str(secret_files["token"]),
                    contact_email_file=str(secret_files["contact"]), request_timeout_s=5.0)


@pytest.fixture()
async def pool(settings):
    from knowledge_plugin.db import create_pool

    with psycopg.connect(settings.database_url, autocommit=True) as conn:
        conn.execute("TRUNCATE " + ", ".join(f"evimed_knowledge.{t}" for t in TABLES) + " RESTART IDENTITY CASCADE")
    opened = await create_pool(settings)
    try:
        yield opened
    finally:
        await opened.close()
