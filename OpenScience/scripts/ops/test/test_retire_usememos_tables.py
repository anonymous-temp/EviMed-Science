import importlib.util
import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("retire_usememos", Path(__file__).parents[1] / "retire-usememos-tables.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeHost:
    """psql, pg_dump, pg_restore and openssl as the retirement calls them."""

    def __init__(self, tables, *, restore_lists=None, drop_fails=False, ledger=(), removed=None, restore_fails=False):
        self.tables = dict(tables)
        self.restore_lists = restore_lists
        self.drop_fails = drop_fails
        self.calls = []
        # The erasure ledger as the platform database holds it, the rows each scratch database would delete, and the
        # databases created and dropped.
        self.ledger = list(ledger)
        self.removed = dict(removed or {})
        self.restore_fails = restore_fails
        self.created = []
        self.dropped_databases = []

    def __call__(self, args, *, stdin=None, stdout=None, capture=False, timeout=900):
        self.calls.append(args)
        if args[:2] == ["docker", "exec"]:
            tool = args[4]
            if tool == "psql":
                statement = args[args.index("-c") + 1]
                database = args[args.index("-d") + 1]
                if statement.startswith("SELECT namespace"):
                    return "".join(f"{namespace} {tag}\n" for namespace, tag in self.ledger)
                if statement.startswith("CREATE DATABASE"):
                    self.created.append(statement.split()[-1].strip('"'))
                    return ""
                if statement.startswith("DROP DATABASE"):
                    self.dropped_databases.append(statement.split()[-1].strip('"'))
                    return ""
                if statement.startswith("WITH gone AS"):
                    name = statement.split("DELETE FROM ")[1].split(".")[1].split(" ")[0]
                    return f"{self.removed.get(name, 0)}\n"
                if statement.startswith("SELECT tablename"):
                    return "".join(f"{name}\n" for name in sorted(self.tables))
                if statement.startswith("SELECT count(*)"):
                    name = statement.rsplit(".", 1)[1].strip('"')
                    return f"{self.tables[name]}\n"
                if statement.startswith("DROP TABLE"):
                    if self.drop_fails:
                        raise MODULE.RetireError("command_failed")
                    for name in [part.split(".")[1].strip('"') for part in statement[len("DROP TABLE "):].split(", ")]:
                        del self.tables[name]
                    return ""
                raise AssertionError(statement)
            if tool == "pg_dump":
                dumped = [args[i + 1].split(".")[1].strip('"') for i, value in enumerate(args) if value == "--table"]
                # A dump of a scratch database is a dump of what is left in it once the erased rows are gone.
                forgotten = ";forgot:" + ",".join(f"{name}={count}" for name, count in sorted(self.removed.items())) if args[args.index("-d") + 1] != "evimed" else ""
                stdout.write(("dump:" + ",".join(dumped) + forgotten).encode())
                return ""
            if tool == "pg_restore" and "-d" in args:
                if self.restore_fails:
                    raise MODULE.RetireError("command_failed")
                stdin.read()
                return ""
            if tool == "pg_restore":
                dumped = stdin.read().decode().split(":", 1)[1].split(",")
                listed = self.restore_lists if self.restore_lists is not None else dumped
                return "".join(f"1; 0 1 TABLE DATA public {name} evimed\n" for name in listed)
        if args[0] == "openssl":
            source, target = Path(args[args.index("-in") + 1]), Path(args[args.index("-out") + 1])
            shutil.copyfile(source, target)
            return ""
        raise AssertionError(args)


class RetireUsememosTablesTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="retire-usememos-test-"))
        self.passphrase = self.dir / "passphrase"
        self.passphrase.write_text("x" * 40)
        self.addCleanup(shutil.rmtree, self.dir)

    def retirement(self, host, **options):
        return MODULE.Retirement(schema="public", also=options.get("also", []), archive_dir=self.dir / "archive",
                                 container="web-evimed-postgres-1", database="evimed", role="evimed",
                                 passphrase=self.passphrase, runner=host,
                                 clock=lambda: datetime(2026, 9, 27, 3, 0, tzinfo=timezone.utc))

    def test_a_dry_run_lists_the_tables_with_their_counts_and_changes_nothing(self):
        host = FakeHost({"memo": 3, "memory_record": 68, "user": 2, "user_setting": 2})
        inventory = self.retirement(host).inventory()
        self.assertEqual(inventory["unknown"], [])
        self.assertEqual({entry["table"]: entry["rows"] for entry in inventory["tables"]}, {"memo": 3, "memory_record": 68, "user": 2, "user_setting": 2})
        self.assertFalse(any(call[4] in ("pg_dump",) or "DROP" in " ".join(call) for call in host.calls))

    def test_a_table_usememos_did_not_create_stops_the_run_until_it_is_admitted(self):
        host = FakeHost({"memo": 3, "orders": 10})
        retirement = self.retirement(host)
        inventory = retirement.inventory()
        self.assertEqual(inventory["unknown"], ["orders"])
        with self.assertRaises(MODULE.RetireError) as refused:
            retirement.apply(inventory)
        self.assertEqual(refused.exception.code, "tables_not_retired")
        self.assertIn("orders", host.tables, "nothing was dropped")
        admitted = self.retirement(host, also=["orders"])
        self.assertEqual(admitted.inventory()["unknown"], [])

    def test_the_tables_are_archived_encrypted_and_verified_before_they_are_dropped(self):
        host = FakeHost({"memo": 3, "memory_record": 68, "user": 2})
        retirement = self.retirement(host)
        result = retirement.apply(retirement.inventory())
        self.assertEqual(sorted(result["dropped"]), ["memo", "memory_record", "user"])
        self.assertEqual(host.tables, {})
        archive = Path(result["archived"]["file"])
        self.assertTrue(archive.name.startswith("usememos-retired-public-20260927T030000Z"))
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        self.assertEqual((archive.parent.stat().st_mode & 0o777), 0o700)
        self.assertIn(result["archived"]["sha256"], archive.with_name(archive.name + ".sha256").read_text())
        order = [call[4] if call[:2] == ["docker", "exec"] else call[0] for call in host.calls]
        drop = next(i for i, call in enumerate(host.calls) if "DROP TABLE" in " ".join(call))
        self.assertLess(order.index("pg_dump"), drop)
        self.assertLess(order.index("pg_restore"), drop)
        self.assertEqual(order[:drop].count("openssl"), 2, "encrypted and decrypted back before the drop")
        dropped = " ".join(host.calls[drop])
        self.assertIn('"public"."user"', dropped, "a reserved word is quoted")
        self.assertNotIn("CASCADE", dropped)

    def test_an_archive_that_does_not_list_every_table_drops_nothing(self):
        host = FakeHost({"memo": 3, "memory_record": 68}, restore_lists=["memo"])
        retirement = self.retirement(host)
        with self.assertRaises(MODULE.RetireError) as refused:
            retirement.apply(retirement.inventory())
        self.assertEqual(refused.exception.code, "archive_incomplete")
        self.assertEqual(set(host.tables), {"memo", "memory_record"})

    def test_a_platform_schema_or_a_hostile_name_is_refused_before_any_command(self):
        for schema in ("evimed_memory", "pg_catalog", 'public"; DROP'):
            with self.assertRaises(MODULE.RetireError):
                MODULE.Retirement(schema=schema, also=[], archive_dir=self.dir, container="c", database="d", role="r",
                                  passphrase=self.passphrase, runner=FakeHost({}))
        with self.assertRaises(MODULE.RetireError):
            self.retirement(FakeHost({}), also=["x; DROP"])

    # --- the archive against the erasure ledger (review M-11) -----------------------------------------------------------------

    NAMESPACE = "evimed-science-" + "a" * 24
    TAG = "b" * 24

    def archive_of(self, tables):
        """An archive as the retirement writes it, and its path."""
        retirement = self.retirement(FakeHost(tables))
        return Path(retirement.apply(retirement.inventory())["archived"]["file"])

    def test_an_archive_is_resealed_without_the_rows_of_an_account_erased_after_it_was_written(self):
        archive = self.archive_of({"memo": 3, "memory_record": 68})
        before = archive.read_bytes()
        host = FakeHost({"memo": 3, "memory_record": 68}, ledger=[(self.NAMESPACE, self.TAG)], removed={"memory_record": 4, "memo": 1})
        report = self.retirement(host).forget_erased()
        self.assertEqual(report["accounts"], 1)
        self.assertEqual(report["archives"], [{"archive": archive.name, "removed": {"memory_record": 4, "memo": 1}, "resealed": True}])
        self.assertNotEqual(archive.read_bytes(), before, "the archive was taken again")
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        checksum = archive.with_name(archive.name + ".sha256").read_text()
        self.assertEqual(checksum.split()[0], MODULE.digest(archive), "and its checksum says so")
        self.assertFalse(archive.with_name(archive.name + ".new").exists())
        # The scratch database that held the rows is gone, and what ran on it carried the digests and nothing else.
        self.assertEqual(host.created, host.dropped_databases)
        self.assertEqual(len(host.created), 1)
        statements = " ".join(" ".join(call) for call in host.calls)
        self.assertIn(self.NAMESPACE, statements)
        self.assertIn(self.TAG, statements)
        order = [call[4] if call[:2] == ["docker", "exec"] else call[0] for call in host.calls]
        self.assertEqual(order.count("openssl"), 3, "decrypted, encrypted again, and decrypted to prove it opens")

    def test_an_archive_with_nothing_of_the_erased_accounts_is_left_exactly_as_it_is(self):
        archive = self.archive_of({"memo": 3, "memory_record": 68})
        before, stamp = archive.read_bytes(), archive.stat().st_mtime_ns
        host = FakeHost({"memo": 3, "memory_record": 68}, ledger=[(self.NAMESPACE, self.TAG)], removed={})
        report = self.retirement(host).forget_erased()
        self.assertEqual(report["archives"][0]["resealed"], False)
        self.assertEqual(archive.read_bytes(), before)
        self.assertEqual(archive.stat().st_mtime_ns, stamp)
        self.assertEqual(host.created, host.dropped_databases)
        self.assertFalse(any(call[4] == "pg_dump" for call in host.calls if call[:2] == ["docker", "exec"]), "nothing was dumped again")

    def test_no_erased_account_means_no_command_beyond_reading_the_ledger(self):
        self.archive_of({"memo": 3})
        host = FakeHost({"memo": 3}, ledger=[])
        report = self.retirement(host).forget_erased()
        self.assertEqual(report, {"accounts": 0, "archives": []})
        self.assertEqual(len(host.calls), 1)

    def test_a_ledger_row_that_is_not_a_digest_stops_the_run_before_it_is_put_in_a_statement(self):
        self.archive_of({"memo": 3})
        host = FakeHost({"memo": 3}, ledger=[("x'; DROP TABLE memo; --", self.TAG)])
        with self.assertRaises(MODULE.RetireError) as refused:
            self.retirement(host).forget_erased()
        self.assertEqual(refused.exception.code, "ledger_invalid")
        self.assertEqual(host.created, [])

    def test_a_restore_that_fails_still_drops_the_scratch_database(self):
        archive = self.archive_of({"memo": 3})
        before = archive.read_bytes()
        host = FakeHost({"memo": 3}, ledger=[(self.NAMESPACE, self.TAG)], restore_fails=True)
        with self.assertRaises(MODULE.RetireError):
            self.retirement(host).forget_erased()
        self.assertEqual(host.created, host.dropped_databases, "the rows being forgotten are not left in a database of their own")
        self.assertEqual(archive.read_bytes(), before, "and the archive is as it was")

    def test_the_cli_is_a_dry_run_unless_asked_and_prints_counts_only(self):
        host = FakeHost({"memo": 3, "memory_record": 68})
        original = MODULE.Retirement.__init__

        def with_fake(self, **kwargs):
            original(self, **{**kwargs, "runner": host})

        MODULE.Retirement.__init__ = with_fake
        try:
            output = io.StringIO()
            with redirect_stdout(output):
                code = MODULE.main(["--archive-dir", str(self.dir / "a")])
        finally:
            MODULE.Retirement.__init__ = original
        report = json.loads(output.getvalue())
        self.assertEqual(code, 0)
        self.assertTrue(report["dryRun"])
        self.assertEqual(set(host.tables), {"memo", "memory_record"})


if __name__ == "__main__":
    unittest.main()
