"""No Docker, provider or secret-file access: exercise the fixed reader."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("observer", Path(__file__).parent.parent / "src" / "openVikingCompileObserver.py")
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class ObserverTests(unittest.TestCase):
    def setUp(self):
        self.config = {"bot": {"sandbox": {"backend": "direct", "backends": {"direct": {"allow_exec": False, "allow_compile_exec": False}}}}}
        self.processes = ({"pid": 1, "ticks": 10000}, {"pid": 2, "ticks": 20000})
        self.code = b"verified fixed upstream source\n"
        self.proof = {"files": [{"installedPath": "/fixed/source.py", "sha256": hashlib.sha256(self.code).hexdigest()}]}
        self.stamp = [1, 2, 100, 1, 1]

    def read(self, path, _limit):
        body = json.dumps(self.config).encode() if path == observer.CONFIG_PATH else self.code
        return body, self.stamp

    def observe(self):
        with patch.object(observer, "checked_bytes", self.read), patch.object(observer, "observed_processes", return_value=self.processes), \
                patch.object(observer.time, "CLOCK_BOOTTIME", 7, create=True), \
                patch.object(observer.time, "clock_gettime", return_value=1000), patch.object(observer.time, "time", return_value=100000):
            return observer.observe(self.proof)

    def test_valid_projection_omits_configuration_content(self):
        self.config["api_key"] = "fake-secret-not-returned"
        result = self.observe()
        self.assertEqual(result["allowCompileExec"], False)
        self.assertNotIn("fake-secret", json.dumps(result))

    def test_exec_backend_alias_and_interpolation_are_rejected(self):
        for change in [
            lambda c: c["bot"]["sandbox"]["backends"]["direct"].update(allow_compile_exec=True),
            lambda c: c["bot"]["sandbox"].update(backend="subprocess"),
            lambda c: c["bot"]["sandbox"]["backends"]["direct"].update(allowCompileExec=True),
            lambda c: c["bot"].update(Sandbox={"backend": "direct", "backends": {"direct": {"allow_exec": True, "allow_compile_exec": True}}}),
            lambda c: c.update(api_key="${RUNTIME_VALUE}"),
        ]:
            original = json.loads(json.dumps(self.config))
            change(self.config)
            with self.assertRaises(ValueError):
                self.observe()
            self.config = original

    def test_modified_installed_code_is_rejected(self):
        self.code = b"changed after deployment"
        with self.assertRaises(ValueError):
            self.observe()

    def test_later_config_write_is_rejected(self):
        self.stamp[-1] = 10**30
        with self.assertRaises(ValueError):
            self.observe()

    def test_process_environment_cannot_supply_sandbox_overrides(self):
        safe = f"OPENVIKING_CONFIG_FILE={observer.CONFIG_PATH}\0".encode()
        with patch.object(Path, "read_bytes", return_value=safe):
            self.assertEqual(observer.environment(123)["OPENVIKING_CONFIG_FILE"], observer.CONFIG_PATH)
        for extra in [b"NANOBOT_SANDBOX={}\0", b"nanobot_sandbox={}\0", b"NanoBot_Sandbox__backend=docker\0",
                      b"NANOBOT_SANDBOX__BACKEND=docker\0", b"OPENVIKING_CONF_CONTENT={}\0"]:
            with patch.object(Path, "read_bytes", return_value=safe + extra), self.assertRaises(ValueError):
                observer.environment(123)

    def test_unrelated_proc_bytes_do_not_become_configuration_rejections(self):
        safe = f"OPENVIKING_CONFIG_FILE={observer.CONFIG_PATH}\0".encode()
        with patch.object(Path, "read_bytes", return_value=safe + b"UNRELATED=\xff\0"):
            self.assertEqual(observer.environment(123)["OPENVIKING_CONFIG_FILE"], observer.CONFIG_PATH)
        raw_stat = b"99 (unrelated\xff) " + b" ".join([b"S", b"1"] + [b"0"] * 17 + [b"123", b"0"])
        def proc_bytes(path):
            return b"/bin/unrelated\0\xff\0" if path.name == "cmdline" else raw_stat
        with patch.object(Path, "read_bytes", proc_bytes):
            row = observer.process("99")
        self.assertEqual(row["args"][0], "/bin/unrelated")
        self.assertEqual(row["ticks"], 123)
        self.assertFalse(issubclass(UnicodeDecodeError, observer.DefiniteRejection))

    def test_observed_processes_require_the_managed_parent_and_fixed_arguments(self):
        server = {"pid": 10, "parent": 1, "ticks": 100, "args": ["/app/.venv/bin/openviking-server", "--host", "0.0.0.0", "--port", "1933", "--with-bot"]}
        bot = {"pid": 11, "parent": 10, "ticks": 200, "args": ["/app/.venv/bin/vikingbot", "gateway", "--host", "127.0.0.1", "--port", "18790", "--config", observer.CONFIG_PATH]}
        entries = [Mock(name="entry") for _ in range(2)]
        entries[0].name, entries[1].name = "10", "11"
        read_process = lambda pid: server if pid == "10" else bot
        with patch.object(Path, "iterdir", return_value=entries), patch.object(observer, "process", read_process), \
                patch.object(observer, "environment", return_value={"VIKINGBOT_WITH_OPENVIKING_SERVER": "1"}):
            self.assertEqual(observer.observed_processes(), (server, bot))
            bot["parent"] = 99
            with self.assertRaises(ValueError):
                observer.observed_processes()
            bot["parent"] = 10
            bot["args"][-1] = "/other.conf"
            with self.assertRaises(ValueError):
                observer.observed_processes()

    def test_real_file_bound_and_symlink_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "source"
            path.write_bytes(b"verified")
            self.assertEqual(observer.checked_bytes(str(path), 20)[0], b"verified")
            with self.assertRaises(ValueError):
                observer.checked_bytes(str(path), 2)
            link = path.parent / "link"
            link.symlink_to(path)
            with self.assertRaises(ValueError):
                observer.checked_bytes(str(link), 20)


if __name__ == "__main__":
    unittest.main()
