"""The pin, the patch set, and the assumptions this package makes about upstream's private names."""
import os
import subprocess
import sys
import unittest

from support import PACKAGE, ensure_upstream


class UpstreamTest(unittest.TestCase):
    def setUp(self):
        ensure_upstream()

    def test_pin_and_patches_are_what_the_package_expects(self):
        from evimed_h2 import config, upstream
        info = upstream.verify()
        self.assertEqual(info["pin"], config.PIN)
        self.assertEqual(info["pin"], "1cfe254e8d25b15f37048c3730134686abe60335")
        self.assertEqual([p["name"] for p in info["patches"]], [p.name for p in sorted((PACKAGE / "patches").glob("*.patch"))])

    def test_setup_check_passes(self):
        done = subprocess.run([str(PACKAGE / "setup.sh"), "--check"], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_the_patched_checkout_still_passes_upstreams_own_tests(self):
        from evimed_h2 import config
        env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "HARNESS2_RUNS_DIR": str(config.RUNS_ROOT / "_upstream-tests")}
        done = subprocess.run([sys.executable, "-m", "unittest", "tests.test_workflow"], cwd=config.WORKDIR, env=env, capture_output=True, text=True, timeout=300)
        self.assertEqual(done.returncode, 0, done.stderr[-1500:])

    def test_private_names_this_package_relies_on(self):
        from evimed_h2 import upstream
        up = upstream.load()
        self.assertTrue(isinstance(up.prompts._SURFACE_TEXTS, dict))
        self.assertEqual(sorted(up.prompts._SurfaceText.__dataclass_fields__), ["dom", "inv", "surface_md", "tts_surface"])
        for name in ("_INV_TEMPLATE", "_DOM_TEMPLATE"):
            self.assertTrue(hasattr(up.prompts, name))
        self.assertTrue(callable(up.proposer._call_fingerprint) and callable(up.proposer._parse_json))
        self.assertEqual(up.proposer.SYSTEM_ARG_MAX, 120_000)
        self.assertTrue(hasattr(up.proposer.Proposer, "_cached") and hasattr(up.proposer.Proposer, "_claude_cli"))

    def test_upstream_defaults_this_package_replaces(self):
        """Documented in PATCHES.md: if one of these changes upstream, a replacement here is no longer needed or no longer enough."""
        from evimed_h2 import upstream
        up = upstream.load()
        import inspect
        env_source = inspect.getsource(up.proposer.Proposer.env)
        self.assertIn("CLAUDE_CODE_USE_VERTEX", env_source)  # upstream's claude_cli channel is Vertex only
        self.assertNotIn("model", inspect.signature(up.proposer._call_fingerprint).parameters)  # its cache key ignores the model
        self.assertIn("dangerously-skip-permissions", inspect.getsource(up.proposer.Proposer._claude_cli))
        pool_source = inspect.getsource(up.selection.selection_pool)
        self.assertIn("del base", pool_source)  # the baseline is not in its selection pool

    def test_surface_text_is_registered_and_prompts_build_for_every_domain(self):
        from evimed_h2 import bench_prompts, config, surface, upstream
        up = upstream.load()
        spec = surface.build_surface()
        with self.assertRaises(ValueError):
            up.prompts._st("not-a-surface")
        surface.register_prompts()
        for domain in config.DOMAINS:
            bp = bench_prompts.for_domain(domain, up.spec.BenchPrompts)
            inv = up.prompts.propose(bp, "INV", spec, k=1, index=1)
            dom = up.prompts.propose(bp, "DOM", spec, k=1, index=1)
            agg = up.prompts.aggregate(bp, spec, k=1, index=1)
            for text in (inv, dom, agg):
                self.assertIn("EDITABLE HARNESS SURFACE", text)
                self.assertIn("4,000 characters", text)
                self.assertIn("NOT ON THIS SURFACE", text)
                self.assertNotIn("systemprompt.md", text)
                self.assertNotIn("plugin/<name>.ts", text)
            self.assertIn("GENERALIZE, DO NOT MEMORIZE", inv)  # the process-text pack, not the pack that tells editors to write workspace facts
            self.assertNotIn("WRITE THE FACT ITSELF", inv)
            self.assertIn("candidate ANSWERS", up.prompts.select(bp, 2, "mixed"))


if __name__ == "__main__":
    unittest.main()
