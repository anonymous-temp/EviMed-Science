import hashlib
import unittest

from support import PACKAGE, ensure_upstream


class SurfaceTest(unittest.TestCase):
    def setUp(self):
        ensure_upstream()
        from evimed_h2 import surface, upstream
        self.up = upstream.load()
        self.surface = surface.build_surface()

    def test_shape_of_the_surface(self):
        s = self.surface
        self.assertEqual(s.always_on, ("guidance.md",))
        self.assertEqual(s.always_on_max, 4000)
        self.assertIsNone(s.plugin_dir)
        self.assertIsNone(s.hooks_file)
        self.assertEqual(s.skill_dir, "skills")
        self.assertEqual({rel for rel, _ in s.stubs}, {"skills/README.md", "reference/current-guidance.md"})

    def test_cap_is_enforced_on_guidance_alone(self):
        self.up.tree.validate(self.surface, {"guidance.md": "x" * 4000})
        with self.assertRaises(ValueError) as caught:
            self.up.tree.validate(self.surface, {"guidance.md": "x" * 4001})
        self.assertIn("over the 4000 cap", str(caught.exception))

    def test_a_skill_needs_its_trigger_line_in_guidance(self):
        skill = "---\nname: check\ndescription: a value must be verified\n---\nBody.\n"
        with self.assertRaises(ValueError):
            self.up.tree.validate(self.surface, {"guidance.md": "Rule.\n", "skills/check/SKILL.md": skill})
        self.up.tree.validate(self.surface, {"guidance.md": "Rule. When X, load the `check` skill.\n", "skills/check/SKILL.md": skill})

    def test_the_reference_stub_is_context_and_cannot_be_edited(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as d:
            self.up.tree.write_tree(self.surface, {"guidance.md": "Rule.\n"}, d)
            reference = Path(d) / "reference/current-guidance.md"
            self.assertTrue(reference.is_file())
            self.assertIn("你怎么工作", reference.read_text(encoding="utf-8"))
            reference.write_text("tampered")
            (Path(d) / "skills/README.md").write_text("tampered")
            rejected: list[str] = []
            tree = self.up.tree.read_tree(self.surface, d, rejected=rejected)
            self.assertEqual(tree, {"guidance.md": "Rule.\n"})
            self.assertEqual(rejected, [])

    def test_guidance_snapshot_is_current(self):
        """The editors' read-only copy of the platform's rules names the source's digest; it must be the source as it is now."""
        from evimed_h2 import config
        snapshot = config.GUIDANCE_SNAPSHOT.read_text(encoding="utf-8")
        if not config.GUIDANCE_SOURCE.is_file():
            self.skipTest("the platform source is not beside this package")
        digest = hashlib.sha256(config.GUIDANCE_SOURCE.read_bytes()).hexdigest()
        self.assertIn(f"sha256 {digest}", snapshot, "packages/socket/src/guidanceText.mjs changed: run `node tools/snapshot_guidance.mjs`")

    def test_scripts_and_subagents_are_allowed_by_upstream_paths_but_refused_by_the_adapter_validator(self):
        # upstream's is_allowed accepts these paths whatever the SurfaceSpec says (tree.py is_allowed); validate_tree is where they are refused
        self.assertTrue(self.up.tree.is_allowed(self.surface, "scripts/x.py"))
        self.assertTrue(self.up.tree.is_allowed(self.surface, "sub_agents/a/AGENT.md"))
        self.assertFalse(self.up.tree.is_allowed(self.surface, "plugin/a.ts"))
        self.assertFalse(self.up.tree.is_allowed(self.surface, ".codex/hooks.json"))


if __name__ == "__main__":
    unittest.main()
