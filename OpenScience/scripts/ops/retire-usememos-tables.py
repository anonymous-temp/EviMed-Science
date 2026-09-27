#!/usr/bin/env python3
"""Archive, then drop, the retired usememos tables left in the platform database.

Research memory moved out of usememos into `evimed_memory` on 2026-09-11 and
the service is gone, but its tables stayed in the `public` schema of the
`evimed` database: twelve of them on 2026-09-26 (audit I3-10), carried into
every nightly backup, read by nothing. This removes them once, the way a
retired store should leave:

  1. list the tables of the schema and refuse unless every one is a table
     usememos (or the EviMed import beside it) created — a closed list; a
     name outside it stops the run and is printed, and `--also NAME` admits
     it after a person has looked;
  2. dump exactly those tables with the database's own pg_dump (custom
     format), check pg_restore can list every one of them, encrypt the dump
     with the platform backup's passphrase and cipher, and decrypt it back to
     prove the archive opens — all before anything is dropped;
  3. drop them in one statement inside one transaction, without CASCADE: an
     object elsewhere that still depends on one of them makes the DROP fail
     and nothing is removed.

Dry run by default: it prints the tables it would archive and drop, with their
row counts, and changes nothing. `--apply` does it. The archive stays outside
the backup rotation (default /srv/evimed-science/shared/backups/usememos-
retired, 0700, the archive 0600). Output is names and counts; never a row.

    sudo python3 scripts/ops/retire-usememos-tables.py            # what would change
    sudo python3 scripts/ops/retire-usememos-tables.py --apply    # archive and drop

Environment, as the platform backup reads it: EVIMED_POSTGRES_CONTAINER
(web-evimed-postgres-1), EVIMED_POSTGRES_DATABASE (evimed),
EVIMED_POSTGRES_USER (evimed), EVIMED_POSTGRES_PASSPHRASE_FILE
(/srv/evimed-science/shared/secrets/backup-passphrase.txt).

Restore, should it ever be needed:
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -md sha256 \\
      -pass file:<passphrase> -in <archive> | docker exec -i <container> \\
      pg_restore --no-owner --no-acl -U evimed -d <a scratch database>
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_ROOT = Path("/srv/evimed-science/shared")
# What usememos creates in its database (its PostgreSQL migrations, v0.18 on:
# `resource` became `attachment`), and the two tables the EviMed import read
# beside them (`memory_record`, `memo_share`, scripts/ops/migrate-research-memory.mjs).
RETIRED_USEMEMOS_TABLES = frozenset({
    "activity", "attachment", "idp", "inbox", "memo", "memo_organizer", "memo_relation", "memo_share",
    "memory_record", "migration_history", "reaction", "resource", "shortcut", "storage", "system_setting",
    "tag", "user", "user_identity", "user_setting", "webhook",
})
IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,62}")
CRYPTO = ["openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-iter", "250000", "-md", "sha256"]


class RetireError(Exception):
    """A refusal with a stable code; the message never carries a row."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(code)
        self.code = code
        self.detail = detail


def run(args: list[str], *, stdin=None, stdout=None, capture: bool = False, timeout: int = 900) -> str:
    """One command; its stderr is not echoed (it can quote table contents)."""
    try:
        completed = subprocess.run(args, stdin=stdin if stdin is not None else subprocess.DEVNULL,
                                   stdout=stdout if stdout is not None else (subprocess.PIPE if capture else subprocess.DEVNULL),
                                   stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise RetireError("command_unavailable", args[0]) from None
    if completed.returncode:
        raise RetireError("command_failed", " ".join(args[:6]))
    return completed.stdout.decode("utf-8") if capture else ""


def quoted(name: str) -> str:
    if not IDENTIFIER.fullmatch(name):
        raise RetireError("identifier_invalid", name)
    return '"' + name + '"'


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


class Retirement:
    def __init__(self, *, schema: str, also: list[str], archive_dir: Path, container: str, database: str,
                 role: str, passphrase: Path, runner=run, clock=lambda: datetime.now(timezone.utc)):
        for value in (container, database, role):
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,127}", value):
                raise RetireError("config_invalid", value)
        quoted(schema)
        if schema.startswith("evimed_") or schema in {"pg_catalog", "information_schema"}:
            raise RetireError("schema_refused", schema)
        self.schema = schema
        for name in also:
            quoted(name)
        self.also = set(also)
        self.archive_dir = archive_dir
        self.base = ["docker", "exec", "-i", container]
        self.database = database
        self.role = role
        self.passphrase = passphrase
        self.run = runner
        self.clock = clock

    def sql(self, statement: str) -> list[str]:
        out = self.run(self.base + ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", self.role, "-d", self.database,
                                    "-c", statement], capture=True)
        return [line for line in out.splitlines() if line.strip()]

    def inventory(self) -> dict:
        names = self.sql(f"SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = '{self.schema}' ORDER BY 1")
        unknown = sorted(name for name in names if name not in RETIRED_USEMEMOS_TABLES and name not in self.also)
        tables = []
        for name in names:
            rows = self.sql(f"SELECT count(*) FROM {quoted(self.schema)}.{quoted(name)}")
            tables.append({"table": name, "rows": int(rows[0]) if rows and rows[0].isdigit() else None})
        return {"schema": self.schema, "tables": tables, "unknown": unknown}

    def apply(self, inventory: dict) -> dict:
        if inventory["unknown"]:
            raise RetireError("tables_not_retired", ",".join(inventory["unknown"]))
        names = [entry["table"] for entry in inventory["tables"]]
        if not names:
            return {"archived": None, "dropped": []}
        if not self.passphrase.is_file():
            raise RetireError("passphrase_unavailable", str(self.passphrase))
        self.archive_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.archive_dir, 0o700)
        stamp = self.clock().strftime("%Y%m%dT%H%M%SZ")
        archive = self.archive_dir / f"usememos-retired-{self.schema}-{stamp}.dump.enc"
        if archive.exists():
            raise RetireError("archive_exists", archive.name)
        crypto = CRYPTO + ["-pass", "file:" + str(self.passphrase)]
        with tempfile.TemporaryDirectory(prefix="evimed-usememos-retire-") as temporary:
            plain = Path(temporary) / "tables.dump"
            decrypted = Path(temporary) / "check.dump"
            tables = [argument for name in names for argument in ("--table", f"{quoted(self.schema)}.{quoted(name)}")]
            with plain.open("xb") as output:
                self.run(self.base + ["pg_dump", "--format=custom", "--compress=9", "--no-owner", "--no-acl",
                                      "--lock-wait-timeout=30000", *tables, "-U", self.role, "-d", self.database], stdout=output)
            with plain.open("rb") as source:
                listing = self.run(self.base + ["pg_restore", "--list"], stdin=source, capture=True)
            missing = [name for name in names if not re.search(rf"\bTABLE DATA {re.escape(self.schema)} {re.escape(name)}\b", listing)]
            if missing:
                raise RetireError("archive_incomplete", ",".join(missing))
            self.run(crypto + ["-salt", "-in", str(plain), "-out", str(archive)])
            os.chmod(archive, 0o600)
            archived = digest(archive)
            self.run(crypto + ["-d", "-in", str(archive), "-out", str(decrypted)])
            if digest(decrypted) != digest(plain) or digest(archive) != archived:
                archive.unlink(missing_ok=True)
                raise RetireError("archive_unverified")
        checksum = archive.with_name(archive.name + ".sha256")
        checksum.write_text(f"{archived}  {archive.name}\n", encoding="utf-8")
        os.chmod(checksum, 0o600)
        # One statement, so one transaction, and no CASCADE: anything outside
        # the list that still depends on one of these tables fails the DROP.
        listed = ", ".join(f"{quoted(self.schema)}.{quoted(name)}" for name in names)
        self.sql(f"DROP TABLE {listed}")
        remaining = self.sql(f"SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = '{self.schema}' ORDER BY 1")
        left = [name for name in names if name in remaining]
        if left:
            raise RetireError("tables_still_present", ",".join(left))
        return {"archived": {"file": str(archive), "sha256": archived}, "dropped": names}


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    apply = "--apply" in args
    schema = "public"
    also: list[str] = []
    archive_dir = DEFAULT_ROOT / "backups/usememos-retired"
    index = 0
    while index < len(args):
        argument = args[index]
        if argument == "--apply":
            pass
        elif argument in ("--schema", "--also", "--archive-dir") and index + 1 < len(args):
            value = args[index + 1]
            index += 1
            if argument == "--schema":
                schema = value
            elif argument == "--also":
                also.append(value)
            else:
                archive_dir = Path(value).absolute()
        else:
            print("usage: retire-usememos-tables.py [--apply] [--schema public] [--also TABLE]... [--archive-dir DIR]", file=sys.stderr)
            return 2
        index += 1
    try:
        retirement = Retirement(
            schema=schema, also=also, archive_dir=archive_dir,
            container=os.environ.get("EVIMED_POSTGRES_CONTAINER", "web-evimed-postgres-1"),
            database=os.environ.get("EVIMED_POSTGRES_DATABASE", "evimed"),
            role=os.environ.get("EVIMED_POSTGRES_USER", "evimed"),
            passphrase=Path(os.environ.get("EVIMED_POSTGRES_PASSPHRASE_FILE", str(DEFAULT_ROOT / "secrets/backup-passphrase.txt"))),
        )
        inventory = retirement.inventory()
        result = {"ok": not inventory["unknown"], "dryRun": not apply, **inventory}
        if apply:
            result.update(retirement.apply(inventory))
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["ok"] else 1
    except RetireError as error:
        print(json.dumps({"ok": False, "code": error.code, "detail": error.detail}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
