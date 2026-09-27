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

    def __init__(self, tables, *, restore_lists=None, drop_fails=False):
        self.tables = dict(tables)
        self.restore_lists = restore_lists
        self.drop_fails = drop_fails
        self.calls = []

    def __call__(self, args, *, stdin=None, stdout=None, capture=False, timeout=900):
        self.calls.append(args)
        if args[:2] == ["docker", "exec"]:
            tool = args[4]
            if tool == "psql":
                statement = args[args.index("-c") + 1]
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
                stdout.write(("dump:" + ",".join(dumped)).encode())
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
