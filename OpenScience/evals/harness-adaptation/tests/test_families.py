import json
import tempfile
import unittest
from pathlib import Path

from support import Sandbox, ensure_upstream

from evimed_h2 import config, families as F
from evimed_h2.errors import ContaminationRefused


class FixtureFamilies(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(self)
        self.family = F.Family("medcalc", root=self.box.bench, fetcher=F.Fetcher(self.box.tmp / "cache", enabled=False))

    def test_only_the_development_list_is_ever_built(self):
        self.assertEqual(sorted(self.family.development_ids()), ["1", "2", "3", "4", "5", "6"])
        with self.assertRaises(ContaminationRefused):
            self.family.tasks(["900"])  # a confirmation row of the fixture pool
        self.assertEqual(sorted(self.family.tasks(["1", "2"])), ["1", "2"])

    def test_a_task_holds_what_the_solver_is_given_and_no_gold(self):
        task = self.family.tasks(["1"])["1"]
        line = task.queue_line()
        self.assertEqual(sorted(line), ["bench", "collect", "deleteGroupAfter", "files", "group", "id", "key", "line", "prompt", "timeoutMin"])
        self.assertNotIn("SECRET-GOLD-VALUE", json.dumps([line, task.facts]))
        self.assertTrue(task.prompt.endswith("End with a final line: Final answer: <value>"))
        self.assertEqual(set(task.facts), {"calculator", "output_type"})

    def test_selection_is_stable_hash_order_and_idempotent(self):
        first = self.family.select(4)
        self.assertEqual(first, self.family.select(4))
        expected = sorted(self.family.development_ids(), key=lambda i: F.order_key(i))[:4]
        self.assertEqual(first, expected)
        self.assertNotEqual(first, self.family.select(4, salt="other-salt"))

    def test_write_ppc_is_idempotent_and_refuses_a_silent_change(self):
        document = F.select_ppc(["medcalc"], root=self.box.bench, fetcher=F.Fetcher(self.box.tmp / "cache", enabled=False))
        path = self.box.tmp / "ppc.json"
        F.write_ppc(document, path)
        F.write_ppc(document, path)
        self.assertEqual(F.read_ppc(path)["medcalc"], document["domains"]["medcalc"]["ids"])
        other = json.loads(json.dumps(document))
        other["domains"]["medcalc"]["ids"] = ["6", "5", "4", "3"]
        with self.assertRaises(RuntimeError):
            F.write_ppc(other, path)
        F.write_ppc(other, path, force=True)
        self.assertEqual(F.read_ppc(path)["medcalc"], ["6", "5", "4", "3"])


class RealBenchData(unittest.TestCase):
    """The builders' output for the baseline items must be reproduced byte for byte, so a probe's task is the solver's task of the campaign."""

    ROOT = config.BENCH_ROOT

    def setUp(self):
        if not (self.ROOT / "queue" / "v1-medcalc.jsonl").is_file():
            self.skipTest("the bench work directory is not on this box")

    def parity(self, domain, queue, select=lambda row: True, ignore=()):
        rows = [json.loads(l) for l in (self.ROOT / "queue" / f"{queue}.jsonl").read_text().splitlines() if l.strip()]
        rows = [r for r in rows if select(r)]
        built = F.BUILDERS[domain](self.ROOT, [r["id"] for r in rows], F.Fetcher(enabled=False))
        for row in rows:
            line = built[row["id"]].queue_line()
            for key in row:
                if key in ignore:
                    continue
                self.assertEqual(line[key], row[key], f"{domain}/{row['id']}/{key}")

    def test_medcalc(self):
        self.parity("medcalc", "v1-medcalc")

    def test_arb(self):
        self.parity("arb-deep", "v1-arb", lambda r: r["id"].startswith("deep"))
        self.parity("arb-wide", "v1-arb", lambda r: r["id"].startswith("wide"))

    def test_mbc(self):
        self.parity("mbc", "v1-medbrowsecomp")

    def test_bixbench_and_rcb(self):
        # the baseline queue was edited after building for two items whose big tables are stored gzipped on the host: only `files` differs
        self.parity("bixbench", "v1-bixbench", ignore=("files",))
        self.parity("rcb", "v1-rcb", lambda r: r["id"] != "Neuroscience_002", ignore=())

    def test_loaders_never_keep_gold_columns(self):
        for domain in ("medcalc", "arb-deep", "mbc", "bixbench"):
            family = F.Family(domain, root=self.ROOT, fetcher=F.Fetcher(enabled=False))
            task = next(iter(family.tasks(family.development_ids()[:1]).values()))
            # keys and the descriptors; the prompt itself is the solver's own text and may contain any word
            line = task.queue_line()
            blob = json.dumps([sorted(line), sorted(task.facts), task.facts], ensure_ascii=False).lower()
            for needle in ("ground truth", "ideal", "distractors", "arxiv_id", "gold", "answer", "rubric"):
                self.assertNotIn(needle, blob, domain)

    def test_the_chosen_tasks_file_matches_the_rule(self):
        path = config.PPC_TASKS_FILE
        if not path.is_file():
            self.skipTest("ppc-tasks.json not written yet")
        chosen = F.read_ppc(path)
        self.assertEqual(sorted(chosen), sorted(config.DOMAINS))
        for domain, ids in chosen.items():
            family = F.Family(domain, root=self.ROOT, fetcher=F.Fetcher(enabled=False)) if domain not in ("drb", "rcb") else F.Family(domain, root=self.ROOT)
            self.assertEqual(len(ids), config.PPC_PER_DOMAIN)
            self.assertTrue(set(ids) <= set(family.development_ids()), domain)
            hashes = [F.order_key(i) for i in ids]
            self.assertEqual(hashes, sorted(hashes), domain)  # chosen in hash order


if __name__ == "__main__":
    unittest.main()
