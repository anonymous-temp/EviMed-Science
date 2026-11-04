#!/usr/bin/env python3
"""Tests of the lane workflow's plan step (the matrix it builds from .rsi-lab/config.json) and of its shape. Stdlib only: the plan script is cut out
of the workflow text and run on a scratch config. Run: python3 -I -m unittest discover -s . -p "test_workflow.py" (from this directory)."""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = pathlib.Path(__file__).resolve().parent
WORKFLOW = (HERE / "rsi-lane.workflow.yml").read_text()


def plan_script():
    body = WORKFLOW.split("python3 - <<'PY'\n", 1)[1].split("\n          PY", 1)[0]
    return textwrap.dedent(body)


def plan(config):
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        (root / ".rsi-lab").mkdir()
        (root / ".rsi-lab" / "config.json").write_text(json.dumps(config))
        output = root / "out"
        done = subprocess.run([sys.executable, "-I", "-c", plan_script()], cwd=root, env={"GITHUB_OUTPUT": str(output), "PATH": os.environ["PATH"]}, capture_output=True, text=True)
        if done.returncode != 0:
            raise AssertionError(done.stderr[-400:])
        values = dict(line.split("=", 1) for line in output.read_text().splitlines())
        return {**values, "matrix": json.loads(values["matrix"])}


BASE = {"mode": "lanes", "batch": "b100", "sourceRef": "main", "imageRunId": 1, "imageArtifact": "a", "idleExitMin": 3}


class Plan(unittest.TestCase):
    def test_every_job_of_an_arm_carries_its_patch_and_its_web_patch(self):
        result = plan({**BASE, "arms": [{"key": "base", "jobs": 2, "workers": 4},
                                        {"key": "t1", "jobs": 1, "workers": 3, "patch": "rsi-lab/patch-t1", "webPatch": "rsi-lab/web-t1"},
                                        {"key": "g1", "jobs": 1, "webPatch": "rsi-lab/web-g1"}]})
        self.assertEqual([(row["lane"], row["patch"], row["webPatch"], row["workers"]) for row in result["matrix"]["include"]],
                         [("b100-base-1", "", "", 4), ("b100-base-2", "", "", 4), ("b100-t1-1", "rsi-lab/patch-t1", "rsi-lab/web-t1", 3), ("b100-g1-1", "", "rsi-lab/web-g1", 3)])

    def test_the_bounds_and_the_idle_modes_are_unchanged(self):
        with self.assertRaises(AssertionError):
            plan({**BASE, "arms": [{"key": "a", "jobs": 9}]})
        with self.assertRaises(AssertionError):
            plan({**BASE, "arms": []})
        idle = plan({**BASE, "mode": "idle", "arms": []})
        self.assertEqual(idle["matrix"]["include"][0]["lane"], "none")
        with self.assertRaises(AssertionError):
            plan({**BASE, "mode": "everything"})


class Shape(unittest.TestCase):
    def test_the_lane_builds_what_it_is_given_and_passes_both_flags_to_env(self):
        self.assertIn("if: matrix.patch != ''", WORKFLOW)
        self.assertIn("if: matrix.webPatch != ''", WORKFLOW)
        self.assertIn("matrix.patch != '' && '--delta'", WORKFLOW)
        self.assertIn("matrix.webPatch != '' && '--web-delta'", WORKFLOW)
        self.assertIn('stack.py" build-web-delta', WORKFLOW)

    def test_sharing_a_built_image_between_jobs_is_not_in_the_workflow(self):
        # tried on 2026-11-02 (runtime delta 511 s, archive 1,925 MiB, upload and download fine) and removed: `docker load` of the saved image
        # failed on the runner with "max depth exceeded"
        for word in ("save-delta", "load-delta", "name: delta-", "needs: [plan, build]"):
            self.assertNotIn(word, WORKFLOW)

    def test_no_step_prints_the_bundle_and_every_secret_file_is_masked(self):
        self.assertIn("::add-mask::", WORKFLOW)
        self.assertNotRegex(WORKFLOW, r"echo[^\n]*RSI_LAB_BUNDLE")
        self.assertNotRegex(WORKFLOW, r"cat[^\n]*(secrets|bundle)/")


if __name__ == "__main__":
    unittest.main()
