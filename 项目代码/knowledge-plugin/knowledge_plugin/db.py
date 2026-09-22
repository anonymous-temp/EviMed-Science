"""The plugin's own database: connection pool and the idempotent startup migration.

The plugin owns the database ``evimed_knowledge`` (a second database in the production PostgreSQL
instance, role ``evimed_knowledge``; the platform never connects to it — plan 10.4.1). The schema
is ``schema.sql``: the normative design draft byte for byte, then this build's additions. It is
applied at every start in ONE transaction behind ``pg_advisory_xact_lock(hashtext(
'evimed-knowledge-v1'))``, so two instances starting together serialise, and a second run is a
no-op (every statement is ``IF NOT EXISTS``).

Two advisory locks exist, and only these two:

- ``SCHEMA_LOCK`` — the migration.
- ``SEQ_LOCK`` — every transaction that allocates an entry ``seq`` holds it until commit. Sequence
  values are handed out at statement time but become visible at commit time; with two writers in
  flight, seq 105 could commit before 104, a consumer at ``after=104``... would read 105 and never
  see 104. Serialising the (short) write transactions makes commit order equal seq order, which
  is what "strictly increasing in delivery order" (contract rule 2) needs.

Connections run in UTC with a 60 s statement timeout; the password, when there is one, comes from
``KNOWLEDGE_PLUGIN_DATABASE_PASSWORD_FILE`` and is added to the conninfo, never logged.
"""

from __future__ import annotations

import logging
from importlib import resources

from psycopg import AsyncConnection
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from .settings import Settings

log = logging.getLogger("knowledge_plugin.db")

SCHEMA_LOCK = "evimed-knowledge-v1"
SEQ_LOCK = "evimed-knowledge-seq"
SCHEMA_VERSION = 1


def conninfo(settings: Settings) -> str:
    """The libpq conninfo: the URL, the password file's content, UTC and a statement timeout."""
    extra = {
        "application_name": "evimed-knowledge-plugin",
        "options": "-c statement_timeout=60000 -c TimeZone=UTC",
    }
    password = settings.secret("database_password")
    if password:
        extra["password"] = password
    return make_conninfo(settings.database_url, **extra)


def schema_sql() -> str:
    return resources.files("knowledge_plugin").joinpath("schema.sql").read_text(encoding="utf-8")


async def create_pool(settings: Settings) -> AsyncConnectionPool:
    """Open the pool (the caller closes it). Rows come back as dicts."""
    pool = AsyncConnectionPool(
        conninfo(settings),
        min_size=1,
        max_size=settings.pool_max,
        # Autocommit: a single statement commits on its own; atomic groups use conn.transaction().
        # No connection ever goes back to the pool inside an open transaction.
        kwargs={"row_factory": dict_row, "autocommit": True},
        open=False,
        name="knowledge-plugin",
        timeout=30.0,
    )
    await pool.open(wait=True, timeout=30.0)
    return pool


async def migrate(conn: AsyncConnection) -> dict:
    """Apply ``schema.sql`` in one transaction behind the schema lock; returns the recorded version."""
    async with conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (SCHEMA_LOCK,))
        await conn.execute(schema_sql())
        await conn.execute(
            """INSERT INTO evimed_knowledge.meta (key, value) VALUES ('schema', %s)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp()""",
            (Jsonb({"version": SCHEMA_VERSION}),),
        )
    log.info("schema applied (version %s)", SCHEMA_VERSION)
    return {"version": SCHEMA_VERSION}


async def lock_seq(conn: AsyncConnection) -> None:
    """Take the seq allocation lock for the current transaction (see module docstring)."""
    await conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (SEQ_LOCK,))


async def meta_get(conn: AsyncConnection, key: str, default=None):
    row = await (await conn.execute("SELECT value FROM evimed_knowledge.meta WHERE key = %s", (key,))).fetchone()
    return row["value"] if row else default


async def meta_set(conn: AsyncConnection, key: str, value) -> None:
    await conn.execute(
        """INSERT INTO evimed_knowledge.meta (key, value) VALUES (%s, %s)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp()""",
        (key, Jsonb(value)),
    )
