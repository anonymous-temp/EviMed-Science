"""Tests of shard_queue.py over synthetic queues.

Run: python3 -I -m unittest discover -s tools/test -p 'test_shard_queue.py'   (from evals/public-benchmarks)
"""
import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import shard_queue as sq  # noqa: E402


def item(key, group, ident=None, minutes=10, bench="b", **extra):
    return {"key": key, "bench": bench, "id": ident if ident is not None else key.rsplit("/", 1)[-1], "group": group,
            "prompt": f"question {key} é", "timeoutMin": minutes, **extra}


def arms_queue(rows=8, arms=("base", "candA"), repeats=1, block=3):
    """Like build_rsi_items.py arms: one group per arm, arm blocks alternating, key bench/<arm>/<row>[#rN]."""
    out = []
    ids = [str(100 + n) for n in range(rows)]
    for start in range(0, rows, block):
        for repeat in range(repeats):
            for arm in arms:
                for ident in ids[start:start + block]:
                    rid = ident + (f"#r{repeat}" if repeats > 1 else "")
                    out.append(item(f"medcalc-rsi/{arm}/{rid}", f"rsi-{arm}", rid, bench="medcalc-rsi", keepRuntime=True))
    return out


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="shard-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def queue(self, name, items, raw=None):
        path = self.tmp / f"{name}.jsonl"
        path.write_text(raw if raw is not None else "".join(json.dumps(i, ensure_ascii=False) + "\n" for i in items), encoding="utf-8")
        return path

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = sq.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def manifest(self, name):
        return json.loads((self.tmp / f"{name}.shards.json").read_text(encoding="utf-8"))

    def shard_items(self, name):
        return {s["name"]: [json.loads(l) for l in (self.tmp / s["file"]).read_text(encoding="utf-8").splitlines()]
                for s in self.manifest(name)["shards"]}


class TestUnits(Base):
    def test_one_group_per_arm_over_the_same_rows_is_one_unit_and_the_tool_says_so(self):
        path = self.queue("arms", arms_queue())
        code, out, err = self.run_cli("split", "--queue", str(path), "-k", "4")
        self.assertEqual(code, 0)
        manifest = self.manifest("arms")
        self.assertEqual(manifest["written"], 1)
        self.assertEqual(manifest["mode"], "keep-groups")
        self.assertIn("--split-groups", err)
        self.assertTrue(any("requested 4 shards, wrote 1" in n for n in manifest["notes"]))
        self.assertEqual(manifest["pairedRows"], 8)

    def test_split_groups_keeps_the_arms_of_a_row_together_and_spreads_the_groups(self):
        items = arms_queue(rows=8, arms=("base", "candA", "candB"), repeats=2)
        path = self.queue("arms", items)
        code, _out, _err = self.run_cli("split", "--queue", str(path), "-k", "4", "--split-groups")
        self.assertEqual(code, 0)
        manifest = self.manifest("arms")
        self.assertEqual(manifest["written"], 4)
        where = {}
        for name, rows in self.shard_items("arms").items():
            for row in rows:
                where.setdefault(sq.pair_of(row), set()).add(name)
        self.assertEqual(len(where), 8)  # the repeats #r0 and #r1 are one row
        self.assertTrue(all(len(s) == 1 for s in where.values()))
        self.assertEqual(sorted(manifest["groupsSpanning"]), ["rsi-base", "rsi-candA", "rsi-candB"])
        self.assertEqual(self.run_cli("check", "--queue", str(path), "--manifest", str(self.tmp / "arms.shards.json"))[0], 0)

    def test_per_item_groups_split_in_both_modes_and_balance_by_timeout(self):
        # weights 10,30,10,20,10,10 over two shards
        minutes = [10, 30, 10, 20, 10, 10]
        items = [item(f"x/{n}", f"g{n}", minutes=m) for n, m in enumerate(minutes)]
        path = self.queue("flat", items)
        self.run_cli("split", "--queue", str(path), "-k", "2")
        manifest = self.manifest("flat")
        self.assertEqual([s["weight"] for s in manifest["shards"]], [50, 40])
        self.assertEqual(manifest["imbalance"]["ratio"], 1.25)
        shards = self.shard_items("flat")
        # heaviest first onto the lightest shard: x/1 (30) -> s1, x/3 (20) -> s2, then the 10s fill the lighter one in queue order
        self.assertEqual([r["key"] for r in shards["flat.s1"]], ["x/1", "x/2", "x/5"])
        self.assertEqual([r["key"] for r in shards["flat.s2"]], ["x/0", "x/3", "x/4"])

    def test_items_without_timeout_weigh_fifteen_and_without_group_share_the_default_group(self):
        raw = "".join(json.dumps({"key": f"k/{n}", "prompt": "p"}) + "\n" for n in range(4))
        path = self.queue("bare", None, raw=raw)
        self.run_cli("split", "--queue", str(path), "-k", "2")
        manifest = self.manifest("bare")
        self.assertEqual(manifest["written"], 1)           # every item is in the driver's default group "bench"
        self.assertEqual(manifest["weight"], 60)
        self.run_cli("split", "--queue", str(path), "-k", "2", "--force", "--split-groups")
        self.assertEqual(self.manifest("bare")["written"], 2)

    def test_the_split_is_deterministic_and_keeps_lines_byte_for_byte(self):
        items = arms_queue(rows=9, repeats=2)
        path = self.queue("det", items, raw="".join(json.dumps(i, ensure_ascii=False, separators=(",", ":")) + "\n\n" for i in items))
        self.run_cli("split", "--queue", str(path), "-k", "3", "--split-groups")
        first = {p.name: p.read_bytes() for p in sorted(self.tmp.glob("det.*"))}
        self.run_cli("split", "--queue", str(path), "-k", "3", "--split-groups", "--force")
        second = {p.name: p.read_bytes() for p in sorted(self.tmp.glob("det.*"))}
        self.assertEqual(first, second)
        original = [l for l in path.read_text(encoding="utf-8").split("\n") if l]
        joined = [l for name in sorted(n for n in first if n.endswith(".jsonl") and ".s" in n)
                  for l in first[name].decode("utf-8").split("\n") if l]
        self.assertEqual(sorted(joined), sorted(original))
        self.assertIn("é", first["det.s1.jsonl"].decode("utf-8"))


class TestRefusals(Base):
    def test_duplicate_keys_and_colliding_folders_and_bad_lines_are_refused(self):
        dup = self.queue("dup", [item("a/1", "g"), item("a/1", "g")])
        code, _o, err = self.run_cli("split", "--queue", str(dup), "-k", "2")
        self.assertEqual(code, 2)
        self.assertIn("a/1", err)
        clash = self.queue("clash", [item("a#r1", "g"), item("a_r1", "g")])
        self.assertEqual(self.run_cli("split", "--queue", str(clash), "-k", "2")[0], 2)
        bad = self.queue("bad", None, raw='{"key":"a","prompt":"p"}\nnot json\n')
        code, _o, err = self.run_cli("split", "--queue", str(bad), "-k", "2")
        self.assertEqual(code, 2)
        self.assertIn("line 2", err)
        self.assertFalse(list(self.tmp.glob("dup.s*")))

    def test_a_split_is_not_redone_without_force_and_force_removes_the_shards_it_no_longer_has(self):
        path = self.queue("flat", [item(f"x/{n}", f"g{n}") for n in range(6)])
        self.run_cli("split", "--queue", str(path), "-k", "3")
        self.assertTrue((self.tmp / "flat.s3.jsonl").exists())
        code, _o, err = self.run_cli("split", "--queue", str(path), "-k", "2")
        self.assertEqual(code, 2)
        self.assertIn("--force", err)
        self.assertEqual(self.run_cli("split", "--queue", str(path), "-k", "2", "--force")[0], 0)
        self.assertFalse((self.tmp / "flat.s3.jsonl").exists())


class TestCheck(Base):
    def split_flat(self):
        path = self.queue("flat", [item(f"x/{n}", f"g{n}") for n in range(6)])
        self.run_cli("split", "--queue", str(path), "-k", "3")
        return path, self.tmp / "flat.shards.json"

    def test_a_good_split_checks_and_a_damaged_one_does_not(self):
        path, manifest = self.split_flat()
        self.assertEqual(self.run_cli("check", "--queue", str(path), "--manifest", str(manifest))[0], 0)
        shard = self.tmp / "flat.s1.jsonl"
        lines = shard.read_text(encoding="utf-8").splitlines()
        # a missing key
        shard.write_text("".join(l + "\n" for l in lines[:-1]), encoding="utf-8")
        code, out, _e = self.run_cli("check", "--queue", str(path), "--manifest", str(manifest))
        self.assertEqual(code, 1)
        self.assertIn("is in no shard", out)
        self.assertIn("changed since the split", out)
        # a key in two shards
        shard.write_text("".join(l + "\n" for l in lines) + lines[0] + "\n", encoding="utf-8")
        code, out, _e = self.run_cli("check", "--queue", str(path), "--shards", str(shard), str(self.tmp / "flat.s2.jsonl"), str(self.tmp / "flat.s3.jsonl"))
        self.assertEqual(code, 1)
        self.assertIn("is on line", out)
        # a changed line
        shard.write_text("".join(l + "\n" for l in lines).replace("question", "questioN"), encoding="utf-8")
        code, out, _e = self.run_cli("check", "--queue", str(path), "--shards", str(shard), str(self.tmp / "flat.s2.jsonl"), str(self.tmp / "flat.s3.jsonl"))
        self.assertEqual(code, 1)
        self.assertIn("differs from the queue's", out)

    def test_order_inside_a_shard_must_follow_the_queue(self):
        path = self.queue("flat", [item(f"x/{n}", "g") for n in range(3)])
        self.run_cli("split", "--queue", str(path), "-k", "1")
        shard = self.tmp / "flat.s1.jsonl"
        lines = shard.read_text(encoding="utf-8").splitlines()
        shard.write_text("".join(l + "\n" for l in reversed(lines)), encoding="utf-8")
        code, out, _e = self.run_cli("check", "--queue", str(path), "--shards", str(shard))
        self.assertEqual(code, 1)
        self.assertIn("out of the queue's order", out)

    def test_shards_made_by_hand_that_split_a_group_or_a_row_fail_the_strict_check(self):
        items = arms_queue(rows=4)
        path = self.queue("arms", items)
        a, b = self.tmp / "a.jsonl", self.tmp / "b.jsonl"
        base = [i for i in items if i["group"] == "rsi-base"]
        cand = [i for i in items if i["group"] == "rsi-candA"]
        a.write_text("".join(json.dumps(i, ensure_ascii=False) + "\n" for i in base), encoding="utf-8")
        b.write_text("".join(json.dumps(i, ensure_ascii=False) + "\n" for i in cand), encoding="utf-8")
        code, out, _e = self.run_cli("check", "--queue", str(path), "--shards", str(a), str(b))
        self.assertEqual(code, 1)
        self.assertIn("has its arms in 2 shards", out)
        # one arm split across shards by row instead: groups span, rows stay whole -> fine with --split-groups only
        rows = sorted({i["id"] for i in items})
        left = [i for i in items if i["id"] in rows[:2]]
        right = [i for i in items if i["id"] in rows[2:]]
        a.write_text("".join(json.dumps(i, ensure_ascii=False) + "\n" for i in left), encoding="utf-8")
        b.write_text("".join(json.dumps(i, ensure_ascii=False) + "\n" for i in right), encoding="utf-8")
        self.assertEqual(self.run_cli("check", "--queue", str(path), "--shards", str(a), str(b))[0], 1)
        self.assertEqual(self.run_cli("check", "--queue", str(path), "--shards", str(a), str(b), "--split-groups")[0], 0)


class TestPendingAndMerge(Base):
    def test_replace_pending_puts_the_shards_where_the_queue_was(self):
        lane = self.tmp / "lane"
        lane.mkdir()
        (lane / "pending.txt").write_text("first\nflat\nlast\n", encoding="utf-8")
        path = self.queue("flat", [item(f"x/{n}", f"g{n}") for n in range(6)])
        code, out, _e = self.run_cli("split", "--queue", str(path), "-k", "2", "--replace-pending", str(lane / "pending.txt"))
        self.assertEqual(code, 0)
        self.assertEqual((lane / "pending.txt").read_text(encoding="utf-8"), "first\nflat.s1\nflat.s2\nlast\n")
        self.assertIn("replaced by", out)

    def test_a_claimed_queue_is_not_sharded_into_pending(self):
        lane = self.tmp / "lane"
        (lane / "claims" / "flat").mkdir(parents=True)
        (lane / "pending.txt").write_text("flat\n", encoding="utf-8")
        path = self.queue("flat", [item(f"x/{n}", f"g{n}") for n in range(4)])
        code, _o, err = self.run_cli("split", "--queue", str(path), "-k", "2", "--replace-pending", str(lane / "pending.txt"))
        self.assertEqual(code, 2)
        self.assertIn("claimed", err)
        self.assertEqual((lane / "pending.txt").read_text(encoding="utf-8"), "flat\n")

    def test_merge_answers_follows_the_queue_order_and_lists_what_is_not_collected(self):
        items = [item(f"x/{n}", f"g{n}") for n in range(6)]
        path = self.queue("flat", items)
        self.run_cli("split", "--queue", str(path), "-k", "3")
        answers = self.tmp / "answers"
        answers.mkdir()
        for name, rows in self.shard_items("flat").items():
            if name == "flat.s3":
                continue
            (answers / f"{name}.jsonl").write_text("".join(json.dumps({"key": r["key"], "text": "t"}) + "\n" for r in rows), encoding="utf-8")
        out_file = answers / "flat.jsonl"
        code, out, _e = self.run_cli("merge-answers", "--manifest", str(self.tmp / "flat.shards.json"), "--answers-dir", str(answers), "--out", str(out_file))
        self.assertEqual(code, 0)
        self.assertIn("not collected yet: flat.s3", out)
        keys = [json.loads(l)["key"] for l in out_file.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(keys, [k for k in (i["key"] for i in items) if k in keys])
        self.assertEqual(self.run_cli("merge-answers", "--manifest", str(self.tmp / "flat.shards.json"), "--answers-dir", str(answers),
                                      "--out", str(out_file), "--require-all")[0], 2)
        # a key in two answers files is refused
        (answers / "flat.s2.jsonl").write_text((answers / "flat.s1.jsonl").read_text(encoding="utf-8"), encoding="utf-8")
        code, _o, err = self.run_cli("merge-answers", "--manifest", str(self.tmp / "flat.shards.json"), "--answers-dir", str(answers), "--out", str(out_file))
        self.assertEqual(code, 2)
        self.assertIn("more than one", err)


if __name__ == "__main__":
    unittest.main()
