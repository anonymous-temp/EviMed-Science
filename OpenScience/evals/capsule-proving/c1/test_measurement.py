"""Offline measurement regressions; no games or models are installed."""
import unittest
from loop import run_episode
from run_c1 import AlfWorld

class Env:
    instructions = "Use admissible commands."
    def __init__(self, terminal=False): self.terminal = terminal
    def reset(self): return "Room", "Place apple"
    def admissible_commands(self): return ["move apple 1 to table 1", "look"]
    def step(self, action): return "Nothing happens", 25, self.terminal, False
class Model:
    def __init__(self, action): self.action = action
    def complete(self, messages): return {"text": "Action: " + self.action}
class Cards:
    def cards_for(self, *args): return [{"name": "one", "level": "atomic", "text": "Move one item at a time."}]

class Tests(unittest.TestCase):
    def test_admissibility_and_termination_do_not_change_loop_length(self):
        row = run_episode(Env(), Model("put apple 1 on table 1"), "alfworld", "seen", Cards())
        self.assertFalse(row["steps"][0]["admissible"])
        self.assertEqual(len(row["steps"]), 50)
        self.assertEqual(row["terminationReason"], "invalid-action-loop")
        self.assertTrue(row["cardExposure"][0]["shown"])
        self.assertIsNone(row["cardExposure"][0]["textRead"])
        row = run_episode(Env(True), Model("move apple 1 to table 1"), "alfworld", "seen")
        self.assertTrue(row["steps"][0]["admissible"])
        self.assertEqual(row["terminationReason"], "early-terminal-state")
        self.assertEqual(row["terminationScore"], 25)
    def test_vocabulary_comes_from_environment(self):
        env = AlfWorld.__new__(AlfWorld)
        env.state = type("State", (), {"admissible_commands": ["move apple 1 to table 1"]})()
        self.assertIn("move apple 1 to table 1", env.instructions)
        self.assertNotIn("put <object>", env.instructions)
if __name__ == "__main__": unittest.main()
