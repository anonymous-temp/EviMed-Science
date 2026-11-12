"""Offline checks of the product selector bridge: the cards come from learn/offlineLoop.mjs, not from Python."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from loop import run_episode
from product_provider import ProductSkillProvider, request_text
from test_loop import FakeEnvironment, FakeModel

SECTIONS = "\n".join(["## Purpose", "P.", "", "## When to Use", "W.", "", "## Inputs", "I.", "", "## Workflow", "1. Do it.", "",
                      "## Verification", "- Checked.", "", "## Constraints", "- Never.", "", "## Output", "O."])


def method(name, words, role="functional", derived_from=None):
    metadata = {"role": role, "applies_when": words, "not_when": "Other work.", "evimed_schema": "method-skill/1"}
    if derived_from:
        metadata["derived_from"] = derived_from
    return {"id": f"method:learned:{name}", "revision": 1, "payload": {
        "status": "approved", "statusChangedAt": "2026-11-10T00:00:00.000Z", "createdAt": "2026-11-10T00:00:00.000Z",
        "frontmatter": {"name": name, "description": words, "whenToUse": words, "metadata": metadata},
        "body": SECTIONS.replace("P.", words), "dependencies": []}}


@unittest.skipUnless(shutil.which("node"), "node is required for the selection bridge")
class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.library = Path(self.temp.name) / "export.json"
        self.library.write_text(json.dumps({"schema": "c1-library-export/1", "methods": [
            method("heat-object-then-place", "Heat an object with the microwave then place it in the receptacle"),
            method("clean-object-then-place", "Clean an object in the sinkbasin then place it in the receptacle"),
            method("place-object-pattern", "Find the object, change its state if asked, carry it to the receptacle", "abstract",
                   "heat-object-then-place, clean-object-then-place"),
            method("kayak-notes", "Kayak river rafting notes for the weekend")]}))

    def tearDown(self):
        self.temp.cleanup()

    def test_pyramid_and_flat_come_from_the_product_selection(self):
        task = "heat some egg and put it in countertop."
        pyramid = ProductSkillProvider(self.library, "pyramid", cache_dir=Path(self.temp.name) / "cache")
        flat = ProductSkillProvider(self.library, "flat")
        try:
            cards = pyramid.cards_for_episode(task, "You are in a room with a microwave 1 and a countertop 1.", "alfworld", "seen")
            self.assertEqual(cards[0]["name"], "place-object-pattern")
            self.assertEqual(cards[0]["level"], "abstract")
            self.assertIn("Find the object", cards[0]["text"])
            self.assertTrue(all(card["reason"] in ("similarity", "dependency", "explore", "abstraction") for card in cards))
            self.assertEqual(pyramid.last["selected"][0]["levelNumber"], 1)
            flat_cards = flat.cards_for_episode(task, "You are in a room with a microwave 1 and a countertop 1.", "alfworld", "seen")
            self.assertNotIn("abstraction", [card["reason"] for card in flat_cards])
            # A cached selection is reused without asking the bridge again.
            pyramid.close()
            pyramid.proc = None
            pyramid.node = "/nonexistent-node"
            again = pyramid.cards_for_episode(task, "You are in a room with a microwave 1 and a countertop 1.", "alfworld", "seen")
            self.assertEqual([c["name"] for c in again], [c["name"] for c in cards])
            without = ProductSkillProvider(self.library, "pyramid", remove_roles=["abstract"])
            self.assertTrue(all(c["level"] != "abstract" for c in without.cards_for("heat some egg", "alfworld", "seen")))
            without.close()
        finally:
            pyramid.close()
            flat.close()

    def test_episode_records_the_selection_and_shows_the_cards(self):
        provider = ProductSkillProvider(self.library, "pyramid")
        try:
            model = FakeModel()
            row = run_episode(FakeEnvironment(), model, "alfworld", "seen", provider)
            self.assertIn("selection", row)
            self.assertEqual(row["selection"]["mode"], "pyramid")
            for card in row["cards"]:
                self.assertIn(card["name"], model.calls[0][0]["content"])
        finally:
            provider.close()

    def test_attached_detail_is_available_only_for_mounted_cards_and_is_not_injected(self):
        library = json.loads(self.library.read_text())
        library["policy"] = {"concise": True}
        for entry in library["methods"]:
            entry["payload"]["files"] = {"scripts/detail.md": "Extended recovery for " + entry["payload"]["frontmatter"]["name"]}
        self.library.write_text(json.dumps(library))
        provider = ProductSkillProvider(self.library, "flat")
        try:
            cards = provider.cards_for("heat some egg", "alfworld", "seen")
            self.assertTrue(cards)
            for card in cards:
                self.assertTrue(card["detailAvailable"])
                self.assertNotIn("Extended recovery", card["text"])
                self.assertEqual(provider.read_detail(card["name"]), "Extended recovery for " + card["name"])
            self.assertEqual(provider.read_detail("unmounted-method"), "No attached detail for that mounted method.")
        finally:
            provider.close()
        library["policy"]["concise"] = False
        self.library.write_text(json.dumps(library))
        off = ProductSkillProvider(self.library, "flat")
        try:
            self.assertTrue(all("detailAvailable" not in card for card in off.cards_for("heat some egg", "alfworld", "seen")))
        finally:
            off.close()

    def test_request_text_matches_how_the_library_was_learnt(self):
        self.assertEqual(request_text("find the exit.", "A room. Your task is to: find the exit."), "A room. Your task is to: find the exit.")
        self.assertEqual(request_text("boil water", "This room is called the kitchen."), "Your task is to: boil water\n\nThis room is called the kitchen.")

    def test_cli_requires_the_product_selector_for_its_options(self):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("run_c1.py")), "--env", "alfworld", "--fold", "seen",
                                 "--samples", "missing", "--arm", "pyramid", "--library", str(self.library), "--remove-roles", "abstract",
                                 "--out", self.temp.name], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("need --selector product", result.stderr)


if __name__ == "__main__":
    unittest.main()
