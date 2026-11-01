"""Tests of register_pools.py over a tiny synthetic work directory (never the real data).

Run: python3 -I -m unittest discover -s tools/test -p 'test_register_pools.py'   (from evals/public-benchmarks)
"""
import contextlib
import csv
import hashlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import register_pools as rp  # noqa: E402


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


def write_csv(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


MEDCALC_COLUMNS = ["Row Number", "Calculator ID", "Note ID", "Output Type", "Patient Note", "Question", "Ground Truth Answer", "Lower Limit", "Upper Limit"]


def medcalc_rows(answer="10"):
    # 60 rows, two rows per note
    return [{"Row Number": str(n), "Calculator ID": str(n % 5 + 1), "Note ID": f"note-{(n - 1) // 2}", "Output Type": "decimal",
             "Patient Note": f"synthetic note {n}", "Question": f"synthetic question {n}", "Ground Truth Answer": answer,
             "Lower Limit": "9", "Upper Limit": "11"} for n in range(1, 61)]


def make_root(root):
    """A work directory with a little of everything, all synthetic."""
    # bixbench: 12 capsules; capsules 11 and 12 share short_id bix-9; capsules 2/3/4 share data
    caps, index = [], {}
    for n in range(1, 13):
        uuid = f"{n:08d}-aaaa-bbbb-cccc-{n:012d}"
        short = "bix-9" if n >= 11 else f"bix-{n}"
        for q in (1, 2):
            caps.append({"capsule_uuid": uuid, "short_id": short, "data_folder": f"CapsuleFolder-{uuid}.zip", "question_id": f"{short}-q{q}"})
        shared = n in (2, 3, 4)
        files = [{"name": f"CapsuleData-{uuid}/", "size": 0}, {"name": f"CapsuleData-{uuid}/{'shared' if shared else 'own' + str(n)}.csv", "size": 100 if shared else n}]
        index[f"CapsuleFolder-{uuid}.zip"] = {"zip_bytes": 1, "entries": files}
    write_jsonl(root / "data/bixbench_meta/BixBench.jsonl", caps)
    write_json(root / "data/bixbench_meta/zip_index.json", index)
    write_jsonl(root / "items/bixbench.jsonl", [{"key": "bixbench/bix-1", "bench": "bixbench", "id": "bix-1", "meta": {"capsule_uuid": "00000001-aaaa-bbbb-cccc-000000000001"}},
                                              {"key": "bixbench/bix-8", "bench": "bixbench", "id": "bix-8", "meta": {"capsule_uuid": "00000008-aaaa-bbbb-cccc-000000000008"}}])
    # drb
    write_jsonl(root / "items/drb.jsonl", [{"key": "drb/5", "bench": "drb", "id": "5"}, {"key": "drb/77", "bench": "drb", "id": "77"}])
    # rcb: 10 leaderboard tasks, two extra tasks in the dataset, one of the extra tasks and one board task used
    board = [f"Life_{n:03d}" for n in range(6)] + [f"Math_{n:03d}" for n in range(4)]
    write_json(root / "data/rcb_leaderboard.json", {"tasks": board})
    write_json(root / "data/rcb_meta/tree.json", {"Life_000": [], "Life_006": [], "Neuroscience_004": []})
    write_jsonl(root / "items/researchclawbench.jsonl", [{"key": "researchclawbench/Life_000", "bench": "researchclawbench", "id": "Life_000"},
                                                        {"key": "researchclawbench/Neuroscience_004", "bench": "researchclawbench", "id": "Neuroscience_004"}])
    # arb: 30 deep + 20 wide
    rows = [{"type": "deep", "question": "q", "answer": ["a"], "arxiv_id": ["1"], "category": "c"} for _ in range(30)]
    rows += [{"type": "wide", "question": "q", "answer": ["a"], "arxiv_id": ["1"], "category": "c"} for _ in range(20)]
    write_jsonl(root / "data/autoresearchbench_data/AutoResearchBench.jsonl", rows)
    write_jsonl(root / "items/arb.jsonl", [{"key": "arb/deep-3", "bench": "arb", "id": "deep-3"}, {"key": "arb/wide-33", "bench": "arb", "id": "wide-33"}])
    # medbrowsecomp
    write_csv(root / "data/medbrowsecomp/MedBrowseComp_605.csv", [{"gold": "g", "prompt": f"p{n}", "task_name": "Ingredient"} for n in range(40)])
    write_jsonl(root / "items/medbrowsecomp.jsonl", [{"key": "medbrowsecomp/7", "bench": "medbrowsecomp", "id": "7"}])
    # medcalc: two v1 rows, one row used by an rsi arm, the used-row list
    write_csv(root / "data/medcalc/test_data.csv", medcalc_rows())
    write_jsonl(root / "items/medcalc.jsonl", [{"key": "medcalc/3", "bench": "medcalc", "id": "3", "meta": {"row_number": 3}},
                                              {"key": "medcalc/40", "bench": "medcalc", "id": "40", "meta": {"row_number": 40}}])
    write_json(root / "items/medcalc_used_rows.json", {"row_numbers": [3, 40]})
    write_jsonl(root / "items/rsi-dev.jsonl", [{"key": "medcalc-rsi/base/20", "bench": "medcalc-rsi", "id": "20", "meta": {"row_number": 20}}])


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="pools-test-"))
        self.root = self.tmp / "bench"
        make_root(self.root)
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = rp.main(["--root", str(self.root), *argv])
        return code, out.getvalue(), err.getvalue()

    def pools(self, bench):
        return json.loads((self.root / "pools" / f"{bench}.json").read_text(encoding="utf-8"))


class TestSplit(Fixture):
    def test_role_is_the_documented_hash_and_depends_on_the_id_only(self):
        first = hashlib.sha256(b"20261028|42").digest()[0]
        self.assertEqual(rp.role("20261028", "42"), "development" if first % 2 == 0 else "confirmation")
        self.assertEqual(rp.SEED, "20261028")
        ids = [str(i) for i in range(200)]
        base = rp.split_pool(ids, None, set(), "salt")
        shuffled = rp.split_pool(list(reversed(ids)), None, set(), "salt")
        self.assertEqual(base["development"], shuffled["development"])
        self.assertEqual(base["confirmation"], shuffled["confirmation"])
        # adding and removing other ids never moves an id
        bigger = rp.split_pool(ids + ["x1", "x2", "x3"], None, set(), "salt")
        smaller = rp.split_pool(ids[:150], None, set(), "salt")
        self.assertTrue(set(smaller["development"]) <= set(base["development"]))
        self.assertTrue(set(base["development"]) <= set(bigger["development"]))
        self.assertTrue(set(smaller["confirmation"]) <= set(base["confirmation"]))
        # a different salt is a different split
        self.assertNotEqual(base["development"], rp.split_pool(ids, None, set(), "other")["development"])

    def test_the_two_roles_are_roughly_half_each(self):
        split = rp.split_pool([str(i) for i in range(1000)], None, set(), rp.SEED)
        self.assertGreater(len(split["development"]), 400)
        self.assertGreater(len(split["confirmation"]), 400)

    def test_registration_is_reproducible_and_the_digest_ignores_the_time(self):
        a, b = rp.stamp(rp.build(self.root, "arb")), rp.stamp(rp.build(self.root, "arb"))
        self.assertEqual(a["digest"], b["digest"])
        b["registeredAt"] = "2000-01-01T00:00:00Z"
        self.assertEqual(rp.content_digest(b), a["digest"])


class TestExclusion(Fixture):
    def test_every_baseline_item_is_excluded_and_the_lists_add_up(self):
        for bench in rp.BENCHES:
            code, _out, err = self.run_main("--bench", bench)
            self.assertEqual(code, 0, err)
        for bench in rp.BENCHES:
            doc = self.pools(bench)
            self.assertEqual(doc["baseline"]["unmatched"], [], bench)
            for name, pool in doc["pools"].items():
                taken = pool["development"] + pool["confirmation"]
                self.assertFalse(set(taken) & set(pool["excludedBaseline"]), f"{bench}/{name}")
                self.assertEqual(len(taken) + len(pool["dropped"]) + len(pool["excludedBaseline"]), pool["universe"], f"{bench}/{name}")
        self.assertEqual(self.pools("drb")["pools"]["main"]["excludedBaseline"], ["5", "77"])
        self.assertEqual(self.pools("medbrowsecomp")["pools"]["main"]["excludedBaseline"], ["7"])
        # medcalc: the v1 items, the used-row list and the rsi arm row alike
        self.assertEqual(self.pools("medcalc")["pools"]["main"]["excludedBaseline"], ["3", "20", "40"])
        self.assertEqual(sorted(self.pools("medcalc")["baseline"]["files"]), ["medcalc.jsonl", "medcalc_used_rows.json", "rsi-dev.jsonl"])

    def test_pools_hold_ids_only(self):
        self.run_main("--bench", "medcalc")
        text = (self.root / "pools/medcalc.json").read_text(encoding="utf-8")
        self.assertNotIn("synthetic note", text)
        self.assertNotIn("synthetic question", text)


class TestBenchSpecifics(Fixture):
    def test_bixbench_splits_capsules_with_a_unique_id_and_drops_shared_data(self):
        self.run_main("--bench", "bixbench")
        doc = self.pools("bixbench")
        pool = doc["pools"]["main"]
        self.assertEqual(pool["universe"], 12)
        self.assertEqual(pool["excludedBaseline"], ["bix-1", "bix-8"])
        ids = pool["development"] + pool["confirmation"] + pool["dropped"] + pool["excludedBaseline"]
        # bix-9 belongs to two capsules: both get the uuid suffix
        self.assertIn("bix-9-00000011", ids)
        self.assertIn("bix-9-00000012", ids)
        self.assertNotIn("bix-9", ids)
        self.assertEqual(doc["dataFamilies"], [["bix-2", "bix-3", "bix-4"]])
        # a confirmation capsule never shares its data family with a development or an excluded capsule
        taken = set(pool["development"]) | set(pool["excludedBaseline"])
        for ident in pool["confirmation"]:
            mates = {m for family in doc["dataFamilies"] if ident in family for m in family} - {ident}
            self.assertFalse(mates & taken, ident)
        for dropped in pool["dropped"]:
            self.assertEqual(rp.role(doc["salt"], dropped), "confirmation")

    def test_a_confirmation_capsule_in_a_development_family_is_dropped(self):
        ids = ["a", "b", "c", "d"]
        groups = {"a": "g1", "b": "g1", "c": "g2", "d": "g3"}
        salt = next(s for s in map(str, range(1000))
                    if rp.role(s, "a") == "development" and rp.role(s, "b") == "confirmation")
        split = rp.split_pool(ids, groups, set(), salt)
        self.assertIn("b", split["dropped"])
        self.assertNotIn("b", split["confirmation"])
        # a group shared with an excluded id drops a confirmation id as well
        salt2 = next(s for s in map(str, range(1000)) if rp.role(s, "b") == "confirmation")
        split2 = rp.split_pool(ids, groups, {"a"}, salt2)
        self.assertIn("b", split2["dropped"])

    def test_arb_has_a_deep_and_a_wide_pool(self):
        self.run_main("--bench", "arb")
        pools = self.pools("arb")["pools"]
        self.assertEqual(sorted(pools), ["deep", "wide"])
        self.assertEqual(pools["deep"]["universe"], 30)
        self.assertEqual(pools["wide"]["universe"], 20)
        self.assertEqual(pools["deep"]["excludedBaseline"], ["deep-3"])
        self.assertEqual(pools["wide"]["excludedBaseline"], ["wide-33"])
        self.assertTrue(all(i.startswith("wide-") for i in pools["wide"]["development"] + pools["wide"]["confirmation"]))

    def test_rcb_lists_the_dataset_tasks_that_are_not_on_the_leaderboard_separately(self):
        self.run_main("--bench", "rcb")
        doc = self.pools("rcb")
        self.assertEqual(doc["pools"]["main"]["universe"], 10)
        self.assertEqual(doc["extraTasks"], ["Life_006", "Neuroscience_004"])
        self.assertEqual(doc["extraUsedInBaseline"], ["Neuroscience_004"])
        self.assertEqual(doc["pools"]["main"]["excludedBaseline"], ["Life_000"])
        self.assertEqual(doc["baseline"]["unmatched"], [])
        taken = doc["pools"]["main"]["development"] + doc["pools"]["main"]["confirmation"]
        self.assertFalse({"Life_006", "Neuroscience_004"} & set(taken))

    def test_drb_pool_is_the_hundred_tasks_with_languages(self):
        self.run_main("--bench", "drb")
        pool = self.pools("drb")["pools"]["main"]
        self.assertEqual(pool["universe"], 100)
        self.assertEqual(pool["counts"]["development"] + pool["counts"]["confirmation"], 98)
        langs = pool["byLanguage"]
        self.assertEqual(langs["development"]["zh"] + langs["confirmation"]["zh"], 49)
        self.assertEqual(langs["development"]["en"] + langs["confirmation"]["en"], 49)

    def test_medcalc_uses_the_legacy_salt_notes_and_reports_the_legacy_comparison(self):
        legacy_dev, legacy_conf = [], []
        for row in medcalc_rows():
            if row["Row Number"] in {"3", "40"}:
                continue
            (legacy_dev if rp.role(rp.LEGACY_MEDCALC_SALT, row["Row Number"]) == "development" else legacy_conf).append(row["Row Number"])
        write_json(self.root / "rsi/pools.json", {"rule": "legacy", "development": legacy_dev, "confirmation": legacy_conf})
        self.run_main("--bench", "medcalc")
        doc = self.pools("medcalc")
        self.assertEqual(doc["salt"], rp.LEGACY_MEDCALC_SALT)
        pool = doc["pools"]["main"]
        notes = {r["Row Number"]: r["Note ID"] for r in medcalc_rows()}
        dev_notes = {notes[i] for i in pool["development"]} | {notes[i] for i in pool["excludedBaseline"]}
        for ident in pool["confirmation"]:
            self.assertNotIn(notes[ident], dev_notes)
        legacy = doc["legacy"]
        self.assertTrue(legacy["present"] and legacy["developmentIsSubset"] and legacy["confirmationIsSubset"])
        self.assertEqual(legacy["removedFromDevelopment"], 1)  # row 20, the rsi arm row, left the development pool
        self.assertEqual(doc["verified"], "to-do")

    def test_medcalc_verified_is_recorded_when_its_test_set_is_present(self):
        rows = medcalc_rows()
        rows[4]["Ground Truth Answer"] = "12"
        write_csv(self.root / "data/medcalc_verified/test_data.csv", rows)
        (self.root / "data/medcalc_verified/SOURCE.txt").write_text("synthetic verified set\n", encoding="utf-8")
        self.run_main("--bench", "medcalc")
        verified = self.pools("medcalc")["verified"]
        self.assertTrue(verified["sameIdsAsOriginal"])
        self.assertEqual(verified["changedRowIds"], ["5"])
        self.assertEqual(verified["source"], "synthetic verified set")


class TestRegisteredFiles(Fixture):
    def test_a_registered_file_is_kept_unless_forced_and_the_old_one_is_kept_aside(self):
        self.assertEqual(self.run_main("--bench", "drb")[0], 0)
        path = self.root / "pools/drb.json"
        before = path.read_bytes()
        old_digest = json.loads(before)["digest"]
        code, out, _err = self.run_main("--bench", "drb")
        self.assertEqual(code, 0)
        self.assertIn("kept", out)
        self.assertEqual(path.read_bytes(), before)
        code, out, _err = self.run_main("--bench", "drb", "--force")
        self.assertEqual(code, 0)
        self.assertIn(old_digest[:16], out)
        self.assertIn("same digest", out)
        self.assertTrue((self.root / "pools/superseded" / f"drb-{old_digest[:12]}.json").exists())

    def test_force_after_the_sources_changed_reports_a_different_digest(self):
        self.run_main("--bench", "medbrowsecomp")
        # one more baseline item changes the registration
        with open(self.root / "items/medbrowsecomp.jsonl", "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"key": "medbrowsecomp/9", "bench": "medbrowsecomp", "id": "9"}) + "\n")
        code, out, _err = self.run_main("--bench", "medbrowsecomp", "--force")
        self.assertEqual(code, 0)
        self.assertIn("DIFFERENT digest", out)

    def test_a_corrupt_registered_file_is_never_overwritten(self):
        self.run_main("--bench", "drb")
        path = self.root / "pools/drb.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        doc["pools"]["main"]["development"].append("999")
        path.write_text(json.dumps(doc), encoding="utf-8")
        tampered = path.read_bytes()
        code, _out, err = self.run_main("--bench", "drb", "--force")
        self.assertEqual(code, 2)
        self.assertIn("digest does not verify", err)
        self.assertEqual(path.read_bytes(), tampered)


class TestCheck(Fixture):
    def register_all(self):
        for bench in rp.BENCHES:
            self.assertEqual(self.run_main("--bench", bench)[0], 0)

    def test_check_passes_on_a_fresh_registration(self):
        self.register_all()
        code, out, _err = self.run_main("--check")
        self.assertEqual(code, 0, out)
        self.assertIn("same digest", out)

    def test_check_fails_on_an_unregistered_bench(self):
        self.run_main("--bench", "drb")
        code, out, _err = self.run_main("--check", "--bench", "arb")
        self.assertEqual(code, 1)
        self.assertIn("not registered", out)

    def test_check_fails_when_the_content_no_longer_matches_the_digest(self):
        self.register_all()
        path = self.root / "pools/arb.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        doc["pools"]["deep"]["development"].append("deep-999")
        path.write_text(json.dumps(doc), encoding="utf-8")
        code, out, _err = self.run_main("--check", "--bench", "arb")
        self.assertEqual(code, 1)
        self.assertIn("digest does not match", out)

    def test_check_fails_on_a_baseline_item_inside_a_pool_even_with_a_valid_digest(self):
        self.register_all()
        path = self.root / "pools/drb.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        pool = doc["pools"]["main"]
        # move an excluded id into the development list and re-seal the digest: the role check or the baseline check must catch it
        stolen = pool["excludedBaseline"].pop(0)
        pool["development"].append(stolen)
        doc["digest"] = rp.content_digest(doc)
        path.write_text(json.dumps(doc), encoding="utf-8")
        code, out, _err = self.run_main("--check", "--bench", "drb")
        self.assertEqual(code, 1)
        self.assertTrue("baseline v1 item" in out or "development role" in out or "confirmation role" in out or "lists hold" in out or "counts." in out, out)

    def test_check_fails_when_a_baseline_file_changed_and_ignores_a_new_items_file(self):
        self.register_all()
        write_jsonl(self.root / "items/rsi2-dev.jsonl", [{"key": "drb/10", "bench": "drb", "id": "10"}])  # a later dev run is not baseline
        self.assertEqual(self.run_main("--check", "--bench", "drb")[0], 0)
        with open(self.root / "items/drb.jsonl", "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"key": "drb/1", "bench": "drb", "id": "1"}) + "\n")
        code, out, _err = self.run_main("--check", "--bench", "drb")
        self.assertEqual(code, 1)
        self.assertIn("changed since registration", out)

    def test_check_without_the_sources_is_structural_only(self):
        self.register_all()
        shutil.rmtree(self.root / "items")
        shutil.rmtree(self.root / "data")
        code, out, _err = self.run_main("--check")
        self.assertEqual(code, 0, out)
        self.assertIn("structural checks only", out)


if __name__ == "__main__":
    unittest.main()
