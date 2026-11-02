import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from support import make_bench

from evimed_h2 import config, families as F

TOOLS = Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "public-benchmarks" / "tools"))
import make_confirmation as MC  # noqa: E402
import register_round as RR  # noqa: E402

ARMS = [{"tag": "base", "image": "base"}, {"tag": "cstar", "image": "cand-cstar"}]


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="make-confirmation-test-")
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.bench = make_bench(self.dir / "bench", 6)  # development 1..6, confirmation 900 and 901; every Ground Truth Answer is SECRET-GOLD-VALUE
        self.registration = self.dir / "registration.json"
        with contextlib.redirect_stdout(io.StringIO()):
            code = self.register()
        self.assertEqual(code, 0)
        self.out = self.dir / "out"

    def register(self):
        return RR.main(["--round", "r", "--family", "medcalc", "--benchmark", "medcalc-bench", "--scorer", "medcalc", "--pools", str(self.bench / "pools/medcalc.json"),
                        "--development-rows", "2", "--confirmation-rows", "2", "--salt", "s", "--failure-slice", "1", "--candidates-max", "1", "--out", str(self.registration)])

    def run_tool(self, *extra):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = MC.main(["--registration", str(self.registration), "--out-dir", str(self.out), "--bench-root", str(self.bench), "--ppc", "", *extra])
        return code, out.getvalue(), err.getvalue()

    def lines(self, tag):
        return [json.loads(line) for line in (self.out / f"requests.{tag}.jsonl").read_text(encoding="utf-8").splitlines()]


class Requests(Fixture):
    def test_exactly_the_registered_rows_three_repeats_two_arms_with_the_rid_form_and_images(self):
        code, out, err = self.run_tool()
        self.assertEqual((code, err), (0, ""))
        rows = json.loads(self.registration.read_text())["rows"]["confirmation"]
        self.assertEqual(sorted(rows), ["900", "901"])
        for tag, image in (("base", "base"), ("cstar", "cand-cstar")):
            requests = self.lines(tag)
            self.assertEqual([r["rid"] for r in requests], [f"cf.medcalc.{row}.{tag}.r{k}" for row in rows for k in range(3)])
            self.assertEqual({r["image"] for r in requests}, {image})
            self.assertEqual({r["probe"]["preamble"] for r in requests} | {r["probe"]["line"] for r in requests}, {None})
            self.assertEqual({r["item"]["id"] for r in requests}, set(rows))
        # a size and a count per file; no prompt is printed
        self.assertRegex(out, r"requests\.base\.jsonl \d+ bytes, 6 requests \(2 rows x 3 repeats\), image base")
        self.assertNotIn("Patient", out)

    def test_the_item_is_the_development_form_byte_for_byte(self):
        self.run_tool()
        developed = F.Family("medcalc", root=self.bench, fetcher=F.Fetcher(self.dir / "cache", enabled=False)).tasks(["1"])["1"].queue_line()
        sample = self.lines("base")[0]["item"]
        self.assertEqual(sorted(sample), sorted(developed))  # the same closed set of keys, medcalc without a deadline
        self.assertNotIn("timeBudgetMinutes", sample)
        self.assertTrue(sample["prompt"].endswith(F.CALC_FINAL))

    def test_no_answer_reaches_a_file_and_no_prompt_reaches_the_output(self):
        code, out, err = self.run_tool()
        self.assertEqual(code, 0)
        for tag in ("base", "cstar"):
            self.assertNotIn("SECRET-GOLD-VALUE", (self.out / f"requests.{tag}.jsonl").read_text(encoding="utf-8"))
        self.assertNotIn("SECRET-GOLD-VALUE", out + err)

    def test_a_deadline_is_carried_for_the_families_that_have_one(self):
        task = F.Task("arb-deep", "deep-1", "q", (), 20)
        with mock.patch.dict(F.BUILDERS, {"arb-deep": lambda root, ids, fetcher: {i: task for i in ids}}):
            document = {"family": "arb-deep", "rows": {"confirmation": ["deep-1"]}, "repeats": {"confirmation": 1}}
            built = MC.build_requests(document, ARMS, bench_root=self.bench)
        self.assertEqual(built["base"][0]["item"]["timeBudgetMinutes"], 20)

    # ------------------------------------------------------------------------------------------------ the guards

    def test_a_registration_that_does_not_verify_builds_nothing(self):
        document = json.loads(self.registration.read_text())
        document["rows"]["confirmation"].reverse()
        self.registration.write_text(json.dumps(document))
        code, _, err = self.run_tool()
        self.assertEqual(code, 2)
        self.assertIn("does not verify", err)
        self.assertFalse(self.out.exists())

    def test_the_rows_are_re_derived_from_the_pools_file(self):
        pools = json.loads((self.bench / "pools/medcalc.json").read_text())
        pools["digest"] = "another-pools-file"
        (self.bench / "pools/medcalc.json").write_text(json.dumps(pools))
        code, _, err = self.run_tool()
        self.assertEqual(code, 2)
        self.assertIn("not the one registered", err)

    def test_a_key_that_names_an_answer_is_refused_by_the_brokers_own_check_and_nothing_is_written(self):
        original = F.Task.queue_line

        def leaky(self):
            return {**original(self), "goldAnswer": "x"}

        with mock.patch.object(F.Task, "queue_line", leaky):
            code, _, err = self.run_tool()
        self.assertEqual(code, 2)
        self.assertIn("closed set", err)
        self.assertFalse(self.out.exists())
        # inside the closed set the broker's check still applies
        with mock.patch.object(MC, "ITEM_KEYS", MC.ITEM_KEYS | {"goldAnswer"}), mock.patch.object(F.Task, "queue_line", leaky):
            code, _, err = self.run_tool()
        self.assertEqual(code, 2)
        self.assertIn("broker would refuse", err)
        self.assertFalse(self.out.exists())

    def test_a_registered_row_without_raw_data_stops_the_call(self):
        document = json.loads(self.registration.read_text())
        document["rows"]["confirmation"] = ["900", "777"]
        built = None
        with self.assertRaises(MC.ConfirmationRefused) as caught:
            built = MC.build_requests(document, ARMS, bench_root=self.bench)
        self.assertIsNone(built)
        self.assertIn("777", str(caught.exception))

    def test_an_existing_file_is_not_replaced_except_by_the_same_bytes(self):
        self.assertEqual(self.run_tool()[0], 0)
        before = (self.out / "requests.base.jsonl").read_bytes()
        self.assertEqual(self.run_tool()[0], 0)  # identical bytes: fine
        (self.out / "requests.base.jsonl").write_text("changed\n")
        code, _, err = self.run_tool()
        self.assertEqual(code, 2)
        self.assertIn("--force", err)
        self.assertEqual((self.out / "requests.base.jsonl").read_text(), "changed\n")
        self.assertEqual(self.run_tool("--force")[0], 0)
        self.assertEqual((self.out / "requests.base.jsonl").read_bytes(), before)

    def test_a_family_with_input_files_gets_the_public_data_manifest_beside_its_requests(self):
        entries = [{"url": "https://example.invalid/a.zip", "bytes": 10, "sha256": "ab" * 32, "dest": "/srv/x/_zips/a.zip", "unzip": {"into": "/srv/x/a"}}]
        with mock.patch.object(F, "fetch_entries", lambda domain, ids, **kw: entries if sorted(ids) == ["900", "901"] else []):
            code, out, err = self.run_tool()
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(json.loads((self.out / "fetch.json").read_text()), entries)
        self.assertIn("fetch.json", out)
        self.assertRegex(out, r"fetch\.json \d+ bytes, 1 public-data entries")
        # the same entries again are fine; other entries do not replace the manifest without --force
        with mock.patch.object(F, "fetch_entries", lambda domain, ids, **kw: entries):
            self.assertEqual(self.run_tool()[0], 0)
        with mock.patch.object(F, "fetch_entries", lambda domain, ids, **kw: [{**entries[0], "bytes": 11}]):
            code, _, err = self.run_tool()
        self.assertEqual(code, 2)
        self.assertIn("--force", err)
        # a family with none (medcalc here) writes no manifest
        self.out = self.dir / "other"
        self.assertEqual(self.run_tool()[0], 0)
        self.assertFalse((self.dir / "other" / "fetch.json").exists())

    def test_the_exclusion_files_a_registration_was_made_with_are_needed_to_build_from_it(self):
        listed = self.dir / "unbuildable.json"
        listed.write_text(json.dumps({"reason": "the request builder cannot name these", "ids": ["1", "999"]}))
        with contextlib.redirect_stdout(io.StringIO()):
            code = RR.main(["--round", "r", "--family", "medcalc", "--benchmark", "medcalc-bench", "--scorer", "medcalc", "--pools", str(self.bench / "pools/medcalc.json"),
                            "--development-rows", "2", "--confirmation-rows", "2", "--salt", "s", "--failure-slice", "1", "--candidates-max", "1", "--exclude-ids", str(listed),
                            "--out", str(self.registration), "--force"])
        self.assertEqual(code, 0)
        code, _, err = self.run_tool()
        self.assertEqual(code, 2)
        self.assertIn("--exclude-ids", err)
        self.assertEqual(self.run_tool("--exclude-ids", str(listed))[0], 0)

    def test_the_development_loader_still_refuses_a_confirmation_row(self):
        family = F.Family("medcalc", root=self.bench, fetcher=F.Fetcher(self.dir / "cache", enabled=False))
        with self.assertRaises(F.ContaminationRefused):
            family.tasks(["900"])


class RealBenchData(unittest.TestCase):
    """The tool's lines for development rows are the lines the development arms were submitted with (rsi/arm-*/requests.jsonl)."""

    ROOT = config.BENCH_ROOT

    def setUp(self):
        if not (self.ROOT / "rsi" / "arm-cs" / "requests.jsonl").is_file():
            self.skipTest("the bench work directory is not on this box")

    def parity(self, family, arm_dir, count=6):
        requests = [json.loads(line) for line in (self.ROOT / "rsi" / arm_dir / "requests.jsonl").read_text().splitlines() if line.strip()]
        requests = [r for r in requests if r["rid"].split(".")[1] == family][:count]
        ids = [r["item"]["id"] for r in requests]
        document = {"family": family, "rows": {"confirmation": ids}, "repeats": {"confirmation": 1}}
        built = MC.build_requests(document, ARMS[:1], bench_root=self.ROOT)["base"]
        self.assertEqual(len(built), len(requests))
        for mine, theirs in zip(built, requests):
            self.assertEqual(mine["item"], theirs["item"], f"{family}/{theirs['item']['id']}")
            self.assertEqual(mine["probe"], theirs["probe"])

    def test_medcalc(self):
        self.parity("medcalc", "arm-cs")

    def test_arb_deep(self):
        self.parity("arb-deep", "arm-c0")

    def test_drb(self):
        self.parity("drb", "arm-c2")


if __name__ == "__main__":
    unittest.main()
